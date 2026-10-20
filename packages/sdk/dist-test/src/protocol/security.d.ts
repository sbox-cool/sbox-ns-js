import { ProtocolError } from "./errors.js";
/** Per-project encrypted-request mode, as stored in project settings. */
export type EncryptedRequestMode = "off" | "v1" | "v2-preferred" | "v2-required";
/** What a request body says about how it was encrypted. `none` is a plain body. */
export type EnvelopeKind = "none" | "v1" | "v2" | "unsupported";
/** `body.security.clientMode` values the library may send. */
export type ClientMode = "legacy" | "session" | "encrypted" | "session+encrypted";
/** The project fields the gate reads. */
export interface SecurityProject {
    enableAuthSessions: boolean;
    requireAuthSessions: boolean;
    encryptedRequestMode: EncryptedRequestMode;
}
export interface SecurityCheck {
    project: SecurityProject;
    /** The config version the server publishes for this project. */
    configVersion: string;
    /** Decrypted or plain JSON body. Only `body.security` is read here. */
    body: unknown;
    hasSecretKey: boolean;
    presentedSession: boolean;
    envelope: EnvelopeKind;
    /** v2 only: the envelope's keyId is a current key or a retired key still in grace. */
    envelopeKeyFound: boolean;
}
/** Which envelope kinds each mode accepts. `plain` is an unencrypted body. */
export declare const ENCRYPTED_REQUEST_ACCEPTS: Record<EncryptedRequestMode, {
    plain: boolean;
    v1: boolean;
    v2: boolean;
}>;
export declare function isEncryptedRequestMode(value: string): value is EncryptedRequestMode;
/**
 * The effective mode. A valid stored mode wins. An absent stored mode maps the legacy flag (true to `v1`, otherwise
 * `off`). A stored value that is present but unknown fails closed to `v2-required`. It never falls back to `off`.
 */
export declare function resolveEncryptedRequestMode(stored: string | null | undefined, legacyEnabled: boolean): EncryptedRequestMode;
/** The envelope kind of an encrypted body, from `envelope.version`: missing or "1" is v1, "2" is v2, anything else is unsupported. */
export declare function envelopeKindOf(version: string): EnvelopeKind;
/**
 * The first security denial for this call, or null to continue. Port of `EndpointSecurityGate.Check`, in the
 * reference order: client mode, config version, session requirements, then the envelope matrix, then the v2 key.
 */
export declare function securityDenial(check: SecurityCheck): ProtocolError | null;
