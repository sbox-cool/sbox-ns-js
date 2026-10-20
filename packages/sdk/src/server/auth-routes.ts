import { ProtocolError } from "../protocol/errors.js";
import { claimedSteamId, readSessionToken, resolvePlayer } from "../protocol/identity.js";
import {
  createAuthSession,
  DEFAULT_SESSION_TTL_SECONDS,
  normalizeSessionTtl,
  refreshAuthSession,
  verifyAuthSession,
  type IssuedSession,
} from "../protocol/sessions.js";
import { jsonResponse } from "../util/http.js";
import { identityOptionsFor, type ServerContext } from "./context.js";
import { credentialsOf, describeError, readJsonBody, safeEqual } from "./http.js";

export type AuthSessionOp = "create" | "refresh" | "reauth" | "revoke";

const WIKI = "https://sboxcool.com/wiki/network-storage-v3";

// Mirrors the reference AuthSessionEndpoints error table: status, default message and docs URL per code.
const SESSION_ERRORS: Record<string, { status: number; message: string; docsUrl: string }> = {
  UNAUTHORIZED: { status: 401, message: "Invalid or missing API key.", docsUrl: `${WIKI}/quick-start#3-configure-the-library` },
  SBOX_AUTH_FAILED: { status: 401, message: "s&box auth token verification failed.", docsUrl: `${WIKI}/sbox-auth#error-handling` },
  AUTH_SESSION_DISABLED: { status: 403, message: "Auth sessions are not enabled for this project.", docsUrl: `${WIKI}/sbox-auth#session-caching` },
  AUTH_SESSION_REQUIRED: { status: 401, message: "Auth session token is required.", docsUrl: `${WIKI}/sbox-auth#session-caching` },
  AUTH_SESSION_INVALID: { status: 401, message: "Auth session token is invalid.", docsUrl: `${WIKI}/sbox-auth#session-caching` },
  AUTH_SESSION_EXPIRED: { status: 401, message: "Auth session has expired.", docsUrl: `${WIKI}/sbox-auth#session-caching` },
  AUTH_SESSION_STEAMID_MISMATCH: { status: 403, message: "Auth session does not match the supplied Steam ID.", docsUrl: `${WIKI}/sbox-auth#session-caching` },
  INVALID_STEAMID: { status: 400, message: "Steam ID must be a plausible numeric s&box/Steam ID.", docsUrl: `${WIKI}/sbox-auth#implementing-auth-in-your-game` },
  PROJECT_DISABLED: { status: 403, message: "This project is currently disabled.", docsUrl: `${WIKI}/quick-start#2-create-a-project` },
};

// Session routes always answer HTTP 200 with the logical status in the body (reference SessionErrorAsync).
// `detail`, when given, replaces the table's default message.
function sessionFailure(code: string, detail: string | null, requestId: string): Response {
  const known = Object.hasOwn(SESSION_ERRORS, code) ? SESSION_ERRORS[code] : undefined;
  const def = known ?? { status: 500, message: "Unknown error.", docsUrl: WIKI };
  const message = detail ?? def.message;
  const body = {
    ok: false,
    status: def.status,
    error: { code, message, requestId, docsUrl: def.docsUrl },
    message,
    _requestId: requestId,
  };
  return jsonResponse(body, 200, { "x-request-id": requestId });
}

function issuedBody(issued: IssuedSession): Record<string, unknown> {
  return {
    ok: true,
    token: issued.token,
    ttlSeconds: issued.ttlSeconds,
    sessionId: issued.session.id,
    steamId: issued.session.steamId,
    expiresAt: issued.session.expiresAt,
  };
}

// POST /{v}/auth-sessions/{project}/{op} and POST /{v}/sessions/{project}/refresh.
export async function handleAuthSession(
  ctx: ServerContext,
  request: Request,
  url: URL,
  op: AuthSessionOp,
): Promise<Response> {
  const { options } = ctx;
  const requestId = crypto.randomUUID();
  const publicKey =
    request.headers.get("x-public-key") ?? request.headers.get("x-api-key") ?? url.searchParams.get("apiKey") ?? "";
  if (publicKey === "") {
    return sessionFailure(
      "UNAUTHORIZED",
      "No API key provided. Send x-api-key header or apiKey query parameter.",
      requestId,
    );
  }
  if (!safeEqual(publicKey, options.publicKey)) return sessionFailure("UNAUTHORIZED", null, requestId);
  const secret = options.sessionSecret;
  if (secret === null || !options.settings.enableAuthSessions) {
    return sessionFailure("AUTH_SESSION_DISABLED", null, requestId);
  }
  try {
    const body = await readJsonBody(request);
    const nowMs = ctx.now();
    const credentials = credentialsOf(request, url, body);
    const ttlSeconds = normalizeSessionTtl(options.settings.authSessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS);
    const identityOptions = identityOptionsFor(ctx, "", nowMs);

    if (op === "create") {
      const identity = await resolvePlayer(credentials, claimedSteamId(credentials), identityOptions);
      const issued = await createAuthSession(secret, {
        userId: options.ownerUserId,
        projectId: options.projectId,
        steamId: identity.steamId,
        ttlSeconds,
        nowMs,
      });
      return jsonResponse(issuedBody(issued), 200);
    }

    if (op === "refresh") {
      const token = readSessionToken(credentials);
      if (token === null) throw new ProtocolError(401, "AUTH_SESSION_REQUIRED", "Auth session token is required.");
      const current = await verifyAuthSession(secret, token, options.projectId, nowMs);
      if (await ctx.revocations.isRevoked(current.id)) {
        throw new ProtocolError(401, "AUTH_SESSION_REVOKED", "The auth session was revoked.");
      }
      const issued = await refreshAuthSession(secret, token, options.projectId, ttlSeconds, nowMs);
      return jsonResponse(issuedBody(issued), 200);
    }

    if (op === "reauth") {
      // Reauth proves identity again, then replaces any session the caller presented.
      const identity = await resolvePlayer(credentials, claimedSteamId(credentials), identityOptions);
      const presented = readSessionToken(credentials);
      if (presented !== null) {
        const old = await verifyAuthSession(secret, presented, options.projectId, nowMs);
        await ctx.revocations.revoke(old.id, old.expiresAt);
      }
      const issued = await createAuthSession(secret, {
        userId: options.ownerUserId,
        projectId: options.projectId,
        steamId: identity.steamId,
        ttlSeconds,
        nowMs,
      });
      return jsonResponse(issuedBody(issued), 200);
    }

    const token = readSessionToken(credentials);
    if (token === null) throw new ProtocolError(401, "AUTH_SESSION_REQUIRED", "Auth session token is required.");
    const claims = await verifyAuthSession(secret, token, options.projectId, nowMs);
    await ctx.revocations.revoke(claims.id, claims.expiresAt);
    return jsonResponse({ ok: true, revoked: true, sessionId: claims.id }, 200);
  } catch (error) {
    const description = describeError(error);
    return sessionFailure(description.code, description.message, requestId);
  }
}
