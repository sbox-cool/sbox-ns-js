import { createServer, type Server } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { nodeHandler } from "../../src/adapters/node.js";
import { createPostgresStorage, createSqliteStorage, type EndpointStorage, type PgPool, type SqliteDatabase } from "../../src/storage/index.js";
import { createMemoryReplayStore } from "../../src/protocol/replay.js";
import { createNetworkStorageServer, type ServerOptions } from "../../src/server/index.js";
import type { StorageDefinition } from "../../src/server/options.js";

// node:sqlite is loaded with createRequire and a typed shape: the installed @types/node does not declare it.
interface NodeSqlite {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

const { DatabaseSync }: NodeSqlite = createRequire(import.meta.url)("node:sqlite");

// The project the parity corpus runs against. The corpus templates these values, so any fixed set works.
export const PARITY_PROJECT = {
  projectId: "parity-project",
  publicKey: "pk_parity_public_0123456789",
  secretKey: "sk_parity_secret_0123456789",
} as const;

export type ParityStorage = "sqlite" | "postgres";

// Storage provider selection for the harness. PARITY_STORAGE=postgres needs PARITY_POSTGRES_URL (a database the
// run may write to) and PARITY_PG_DRIVER (the directory of an installed node-postgres `pg` package; the SDK has no
// driver dependency of its own).
export interface ParityStorageConfig {
  storage: ParityStorage;
  postgresUrl?: string;
  pgDriverDir?: string;
}

export function parityStorageFromEnv(env: NodeJS.ProcessEnv): ParityStorageConfig {
  const storage = env["PARITY_STORAGE"] ?? "sqlite";
  if (storage === "sqlite") return { storage };
  if (storage !== "postgres") throw new Error(`PARITY_STORAGE must be sqlite or postgres, got ${storage}`);
  const postgresUrl = env["PARITY_POSTGRES_URL"];
  const pgDriverDir = env["PARITY_PG_DRIVER"];
  if (!postgresUrl || !pgDriverDir) throw new Error("PARITY_STORAGE=postgres requires PARITY_POSTGRES_URL and PARITY_PG_DRIVER");
  return { storage, postgresUrl, pgDriverDir };
}

// The storage factory is called again whenever management sync changes the catalog, so each provider reopens its
// single backing store: one SQLite handle, or one connection pool.
function storageFactory(config: ParityStorageConfig): (definition: StorageDefinition) => EndpointStorage {
  if (config.storage === "postgres") {
    const loaded: { Pool: new (options: { connectionString: string; max: number }) => PgPool } =
      createRequire(import.meta.url)(config.pgDriverDir!);
    const pool = new loaded.Pool({ connectionString: config.postgresUrl!, max: 4 });
    return (definition) => createPostgresStorage({ pool, collections: definition.collections, values: definition.values });
  }
  const db = new DatabaseSync(":memory:");
  return (definition) => createSqliteStorage({ db, collections: definition.collections, values: definition.values });
}

// Builds the reference backend's options. The storage factory reopens one shared backing store, so catalog
// rebuilds from management sync keep the records already written.
export function referenceOptions(config: ParityStorageConfig = { storage: "sqlite" }): ServerOptions {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signingPrivateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    projectId: PARITY_PROJECT.projectId,
    publicKey: PARITY_PROJECT.publicKey,
    secretKey: PARITY_PROJECT.secretKey,
    ownerUserId: 1,
    settings: { enableAuthSessions: false, requireAuthSessions: false, encryptedRequestMode: "off" },
    signingPrivateKeyPem,
    sessionSecret: null,
    endpoints: {},
    storage: storageFactory(config),
    parseYaml,
    stringifyYaml,
    fetchPolicy: { allowedHosts: [], resolveHost: async () => [] },
    replayStore: createMemoryReplayStore(),
  };
}

// Starts the reference backend on a local port and resolves once it is listening.
export function startReferenceBackend(port: number, config?: ParityStorageConfig, host = "127.0.0.1"): Promise<Server> {
  const server = createServer(nodeHandler(createNetworkStorageServer(referenceOptions(config))));
  let resolve!: (server: Server) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Server>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  server.once("error", reject);
  server.listen(port, host, () => resolve(server));
  return promise;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env["PARITY_PORT"] ?? 8787);
  const config = parityStorageFromEnv(process.env);
  await startReferenceBackend(port, config);
  console.log(`reference backend (${config.storage}) listening on http://127.0.0.1:${port}`);
}
