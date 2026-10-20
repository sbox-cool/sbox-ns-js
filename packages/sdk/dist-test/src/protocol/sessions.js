import { base64UrlDecode, base64UrlEncode, constantTimeEqual, hexEncode, utf8, utf8Decode } from "../util/bytes.js";
import { hmacSha256, randomBytes } from "./crypto.js";
import { ProtocolError } from "./errors.js";
export const SESSION_TOKEN_PREFIX = "sbox_sess_";
export const DEFAULT_SESSION_TTL_SECONDS = 60 * 60;
export const MIN_SESSION_TTL_SECONDS = 60;
export const MAX_SESSION_TTL_SECONDS = 24 * 60 * 60;
export function normalizeSessionTtl(value) {
    return Math.min(MAX_SESSION_TTL_SECONDS, Math.max(MIN_SESSION_TTL_SECONDS, Math.trunc(value)));
}
function refuse(code, message) {
    return new ProtocolError(401, code, message);
}
async function sign(secret, payload) {
    return base64UrlEncode(await hmacSha256(utf8(secret), utf8(payload)));
}
async function encode(secret, claims) {
    const payload = base64UrlEncode(utf8(JSON.stringify({
        v: 1,
        id: claims.id,
        userId: claims.userId,
        projectId: claims.projectId,
        steamId: claims.steamId,
        createdAt: claims.createdAt,
        expiresAt: claims.expiresAt,
        metadata: claims.metadata,
    })));
    return `${SESSION_TOKEN_PREFIX}${payload}.${await sign(secret, payload)}`;
}
/** Issues a session token. The token is stateless: the signature covers the base64url payload string. */
export async function createAuthSession(secret, input) {
    const ttlSeconds = normalizeSessionTtl(input.ttlSeconds);
    const id = hexEncode(await randomBytes(16));
    const session = {
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
/** Refresh re-issues a valid session for the same player, recording the session it replaced. */
export async function refreshAuthSession(secret, token, projectId, ttlSeconds, nowMs) {
    const current = await verifyAuthSession(secret, token, projectId, nowMs);
    return createAuthSession(secret, {
        userId: current.userId,
        projectId: current.projectId,
        steamId: current.steamId,
        ttlSeconds,
        metadata: { refreshedFrom: current.id },
        nowMs,
    });
}
function readLong(record, key) {
    const value = record[key];
    return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}
function readText(record, key) {
    const value = record[key];
    if (typeof value === "string")
        return value;
    if (typeof value === "number")
        return String(value);
    return "";
}
/** Verifies a session token and returns its claims. Mirrors `NetworkStorageAuthSessionService.Validate`. */
export async function verifyAuthSession(secret, token, projectId, nowMs) {
    if (token.length === 0 || !token.startsWith(SESSION_TOKEN_PREFIX)) {
        throw refuse("AUTH_SESSION_INVALID", "Auth session token is missing or invalid.");
    }
    const packed = token.slice(SESSION_TOKEN_PREFIX.length);
    const dot = packed.lastIndexOf(".");
    if (dot <= 0)
        throw refuse("AUTH_SESSION_INVALID", "Auth session token is malformed.");
    const payload = packed.slice(0, dot);
    const signature = packed.slice(dot + 1);
    const expected = await sign(secret, payload);
    if (!constantTimeEqual(utf8(signature), utf8(expected))) {
        throw refuse("AUTH_SESSION_INVALID", "Auth session signature is invalid.");
    }
    let decoded;
    try {
        decoded = JSON.parse(utf8Decode(base64UrlDecode(payload)));
    }
    catch {
        throw refuse("AUTH_SESSION_INVALID", "Auth session payload is invalid.");
    }
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
        throw refuse("AUTH_SESSION_INVALID", "Auth session payload is invalid.");
    }
    const record = decoded;
    if (readText(record, "projectId") !== projectId) {
        throw refuse("AUTH_SESSION_INVALID", "Auth session project does not match this request.");
    }
    const expiresAt = readLong(record, "expiresAt");
    if (expiresAt <= nowMs)
        throw refuse("AUTH_SESSION_EXPIRED", "Auth session has expired. Create a new session.");
    const metadata = record.metadata;
    return {
        id: readText(record, "id"),
        userId: readLong(record, "userId"),
        projectId: readText(record, "projectId"),
        steamId: readText(record, "steamId"),
        createdAt: readLong(record, "createdAt"),
        expiresAt,
        metadata: metadata !== null && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {},
    };
}
