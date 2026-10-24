import { looseEquals } from "./expression.js";
import type { RecordData } from "../storage/types.js";

// Write operations applied to a record document. They run on a copy and return the new document plus the
// positive numeric deltas per path, which the ledger and rate-limit accounting read.

export const WRITE_OPS = ["set", "inc", "push", "pull", "remove", "delete", "merge", "set_if_null"] as const;
export type WriteOpName = (typeof WRITE_OPS)[number];

export interface WriteOp {
  op: WriteOpName;
  path: string;
  value?: unknown;
  match?: Record<string, unknown>;
  source?: string;
  reason?: string;
}

export interface ApplyOutcome {
  data: RecordData;
  increments: Readonly<Record<string, number>>;
  meta: Readonly<Record<string, { source: string | null; reason: string | null }>>;
}

export class OperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationError";
  }
}

const MAX_OPS = 100;

function getNested(data: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = data;
  for (const part of path.split(".")) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = Reflect.get(cursor, part);
  }
  return cursor;
}

function setNested(data: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  const last = parts.pop()!;
  let cursor: Record<string, unknown> = data;
  for (const part of parts) {
    const next = cursor[part];
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      cursor[part] = {};
    }
    cursor = Reflect.get(cursor, part) as Record<string, unknown>;
  }
  cursor[last] = value;
}

function matchesAll(item: Record<string, unknown>, match: Record<string, unknown>): boolean {
  return Object.entries(match).every(([key, expected]) => looseEquals(Reflect.get(item, key), expected));
}

function requiresValue(op: WriteOpName, value: unknown, index: number): void {
  if (value === undefined) throw new OperationError(`ops[${index}]: "${op}" requires a "value".`);
}

function addIncrement(increments: Record<string, number>, path: string, delta: number): void {
  if (delta > 0) increments[path] = (increments[path] ?? 0) + delta;
}

function numericDelta(data: Record<string, unknown>, path: string, next: number): number {
  const prev = getNested(data, path);
  return next - (typeof prev === "number" ? prev : 0);
}

// Applies operations in order. Throws OperationError on invalid operations; the caller maps it to 400.
export function applyWriteOps(existing: RecordData | null, ops: readonly unknown[]): ApplyOutcome {
  if (ops.length === 0) throw new OperationError("ops must be a non-empty array.");
  if (ops.length > MAX_OPS) throw new OperationError("Maximum 100 operations per request.");

  const data: Record<string, unknown> = structuredClone(existing ?? {});
  const increments: Record<string, number> = {};
  const meta: Record<string, { source: string | null; reason: string | null }> = {};

  ops.forEach((raw, index) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new OperationError(`ops[${index}]: invalid operation.`);
    }
    const op = raw as Partial<WriteOp>;
    if (typeof op.op !== "string" || typeof op.path !== "string") {
      throw new OperationError(`ops[${index}]: missing "op" or "path".`);
    }
    if (!(WRITE_OPS as readonly string[]).includes(op.op)) {
      throw new OperationError(`ops[${index}]: invalid op "${op.op}". Must be: ${WRITE_OPS.join(", ")}`);
    }
    const name = op.op;
    const path = op.path;
    const value = op.value;
    const recordMeta = () => {
      meta[path] = { source: typeof op.source === "string" ? op.source : null, reason: typeof op.reason === "string" ? op.reason : null };
    };

    switch (name) {
      case "set": {
        requiresValue(name, value, index);
        if (typeof value === "number") addIncrement(increments, path, numericDelta(data, path, value));
        setNested(data, path, value);
        recordMeta();
        return;
      }
      case "inc": {
        if (typeof value !== "number") throw new OperationError(`ops[${index}]: "inc" requires a numeric "value".`);
        const current = getNested(data, path);
        let next = (typeof current === "number" ? current : 0) + value;
        if (next !== 0 && Math.abs(next) < 1e-9) next = 0;
        setNested(data, path, next);
        addIncrement(increments, path, value);
        recordMeta();
        return;
      }
      case "push": {
        requiresValue(name, value, index);
        const list = getNested(data, path);
        if (Array.isArray(list)) list.push(value);
        else setNested(data, path, [value]);
        return;
      }
      case "pull":
      case "remove":
      case "delete": {
        const current = getNested(data, path);
        if (!Array.isArray(current)) {
          if (name === "pull" && (op.match === undefined || op.match === null || typeof op.match !== "object")) {
            throw new OperationError(`ops[${index}]: "pull" requires a "match" object.`);
          }
          return;
        }
        if (name === "pull") {
          if (op.match === null || typeof op.match !== "object" || Array.isArray(op.match)) {
            throw new OperationError(`ops[${index}]: "pull" requires a "match" object.`);
          }
          const match = op.match;
          const expected = Reflect.get(match, "value");
          setNested(
            data,
            path,
            current.filter((item) => {
              if (item === null || typeof item !== "object" || Array.isArray(item)) {
                return !("value" in match && looseEquals(item, expected));
              }
              return !matchesAll(item as Record<string, unknown>, match);
            }),
          );
          return;
        }
        requiresValue(name, value, index);
        setNested(
          data,
          path,
          current.filter((item) => {
            if (item === null || typeof item !== "object" || Array.isArray(item)) return !looseEquals(item, value);
            if (value !== null && typeof value === "object" && !Array.isArray(value)) {
              return !matchesAll(item as Record<string, unknown>, value as Record<string, unknown>);
            }
            return true;
          }),
        );
        return;
      }
      case "merge": {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          throw new OperationError(`ops[${index}]: "merge" requires an object "value".`);
        }
        let target = getNested(data, path);
        if (target === null || target === undefined) {
          setNested(data, path, {});
          target = getNested(data, path);
        }
        if (target === null || typeof target !== "object" || Array.isArray(target)) {
          throw new OperationError(`ops[${index}]: cannot merge into a non-object at "${path}".`);
        }
        for (const [key, item] of Object.entries(value)) {
          const childPath = path.length > 0 ? `${path}.${key}` : key;
          if (typeof item === "number") addIncrement(increments, childPath, numericDelta(data, childPath, item));
          Reflect.set(target, key, item);
        }
        recordMeta();
        return;
      }
      case "set_if_null": {
        requiresValue(name, value, index);
        const current = getNested(data, path);
        if (current !== null && current !== undefined) return;
        if (typeof value === "number") addIncrement(increments, path, numericDelta(data, path, value));
        setNested(data, path, value);
        recordMeta();
        return;
      }
    }
  });

  return { data: data as RecordData, increments, meta };
}
