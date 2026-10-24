// Durable control state over a real PostgreSQL server through node-postgres (`pg`). Like storage-postgres.test.ts, the
// SDK has no driver dependency, so `pg` is loaded from NS_TEST_PG_DRIVER (the directory of an installed pg package).
// Requires NS_TEST_POSTGRES_URL: a server where the test may create and drop schemas.
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import type { ControlEnv } from "./control/stores.js";
import { type ControlBackend, runControlSuite } from "./control/suite.js";

const connectionString = process.env.NS_TEST_POSTGRES_URL ?? "";
const driverDir = process.env.NS_TEST_PG_DRIVER ?? "";
const skip = connectionString !== "" && driverDir !== "" ? false : "NS_TEST_POSTGRES_URL and NS_TEST_PG_DRIVER are not set";

interface AdminPool {
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}
interface PoolConstructor {
  new (options: { connectionString: string; max: number }): AdminPool;
}

let admin: AdminPool | undefined;
const schemas: string[] = [];

function adminPool(): AdminPool {
  if (admin === undefined) {
    const loaded: { Pool: PoolConstructor } = createRequire(import.meta.url)(driverDir);
    admin = new loaded.Pool({ connectionString, max: 1 });
  }
  return admin;
}

const postgres: ControlBackend = {
  label: "postgres",
  skip,
  newLocation: async (): Promise<ControlEnv> => {
    const schema = `ctl_${randomBytes(6).toString("hex")}`;
    await adminPool().query(`CREATE SCHEMA ${schema}`);
    schemas.push(schema);
    return {
      NS_CONTROL_BACKEND: "postgres",
      NS_CONTROL_PG_URL: connectionString,
      NS_CONTROL_PG_DRIVER: driverDir,
      NS_CONTROL_PG_SCHEMA: schema,
    };
  },
  cleanup: async () => {
    for (const schema of schemas) await adminPool().query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    if (admin !== undefined) await admin.end();
  },
};

runControlSuite(postgres);
