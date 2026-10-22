import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { loadRequestKeyRing, type RequestKeyRing } from "../src/protocol/crypto.js";
import { createMemoryReplayStore } from "../src/protocol/index.js";
import { createNetworkStorageServer, type ServerOptions } from "../src/server/index.js";
import { createMemoryStorage } from "../src/storage/index.js";

const PROJECT = "proj-settings";
const PUBLIC = "public-settings";
const SECRET = "secret-settings";

type Body = Record<string, unknown>;
type TestServer = { fetch(request: Request): Promise<Response> };

function rsaPem(): string {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).privateKey;
}

function serverOptions(requestKeys?: RequestKeyRing): ServerOptions {
  return {
    projectId: PROJECT,
    publicKey: PUBLIC,
    secretKey: SECRET,
    ownerUserId: 1,
    settings: { enableAuthSessions: false, requireAuthSessions: false, encryptedRequestMode: "off" },
    signingPrivateKeyPem: rsaPem(),
    requestKeys,
    sessionSecret: "management-settings-test-session-secret",
    endpoints: {},
    storage: (definition) => createMemoryStorage({ collections: definition.collections, values: definition.values }),
    parseYaml,
    stringifyYaml,
    fetchPolicy: { allowedHosts: [], resolveHost: async () => [] },
    replayStore: createMemoryReplayStore(),
  };
}

function settingsRequest(body: string | null, withSecret = true): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (withSecret) headers["x-api-key"] = SECRET;
  return new Request(`http://ns.test/v3/manage/${PROJECT}/settings`, {
    method: "PUT",
    headers,
    body: body ?? undefined,
  });
}

async function readBody(response: Response): Promise<Body> {
  return (await response.json()) as Body;
}

async function currentSettings(app: TestServer): Promise<Body> {
  const response = await app.fetch(
    new Request(`http://ns.test/v3/manage/${PROJECT}/settings`, { headers: { "x-api-key": SECRET } }),
  );
  assert.equal(response.status, 200);
  return (await readBody(response))["settings"] as Body;
}

async function signedConfig(app: TestServer): Promise<Body> {
  const response = await app.fetch(new Request(`http://ns.test/v3/security-config/${PROJECT}`));
  assert.equal(response.status, 200);
  return (await readBody(response))["config"] as Body;
}

describe("PUT /v3/manage/{project}/settings, as the reference answers it", () => {
  it("refuses a call without the secret key", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const response = await app.fetch(settingsRequest("{}", false));
    assert.equal(response.status, 401);
  });

  it("answers an empty body and a non-object body with VALIDATION_FAILED", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const empty = await app.fetch(settingsRequest(""));
    assert.equal(empty.status, 400);
    assert.deepEqual(await readBody(empty), {
      ok: false,
      resourceKind: "project-settings",
      error: { code: "VALIDATION_FAILED", message: "Request body is empty." },
    });

    const array = await app.fetch(settingsRequest("[1]"));
    assert.equal(array.status, 400);
    assert.deepEqual(await readBody(array), {
      ok: false,
      resourceKind: "project-settings",
      error: { code: "VALIDATION_FAILED", message: "Body must be a project settings object." },
    });
  });

  it("names a setting this server does not store, and refuses it with SETTING_NOT_STORED", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const backend = await app.fetch(settingsRequest(JSON.stringify({ spacetimeBackendMode: "x" })));
    assert.equal(backend.status, 400);
    assert.deepEqual(await readBody(backend), {
      ok: false,
      error: "SETTING_NOT_STORED",
      message: "'spacetimeBackendMode' is not a setting this server stores.",
    });

    const enabled = await app.fetch(settingsRequest(JSON.stringify({ enabled: false })));
    assert.equal(enabled.status, 400);
    assert.match(String((await readBody(enabled))["message"]), /'enabled' is not a setting/);
  });

  it("accepts a GET view written back unchanged", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const view = await currentSettings(app);
    const response = await app.fetch(settingsRequest(JSON.stringify(view)));
    assert.equal(response.status, 200);
    assert.equal((await readBody(response))["projectId"], PROJECT);
  });

  it("rejects an unknown encryptedRequestMode as the reference does", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const response = await app.fetch(settingsRequest(JSON.stringify({ encryptedRequestMode: "v3" })));
    assert.equal(response.status, 400);
    assert.deepEqual(await readBody(response), {
      ok: false,
      error: "VALIDATION_FAILED",
      message: "encryptedRequestMode must be off, v1, v2-preferred, or v2-required.",
    });
  });

  it("refuses a v2 mode while no request key is configured", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const response = await app.fetch(settingsRequest(JSON.stringify({ encryptedRequestMode: "v2-preferred" })));
    assert.equal(response.status, 400);
    assert.match(String((await readBody(response))["message"]), /needs a request key configured/);
    assert.equal((await currentSettings(app))["encryptedRequestMode"], undefined);
  });

  it("switches plain and encrypted requests, and the signed config follows at once", async () => {
    const app = createNetworkStorageServer(serverOptions());
    assert.equal(((await signedConfig(app))["modes"] as Body)["encryptedRequests"], "disabled");

    const on = await app.fetch(settingsRequest(JSON.stringify({ enableEncryptedRequests: true })));
    assert.equal(on.status, 200);
    assert.equal((await readBody(on))["enableEncryptedRequests"], true);
    const enabled = await signedConfig(app);
    assert.equal((enabled["modes"] as Body)["encryptedRequests"], "required");
    assert.equal((enabled["settings"] as Body)["enableEncryptedRequests"], true);

    const off = await app.fetch(settingsRequest(JSON.stringify({ encryptedRequestMode: "off" })));
    assert.equal(off.status, 200);
    assert.equal(((await signedConfig(app))["modes"] as Body)["encryptedRequests"], "disabled");
  });

  it("carries the request key in the signed config for a v2 mode", async () => {
    const privateKeyPem = rsaPem();
    const ring = await loadRequestKeyRing({
      currentKeyId: "k1",
      keys: [{ keyId: "k1", createdAt: "2026-01-01T00:00:00Z", privateKeyPem }],
    });
    const app = createNetworkStorageServer(serverOptions(ring));
    const response = await app.fetch(settingsRequest(JSON.stringify({ encryptedRequestMode: "v2-required" })));
    assert.equal(response.status, 200);
    assert.equal((await readBody(response))["enableEncryptedRequests"], true);
    const config = await signedConfig(app);
    assert.equal((config["encryption"] as Body)["keyId"], "k1");
    assert.equal((config["encryption"] as Body)["required"], true);
  });

  it("clamps the session TTL and replay window as the reference does", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const low = await app.fetch(
      settingsRequest(JSON.stringify({ authSessionTtlSeconds: "30", encryptedRequestWindowSeconds: 9999 })),
    );
    assert.equal(low.status, 200);
    const clamped = await currentSettings(app);
    assert.equal(clamped["authSessionTtlSeconds"], 60);
    assert.equal(clamped["encryptedRequestWindowSeconds"], 600);

    const unparsed = await app.fetch(settingsRequest(JSON.stringify({ authSessionTtlSeconds: "abc" })));
    assert.equal(unparsed.status, 200);
    assert.equal((await currentSettings(app))["authSessionTtlSeconds"], 3600);
  });

  it("stores the auth-session and require-sbox-auth flags", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const response = await app.fetch(
      settingsRequest(JSON.stringify({ enableAuthSessions: true, requireSboxAuth: true })),
    );
    assert.equal(response.status, 200);
    const view = await currentSettings(app);
    assert.equal(view["enableAuthSessions"], true);
    assert.equal(view["requireSboxAuth"], true);
  });
});
