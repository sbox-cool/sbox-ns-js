// Shared, provider-independent write planning. Every adapter runs this against its own reads and then
// commits the plan atomically (checks, limits, and ops in one unit). Semantics mirror the server's
// endpoint write path (StoreEndpointDataSource / RelationalNetworkStorageStore):
//   - every observed record must still be at the observed version when the batch commits
//   - put on a live record = update (version+1); put on absent/tombstone = create (version = last+1)
//   - per-steamid delete = tombstone (version+1); global delete = hard delete
//   - delete of an absent or tombstoned record is a no-op
//   - per-steamid maxRecords counts live records owned by the player
import { type CollectionRule, type Registry, requireKey, requireRule } from "./collections.js";
import { StorageError } from "./errors.js";
import { normalizeRecordData } from "./json.js";
import { playerKeyOf } from "./keys.js";
import { schemaViolation } from "./schema.js";
import type { ApplyOptions, RecordData, RecordWrite } from "./types.js";

// Only what planning needs. Payloads are not read here, so KV-style providers never fetch blobs to plan.
export interface RowState {
  live: boolean;
  version: number;
}

export interface PlanReader {
  // version 0 and live false when the record never existed.
  read(collection: string, key: string): Promise<RowState>;
  // Live (non-tombstoned) records owned by playerKey (key === playerKey or starts with playerKey + "_").
  countLive(collection: string, playerKey: string): Promise<number>;
}

export type PlannedOp =
  | { kind: "upsert"; collection: string; key: string; data: RecordData | null; version: number }
  | { kind: "remove"; collection: string; key: string };

export interface Plan {
  // Each observed record must currently be at exactly this version.
  checks: { collection: string; key: string; version: number }[];
  // The live count for this player must equal `count` at commit (limits were computed against it).
  limits: { collection: string; playerKey: string; count: number }[];
  ops: PlannedOp[];
}

type PlannedWrite =
  | { op: "put"; key: string; data: RecordData }
  | { op: "delete"; key: string };

export async function planApply(
  registry: Registry,
  writes: readonly RecordWrite[],
  options: ApplyOptions,
  reader: PlanReader,
): Promise<Plan> {
  const checks = new Map<string, { collection: string; key: string; version: number }>();
  for (const entry of options.expectedVersions ?? []) {
    const rule = requireRule(registry, entry.collection);
    requireKey(rule, entry.key);
    if (!Number.isSafeInteger(entry.version) || entry.version < 0) {
      throw new StorageError("INVALID_BATCH", `Expected version for ${entry.collection}/${entry.key} must be a non-negative integer.`);
    }
    const target = targetOf(entry.collection, entry.key);
    const previous = checks.get(target);
    if (previous && previous.version !== entry.version) {
      throw new StorageError("INVALID_BATCH", `Conflicting expected versions for ${entry.collection}/${entry.key}.`);
    }
    checks.set(target, { collection: entry.collection, key: entry.key, version: entry.version });
  }

  const planned: Array<{ write: PlannedWrite; rule: CollectionRule }> = [];
  const seenTargets = new Set<string>();
  for (const write of writes) {
    const rule = requireRule(registry, write.collection);
    requireKey(rule, write.key);
    const target = targetOf(write.collection, write.key);
    if (seenTargets.has(target)) {
      throw new StorageError("INVALID_BATCH", `Record ${write.collection}/${write.key} is written more than once in one apply().`);
    }
    seenTargets.add(target);
    if (write.op === "put") {
      const data = checkPut(registry, write.collection, write.key, write.data);
      planned.push({ write: { op: "put", key: write.key, data }, rule });
      // A put target must have been observed: an unobserved write can't be checked for conflicts.
      if (!checks.has(target)) {
        throw new StorageError("UNOBSERVED_WRITE", `Record ${write.collection}/${write.key} was written without an expected version. Read it with getVersioned() in the same run.`);
      }
    } else if (write.op === "delete") {
      planned.push({ write: { op: "delete", key: write.key }, rule });
      // An unobserved delete is observed here, so it is still checked against concurrent creates.
      if (!checks.has(target)) {
        const observed = await reader.read(write.collection, write.key);
        checks.set(target, { collection: write.collection, key: write.key, version: observed.version });
      }
    } else {
      throw new StorageError("INVALID_BATCH", "Write op must be \"put\" or \"delete\".");
    }
  }

  // Read-set validation: every observed record must still be at its observed version.
  const observed = new Map<string, RowState>();
  for (const check of checks.values()) {
    const current = await reader.read(check.collection, check.key);
    if (current.version !== check.version) {
      throw new StorageError("CONFLICT", `Record ${check.collection}/${check.key} changed (expected version ${check.version}, found ${current.version}).`);
    }
    observed.set(targetOf(check.collection, check.key), current);
  }

  const counts = new Map<string, { collection: string; playerKey: string; before: number; added: number; max: number }>();
  const ops: PlannedOp[] = [];
  // The per-player count moves by the net effect of the whole batch: a delete earlier in the batch frees the slot a later create uses.
  const adjustCount = async (rule: CollectionRule, key: string, delta: number): Promise<void> => {
    const playerKey = playerKeyOf(key);
    const id = targetOf(rule.id, playerKey);
    let entry = counts.get(id);
    if (!entry) {
      entry = { collection: rule.id, playerKey, before: await reader.countLive(rule.id, playerKey), added: 0, max: rule.maxRecords };
      counts.set(id, entry);
    }
    entry.added += delta;
  };
  for (const { write, rule } of planned) {
    const current = observed.get(targetOf(rule.id, write.key));
    if (current === undefined) {
      throw new StorageError("INVALID_BATCH", `Record ${rule.id}/${write.key} was not observed before planning.`);
    }
    if (write.op === "delete") {
      if (!current.live) continue;
      if (rule.global) {
        ops.push({ kind: "remove", collection: rule.id, key: write.key });
      } else {
        await adjustCount(rule, write.key, -1);
        ops.push({ kind: "upsert", collection: rule.id, key: write.key, data: null, version: current.version + 1 });
      }
      continue;
    }
    if (!rule.global && !current.live) await adjustCount(rule, write.key, 1);
    ops.push({ kind: "upsert", collection: rule.id, key: write.key, data: write.data, version: current.version + 1 });
  }
  // Only the final live count per player must fit the limit; the order of writes inside the batch does not matter.
  for (const entry of counts.values()) {
    if (entry.before + entry.added > entry.max) {
      throw new StorageError("RECORD_LIMIT_REACHED", `Maximum ${entry.max} record(s) per player in "${entry.collection}".`);
    }
  }
  const limits = [...counts.values()].map((entry) => ({ collection: entry.collection, playerKey: entry.playerKey, count: entry.before }));

  return { checks: [...checks.values()], limits, ops };
}

// Checks one put without touching storage. Shared by apply() and by construction-time seed validation,
// so a bad seed fails when the storage is constructed rather than on its first call.
export function checkPut(registry: Registry, collection: string, key: string, data: RecordData): RecordData {
  const rule = requireRule(registry, collection);
  requireKey(rule, key);
  const normalized = normalizeRecordData(data);
  const violation = schemaViolation(rule.schema, normalized);
  if (violation) {
    throw new StorageError("SCHEMA_VIOLATION", `Schema validation failed for ${collection}/${key}: ${violation}`);
  }
  return normalized;
}

function targetOf(collection: string, key: string): string {
  return `${collection}\u0000${key}`;
}
