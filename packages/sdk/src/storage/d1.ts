import { StorageError } from "./errors.js";
import type { Plan } from "./planner.js";
import {
  COUNT_LIVE_EXPR,
  countLiveParams,
  createSqlStorage,
  opStatements,
  type QueryFn,
  type SqlDriver,
  type SqlRow,
  type SqlValue,
  type Statement,
  SCHEMA_STATEMENTS,
  sqlReader,
} from "./sql.js";
import type { EndpointStorageOptions } from "./engine.js";
import type { CollectionDefinition, EndpointStorage, RecordData } from "./types.js";

// Structural subset of the Workers D1 binding. The SDK never imports @cloudflare/workers-types.
export interface D1Statement {
  bind(...values: SqlValue[]): D1Statement;
  all(): Promise<{ results: SqlRow[] }>;
}

export interface D1Database {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown[]>;
}

export interface D1StorageOptions extends EndpointStorageOptions {
  db: D1Database;
}

// D1 has no interactive transactions, but batch() runs its statements as one SQL transaction: if any
// statement fails, the whole batch is rolled back. So apply() plans with ordinary reads, then sends one
// batch that first asserts every observed version and every player limit, then writes the ops.
//
// An assertion is an INSERT into ns_assert whose ok column is NOT NULL. When the condition is false,
// the CASE yields NULL, the insert violates NOT NULL, and the batch rolls back. The table is cleared
// at the end of each batch; D1 serializes batches, so batches never interleave.
//
// Limit: planning reads are not in the batch, so a concurrent writer can change them between the plan
// and the batch. The assertions catch that and report CONFLICT, so no inconsistent write commits.
const ASSERT_TABLE_SQL = "CREATE TABLE IF NOT EXISTS ns_assert (id INTEGER PRIMARY KEY, ok INTEGER NOT NULL)";
const ASSERT_CLEAR_SQL = "DELETE FROM ns_assert";
const ASSERT_FAILED_MARKER = "ns_assert.ok";

export function createD1Storage(options: D1StorageOptions): EndpointStorage {
  const { db } = options;
  const query: QueryFn = async (sql, params) => (await db.prepare(sql).bind(...params).all()).results;

  const driver: SqlDriver = {
    query,
    async setup() {
      await db.batch([...SCHEMA_STATEMENTS, ASSERT_TABLE_SQL].map((sql) => db.prepare(sql)));
    },
    async atomic(work) {
      const plan: Plan = await work(sqlReader(query));
      const statements = [...assertStatements(plan), ...opStatements(plan, Date.now())];
      if (statements.length === 0) return;
      const prepared = [
        ...statements.map((statement) => db.prepare(statement.sql).bind(...statement.params)),
        db.prepare(ASSERT_CLEAR_SQL),
      ];
      try {
        await db.batch(prepared);
      } catch (error) {
        if (error instanceof Error && error.message.includes(ASSERT_FAILED_MARKER)) {
          throw new StorageError("CONFLICT", "A concurrent write changed these records. Retry the run.");
        }
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

function assertStatements(plan: Plan): Statement[] {
  const versionChecks = plan.checks.map((check): Statement => ({
    sql: "INSERT INTO ns_assert (ok) SELECT CASE WHEN COALESCE((SELECT version FROM ns_records WHERE collection = ? AND record_key = ?), 0) = ? THEN 1 END",
    params: [check.collection, check.key, check.version],
  }));
  const countChecks = plan.limits.map((limit): Statement => ({
    sql: `INSERT INTO ns_assert (ok) SELECT CASE WHEN ${COUNT_LIVE_EXPR} = ? THEN 1 END`,
    params: [...countLiveParams(limit.collection, limit.playerKey), limit.count],
  }));
  return [...versionChecks, ...countChecks];
}
