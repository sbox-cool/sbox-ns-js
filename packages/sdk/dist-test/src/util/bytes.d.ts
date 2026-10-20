export type Bytes = Uint8Array<ArrayBuffer>;
export declare function utf8(text: string): Bytes;
export declare function utf8Decode(bytes: Bytes): string;
export declare function concatBytes(...parts: Bytes[]): Bytes;
export declare function constantTimeEqual(a: Bytes, b: Bytes): boolean;
/** Unpadded base64url, the encoding the server writes for keys, IVs, tags and payloads. */
export declare function base64UrlEncode(bytes: Bytes): string;
/** Strict base64url decode. Rejects any character outside the base64url alphabet. */
export declare function base64UrlDecode(text: string): Bytes;
export declare function hexEncode(bytes: Bytes): string;
export declare function hexDecode(text: string): Bytes;
/**
 * Lenient decode used by the v1 envelope: an even-length hex string is hex, anything else is
 * base64url. This mirrors `EncryptedEndpointEnvelope.DecodeBytes` on the server. v2 is strict
 * base64url and must use `base64UrlDecode` instead.
 */
export declare function decodeV1Bytes(text: string): Bytes;
