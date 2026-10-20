// Runs the shared conformance suite against a real PostgreSQL server through node-postgres (`pg`).
// The SDK has zero driver dependencies, so the test loads `pg` from NS_TEST_PG_DRIVER (the directory of an
// installed pg package). Requires NS_TEST_POSTGRES_URL: a server where the test may create and drop schemas.
import { createRequire } from "node:module";
import { after } from "node:test";
import { createPostgresStorage, type EndpointStorage, type PgPool, type PostgresStorageOptions } from "../src/storage/index.js";
import { runConformance, type StorageConfig } from "./storage/conformance.js";

const connectionString = process.env.NS_TEST_POSTGRES_URL ?? "";
const driverDir = process.env.NS_TEST_PG_DRIVER ?? "";
const skip = connectionString !== "" && driverDir !== ""
  ? undefined
  : "NS_TEST_POSTGRES_URL and NS_TEST_PG_DRIVER are not set";

interface PoolOptions {
  connectionString: string;
  options?: string;
  max?: number;
}
type PgPoolInstance = PgPool & { end(): Promise<void> };
type PoolConstructor = new (options: PoolOptions) => PgPoolInstance;

let PoolCtor: PoolConstructor | undefined;
let admin: PgPoolInstance | undefined;
const pools: PgPoolInstance[] = [];
const schemas: string[] = [];

function poolConstructor(): PoolConstructor {
  if (PoolCtor === undefined) {
    const loaded: { Pool: PoolConstructor } = createRequire(import.meta.url)(driverDir);
    PoolCtor = loaded.Pool;
  }
  return PoolCtor;
}

function adminPool(): PgPoolInstance {
  if (admin === undefined) admin = new (poolConstructor())({ connectionString, max: 1 });
  return admin;
}

// Each open() gets its own schema, so tests cannot see each other's rows and reopening a store name reaches
// the same committed data.
async function open(config: StorageConfig, store: string): Promise<EndpointStorage> {
  const schema = store.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  if (!schemas.includes(schema)) {
    await adminPool().query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    schemas.push(schema);
  }
  const pool = new (poolConstructor())({ connectionString, options: `-c search_path=${schema}`, max: 4 });
  pools.push(pool);
  const options: PostgresStorageOptions = { ...config, pool };
  return createPostgresStorage(options);
}

after(async () => {
  for (const schema of schemas) await adminPool().query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  for (const pool of pools) await pool.end();
  if (admin !== undefined) await admin.end();
});

runConformance({ name: "postgres", persistent: true, skip, open });
