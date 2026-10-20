import { isRecord } from "../util/guards.js";
import type { EndpointStorage, RecordData, RecordWrite, StoredRecord } from "./types.js";

export interface MemoryStorageSeed {
  records?: Record<string, Record<string, RecordData>>;
  values?: Record<string, unknown>;
}

// Single-process only. State lives in this instance, not in module globals. Use a database adapter
// for multiple instances or restarts.
export function createMemoryStorage(seed: MemoryStorageSeed = {}): EndpointStorage {
  const collections = new Map<string, Map<string, RecordData>>();
  for (const [collection, rows] of Object.entries(seed.records ?? {})) {
    const map = new Map<string, RecordData>();
    for (const [key, data] of Object.entries(rows)) map.set(key, cloneRecord(data));
    collections.set(collection, map);
  }
  const values = seed.values ?? {};

  return {
    records: {
      async get(collection, key) {
        const data = collections.get(collection)?.get(key);
        return data === undefined ? null : cloneRecord(data);
      },
      async list(collection) {
        const rows: StoredRecord[] = [];
        for (const [key, data] of collections.get(collection) ?? []) {
          rows.push({ key, data: cloneRecord(data) });
        }
        return rows;
      },
    },
    values: {
      async get(path) {
        const [group, key] = path.split(".", 2);
        if (group === undefined || group === "") return null;
        const groupValue = Object.hasOwn(values, group) ? values[group] : undefined;
        if (key === undefined) return groupValue === undefined ? null : clone(groupValue);
        if (!isRecord(groupValue) || !Object.hasOwn(groupValue, key)) return null;
        return clone(groupValue[key]);
      },
    },
    async apply(writes: readonly RecordWrite[]) {
      for (const write of writes) {
        if (write.op === "delete") {
          collections.get(write.collection)?.delete(write.key);
          continue;
        }
        let map = collections.get(write.collection);
        if (map === undefined) {
          map = new Map();
          collections.set(write.collection, map);
        }
        map.set(write.key, cloneRecord(write.data));
      }
    },
  };
}

function clone(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

function cloneRecord(data: RecordData): RecordData {
  return JSON.parse(JSON.stringify(data));
}
