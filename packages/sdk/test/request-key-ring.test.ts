import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ensureRequestKeyRing } from "../src/node/index.js";

interface StoredRing {
  schemaVersion: number;
  currentKeyId: string;
  keys: { keyId: string; createdAt: string; privateKeyPem: string }[];
}

describe("ensureRequestKeyRing", () => {
  it("creates the reference file format once, owner-only, and reloads the same ring", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sbox-ns-ring-"));
    try {
      const file = join(dir, "nested", "request_encryption_keys.json");
      const first = await ensureRequestKeyRing(file, new Date("2026-01-02T03:04:05.000Z"));
      const text = readFileSync(file, "utf8");
      const stored = JSON.parse(text) as StoredRing;

      assert.equal(stored.schemaVersion, 1);
      assert.equal(stored.currentKeyId, first.currentKeyId);
      assert.equal(stored.keys[0]?.keyId, first.currentKeyId);
      assert.equal(stored.keys[0]?.createdAt, "2026-01-02T03:04:05.000Z");
      assert.ok(stored.keys[0]?.privateKeyPem.startsWith("-----BEGIN PRIVATE KEY-----"));
      // The reference derives keyId from the SHA-256 fingerprint of the SPKI DER: the first 32 hex characters.
      const fingerprint = first.keys[0]?.fingerprint ?? "";
      assert.equal(fingerprint.length, 64);
      assert.equal(stored.currentKeyId, fingerprint.slice(0, 32));
      if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);

      const second = await ensureRequestKeyRing(file);
      assert.equal(second.currentKeyId, first.currentKeyId);
      assert.equal(readFileSync(file, "utf8"), text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
