import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createMemoryReplayStore } from "../src/protocol/index.js";
import { createNetworkStorageServer, type ServerOptions } from "../src/server/index.js";
import { createMemoryStorage } from "../src/storage/index.js";

// The golden v1 vectors: a steam envelope sealed for proj_golden_1 and set-coins under the vector api key. The library
// sends it nested under `envelope` beside `encrypted: true` and `security`, as the reference reads it.
const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "fixtures",
  "network-storage",
  "encrypted-request-vectors.json",
);
const vectors = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  apiKey: string;
  projectId: string;
  endpointSlug: string;
  steam: { envelope: Record<string, unknown> };
};

const SECRET = "encrypted-envelope-route-secret";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function serverOptions(): ServerOptions {
  return {
    projectId: vectors.projectId,
    publicKey: vectors.apiKey,
    secretKey: SECRET,
    ownerUserId: 1,
    settings: { enableAuthSessions: false, requireAuthSessions: false, encryptedRequestMode: "v1" },
    signingPrivateKeyPem: privateKey,
    sessionSecret: "encrypted-envelope-route-session-secret",
    endpoints: {},
    storage: (definition) => createMemoryStorage({ collections: definition.collections, values: definition.values }),
    parseYaml,
    stringifyYaml,
    fetchPolicy: { allowedHosts: [], resolveHost: async () => [] },
    replayStore: createMemoryReplayStore(),
  };
}

// A server with the golden endpoint published, as a project's manage route leaves it.
type TestServer = { fetch(request: Request): Promise<Response> };

async function appWithEndpoint(): Promise<TestServer> {
  const app = createNetworkStorageServer(serverOptions());
  const put = await app.fetch(
    new Request(`http://ns.test/v3/manage/${vectors.projectId}/endpoints`, {
      method: "PUT",
      headers: { "x-api-key": SECRET, "content-type": "application/json" },
      body: JSON.stringify([
        { sourceVersion: 1, kind: "endpoint", id: vectors.endpointSlug, method: "POST", steps: [], response: { status: 200, body: { ok: true } } },
      ]),
    }),
  );
  assert.equal(put.status, 200);
  return app;
}

function callRequest(envelope: Record<string, unknown>): Request {
  return new Request(`http://ns.test/v3/endpoints/${vectors.projectId}/${vectors.endpointSlug}`, {
    method: "POST",
    headers: { "x-public-key": vectors.apiKey, "content-type": "application/json" },
    body: JSON.stringify({ security: { clientMode: "encrypted" }, encrypted: true, envelope }),
  });
}

describe("encrypted calls carry the envelope nested under `envelope`", () => {
  it("opens the nested golden envelope and runs the endpoint", async () => {
    const app = await appWithEndpoint();
    const response = await app.fetch(callRequest(vectors.steam.envelope));
    const text = await response.text();
    assert.doesNotMatch(text, /REQUEST_SIGNATURE_INVALID/);
    assert.equal(response.status, 200, text);
  });

  it("refuses a nested envelope whose projectId is not this project", async () => {
    const app = await appWithEndpoint();
    const response = await app.fetch(callRequest({ ...vectors.steam.envelope, projectId: "proj_other" }));
    assert.match(await response.text(), /"code":"REQUEST_SIGNATURE_INVALID"/);
  });
});
