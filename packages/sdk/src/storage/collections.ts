import { StorageError } from "./errors.js";
import { isPlainObject } from "./json.js";
import { isValidId, isValidRecordKey } from "./keys.js";
import type { CollectionDefinition } from "./types.js";

export interface CollectionRule {
  readonly id: string;
  readonly global: boolean;
  readonly maxRecords: number;
  readonly requireSaveVersion: boolean;
  readonly allowRecordDelete: boolean;
  readonly schema: Record<string, unknown>;
}

export type Registry = ReadonlyMap<string, CollectionRule>;

const MAX_RECORDS_LIMIT = 50;

export function compileCollections(definitions: readonly CollectionDefinition[]): Registry {
  const registry = new Map<string, CollectionRule>();
  for (const definition of definitions) {
    const rule = compileOne(definition);
    if (registry.has(rule.id)) {
      throw new StorageError("INVALID_COLLECTION", `Collection "${rule.id}" is defined more than once.`);
    }
    registry.set(rule.id, rule);
  }
  return registry;
}

function compileOne(definition: CollectionDefinition): CollectionRule {
  if (!isPlainObject(definition)) {
    throw new StorageError("INVALID_COLLECTION", "Collection definitions must be objects.");
  }
  const id = definition.id;
  if (typeof id !== "string" || !isValidId(id)) {
    throw new StorageError("INVALID_COLLECTION", `Collection id ${JSON.stringify(id)} must match [a-zA-Z0-9_-]{1,128}.`);
  }
  if (definition.collectionType !== undefined && typeof definition.collectionType !== "string") {
    throw new StorageError("INVALID_COLLECTION", `Collection "${id}" collectionType must be a string.`);
  }
  // The server treats any collectionType other than "global" (case-insensitive) as per-steamid.
  const global = typeof definition.collectionType === "string"
    && definition.collectionType.toLowerCase() === "global";

  // A blank maxRecords means unset (server: "key present but blank" falls back to the default).
  const maxRecords = definition.maxRecords ?? 1;
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_RECORDS_LIMIT) {
    throw new StorageError("INVALID_COLLECTION", `Collection "${id}" maxRecords must be an integer from 1 to ${MAX_RECORDS_LIMIT}.`);
  }
  for (const flag of ["allowRecordDelete", "requireSaveVersion"] as const) {
    if (definition[flag] !== undefined && typeof definition[flag] !== "boolean") {
      throw new StorageError("INVALID_COLLECTION", `Collection "${id}" ${flag} must be a boolean.`);
    }
  }
  // A missing schema serializes to JSON null on the server, which fails every record write. Reject it here.
  if (!isPlainObject(definition.schema)) {
    throw new StorageError("INVALID_COLLECTION", `Collection "${id}" must declare an object schema.`);
  }

  return {
    id,
    global,
    maxRecords,
    requireSaveVersion: definition.requireSaveVersion ?? false,
    allowRecordDelete: definition.allowRecordDelete ?? false,
    schema: definition.schema,
  };
}

export function requireRule(registry: Registry, collection: string): CollectionRule {
  const rule = registry.get(collection);
  if (!rule) {
    throw new StorageError("UNKNOWN_COLLECTION", `Unknown collection "${collection}".`);
  }
  return rule;
}

export function requireKey(rule: CollectionRule, key: string): void {
  const valid = rule.global ? isValidId(key) : isValidRecordKey(key);
  if (!valid) {
    const pattern = rule.global ? "[a-zA-Z0-9_-]{1,128}" : "[a-zA-Z0-9_:-]{1,256}";
    throw new StorageError("INVALID_KEY", `Record key ${JSON.stringify(key)} in "${rule.id}" must match ${pattern}.`);
  }
}
