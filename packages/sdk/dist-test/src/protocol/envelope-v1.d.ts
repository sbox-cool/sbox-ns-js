export declare const V1_VERSION = "1";
export declare const V1_ALGORITHM = "aes-256-gcm+hmac-sha256";
export interface V1OpenInput {
    /** The envelope exactly as parsed from the request body. */
    raw: Readonly<Record<string, unknown>>;
    apiKey: string;
    projectId: string;
    endpointSlug: string;
    /** Verified steam id of the caller, or null when the caller is session-bound. */
    steamId: string | null;
    /** Verified auth-session id, or null when the request presented no session. */
    sessionId: string | null;
}
export interface V1Opened {
    /** Decrypted body with reserved keys removed. */
    payload: Record<string, unknown>;
    /** `encryptedRequestId`, unvalidated. The replay layer validates it. */
    requestId: string;
    /** `type:value` of the envelope identity, the replay scope. */
    identityKey: string;
}
/**
 * Opens a v1 envelope. Order follows `EncryptedEndpointEnvelope.ValidateShape` then `Decrypt`: shape, api-key
 * fingerprint, identity binding, HMAC signature, AES-GCM open, payload shape. Replay consumption is the caller's job
 * and happens only once the endpoint is confirmed.
 */
export declare function openV1Envelope(input: V1OpenInput): Promise<V1Opened>;
