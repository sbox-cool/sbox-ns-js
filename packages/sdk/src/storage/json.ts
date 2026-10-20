import { StorageError } from "./errors.js";

export const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_DEPTH = 64;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Returns a detached JSON copy of a record payload. Rejects anything JSON.stringify would silently
// change (undefined, functions, symbols, NaN/Infinity, Dates, class instances, cycles).
export function normalizeRecordData(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new StorageError("INVALID_RECORD", "Record payload must be a JSON object.");
  }
  const copy = cloneJson(value) as Record<string, unknown>;
  const text = JSON.stringify(copy);
  if (new TextEncoder().encode(text).length > MAX_PAYLOAD_BYTES) {
    throw new StorageError("RECORD_TOO_LARGE", `Record payload exceeds ${MAX_PAYLOAD_BYTES} bytes.`);
  }
  return copy;
}

// Detached JSON copy of any JSON-compatible value. Throws INVALID_RECORD for non-JSON input.
export function cloneJson(value: unknown, depth = 0, seen: Set<object> = new Set()): unknown {
  if (depth > MAX_DEPTH) {
    throw new StorageError("INVALID_RECORD", `Payload nests deeper than ${MAX_DEPTH} levels.`);
  }
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new StorageError("INVALID_RECORD", "Payload numbers must be finite.");
      }
      return value;
    case "object":
      break;
    default:
      throw new StorageError("INVALID_RECORD", `Payload contains a ${typeof value} value, which is not JSON.`);
  }
  if (seen.has(value as object)) {
    throw new StorageError("INVALID_RECORD", "Payload contains a cycle.");
  }
  seen.add(value as object);
  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map((item, index) => {
      if (!(index in value)) {
        throw new StorageError("INVALID_RECORD", "Payload arrays must not be sparse.");
      }
      return cloneJson(item, depth + 1, seen);
    });
  } else if (isPlainObject(value)) {
    const obj: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      obj[key] = cloneJson(value[key], depth + 1, seen);
    }
    out = obj;
  } else {
    throw new StorageError("INVALID_RECORD", "Payload contains a non-plain object.");
  }
  seen.delete(value as object);
  return out;
}
