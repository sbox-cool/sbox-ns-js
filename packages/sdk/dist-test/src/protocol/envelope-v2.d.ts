import { type LoadedRequestKey } from "./crypto.js";
import type { Bytes } from "../util/bytes.js";
export declare const V2_VERSION = "2";
export declare const V2_ALGORITHM = "rsa-oaep-256+aes-256-gcm";
export interface V2OpenInput {
    /** The envelope exactly as parsed from the request body. */
    raw: Readonly<Record<string, unknown>>;
    projectId: string;
    endpointSlug: string;
    /** The request-encryption key the envelope's `keyId` resolved to. */
    key: LoadedRequestKey;
    steamId: string | null;
    sessionId: string | null;
}
/** Per-request response sealing state. Built from the decrypted request, never stored. */
export interface V2ResponseKey {
    aes: CryptoKey;
    nonce: string;
    keyId: string;
}
export interface V2Opened {
    payload: Record<string, unknown>;
    requestId: string;
    identityKey: string;
    responseKey: V2ResponseKey;
}
export interface V2SealedResponse {
    encrypted: true;
    v: 2;
    iv: string;
    tag: string;
    payload: string;
}
/**
 * Opens a v2 envelope. Order follows `EncryptedRequestV2.ValidateShape` then `Decrypt`: shape, identity binding,
 * IV/tag/key lengths, RSA-OAEP unwrap, AES-GCM open with the sorted binding as AAD, then payload shape.
 */
export declare function openV2Envelope(input: V2OpenInput): Promise<V2Opened>;
/**
 * Seals a response body for a v2 request. Applied to every body after decryption, errors included. The AAD binds the
 * response to the request nonce and key id so a sealed body cannot be replayed against another request.
 */
export declare function sealV2Response(key: V2ResponseKey, body: unknown, fixedIv?: Bytes): Promise<V2SealedResponse>;
