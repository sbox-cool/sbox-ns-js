import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { createSboxNsClient, isSboxNsError } from "../src/client/index.js";
import {
  compileModule,
  economy,
  inventory,
  installModules,
  isModuleError,
  leaderboards,
  progression,
  uninstallModules,
  withModules,
} from "../src/modules/index.js";
import { createMemoryReplayStore } from "../src/protocol/index.js";
import { createNetworkStorageServer, type ServerOptions } from "../src/server/index.js";
import { createMemoryStorage } from "../src/storage/index.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function serverOptions(): ServerOptions {
  return {
    projectId: "proj_modules",
    publicKey: "sbox_ns_pk_modules",
    secretKey: "sbox_ns_sk_modules",
    ownerUserId: 1,
    settings: { enableAuthSessions: false, requireAuthSessions: false, encryptedRequestMode: "off" },
    signingPrivateKeyPem: privateKey,
    sessionSecret: "modules-test-session-secret",
    endpoints: {},
    storage: (definition) => createMemoryStorage({ collections: definition.collections, values: definition.values }),
    fetchPolicy: { allowedHosts: [], resolveHost: async () => [] },
    replayStore: createMemoryReplayStore(),
  };
}

function clientFor(options: ServerOptions) {
  const server = createNetworkStorageServer(options);
  const secretKey = options.secretKey;
  assert.ok(secretKey, "test server options carry a secret key");
  return createSboxNsClient({
    baseUrl: "http://ns.test",
    projectId: options.projectId,
    secretKey,
    fetch: (url, init) => server.fetch(new Request(url, init)),
  });
}

test("every catalog module compiles, including inventory's owns-item expression", () => {
  for (const module of [economy, inventory, progression, leaderboards]) {
    assert.doesNotThrow(() => compileModule(module), module.id);
  }
});

test("a module with a bad version or foreign endpoint id is rejected as INVALID_MODULE", () => {
  assert.throws(() => compileModule({ ...economy, version: "1.0" }), (error: unknown) => {
    return isModuleError(error) && error.code === "INVALID_MODULE";
  });
  assert.throws(
    () => compileModule({ ...economy, endpoints: [{ ...economy.endpoints[0]!, id: "other_earn" }] }),
    (error: unknown) => isModuleError(error) && error.code === "INVALID_MODULE",
  );
});

test("withModules refuses the same module twice", () => {
  assert.throws(() => withModules(serverOptions(), [economy, economy]), (error: unknown) => {
    return isModuleError(error) && error.code === "MODULE_CONFLICT";
  });
});

test("a custom backend serves module queries once withModules wires them in", async () => {
  const options = withModules(serverOptions(), [leaderboards]);
  const client = clientFor(options);
  const top = await client.get<{ type: string; entries: unknown[] }>("leaderboards_top");
  assert.equal(top.type, "leaderboard");
  assert.deepEqual(top.entries, []);
});

test("installModules and uninstallModules are idempotent on a hosted project", async () => {
  const client = clientFor(serverOptions());

  const installed = await installModules(client, [leaderboards]);
  assert.equal(installed.modules[0]?.status, "installed");
  const unchanged = await installModules(client, [leaderboards]);
  assert.equal(unchanged.modules[0]?.status, "unchanged");

  const removed = await uninstallModules(client, [leaderboards]);
  assert.equal(removed.modules[0]?.status, "removed");
  const absent = await uninstallModules(client, [leaderboards]);
  assert.equal(absent.modules[0]?.status, "not-installed");
});

test("an installed module's query answers on the hosted project", async () => {
  const client = clientFor(serverOptions());
  await installModules(client, [leaderboards]);
  await assert.rejects(client.get("leaderboards_missing"), (error: unknown) => {
    return isSboxNsError(error) && error.status === 404;
  });
  const top = await client.queries.run<{ type: string }>("leaderboards_top");
  assert.equal(top.type, "leaderboard");
});
