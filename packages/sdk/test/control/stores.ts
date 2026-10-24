import { createRequire } from "node:module";
import { createPostgresControlStateStore, createSqliteControlStateStore } from "../../src/storage/index.js";
import type { ControlStateStore } from "../../src/storage/control.js";
import type { PgPool } from "../../src/storage/postgres.js";
import type { SqliteDatabase } from "../../src/storage/sqlite.js";

// Environment that names one control-state location. Child processes inherit it, so the restart test reopens the same
// location the parent wrote.
export type ControlEnv = Readonly<Record<string, string | undefined>>;

export interface OpenedStore {
  readonly store: ControlStateStore;
  close(): Promise<void>;
}

interface SqliteHandle extends SqliteDatabase {
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (file: string) => SqliteHandle;
}

interface PgHandle extends PgPool {
  end(): Promise<void>;
}

interface PgDriver {
  Pool: new (options: { connectionString: string; max: number; options: string }) => PgHandle;
}

function required(env: ControlEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") throw new Error(`${name} must be set for the control-state test`);
  return value;
}

// Opens the store named by env. NS_CONTROL_BACKEND selects the backend: "sqlite" reads NS_CONTROL_SQLITE_FILE;
// "postgres" reads NS_CONTROL_PG_URL, NS_CONTROL_PG_DRIVER (the directory holding the pg package), and
// NS_CONTROL_PG_SCHEMA, which must already exist.
export async function openStore(env: ControlEnv): Promise<OpenedStore> {
  if (required(env, "NS_CONTROL_BACKEND") === "postgres") return openPostgresStore(env);
  return openSqliteStore(required(env, "NS_CONTROL_SQLITE_FILE"));
}

function openSqliteStore(file: string): OpenedStore {
  const sqlite: SqliteModule = createRequire(import.meta.url)("node:sqlite");
  const db = new sqlite.DatabaseSync(file);
  return {
    store: createSqliteControlStateStore({ db }),
    close: async () => db.close(),
  };
}

function openPostgresStore(env: ControlEnv): OpenedStore {
  const driver: PgDriver = createRequire(import.meta.url)(required(env, "NS_CONTROL_PG_DRIVER"));
  const pool = new driver.Pool({
    connectionString: required(env, "NS_CONTROL_PG_URL"),
    max: 2,
    options: `-c search_path=${required(env, "NS_CONTROL_PG_SCHEMA")}`,
  });
  return {
    store: createPostgresControlStateStore({ pool }),
    close: () => pool.end(),
  };
}
