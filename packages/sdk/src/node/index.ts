import { generateKeyPairSync } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { lookup } from "node:dns/promises";
import { importRsaPrivatePem, loadRequestKeyRing, rsaSpkiFingerprint, type RequestKeyRing, type RequestKeyRingFile } from "../protocol/crypto.js";
import type { FetchPolicy } from "../endpoint/fetch.js";

// Resolves a host with the operating system resolver, every address the name maps to, IPv4 and IPv6.
export async function nodeResolveHost(host: string): Promise<readonly string[]> {
  const records = await lookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

// The fetch policy for Node: the allow-listed hosts plus the system resolver. Requests check every resolved
// address before connecting, but the connection itself is made by Node's fetch, so a DNS change between that check
// and the connect is not pinned. The README documents this limit.
export function nodeFetchPolicy(allowedHosts: readonly string[]): FetchPolicy {
  return { allowedHosts, resolveHost: nodeResolveHost };
}

export { nodeHandler } from "../adapters/node.js";

// Loads the request key ring at `file`, or creates it on first start, as the reference server does. The file holds
// RSA 2048 private keys, is written owner-only, and is never overwritten. Its format matches the reference's
// request_encryption_keys.json, so either server reads the other's file. Keep the file on persistent storage: losing
// it makes clients re-fetch the signed config for a new key.
export async function ensureRequestKeyRing(file: string, now: Date = new Date()): Promise<RequestKeyRing> {
  const existing = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing !== undefined) return loadRequestKeyRing(JSON.parse(existing) as RequestKeyRingFile);

  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const { publicJwk } = await importRsaPrivatePem(privateKey, "SHA-256");
  const keyId = (await rsaSpkiFingerprint(publicJwk)).slice(0, 32);
  const text = JSON.stringify(
    { schemaVersion: 1, currentKeyId: keyId, keys: [{ keyId, createdAt: now.toISOString(), privateKeyPem: privateKey }] },
    null,
    2,
  ) + "\n";
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${String(process.pid)}.tmp`;
  await writeFile(temp, text, { mode: 0o600 });
  try {
    // link fails with EEXIST when another start created the file first; that file is then the one to load.
    await link(temp, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await unlink(temp);
  }
  return ensureRequestKeyRing(file, now);
}
