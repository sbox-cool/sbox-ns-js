import { base64UrlDecode, base64UrlEncode, constantTimeEqual, hexEncode, utf8, utf8Decode } from "../util/bytes.js";
import { hmacSha256, randomBytes } from "./crypto.js";
import { ProtocolError } from "./errors.js";

/** HMAC secret for auth-session tokens. Supplied by project configuration, never read from globals. */
export type SessionSecret = string;

export const SESSION_TOKEN_PREFIX = "sbox_sess_";
export const DEFAULT_SESSION_TTL_SECONDS = 60 * 60;
export const MIN_SESSION_TTL_SECONDS = 60;
export const MAX_SESSION_TTL_SECONDS = 24 * 60 * 60;

/**
 * How long a family revocation marker is kept. A token minted before the revoke expires within the max TTL of the
 * revoke; the extra hour tolerates clock skew, matching the reference RevocationGraceSeconds.
 */
export const REVOCATION_RETENTION_MS = (MAX_SESSION_TTL_SECONDS + 60 * 60) * 1000;

export function normalizeSessionTtl(value: number): number {
  return Math.min(MAX_SESSION_TTL_SECONDS, Math.max(MIN_SESSION_TTL_SECONDS, Math.trunc(value)));
}

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

function refuse(code: string, message: string): ProtocolError {
  return new ProtocolError(401, code, message);
}

async function sign(secret: SessionSecret, payload: string): Promise<string> {
  return base64UrlEncode(await hmacSha256(utf8(secret), utf8(payload)));
}

async function encode(secret: SessionSecret, claims: AuthSessionClaims): Promise<string> {
  const payload = base64UrlEncode(
    utf8(
      JSON.stringify({
        v: 1,
        id: claims.id,
        userId: claims.userId,
        projectId: claims.projectId,
        steamId: claims.steamId,
        createdAt: claims.createdAt,
        expiresAt: claims.expiresAt,
        metadata: claims.metadata,
      }),
    ),
  );
  return `${SESSION_TOKEN_PREFIX}${payload}.${await sign(secret, payload)}`;
}

/** Revocation lookups keyed by session family id. Structural, so the protocol layer does not import the server layer. */
export interface SessionRevocationCheck {
  isRevoked(familyId: string): Promise<boolean>;
}

/** Issues a session token in a new family. The token is stateless: the signature covers the base64url payload string. */
export async function createAuthSession(secret: SessionSecret, input: CreateSessionInput): Promise<IssuedSession> {
  return mintAuthSession(secret, input, hexEncode(await randomBytes(16)));
}

async function mintAuthSession(secret: SessionSecret, input: CreateSessionInput, id: string): Promise<IssuedSession> {
  const ttlSeconds = normalizeSessionTtl(input.ttlSeconds);
  const session: AuthSessionClaims = {
    id,
    userId: input.userId,
    projectId: input.projectId,
    steamId: input.steamId,
    createdAt: input.nowMs,
    expiresAt: input.nowMs + ttlSeconds * 1000,
    metadata: input.metadata ?? {},
  };
  return { token: await encode(secret, session), ttlSeconds, session };
}

/** Verifies a presented token and rejects it when its session family is revoked. Every path that accepts a token uses this. */
export async function requireActiveAuthSession(
  secret: SessionSecret,
  token: string,
  projectId: string,
  nowMs: number,
  revocations: SessionRevocationCheck,
): Promise<AuthSessionClaims> {
  const claims = await verifyAuthSession(secret, token, projectId, nowMs);
  if (await revocations.isRevoked(claims.id)) {
    throw refuse("AUTH_SESSION_REVOKED", "Auth session has been revoked. Create a new session.");
  }
  return claims;
}

/**
 * Refresh mints a successor in the same family (the payload id is kept), so revoking any token of the family
 * revokes every token of it. The revocation check runs again after minting, so a revoke that lands mid-refresh wins.
 */
export async function refreshAuthSession(
  secret: SessionSecret,
  token: string,
  projectId: string,
  ttlSeconds: number,
  nowMs: number,
  revocations: SessionRevocationCheck,
): Promise<IssuedSession> {
  const current = await requireActiveAuthSession(secret, token, projectId, nowMs, revocations);
  const issued = await mintAuthSession(
    secret,
    {
      userId: current.userId,
      projectId: current.projectId,
      steamId: current.steamId,
      ttlSeconds,
      metadata: { refreshedFrom: current.id },
      nowMs,
    },
    current.id,
  );
  if (await revocations.isRevoked(current.id)) {
    throw refuse("AUTH_SESSION_REVOKED", "Auth session has been revoked. Create a new session.");
  }
  return issued;
}

function readLong(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

function readText(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

/** Verifies a session token and returns its claims. Mirrors `NetworkStorageAuthSessionService.Validate`. */
export async function verifyAuthSession(secret: SessionSecret, token: string, projectId: string, nowMs: number): Promise<AuthSessionClaims> {
  if (token.length === 0 || !token.startsWith(SESSION_TOKEN_PREFIX)) {
    throw refuse("AUTH_SESSION_INVALID", "Auth session token is missing or invalid.");
  }
  const packed = token.slice(SESSION_TOKEN_PREFIX.length);
  const dot = packed.lastIndexOf(".");
  if (dot <= 0) throw refuse("AUTH_SESSION_INVALID", "Auth session token is malformed.");
  const payload = packed.slice(0, dot);
  const signature = packed.slice(dot + 1);
  const expected = await sign(secret, payload);
  if (!constantTimeEqual(utf8(signature), utf8(expected))) {
    throw refuse("AUTH_SESSION_INVALID", "Auth session signature is invalid.");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(utf8Decode(base64UrlDecode(payload)));
  } catch {
    throw refuse("AUTH_SESSION_INVALID", "Auth session payload is invalid.");
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw refuse("AUTH_SESSION_INVALID", "Auth session payload is invalid.");
  }
  const record = decoded as Record<string, unknown>;
  if (readText(record, "projectId") !== projectId) {
    throw refuse("AUTH_SESSION_INVALID", "Auth session project does not match this request.");
  }
  const expiresAt = readLong(record, "expiresAt");
  if (expiresAt <= nowMs) throw refuse("AUTH_SESSION_EXPIRED", "Auth session has expired. Create a new session.");

  const metadata = record.metadata;
  return {
    id: readText(record, "id"),
    userId: readLong(record, "userId"),
    projectId: readText(record, "projectId"),
    steamId: readText(record, "steamId"),
    createdAt: readLong(record, "createdAt"),
    expiresAt,
    metadata: metadata !== null && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {},
  };
}
