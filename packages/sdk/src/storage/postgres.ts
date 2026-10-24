import { StorageError } from "./errors.js";
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

// Structural subset of node-postgres (`pg`) Pool / PoolClient. Any driver with the same shape works;
// the SDK never imports a PostgreSQL driver.
export interface PgQueryResult {
  rows: SqlRow[];
}

export interface PgClient {
  query(text: string, values?: SqlValue[]): Promise<PgQueryResult>;
  release(): void;
}

export interface PgPool {
  query(text: string, values?: SqlValue[]): Promise<PgQueryResult>;
  connect(): Promise<PgClient>;
}

export interface PostgresStorageOptions extends EndpointStorageOptions {
  pool: PgPool;
}

// Each apply() takes a dedicated client, runs in BEGIN ISOLATION LEVEL SERIALIZABLE, and commits
// once. Serializable isolation makes the planner's reads and the writes behave as one unit: a
// concurrent transaction that touches the same records or the same player's record set makes one
// side fail with SQLSTATE 40001 (serialization_failure). That maps to CONFLICT. Callers retry the
// whole run; the planner is re-evaluated against the new state.
export function createPostgresStorage(options: PostgresStorageOptions): EndpointStorage {
  const { pool } = options;
  const query: QueryFn = async (sql, params) => (await pool.query(toPostgresPlaceholders(sql), params)).rows;

  const driver: SqlDriver = {
    query,
    async setup() {
      for (const statement of SCHEMA_STATEMENTS) await pool.query(statement);
    },
    async atomic(work) {
      const client = await pool.connect();
      const clientQuery: QueryFn = async (sql, params) => (await client.query(toPostgresPlaceholders(sql), params)).rows;
      let open = false;
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        open = true;
        const plan = await work(sqlReader(clientQuery));
        for (const statement of opStatements(plan, Date.now())) {
          await client.query(toPostgresPlaceholders(statement.sql), statement.params);
        }
        await client.query("COMMIT");
        open = false;
      } catch (error) {
        if (open) await client.query("ROLLBACK").catch(() => undefined);
        throw mapPostgresError(error);
      } finally {
        client.release();
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

// `?` placeholders are never inside SQL literals in this module, so a sequential rewrite is exact.
export function toPostgresPlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
}

// 40001 serialization_failure and 40P01 deadlock_detected both mean "retry the run".
const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(["40001", "40P01"]);

function mapPostgresError(error: unknown): unknown {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && RETRYABLE_SQLSTATES.has(error.code)) {
    return new StorageError("CONFLICT", "A concurrent write changed these records. Retry the run.");
  }
  return error;
}
