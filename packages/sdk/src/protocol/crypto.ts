import { base64UrlDecode, base64UrlEncode, concatBytes, hexEncode, utf8 } from "../util/bytes.js";
import { ProtocolError } from "./errors.js";
import type { Bytes } from "../util/bytes.js";

const subtle = globalThis.crypto.subtle;


function toBytes(view: ArrayBufferView): Bytes {
  const copy = new Uint8Array(view.byteLength);
  copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return copy;
}

export async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await subtle.digest("SHA-256", data));
}

export async function sha256Hex(text: string): Promise<string> {
  return hexEncode(await sha256(utf8(text)));
}

export async function hmacSha256(key: Bytes, data: Bytes): Promise<Bytes> {
  const cryptoKey = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", cryptoKey, data));
}

/** AES-256-GCM key from raw 32-byte material. Keys are created per request, never cached globally. */
export async function aesGcmKey(raw: Bytes, usages: KeyUsage[]): Promise<CryptoKey> {
  if (raw.length !== 32) throw new ProtocolError(401, "REQUEST_SIGNATURE_INVALID", "Encrypted request payload could not be decrypted.");
  return subtle.importKey("raw", raw, { name: "AES-GCM" }, false, usages);
}

/** Decrypts `ciphertext || tag` (the WebCrypto layout) with a separate 16-byte tag. Throws on authentication failure. */
export async function aesGcmOpen(key: CryptoKey, iv: Bytes, ciphertext: Bytes, tag: Bytes, aad: Bytes): Promise<Bytes> {
  const sealed = concatBytes(ciphertext, tag);
  return toBytes(new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key, sealed)));
}

export async function aesGcmSeal(key: CryptoKey, iv: Bytes, plaintext: Bytes, aad: Bytes): Promise<{ ciphertext: Bytes; tag: Bytes }> {
  const sealed = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key, plaintext));
  const split = sealed.length - 16;
  return { ciphertext: toBytes(sealed.subarray(0, split)), tag: toBytes(sealed.subarray(split)) };
}

/** Standard RSA-OAEP key shape for a loaded request key. The private JWK gives us the public modulus and exponent. */
export interface RsaPublicJwk {
  kty: "RSA";
  n: string;
  e: string;
}

export interface LoadedRequestKey {
  keyId: string;
  /** hex SHA-256 of the SPKI DER of the public half. Clients pin this value. */
  fingerprint: string;
  publicJwk: RsaPublicJwk;
  modulusBytes: number;
  privateKey: CryptoKey;
  createdAt: string;
  retiredAt: string | null;
  graceUntil: string | null;
}

export interface RequestKeyRing {
  currentKeyId: string;
  keys: readonly LoadedRequestKey[];
}

export interface RequestKeyRingFile {
  currentKeyId: string;
  keys: readonly {
    keyId: string;
    createdAt: string;
    retiredAt?: string | null;
    graceUntil?: string | null;
    /** PKCS#8 PEM, RSA 2048 or 3072. Kept in the platform secret store, never in source. */
    privateKeyPem: string;
  }[];
}

function pemToDer(pem: string): Bytes {
  const body = pem.replace(/-----(BEGIN|END) [^-]+-----/g, "").replace(/\s+/g, "");
  return toBytes(Uint8Array.from(atob(body), (char) => char.charCodeAt(0)));
}

/** Imports a PKCS#8 RSA private key. The key is extractable only so its public JWK can be derived. */
export async function importRsaPrivatePem(pem: string, hash: "SHA-256"): Promise<{ privateKey: CryptoKey; publicJwk: RsaPublicJwk; modulusBytes: number }> {
  const der = pemToDer(pem);
  const privateKey = await subtle.importKey("pkcs8", der, { name: "RSA-OAEP", hash }, true, ["decrypt"]);
  const jwk = await subtle.exportKey("jwk", privateKey);
  if (jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") {
    throw new Error("request key is not an RSA key");
  }
  const modulus = base64UrlDecode(jwk.n);
  const modulusBytes = modulus[0] === 0 ? modulus.length - 1 : modulus.length;
  return { privateKey, publicJwk: { kty: "RSA", n: jwk.n, e: jwk.e }, modulusBytes };
}

/** SubjectPublicKeyInfo DER of an RSA public JWK. The fingerprint and the PEM both derive from it. */
export async function rsaSpkiDer(publicJwk: RsaPublicJwk): Promise<Bytes> {
  const key = await subtle.importKey("jwk", { ...publicJwk, alg: "RSA-OAEP-256", ext: true }, { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]);
  return toBytes(new Uint8Array(await subtle.exportKey("spki", key)));
}

export async function rsaSpkiFingerprint(publicJwk: RsaPublicJwk): Promise<string> {
  return hexEncode(await sha256(await rsaSpkiDer(publicJwk)));
}

/** PEM for SPKI DER with 64-character base64 lines, as .NET's `ExportSubjectPublicKeyInfoPem` writes them. */
export function spkiPem(der: Bytes): string {
  const lines = btoa(String.fromCharCode(...der)).match(/.{1,64}/g) ?? [];
  return ["-----BEGIN PUBLIC KEY-----", ...lines, "-----END PUBLIC KEY-----", ""].join("\n");
}

export async function loadRequestKeyRing(file: RequestKeyRingFile): Promise<RequestKeyRing> {
  const keys: LoadedRequestKey[] = [];
  for (const entry of file.keys) {
    const imported = await importRsaPrivatePem(entry.privateKeyPem, "SHA-256");
    keys.push({
      keyId: entry.keyId,
      fingerprint: await rsaSpkiFingerprint(imported.publicJwk),
      publicJwk: imported.publicJwk,
      modulusBytes: imported.modulusBytes,
      privateKey: imported.privateKey,
      createdAt: entry.createdAt,
      retiredAt: entry.retiredAt ?? null,
      graceUntil: entry.graceUntil ?? null,
    });
  }
  if (!keys.some((key) => key.keyId === file.currentKeyId)) {
    throw new Error("currentKeyId is not present in the key ring");
  }
  return { currentKeyId: file.currentKeyId, keys };
}

/** RSA-OAEP(SHA-256) wrap of an AES key for a published request key. Used by clients and tests. */
export async function rsaOaepWrap(publicJwk: RsaPublicJwk, aesKeyRaw: Bytes): Promise<Bytes> {
  const key = await subtle.importKey("jwk", { ...publicJwk, alg: "RSA-OAEP-256", ext: true }, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  return toBytes(new Uint8Array(await subtle.encrypt({ name: "RSA-OAEP" }, key, aesKeyRaw)));
}

export async function rsaOaepUnwrap(privateKey: CryptoKey, wrapped: Bytes): Promise<Bytes> {
  return toBytes(new Uint8Array(await subtle.decrypt({ name: "RSA-OAEP" }, privateKey, wrapped)));
}

/** RSASSA-PKCS1-v1_5 SHA-256 over `data`, base64url. Used to sign the security config. */
export async function rsaPkcs1Sign(pem: string, data: Bytes): Promise<string> {
  const key = await subtle.importKey("pkcs8", pemToDer(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await subtle.sign("RSASSA-PKCS1-v1_5", key, data));
  return base64UrlEncode(signature);
}

export async function randomBytes(length: number): Promise<Bytes> {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}
