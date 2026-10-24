import type { ExpectedVersion, RecordData, RecordWrite } from "../storage/index.js";

// Internal collection holding one row per tracked number change. Rows are created by endpoint writes only,
// in the same atomic apply() as the record write that changed the field.
export const LEDGER_COLLECTION = "_ledger";

export interface LedgerRow {
  field: string;
  collection_id: string;
  before: number;
  after: number;
  delta: number;
  source: string;
  steam_id: string;
  ts: string;
  event_id: string;
}

export interface LedgerInput {
  // Writes staged by the run, before the ledger rows are added.
  writes: readonly RecordWrite[];
  // The committed value a staged put replaces, or null when the record did not exist.
  before(collection: string, key: string): RecordData | null;
  // Dotted paths of the number fields marked _ledger on a collection. Empty for collections that are not ledgered.
  trackedFields(collection: string): readonly string[];
  source: string;
  now: number;
  newId(): string;
}

export interface LedgerOutput {
  writes: RecordWrite[];
  // Each new row must not exist yet, so its expected version is 0.
  expectedVersions: ExpectedVersion[];
}

export function ledgerWritesOf(input: LedgerInput): LedgerOutput {
  const writes: RecordWrite[] = [];
  const expectedVersions: ExpectedVersion[] = [];
  const ts = new Date(input.now).toISOString();
  for (const write of input.writes) {
    if (write.op !== "put") continue;
    const fields = input.trackedFields(write.collection);
    if (fields.length === 0) continue;
    const prior = input.before(write.collection, write.key);
    for (const field of fields) {
      const before = numberAt(prior, field);
      const after = numberAt(write.data, field);
      const delta = after - before;
      if (delta === 0) continue;
      const eventId = input.newId();
      const row: LedgerRow = {
        field,
        collection_id: write.collection,
        before,
        after,
        delta,
        source: input.source,
        steam_id: write.key,
        ts,
        event_id: eventId,
      };
      writes.push({ op: "put", collection: LEDGER_COLLECTION, key: eventId, data: { ...row } });
      expectedVersions.push({ collection: LEDGER_COLLECTION, key: eventId, version: 0 });
    }
  }
  return { writes, expectedVersions };
}

// A tracked field that is not a number counts as 0, as the reference ledger does.
function numberAt(data: RecordData | null, path: string): number {
  let value: unknown = data;
  for (const segment of path.split(".")) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return 0;
    value = (value as Record<string, unknown>)[segment];
  }
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export interface LedgerSummary {
  totalIncrease: number;
  totalDecrease: number;
  netChange: number;
  entryCount: number;
  sources: Record<string, { count: number; total: number }>;
}

// The totals and per-source accumulators the ledger read returns. Entries without a numeric delta still count
// toward their source, matching the reference summary.
export function ledgerSummaryOf(entries: readonly Readonly<Record<string, unknown>>[]): LedgerSummary {
  let totalIncrease = 0;
  let totalDecrease = 0;
  let netChange = 0;
  const sources: Record<string, { count: number; total: number }> = {};
  for (const entry of entries) {
    const delta = typeof entry["delta"] === "number" ? entry["delta"] : null;
    if (delta !== null) {
      if (delta > 0) totalIncrease += delta;
      else totalDecrease += delta;
      netChange += delta;
    }
    const source = typeof entry["source"] === "string" ? entry["source"] : "unknown";
    const accumulator = sources[source] ?? { count: 0, total: 0 };
    accumulator.count += 1;
    if (delta !== null) accumulator.total += delta;
    sources[source] = accumulator;
  }
  return { totalIncrease, totalDecrease, netChange, entryCount: entries.length, sources };
}
