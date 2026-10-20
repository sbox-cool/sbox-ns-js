import { type SessionSecret } from "./sessions.js";
/** Payload keys that carry identity or auth and never reach endpoint code. Mirrors the server's reserved set. */
export declare const RESERVED_PAYLOAD_KEYS: Record<string, true>;
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
/**
 * The request as the identity layer sees it. Adapters implement this for their framework. Header names are passed
 * lowercase and matched case-insensitively by the adapter.
 */
export interface RequestCredentials {
    header(name: string): string | undefined;
    query(name: string): string | undefined;
    /** The parsed JSON body when it is an object, otherwise null. */
    body: Readonly<Record<string, unknown>> | null;
}
/** Auth sessions are enabled exactly when a secret is configured. */
export interface IdentityOptions {
    projectId: string;
    endpointSlug: string;
    /** The project's public key. Proxy signatures are keyed by it. */
    apiKey: string;
    /** The project owner. Auth sessions must belong to this user. */
    ownerUserId: number;
    /** Mirrors the project's `RequireSboxAuth`. When false, unverified legacy callers pass through. */
    requireSboxAuth: boolean;
    sessions: {
        secret: SessionSecret;
    } | null;
    nowMs: number;
    fetch: FetchLike;
}
export interface PlayerIdentity {
    steamId: string;
    /** The validated auth-session id, present only when the request presented a session token. */
    sessionId: string | null;
}
export interface EnvelopeIdentity {
    /** `"session"`, `"steam"`, or `""` when the envelope binds neither. */
    type: "session" | "steam" | "";
    value: string;
}
/** Reads the identity an envelope is bound to. A session id takes precedence over a steam id. Values are trimmed. */
export declare function envelopeIdentity(raw: Readonly<Record<string, unknown>>): EnvelopeIdentity;
/**
 * Checks an envelope's identity binding against the resolved player and session. Shared by v1 and v2 and mirrors
 * `ValidateIdentityBinding` on the server. Throws on refusal.
 */
export declare function validateIdentityBinding(raw: Readonly<Record<string, unknown>>, steamId: string | null, sessionId: string | null): void;
/** Session token from headers, then the Authorization bearer, then query, then body. */
export declare function readSessionToken(req: RequestCredentials): string | null;
/**
 * HMAC-SHA256(apiKey, `projectId:endpointSlug:clientSteamId:clientToken`) as lowercase hex. The SDK's proxy
 * signature; the client library sends it in `x-proxy-signature`.
 */
export declare function computeProxySignature(apiKey: string, projectId: string, endpointSlug: string, clientSteamId: string, clientToken: string): Promise<string>;
/**
 * Resolves the verified player for a request. Mirrors `PlayerIdentity.ResolveAsync`. Throws `ProtocolError` on refusal.
 * `claimedSteamId` is the caller's first supplied claim (see {@link claimedSteamId}).
 */
export declare function resolvePlayer(req: RequestCredentials, claimed: string | null, options: IdentityOptions): Promise<PlayerIdentity>;
/** The steam id the caller claims, from the first supplied claim source. Matches the server's claim readers. */
export declare function claimedSteamId(req: RequestCredentials): string | null;
/** Replay scope for an envelope: `type:value`, empty when the envelope binds nothing. */
export declare function identityKeyOf(raw: Readonly<Record<string, unknown>>): string;
