// Cloudflare KV adapter. KV alone cannot provide what apply() promises: it is eventually consistent,
// has no multi-key transactions, and no conditional writes. So the adapter splits the record store:
//   - a coordinator (a Durable Object, see recipes/cloudflare-kv) owns metadata: version, tombstone
//     state, and the blob pointer per record. It validates checks and limits and applies the metadata
//     for one apply() as a single synchronous transaction. That transaction is the atomicity guarantee.
//   - KV holds payloads as immutable blobs under unique keys. A blob is never overwritten, so KV's
//     eventual consistency cannot make a reader see a mixed or stale value for one record version.
// Exact semantics and limits are documented in packages/sdk/docs/storage.md.
import { createEndpointStorage, type EndpointStorageOptions, type StorageEngine } from "./engine.js";
import { StorageError } from "./errors.js";
import type { Plan, PlanReader, PlannedOp } from "./planner.js";
import type { EndpointStorage, RecordData, StoredRecord, VersionedRecord } from "./types.js";

// Metadata of one record as the coordinator stores it. blobKey null = tombstone (version is kept).
export interface CoordinatorRecord {
  version: number;
  blobKey: string | null;
}

export interface CoordinatorLiveRecord {
  key: string;
  version: number;
  blobKey: string;
}

export type CoordinatorOp =
  | { kind: "upsert"; collection: string; key: string; version: number; blobKey: string | null }
  | { kind: "remove"; collection: string; key: string };

export interface CoordinatorCommit {
  checks: { collection: string; key: string; version: number }[];
  limits: { collection: string; playerKey: string; count: number }[];
  ops: CoordinatorOp[];
}

export type CoordinatorCommitResult = { ok: true; superseded: string[] } | { ok: false; reason: string };

// RPC surface of the coordinator Durable Object. Each method runs synchronously inside the object, so
// commit() evaluates its checks and applies its ops against one consistent metadata state.
export interface CoordinatorStub {
  read(collection: string, key: string): Promise<CoordinatorRecord | null>;
  countLive(collection: string, playerKey: string): Promise<number>;
  list(collection: string): Promise<CoordinatorLiveRecord[]>;
  commit(commit: CoordinatorCommit): Promise<CoordinatorCommitResult>;
}

// Structural subset of a Durable Object namespace (DurableObjectNamespace.getByName).
export interface KvCoordinatorNamespace {
  getByName(name: string): CoordinatorStub;
}

