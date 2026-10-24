import {
  createSqlStorage,
  opStatements,
  type QueryFn,
  type SqlDriver,
  type SqlRow,
  type SqlValue,
  SCHEMA_STATEMENTS,
  sqlReader,
} from "./sql.js";
import type { EndpointStorageOptions } from "./engine.js";
import type { CollectionDefinition, EndpointStorage, RecordData } from "./types.js";

// Structural subset shared by bun:sqlite (`Database`) and node:sqlite (`DatabaseSync`, Node 22.5+).
// Pass either one; the SDK never imports a SQLite module itself.
export interface SqliteStatement {
  all(...params: SqlValue[]): unknown[];
  run(...params: SqlValue[]): unknown;
}

export interface SqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
}

export interface SqliteStorageOptions extends EndpointStorageOptions {
  db: SqliteDatabase;
}

// Each apply() runs in BEGIN IMMEDIATE, so writers from other connections to the same file serialize
// at the database. The in-process queue (sql.ts) keeps this connection's apply() calls ordered.
// Plan reads run inside the transaction, so the checks are evaluated against the locked snapshot.
export function createSqliteStorage(options: SqliteStorageOptions): EndpointStorage {
  const { db } = options;
  const query: QueryFn = async (sql, params) => toRows(db.prepare(sql).all(...params));

  const driver: SqlDriver = {
    query,
    async setup() {
      for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
    },
    async atomic(work) {
      db.exec("BEGIN IMMEDIATE");
      let open = true;
      try {
        const plan = await work(sqlReader(query));
        for (const statement of opStatements(plan, Date.now())) {
          db.prepare(statement.sql).run(...statement.params);
        }
        db.exec("COMMIT");
        open = false;
      } catch (error) {
        if (open) db.exec("ROLLBACK");
        throw error;
      }
    },
  };

  return createSqlStorage({
    driver,
    collections: options.collections,
    values: options.values,
    seed: options.seed,
  });
}

// The driver returns unknown objects; keep only object rows so no cast is needed.
function toRows(rows: unknown[]): SqlRow[] {
  return rows.filter((row): row is SqlRow => typeof row === "object" && row !== null);
}

