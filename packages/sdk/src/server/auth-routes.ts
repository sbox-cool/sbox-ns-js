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

// Auth-session routes answer HTTP 200 with `ok: false` and an error code, as the parity corpus expects.
function sessionFailure(code: string, message: string): Response {
  return jsonResponse({ ok: false, error: { code, message } }, 200);
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
  const publicKey = request.headers.get("x-public-key") ?? request.headers.get("x-api-key") ?? "";
  if (!safeEqual(publicKey, options.publicKey)) {
    return sessionFailure("UNAUTHORIZED", "The request has no valid public key.");
  }
  const secret = options.sessionSecret;
  if (secret === null || !options.settings.enableAuthSessions) {
    return sessionFailure("AUTH_SESSION_DISABLED", "Auth sessions are not enabled for this project.");
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
      if (token === null) throw new ProtocolError(401, "AUTH_SESSION_INVALID", "Auth session token is missing.");
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
    if (token === null) throw new ProtocolError(401, "AUTH_SESSION_INVALID", "Auth session token is missing.");
    const claims = await verifyAuthSession(secret, token, options.projectId, nowMs);
    await ctx.revocations.revoke(claims.id, claims.expiresAt);
    return jsonResponse({ ok: true, revoked: true, sessionId: claims.id }, 200);
  } catch (error) {
    const description = describeError(error);
    return sessionFailure(description.code, description.message);
  }
}
