// Provider-independent EndpointStorage. A provider supplies a StorageEngine (committed reads plus one
// atomic plan-and-commit primitive); this module owns key/collection validation, the in-process
// apply() queue, seeding, value access, and list ordering, so every provider behaves the same way.
import { compileCollections, requireKey, requireRule } from "./collections.js";
import { createLock } from "./lock.js";
import { type Plan, type PlanReader, checkPut, planApply } from "./planner.js";
import { createValueStore } from "./values.js";
import type {
  ApplyOptions,
  CollectionDefinition,
  EndpointStorage,
  RecordData,
  RecordWrite,
  StoredRecord,
  VersionedRecord,
} from "./types.js";

export interface StorageEngine {
  // Idempotent schema or resource setup. Runs once, before any other engine call.
  setup(): Promise<void>;
  // Committed state of one record. Version 0 and data null when it never existed.
  readVersioned(collection: string, key: string): Promise<VersionedRecord>;
  // Live records of one collection, in any order.
  list(collection: string): Promise<StoredRecord[]>;
  // Runs work() with a reader that observes committed state, then commits the plan it returns as one
  // unit. Throws StorageError CONFLICT if a concurrent writer changed a checked record or limit.
  atomic(work: (reader: PlanReader) => Promise<Plan>): Promise<void>;
}

export interface EndpointStorageOptions {
  collections: readonly CollectionDefinition[];
  // Game values (server: game-values.json), read-only. Snapshotted at construction.
  values?: Record<string, unknown>;
  // Initial records: collection -> key -> payload. Every seed record is validated on each
  // construction. A record is inserted (version 1) only if it has never existed; existing and
  // tombstoned records are left untouched, so seeding is safe on durable providers across restarts.
  seed?: Record<string, Record<string, RecordData>>;
}

interface SeedRecord {
  collection: string;
  key: string;
  data: RecordData;
}

const EMPTY_READER: PlanReader = {
  async read() {
    return { live: false, version: 0 };
  },
  async countLive() {
    return 0;
  },
};

export function createEndpointStorage(engine: StorageEngine, options: EndpointStorageOptions): EndpointStorage {
  const registry = compileCollections(options.collections);
  const values = createValueStore(options.values);
  const lock = createLock();
  const seeds = flattenSeed(options.seed);
  // Validated now, not in the lock, so a bad seed throws at construction. apply() re-checks inside planApply.
  for (const seed of seeds) checkPut(registry, seed.collection, seed.key, seed.data);

  // Setup and seeding run under the lock; reads and apply() wait for them, so no call sees a half-seeded store.
  // The lock is FIFO and this is enqueued at construction, so seeding always precedes any apply().
  const ready: Promise<void> = lock(async () => {
    await engine.setup();
    if (seeds.length === 0) return;
    // Validate every seed record, including ones that already exist.
    await planApply(registry, seeds.map(toPut), { expectedVersions: seeds.map(toAbsent) }, EMPTY_READER);
    await engine.atomic(async (reader) => {
      const missing: SeedRecord[] = [];
      for (const seed of seeds) {
        const current = await reader.read(seed.collection, seed.key);
        if (current.version === 0) missing.push(seed);
      }
      return planApply(registry, missing.map(toPut), { expectedVersions: missing.map(toAbsent) }, reader);
    });
  });
  ready.catch(() => undefined);

  return {
    records: {
      async get(collection, key) {
        requireKey(requireRule(registry, collection), key);
        await ready;
        return (await engine.readVersioned(collection, key)).data;
      },
      async getVersioned(collection, key): Promise<VersionedRecord> {
        requireKey(requireRule(registry, collection), key);
        await ready;
        return engine.readVersioned(collection, key);
      },
      async list(collection): Promise<StoredRecord[]> {
        requireRule(registry, collection);
        await ready;
        const records = await engine.list(collection);
        return records.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      },
    },
    values,
    apply(writes: readonly RecordWrite[], applyOptions: ApplyOptions = {}) {
      return lock(async () => {
        await ready;
        await engine.atomic((reader) => planApply(registry, writes, applyOptions, reader));
      });
    },
  };
}

function flattenSeed(seed: Record<string, Record<string, RecordData>> | undefined): SeedRecord[] {
  const out: SeedRecord[] = [];
  for (const [collection, entries] of Object.entries(seed ?? {})) {
    for (const [key, data] of Object.entries(entries)) out.push({ collection, key, data });
  }
  return out;
}

function toPut(seed: SeedRecord): RecordWrite {
  return { op: "put", collection: seed.collection, key: seed.key, data: seed.data };
}

function toAbsent(seed: SeedRecord): { collection: string; key: string; version: number } {
  return { collection: seed.collection, key: seed.key, version: 0 };
}
