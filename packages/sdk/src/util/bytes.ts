export type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(text: string): Bytes {
  return encoder.encode(text);
}

export function utf8Decode(bytes: Bytes): string {
  return decoder.decode(bytes);
}

export function concatBytes(...parts: Bytes[]): Bytes {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function constantTimeEqual(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

const B64URL = /^[A-Za-z0-9_-]*={0,2}$/;

/** Unpadded base64url, the encoding the server writes for keys, IVs, tags and payloads. */
export function base64UrlEncode(bytes: Bytes): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict base64url decode. Rejects any character outside the base64url alphabet. */
export function base64UrlDecode(text: string): Bytes {
  if (!B64URL.test(text)) throw new Error("invalid base64url");
  const unpadded = text.replace(/=+$/, "");
  if (unpadded.length % 4 === 1) throw new Error("invalid base64url length");
  const padded = unpadded.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((unpadded.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const HEX = /^[0-9a-fA-F]*$/;

export function hexEncode(bytes: Bytes): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function hexDecode(text: string): Bytes {
  if (text.length % 2 !== 0 || !HEX.test(text)) throw new Error("invalid hex");
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Lenient decode used by the v1 envelope: an even-length hex string is hex, anything else is
 * base64url. This mirrors `EncryptedEndpointEnvelope.DecodeBytes` on the server. v2 is strict
 * base64url and must use `base64UrlDecode` instead.
 */
export function decodeV1Bytes(text: string): Bytes {
  if (text.length > 0 && text.length % 2 === 0 && HEX.test(text)) return hexDecode(text);
  return base64UrlDecode(text);
}
