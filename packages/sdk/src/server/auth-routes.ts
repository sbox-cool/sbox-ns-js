import { ProtocolError } from "../protocol/errors.js";
import { isPlausibleSteamId, readSessionToken, requestedClaimsMatch, requestedSteamId, verifySboxPlayer } from "../protocol/identity.js";
import {
  createAuthSession,
  DEFAULT_SESSION_TTL_SECONDS,
  normalizeSessionTtl,
  REVOCATION_RETENTION_MS,
  refreshAuthSession,
  requireActiveAuthSession,
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
  AUTH_SESSION_REVOKED: { status: 401, message: "Auth session has been revoked. Create a new session.", docsUrl: `${WIKI}/sbox-auth#session-caching` },
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

// A session refusal thrown from inside the flow. The table supplies the message unless `detail` is given.
function refuse(code: string, detail?: string): ProtocolError {
  const known = Object.hasOwn(SESSION_ERRORS, code) ? SESSION_ERRORS[code] : undefined;
  return new ProtocolError(known?.status ?? 500, code, detail ?? known?.message ?? "Unknown error.");
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
  if (secret === null || !ctx.settings().security.enableAuthSessions) {
    return sessionFailure("AUTH_SESSION_DISABLED", null, requestId);
  }
  try {
    const body = await readJsonBody(request);
    const nowMs = ctx.now();
    const credentials = credentialsOf(request, url, body);
    const ttlSeconds = normalizeSessionTtl(ctx.settings().security.authSessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS);
    const identityOptions = identityOptionsFor(ctx, `__auth_session_${op}`, nowMs);

    if (op === "create") {
      // Create always proves the player with s&box and ignores any presented session, whatever `requireSboxAuth` says.
      const claimed = requestedSteamId(credentials);
      if (claimed === null || !isPlausibleSteamId(claimed)) {
        throw refuse("INVALID_STEAMID", "Create session requires a plausible x-steam-id value.");
      }
      const verified = await verifySboxPlayer(credentials, identityOptions);
      if (!requestedClaimsMatch(credentials, verified)) throw refuse("AUTH_SESSION_STEAMID_MISMATCH");
      const issued = await createAuthSession(secret, {
        userId: options.ownerUserId,
        projectId: options.projectId,
        steamId: verified,
        ttlSeconds,
        nowMs,
      });
      return jsonResponse(issuedBody(issued), 200);
    }

    if (op === "refresh") {
      const token = readSessionToken(credentials);
      if (token === null) throw new ProtocolError(401, "AUTH_SESSION_REQUIRED", "Auth session token is required.");
      const issued = await refreshAuthSession(secret, token, options.projectId, ttlSeconds, nowMs, ctx.revocations);
      return jsonResponse(issuedBody(issued), 200);
    }

    if (op === "reauth") {
      // Reauth needs a live presented session and a fresh s&box proof for the same player. Only then does it refresh
      // within that session's family, so a revoked or unverified caller never mints a successor.
      const token = readSessionToken(credentials);
      if (token === null) throw refuse("AUTH_SESSION_REQUIRED");
      const current = await requireActiveAuthSession(secret, token, options.projectId, nowMs, ctx.revocations);
      const verified = await verifySboxPlayer(credentials, identityOptions);
      if (verified !== current.steamId || !requestedClaimsMatch(credentials, verified)) {
        throw refuse("AUTH_SESSION_STEAMID_MISMATCH");
      }
      const issued = await refreshAuthSession(secret, token, options.projectId, ttlSeconds, nowMs, ctx.revocations);
      return jsonResponse(issuedBody(issued), 200);
    }

    const token = readSessionToken(credentials);
    if (token === null) throw new ProtocolError(401, "AUTH_SESSION_REQUIRED", "Auth session token is required.");
    const claims = await verifyAuthSession(secret, token, options.projectId, nowMs);
    // Revoke is idempotent and retains the marker past the longest token the family could still hold.
    await ctx.revocations.revoke(claims.id, nowMs + REVOCATION_RETENTION_MS);
    return jsonResponse({ ok: true, revoked: true, sessionId: claims.id }, 200);
  } catch (error) {
    const description = describeError(error);
    return sessionFailure(description.code, description.message, requestId);
  }
}
