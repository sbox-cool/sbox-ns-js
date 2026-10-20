import { createServer, type Server } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { parse as parseYaml } from "yaml";
import { nodeHandler } from "../../src/adapters/node.js";
import { createSqliteStorage } from "../../src/storage/sqlite.js";
import { createMemoryReplayStore } from "../../src/protocol/replay.js";
import { createNetworkStorageServer, type ServerOptions } from "../../src/server/index.js";

// The project the parity corpus runs against. The corpus templates these values, so any fixed set works.
export const PARITY_PROJECT = {
  projectId: "parity-project",
  publicKey: "pk_parity_public_0123456789",
  secretKey: "sk_parity_secret_0123456789",
} as const;

// Builds the reference backend's options. The storage factory reopens one shared SQLite handle, so catalog
// rebuilds from management sync keep the records already written.
export function referenceOptions(): ServerOptions {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signingPrivateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const db = new DatabaseSync(":memory:");
  return {
    projectId: PARITY_PROJECT.projectId,
    publicKey: PARITY_PROJECT.publicKey,
    secretKey: PARITY_PROJECT.secretKey,
    ownerUserId: 1,
    settings: { enableAuthSessions: false, requireAuthSessions: false, encryptedRequestMode: "off" },
    signingPrivateKeyPem,
    sessionSecret: null,
    endpoints: {},
    storage: (definition) =>
      createSqliteStorage({ db, collections: definition.collections, values: definition.values as Record<string, unknown> }),
    parseYaml,
    fetchPolicy: { allowedHosts: [], resolveHost: async () => [] },
    replayStore: createMemoryReplayStore(),
  };
}

// Starts the reference backend on a local port and resolves once it is listening.
export function startReferenceBackend(port: number, host = "127.0.0.1"): Promise<Server> {
  const server = createServer(nodeHandler(createNetworkStorageServer(referenceOptions())));
  const { promise, resolve, reject } = Promise.withResolvers<Server>();
  server.once("error", reject);
  server.listen(port, host, () => resolve(server));
  return promise;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env["PARITY_PORT"] ?? 8787);
  await startReferenceBackend(port);
  console.log(`reference backend listening on http://127.0.0.1:${port}`);
}
