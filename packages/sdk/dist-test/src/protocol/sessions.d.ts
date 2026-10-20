/** HMAC secret for auth-session tokens. Supplied by project configuration, never read from globals. */
export type SessionSecret = string;
export declare const SESSION_TOKEN_PREFIX = "sbox_sess_";
export declare const DEFAULT_SESSION_TTL_SECONDS: number;
export declare const MIN_SESSION_TTL_SECONDS = 60;
export declare const MAX_SESSION_TTL_SECONDS: number;
export declare function normalizeSessionTtl(value: number): number;
export interface AuthSessionClaims {
    id: string;
    userId: number;
    projectId: string;
    steamId: string;
    createdAt: number;
    expiresAt: number;
    metadata: Record<string, unknown>;
}
export interface CreateSessionInput {
    userId: number;
    projectId: string;
    steamId: string;
    ttlSeconds: number;
    metadata?: Record<string, unknown>;
    nowMs: number;
}
export interface IssuedSession {
    token: string;
    ttlSeconds: number;
    session: AuthSessionClaims;
}
/** Issues a session token. The token is stateless: the signature covers the base64url payload string. */
export declare function createAuthSession(secret: SessionSecret, input: CreateSessionInput): Promise<IssuedSession>;
/** Refresh re-issues a valid session for the same player, recording the session it replaced. */
export declare function refreshAuthSession(secret: SessionSecret, token: string, projectId: string, ttlSeconds: number, nowMs: number): Promise<IssuedSession>;
/** Verifies a session token and returns its claims. Mirrors `NetworkStorageAuthSessionService.Validate`. */
export declare function verifyAuthSession(secret: SessionSecret, token: string, projectId: string, nowMs: number): Promise<AuthSessionClaims>;