// Structural subset of a KV namespace binding.
export interface KvBlobStore {
  get(key: string, type: "text"): Promise<string | null>;
  put(key: string, value: string): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

export interface KvStorageOptions extends EndpointStorageOptions {
  coordinator: KvCoordinatorNamespace;
  blobs: KvBlobStore;
  // Names the coordinator instance that holds this storage namespace's metadata. One name per storage
  // namespace (for example one project); every writer of that namespace must use the same name.
  coordinatorName: string;
}

// A blob that is not yet visible is retried while KV propagates it. Total wait is about 1.5 s.
const BLOB_READ_ATTEMPTS = 6;
const BLOB_RETRY_BASE_MS = 50;

export function createKvStorage(options: KvStorageOptions): EndpointStorage {
  const coordinator = options.coordinator.getByName(options.coordinatorName);
  const blobs = options.blobs;

  // Loads a payload for a metadata row. If the blob is missing, the row may have been superseded (its
  // old blob deleted after the commit), so metadata is re-read and the blob retried. A row that never
  // becomes readable within the retry budget is reported as STORAGE_UNAVAILABLE.
  async function readRecord(collection: string, key: string, first: CoordinatorRecord | null): Promise<VersionedRecord> {
    let meta = first;
    for (let attempt = 0; ; attempt += 1) {
      if (meta === null || meta.blobKey === null) return { data: null, version: meta?.version ?? 0 };
      const text = await blobs.get(meta.blobKey, "text");
      if (text !== null) return { data: JSON.parse(text) as RecordData, version: meta.version };
      if (attempt + 1 >= BLOB_READ_ATTEMPTS) {
        throw new StorageError("STORAGE_UNAVAILABLE", `Payload for ${collection}/${key} is not readable from KV yet. Retry.`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, BLOB_RETRY_BASE_MS * 2 ** attempt));
      meta = await coordinator.read(collection, key);
    }
  }

  // Writes the payload blobs, commits the metadata, then removes superseded blobs.
  async function commitPlan(plan: Plan): Promise<void> {
    const uploads: { key: string; json: string }[] = [];
    const ops: CoordinatorOp[] = [];
    for (const op of plan.ops) ops.push(toCoordinatorOp(op, uploads));
    const uploaded = uploads.map((upload) => upload.key);

    // Blobs are written before the commit, so committed metadata never points at a missing payload.
    try {
      await Promise.all(uploads.map((upload) => blobs.put(upload.key, upload.json)));
    } catch (error) {
      await discard(uploaded);
      throw error;
    }

    // If the commit RPC throws, the coordinator may or may not have applied it. The blobs are left in
    // place in that case: deleting a blob the coordinator did commit would lose data. Unreferenced
    // blobs are harmless.
    const result = await coordinator.commit({ checks: plan.checks, limits: plan.limits, ops });
    if (!result.ok) {
      await discard(uploaded);
      throw new StorageError("CONFLICT", result.reason);
    }
    // The commit is durable. Removing superseded blobs is best effort; leftovers are unreferenced.
    await discard(result.superseded);
  }

  async function discard(keys: readonly string[]): Promise<void> {
    await Promise.allSettled(keys.map((key) => blobs.delete(key)));
  }

  const engine: StorageEngine = {
    async setup() {},

    async readVersioned(collection, key): Promise<VersionedRecord> {
      return readRecord(collection, key, await coordinator.read(collection, key));
    },

    async list(collection): Promise<StoredRecord[]> {
      const rows = await coordinator.list(collection);
      const loaded = await Promise.all(
        rows.map(async (row) => ({
          key: row.key,
          record: await readRecord(collection, row.key, { version: row.version, blobKey: row.blobKey }),
        })),
      );
      // A record tombstoned between the list and the payload read is dropped, as a concurrent delete would be.
      return loaded.flatMap(({ key, record }) => (record.data === null ? [] : [{ key, data: record.data, version: record.version }]));
    },

    async atomic(work) {
      await commitPlan(await work(coordinatorReader(coordinator)));
    },
  };

  return createEndpointStorage(engine, options);
}

// Maps one planned op to a coordinator op. A put's payload becomes a new blob under a fresh key.
function toCoordinatorOp(op: PlannedOp, uploads: { key: string; json: string }[]): CoordinatorOp {
  if (op.kind === "remove") return { kind: "remove", collection: op.collection, key: op.key };
  if (op.data === null) return { kind: "upsert", collection: op.collection, key: op.key, version: op.version, blobKey: null };
  const blobKey = newBlobKey(op.collection, op.key, op.version);
  uploads.push({ key: blobKey, json: JSON.stringify(op.data) });
  return { kind: "upsert", collection: op.collection, key: op.key, version: op.version, blobKey };
}

// Unique per write attempt. A blob key is never reused, so KV caches cannot serve a stale payload for it
// and writes never overwrite a value a reader may be fetching. Keys stay under KV's 512-byte limit:
// the prefix plus collection (≤128), record key (≤256), version, and a 36-character UUID.
function newBlobKey(collection: string, key: string, version: number): string {
  return `ns/${collection}/${key}/v${version}/${crypto.randomUUID()}`;
}

function coordinatorReader(coordinator: CoordinatorStub): PlanReader {
  return {
    async read(collection, key) {
      const row = await coordinator.read(collection, key);
      return { live: row !== null && row.blobKey !== null, version: row?.version ?? 0 };
    },
    countLive: (collection, playerKey) => coordinator.countLive(collection, playerKey),
  };
}
