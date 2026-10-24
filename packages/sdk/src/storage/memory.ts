import { createEndpointStorage, type EndpointStorageOptions, type StorageEngine } from "./engine.js";
import { playerKeyOf } from "./keys.js";
import type { PlanReader, PlannedOp } from "./planner.js";
import type { EndpointStorage, RecordData, StoredRecord, VersionedRecord } from "./types.js";

export type MemoryStorageOptions = EndpointStorageOptions;

interface Row {
  collection: string;
  key: string;
  // JSON text of the payload, or null for a tombstone. Text keeps reads detached from stored state.
  json: string | null;
  version: number;
}

// Non-durable provider for tests, local development, and single-process runs. apply() is serialized by
// the engine lock, and the plan is committed synchronously after it is computed.
export function createMemoryStorage(options: MemoryStorageOptions): EndpointStorage {
  const rows = new Map<string, Row>();
  const engine: StorageEngine = {
    async setup() {},
    async readVersioned(collection, key): Promise<VersionedRecord> {
      const row = rows.get(targetOf(collection, key));
      if (row === undefined) return { data: null, version: 0 };
      return { data: row.json === null ? null : (JSON.parse(row.json) as RecordData), version: row.version };
    },
    async list(collection): Promise<StoredRecord[]> {
      const out: StoredRecord[] = [];
      for (const row of rows.values()) {
        if (row.collection !== collection || row.json === null) continue;
        out.push({ key: row.key, data: JSON.parse(row.json) as RecordData, version: row.version });
      }
      return out;
    },
    async atomic(work) {
      const plan = await work(memoryReader(rows));
      for (const op of plan.ops) applyOp(rows, op);
    },
  };
  return createEndpointStorage(engine, options);
}

function memoryReader(rows: Map<string, Row>): PlanReader {
  return {
    async read(collection, key) {
      const row = rows.get(targetOf(collection, key));
      return { live: row !== undefined && row.json !== null, version: row?.version ?? 0 };
    },
    async countLive(collection, playerKey) {
      let count = 0;
      for (const row of rows.values()) {
        if (row.collection === collection && row.json !== null && playerKeyOf(row.key) === playerKey) count += 1;
      }
      return count;
    },
  };
}

function applyOp(rows: Map<string, Row>, op: PlannedOp): void {
  if (op.kind === "remove") {
    rows.delete(targetOf(op.collection, op.key));
    return;
  }
  rows.set(targetOf(op.collection, op.key), {
    collection: op.collection,
    key: op.key,
    json: op.data === null ? null : JSON.stringify(op.data),
    version: op.version,
  });
}

function targetOf(collection: string, key: string): string {
  return `${collection}\u0000${key}`;
}
