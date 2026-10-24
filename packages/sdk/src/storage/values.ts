import { StorageError } from "./errors.js";
import { cloneJson, isPlainObject } from "./json.js";
import type { ValueStore } from "./types.js";

// Project game values (server: game-values.json) are deploy-time configuration, not writable records.
// They are snapshotted once at construction and every read returns a fresh copy.
export function createValueStore(values: Record<string, unknown> | undefined): ValueStore {
  if (values !== undefined && !isPlainObject(values)) {
    throw new StorageError("INVALID_STORAGE_CONFIG", "values must be an object of value groups.");
  }
  const snapshot = cloneJson(values ?? {}) as Record<string, unknown>;
  return {
    async get(path: string): Promise<unknown> {
      const dot = path.indexOf(".");
      const group = dot === -1 ? path : path.slice(0, dot);
      if (!Object.prototype.hasOwnProperty.call(snapshot, group)) return null;
      const value = snapshot[group];
      if (dot === -1) return cloneJson(value);
      if (!isPlainObject(value)) return null;
      const field = path.slice(dot + 1);
      if (!Object.prototype.hasOwnProperty.call(value, field)) return null;
      return cloneJson(value[field]);
    },
  };
}
