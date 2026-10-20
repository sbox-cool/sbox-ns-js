import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { base64UrlDecode, base64UrlEncode } from "../src/util/bytes.js";
import { importRsaPrivatePem, loadRequestKeyRing, rsaSpkiFingerprint, type LoadedRequestKey } from "../src/protocol/crypto.js";
import { openV2Envelope, sealV2Response, type V2ResponseKey } from "../src/protocol/envelope-v2.js";
import { openV1Envelope } from "../src/protocol/envelope-v1.js";
import { ProtocolError } from "../src/protocol/errors.js";

// Compiled tests run from dist-test/test; fixtures stay in the package source tree at test/fixtures.
const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures");
const fixtureDir = join(fixtureRoot, "network-storage");

interface V2Request {
  name: string;
  keyRole: string;
  aesKey: string;
  envelope: Record<string, unknown>;
  expect: { ok: boolean; requestId?: string; identityKey?: string; payload?: Record<string, unknown> };
}

interface V2Vectors {
  projectId: string;
  endpointSlug: string;
  serverKey: { keyId: string; fingerprint: string; privateKeyPem: string };
  wrongKey: { privateKeyPem: string };
  requests: V2Request[];
  responses: { name: string; nonce: string; keyId: string; aesKey: string; sealed: { iv: string; tag: string; payload: string; encrypted: true; v: 2 } }[];
}

interface V1Vectors {
  apiKey: string;
  projectId: string;
  endpointSlug: string;
  steam: { steamId: string; expectedCoins: number; envelope: Record<string, unknown> };
  session: { sessionId: string; token: string; expectedCoins: number; envelope: Record<string, unknown> };
}

const v2 = JSON.parse(readFileSync(join(fixtureDir, "encrypted-request-v2-vectors.json"), "utf8")) as V2Vectors;
const v1 = JSON.parse(readFileSync(join(fixtureDir, "encrypted-request-vectors.json"), "utf8")) as V1Vectors;

async function serverKey(): Promise<LoadedRequestKey> {
  const ring = await loadRequestKeyRing({
    currentKeyId: v2.serverKey.keyId,
    keys: [{ keyId: v2.serverKey.keyId, privateKeyPem: v2.serverKey.privateKeyPem, createdAt: "2026-01-01T00:00:00Z" }],
  });
  const key = ring.keys[0]!;
  assert.equal(key.fingerprint, v2.serverKey.fingerprint, "fixture fingerprint matches its key");
  return key;
}

async function wrongServerKey(): Promise<LoadedRequestKey> {
  const wrong = await importRsaPrivatePem(v2.wrongKey.privateKeyPem, "SHA-256");
  return {
    keyId: v2.serverKey.keyId,
    fingerprint: await rsaSpkiFingerprint(wrong.publicJwk),
    publicJwk: wrong.publicJwk,
    modulusBytes: wrong.modulusBytes,
    privateKey: wrong.privateKey,
    createdAt: "2026-01-01T00:00:00Z",
    retiredAt: null,
    graceUntil: null,
  };
}

test("v2 fixture: valid steam request decrypts to the expected payload and identity", async () => {
  const key = await serverKey();
  const request = v2.requests.find((r) => r.name === "valid-steam-request")!;
  const opened = await openV2Envelope({
    raw: request.envelope,
    projectId: v2.projectId,
    endpointSlug: v2.endpointSlug,
    key,
    steamId: String(request.envelope.steamId),
    sessionId: null,
  });
  assert.equal(opened.responseKey.nonce, request.envelope.nonce);
  assert.equal(opened.responseKey.keyId, request.envelope.keyId);
  assert.equal(opened.requestId, request.expect.requestId);
  assert.equal(opened.identityKey, request.expect.identityKey);
  assert.deepEqual(opened.payload, request.expect.payload);
});

test("v2 fixture: every request either opens or refuses exactly as the fixture says", async () => {
  const server = await serverKey();
  const wrong = await wrongServerKey();
  for (const request of v2.requests) {
    const raw = request.envelope;
    const key = request.keyRole === "wrong" ? wrong : server;
    const steamId = typeof raw.steamId === "string" ? raw.steamId : null;
    const attempt = openV2Envelope({ raw, projectId: v2.projectId, endpointSlug: v2.endpointSlug, key, steamId, sessionId: null });
    if (!request.expect.ok) {
      await assert.rejects(attempt, (error: unknown) => error instanceof ProtocolError, request.name);
    } else {
      await attempt;
    }
  }
});

test("v2 fixture: response seal reproduces the golden bytes with the fixed IV", async () => {
  for (const expected of v2.responses) {
    const aes = await crypto.subtle.importKey("raw", base64UrlDecode(expected.aesKey), "AES-GCM", false, ["encrypt"]);
    const responseKey: V2ResponseKey = { aes, nonce: expected.nonce, keyId: expected.keyId };
    const body = { ok: true, coins: 1337, items: ["sword", "shield"] };
    const iv = base64UrlDecode(expected.sealed.iv);
    const sealed = await sealV2Response(responseKey, body, iv);
    assert.deepEqual(sealed, expected.sealed);
  }
});

test("v2 fixture: envelope presented to the wrong RSA key is refused", async () => {
  const request = v2.requests.find((r) => r.name === "valid-steam-request")!;
  await assert.rejects(
    openV2Envelope({
      raw: request.envelope,
      projectId: v2.projectId,
      endpointSlug: v2.endpointSlug,
      key: await wrongServerKey(),
      steamId: String(request.envelope.steamId),
      sessionId: null,
    }),
    ProtocolError,
  );
});

test("v1 fixture: steam envelope opens with the public api key and yields the expected coins", async () => {
  const opened = await openV1Envelope({
    raw: v1.steam.envelope,
    apiKey: v1.apiKey,
    projectId: v1.projectId,
    endpointSlug: v1.endpointSlug,
    steamId: v1.steam.steamId,
    sessionId: null,
  });
  assert.equal(opened.payload.coins, v1.steam.expectedCoins);
});

test("v1 fixture: session envelope opens with the session id bound", async () => {
  const opened = await openV1Envelope({
    raw: v1.session.envelope,
    apiKey: v1.apiKey,
    projectId: v1.projectId,
    endpointSlug: v1.endpointSlug,
    steamId: null,
    sessionId: v1.session.sessionId,
  });
  assert.equal(opened.payload.coins, v1.session.expectedCoins);
});

test("v1 fixture: a different steam id is refused by the identity binding", async () => {
  await assert.rejects(
    openV1Envelope({
      raw: v1.steam.envelope,
      apiKey: v1.apiKey,
      projectId: v1.projectId,
      endpointSlug: v1.endpointSlug,
      steamId: "76561190000000000",
      sessionId: null,
    }),
    ProtocolError,
  );
});
