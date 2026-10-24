import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { networkStorageConfigureLine, scaffoldBackend } from "../src/index.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "create-sbox-ns-backend-"));
}

test("networkStorageConfigureLine emits the exact Configure call", () => {
  const line = networkStorageConfigureLine({
    projectId: "proj_abc",
    publicKey: "sbox_ns_pk_xyz",
    baseUrl: "https://ns.example.com",
  });
  assert.equal(line, 'NetworkStorage.Configure( "proj_abc", "sbox_ns_pk_xyz", "https://ns.example.com" );');
});

test("networkStorageConfigureLine rejects values that would break the Lua-style call", () => {
  assert.throws(() =>
    networkStorageConfigureLine({ projectId: 'proj"x', publicKey: "pk", baseUrl: "http://localhost:8080" }),
  );
  assert.throws(() => networkStorageConfigureLine({ projectId: "p", publicKey: "pk", baseUrl: "ftp://x" }));
});

test("scaffold writes a complete project and keeps the secret key out of the Configure line", () => {
  const dir = tempDir();
  try {
    const result = scaffoldBackend({ dir, projectId: "proj_test", publicKey: "sbox_ns_pk_test", secretKey: "sbox_ns_sk_test" });
    assert.equal(
      result.configureLine,
      'NetworkStorage.Configure( "proj_test", "sbox_ns_pk_test", "http://localhost:8080" );',
    );
    for (const required of [
      "package.json",
      "src/server.ts",
      "src/app.ts",
      "src/test/app.test.ts",
      "Dockerfile",
      "deploy/sbox-ns.service",
      "Editor/Network Storage/endpoints/add-score.endpoint.yml",
      "keys/signing-private.pem",
      ".env",
      "configure.txt",
    ]) {
      assert.ok(result.files.includes(required), "missing " + required);
    }

    const configure = readFileSync(join(dir, "configure.txt"), "utf8");
    assert.equal(configure.trim(), result.configureLine);
    assert.ok(!configure.includes("sbox_ns_sk_test"));
    assert.ok(!readFileSync(join(dir, "README.md"), "utf8").includes("sbox_ns_sk_test"));

    const env = readFileSync(join(dir, ".env"), "utf8");
    assert.ok(env.includes("SECRET_KEY=sbox_ns_sk_test"));
    assert.ok(env.includes("PUBLIC_KEY=sbox_ns_pk_test"));
    assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "keys/signing-private.pem")).mode & 0o777, 0o600);
    assert.ok(readFileSync(join(dir, "keys/signing-private.pem"), "utf8").startsWith("-----BEGIN PRIVATE KEY-----"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scaffold refuses a non-empty directory and leaves its files untouched", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "existing.txt"), "keep");
    assert.throws(() => scaffoldBackend({ dir }), /is not empty/);
    assert.equal(readFileSync(join(dir, "existing.txt"), "utf8"), "keep");
    assert.equal(existsSync(join(dir, "package.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scaffold rejects a public key in the secret slot and equal keys", () => {
  const dir = tempDir();
  try {
    assert.throws(() => scaffoldBackend({ dir, publicKey: "sbox_ns_sk_leaked" }), /secret key prefix/);
    assert.throws(() => scaffoldBackend({ dir, publicKey: "same", secretKey: "same" }), /must differ/);
    assert.throws(() => scaffoldBackend({ dir, port: 70000 }), /port must be/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
