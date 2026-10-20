import { createEndpointStorage, type EndpointStorageOptions, type StorageEngine } from "./engine.js";
import type { EndpointStorage } from "./types.js";

// Shared SQL core. Drivers (sqlite.ts, postgres.ts, d1.ts) supply query and transaction behavior; record
// semantics live in planner.ts, lifecycle in engine.ts, and statements here. SQL uses `?` placeholders;
// the PostgreSQL driver rewrites them to $n.
import { type Plan, type PlanReader, type PlannedOp, type RowState } from "./planner.js";
import type { RecordData, StoredRecord, VersionedRecord } from "./types.js";

export type SqlValue = string | number | null;
export type SqlRow = Record<string, unknown>;
export type QueryFn = (sql: string, params: SqlValue[]) => Promise<SqlRow[]>;

export interface Statement {
  sql: string;
  params: SqlValue[];
}

export interface SqlDriver {
  // Creates the table if missing. Idempotent.
  setup(): Promise<void>;
  // Autocommit read.
  query: QueryFn;
  // Plans with the given reader and commits the plan atomically. The driver decides the isolation
  // mechanism. It throws StorageError CONFLICT when the database refuses the unit because of a
  // concurrent write.
  atomic(work: (reader: PlanReader) => Promise<Plan>): Promise<void>;
}

// One table for every collection. Tombstones keep payload_json NULL and deleted = 1 so the version
// sequence survives deletion (server: tombstones keep a monotonic version).
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ns_records (
    collection TEXT NOT NULL,
    record_key TEXT NOT NULL,
    payload_json TEXT,
    version INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    updated_at_unix_ms BIGINT NOT NULL,
    PRIMARY KEY (collection, record_key)
  )`,
];

const READ_ROW_SQL = "SELECT payload_json, version, deleted FROM ns_records WHERE collection = ? AND record_key = ?";
const LIST_SQL = "SELECT record_key, payload_json, version FROM ns_records WHERE collection = ? AND deleted = 0";
// Live records a player owns: the bare player key, or player_<suffix>. substr keeps the match
// portable across SQLite and PostgreSQL collations (keys are ASCII, so character and byte offsets agree).
export const COUNT_LIVE_EXPR = "(SELECT COUNT(*) FROM ns_records WHERE collection = ? AND deleted = 0 AND (record_key = ? OR substr(record_key, 1, ?) = ?))";
const UPSERT_SQL = `INSERT INTO ns_records (collection, record_key, payload_json, version, deleted, updated_at_unix_ms)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (collection, record_key) DO UPDATE SET
    payload_json = excluded.payload_json,
    version = excluded.version,
    deleted = excluded.deleted,
    updated_at_unix_ms = excluded.updated_at_unix_ms`;
const REMOVE_SQL = "DELETE FROM ns_records WHERE collection = ? AND record_key = ?";

// Storage engine over a SQL driver. Reads are autocommit; apply goes through driver.atomic.
export function sqlEngine(driver: SqlDriver): StorageEngine {
  return {
    setup: () => driver.setup(),
    readVersioned: (collection, key) => readVersioned(driver.query, collection, key),
    async list(collection): Promise<StoredRecord[]> {
      const rows = await driver.query(LIST_SQL, [collection]);
      return rows.map((row) => ({
        key: String(row.record_key),
        data: JSON.parse(String(row.payload_json)) as RecordData,
        version: Number(row.version),
      }));
    },
    atomic: (work) => driver.atomic(work),
  };
}

// Planning reads. `query` may be bound to a transaction so planning sees that transaction's snapshot.
export function sqlReader(query: QueryFn): PlanReader {
  return {
    async read(collection, key): Promise<RowState> {
      const rows = await query(READ_ROW_SQL, [collection, key]);
      const row = rows[0];
      return { live: row !== undefined && Number(row.deleted) === 0, version: row === undefined ? 0 : Number(row.version) };
    },
    async countLive(collection, playerKey) {
      const rows = await query(`SELECT ${COUNT_LIVE_EXPR} AS n`, countLiveParams(collection, playerKey));
      return Number(rows[0]?.n ?? 0);
    },
  };
}

export function countLiveParams(collection: string, playerKey: string): SqlValue[] {
  return [collection, playerKey, playerKey.length + 1, `${playerKey}_`];
}

// Statements that commit a plan's ops, in order. Callers run them in one transaction or batch.
export function opStatements(plan: Plan, nowMs: number): Statement[] {
  return plan.ops.map((op: PlannedOp): Statement => {
    if (op.kind === "remove") {
      return { sql: REMOVE_SQL, params: [op.collection, op.key] };
    }
    const deleted = op.data === null ? 1 : 0;
    const json = op.data === null ? null : JSON.stringify(op.data);
    return { sql: UPSERT_SQL, params: [op.collection, op.key, json, op.version, deleted, nowMs] };
  });
}

async function readVersioned(query: QueryFn, collection: string, key: string): Promise<VersionedRecord> {
  const rows = await query(READ_ROW_SQL, [collection, key]);
  const row = rows[0];
  if (row === undefined) return { data: null, version: 0 };
  const deleted = Number(row.deleted) === 1;
  return {
    data: deleted ? null : (JSON.parse(String(row.payload_json)) as RecordData),
    version: Number(row.version),
  };
}

export interface SqlStorageOptions extends EndpointStorageOptions {
  driver: SqlDriver;
}

// SQL providers: planning, validation, and lifecycle come from the engine; only the driver differs.
export function createSqlStorage(options: SqlStorageOptions): EndpointStorage {
  return createEndpointStorage(sqlEngine(options.driver), options);
}
