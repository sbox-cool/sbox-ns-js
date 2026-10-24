import { base64UrlDecode, base64UrlEncode, utf8, utf8Decode, type Bytes } from "../util/bytes.js";
import { aesGcmKey, aesGcmOpen, aesGcmSeal, randomBytes, rsaOaepWrap, type RsaPublicJwk } from "./crypto.js";
import { RESPONSE_LABEL, V2_ALGORITHM, V2_VERSION, bindingJson } from "./envelope-v2.js";

const AES_KEY_BYTES = 32;
const IV_BYTES = 12;

export interface V2RequestIdentity {
  type: "steam" | "session";
  value: string;
}

export interface V2RequestInput {
  projectId: string;
  endpointSlug: string;
  identity: V2RequestIdentity;
  /** The request-encryption key id from the signed security config. */
  keyId: string;
  /** The server's RSA public key, as published in the signed security config. */
  publicJwk: RsaPublicJwk;
  /** The client nonce, at least 8 characters. The server binds it into the AAD and into the response AAD. */
  nonce: string;
  /** The request body. `_endpointSlug` is added and `encryptedRequestId` is generated when absent. */
  payload: Record<string, unknown>;
  /** Test vectors only: fixes the AES key and IV. Omit both in production so they are random per request. */
  fixed?: { aesKey: Bytes; iv: Bytes };
}

export interface SealedV2Request {
  /** The envelope to POST as the request body. */
  envelope: Record<string, string>;
  /** The AES-GCM key that seals the request. Keep it to open the response. */
  aes: CryptoKey;
}

/** A v2 response body as the server writes it: `{encrypted: true, v: 2, iv, tag, payload}`. */
export interface V2SealedResponse {
  iv: string;
  tag: string;
  payload: string;
}

/**
 * Seals a request for the v2 encrypted envelope. The AAD is the same canonical binding the server verifies, built by
 * `bindingJson` over the fields the envelope carries, so the two sides cannot drift.
 */
export async function sealV2Request(input: V2RequestInput): Promise<SealedV2Request> {
  const identityField = input.identity.type === "session" ? "sessionId" : "steamId";
  const head: Record<string, string> = {
    version: V2_VERSION,
    algorithm: V2_ALGORITHM,
    projectId: input.projectId,
    endpointSlug: input.endpointSlug,
    [identityField]: input.identity.value,
    keyId: input.keyId,
    nonce: input.nonce,
  };
  const aad = utf8(bindingJson(head));
  const aesKeyRaw = input.fixed?.aesKey ?? (await randomBytes(AES_KEY_BYTES));
  const iv = input.fixed?.iv ?? (await randomBytes(IV_BYTES));
  const aes = await aesGcmKey(aesKeyRaw, ["encrypt", "decrypt"]);
  const plaintext = utf8(JSON.stringify(withPayloadDefaults(input.payload, input.endpointSlug)));
  const sealed = await aesGcmSeal(aes, iv, plaintext, aad);
  const wrapped = await rsaOaepWrap(input.publicJwk, aesKeyRaw);
  return {
    envelope: {
      ...head,
      wrappedKey: base64UrlEncode(wrapped),
      iv: base64UrlEncode(iv),
      tag: base64UrlEncode(sealed.tag),
      encryptedPayload: base64UrlEncode(sealed.ciphertext),
    },
    aes,
  };
}

/**
 * Opens a sealed v2 response with the request's AES key. The AAD is the response label, the request nonce, and the
 * key id, the same bytes `sealV2Response` authenticates on the server. Throws when the tag does not verify.
 */
export async function openV2Response(
  aes: CryptoKey,
  request: { nonce: string; keyId: string },
  sealed: V2SealedResponse,
): Promise<unknown> {
  const aad = utf8(`${RESPONSE_LABEL}\0${request.nonce}\0${request.keyId}`);
  const plaintext = await aesGcmOpen(aes, base64UrlDecode(sealed.iv), base64UrlDecode(sealed.payload), base64UrlDecode(sealed.tag), aad);
  return JSON.parse(utf8Decode(plaintext));
}

function withPayloadDefaults(payload: Record<string, unknown>, endpointSlug: string): Record<string, unknown> {
  const body: Record<string, unknown> = { ...payload, _endpointSlug: endpointSlug };
  if (!("encryptedRequestId" in body)) body.encryptedRequestId = newRequestId();
  return body;
}

function newRequestId(): string {
  return `${Date.now()}_${base64UrlEncode(crypto.getRandomValues(new Uint8Array(6)))}`;
}
