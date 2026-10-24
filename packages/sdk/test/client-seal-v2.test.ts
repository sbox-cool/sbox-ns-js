import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { base64UrlDecode, utf8, utf8Decode } from "../src/util/bytes.js";
import { aesGcmKey, aesGcmOpen, importRsaPrivatePem } from "../src/protocol/crypto.js";
import { bindingJson, sealV2Response } from "../src/protocol/envelope-v2.js";
import { openV2Response, sealV2Request } from "../src/protocol/envelope-v2-client.js";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "network-storage", "encrypted-request-v2-vectors.json");

interface FixtureEnvelope {
  projectId: string;
  endpointSlug: string;
  steamId: string;
  keyId: string;
  nonce: string;
  iv: string;
  tag: string;
  encryptedPayload: string;
  [field: string]: string;
}

interface FixtureRequest {
  name: string;
  aesKey: string;
  envelope: FixtureEnvelope;
}

interface FixtureFile {
  projectId: string;
  endpointSlug: string;
  serverKey: { keyId: string; privateKeyPem: string };
  requests: FixtureRequest[];
}

const fixture: FixtureFile = JSON.parse(readFileSync(fixturePath, "utf8"));
const request = fixture.requests.find((entry) => entry.name === "valid-steam-request");
assert.ok(request, "valid-steam-request vector is present");

test("client seal reproduces the golden ciphertext and tag for the fixture request", async () => {
  const { publicJwk } = await importRsaPrivatePem(fixture.serverKey.privateKeyPem, "SHA-256");
  const env = request.envelope;
  const aesKeyRaw = base64UrlDecode(request.aesKey);
  const aes = await aesGcmKey(aesKeyRaw, ["decrypt"]);
  const plaintext = await aesGcmOpen(aes, base64UrlDecode(env.iv), base64UrlDecode(env.encryptedPayload), base64UrlDecode(env.tag), utf8(bindingJson(env)));
  const payload: Record<string, unknown> = JSON.parse(utf8Decode(plaintext));

  const sealed = await sealV2Request({
    projectId: env.projectId,
    endpointSlug: env.endpointSlug,
    identity: { type: "steam", value: env.steamId },
    keyId: env.keyId,
    publicJwk,
    nonce: env.nonce,
    payload,
    fixed: { aesKey: aesKeyRaw, iv: base64UrlDecode(env.iv) },
  });

  assert.equal(sealed.envelope.encryptedPayload, env.encryptedPayload);
  assert.equal(sealed.envelope.tag, env.tag);
  assert.equal(sealed.envelope.iv, env.iv);
  assert.equal(sealed.envelope.keyId, fixture.serverKey.keyId);
});

test("a response sealed by the server opens with the client", async () => {
  const { publicJwk } = await importRsaPrivatePem(fixture.serverKey.privateKeyPem, "SHA-256");
  const sealedReq = await sealV2Request({
    projectId: fixture.projectId,
    endpointSlug: fixture.endpointSlug,
    identity: { type: "session", value: "sess-1" },
    keyId: fixture.serverKey.keyId,
    publicJwk,
    nonce: "nonce-roundtrip-1",
    payload: { coins: 3 },
  });
  const body = { ok: true, coins: 3 };
  const sealedRes = await sealV2Response({ aes: sealedReq.aes, nonce: "nonce-roundtrip-1", keyId: fixture.serverKey.keyId }, body);
  const opened = await openV2Response(sealedReq.aes, { nonce: "nonce-roundtrip-1", keyId: fixture.serverKey.keyId }, sealedRes);
  assert.deepEqual(opened, body);
});
