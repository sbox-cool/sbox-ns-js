import { constantTimeEqual, hexEncode, utf8 } from "../util/bytes.js";
import { hmacSha256 } from "./crypto.js";
import { ProtocolError } from "./errors.js";
import { readField, refuseEnvelope } from "./fields.js";
import {
  requireActiveAuthSession,
  type AuthSessionClaims,
  type SessionRevocationCheck,
  type SessionSecret,
} from "./sessions.js";

/** Payload keys that carry identity or auth and never reach endpoint code. Mirrors the server's reserved set. */
export const RESERVED_PAYLOAD_KEYS: Record<string, true> = {
  steamId: true,
  apiKey: true,
  token: true,
  authSessionToken: true,
  sessionToken: true,
  encryptedRequestId: true,
};

const FACEPUNCH_VERIFY_URL = "https://public.facepunch.com/sbox/auth/token";
const FACEPUNCH_TIMEOUT_MS = 10_000;
const STATUS_PATTERN = /"Status"\s*:\s*"([^"]+)"/;
const RETURNED_STEAM_ID_PATTERN = /"SteamId"\s*:\s*(\d+)/;

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
  sessions: { secret: SessionSecret; revocations: SessionRevocationCheck } | null;
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
export function envelopeIdentity(raw: Readonly<Record<string, unknown>>): EnvelopeIdentity {
  const sessionId = readField(raw, "sessionId").trim();
  if (sessionId.length > 0) return { type: "session", value: sessionId };
  const steamId = readField(raw, "steamId").trim();
  return steamId.length > 0 ? { type: "steam", value: steamId } : { type: "", value: "" };
}

/**
 * Checks an envelope's identity binding against the resolved player and session. Shared by v1 and v2 and mirrors
 * `ValidateIdentityBinding` on the server. Throws on refusal.
 */
export function validateIdentityBinding(
  raw: Readonly<Record<string, unknown>>,
  steamId: string | null,
  sessionId: string | null,
): void {
  const identity = envelopeIdentity(raw);
  if (identity.type === "") {
    throw refuseEnvelope("Encrypted request envelope must bind a steamId or sessionId.");
  }
  if (identity.type === "session" && sessionId === null) {
    throw new ProtocolError(
      401,
      "AUTH_SESSION_REQUIRED",
      "Encrypted requests bound to a sessionId require a valid auth session token.",
    );
  }
  if (sessionId !== null) {
    if (identity.type === "session" && identity.value !== sessionId) {
      throw new ProtocolError(
        403,
        "AUTH_SESSION_STEAMID_MISMATCH",
        "Encrypted request sessionId does not match the auth session.",
      );
    }
    const envelopeSteamId = raw.steamId;
    const presented = envelopeSteamId !== undefined && envelopeSteamId !== null;
    if (steamId !== null && presented && readField(raw, "steamId") !== steamId) {
      throw new ProtocolError(
        403,
        "AUTH_SESSION_STEAMID_MISMATCH",
        "Encrypted request steamId does not match the auth session.",
      );
    }
    return;
  }
  if (steamId !== null && identity.type === "steam" && identity.value !== steamId) {
    throw refuseEnvelope("Encrypted request steamId does not match the authenticated Steam ID.");
  }
}

/** Session token from headers, then the Authorization bearer, then query, then body. */
export function readSessionToken(req: RequestCredentials): string | null {
  const bearer = req.header("authorization");
  const bearerToken = bearer?.startsWith("Bearer ") ? bearer.slice("Bearer ".length) : undefined;
  return firstPresent(
    req.header("x-auth-session"),
    req.header("x-auth-session-token"),
    bearerToken,
    req.query("authSessionToken"),
    req.query("sessionToken"),
    bodyString(req, "authSessionToken"),
    bodyString(req, "sessionToken"),
  );
}

/**
 * HMAC-SHA256(apiKey, `projectId:endpointSlug:clientSteamId:clientToken`) as lowercase hex. The SDK's proxy
 * signature; the client library sends it in `x-proxy-signature`.
 */
export async function computeProxySignature(
  apiKey: string,
  projectId: string,
  endpointSlug: string,
  clientSteamId: string,
  clientToken: string,
): Promise<string> {
  const mac = await hmacSha256(utf8(apiKey), utf8(`${projectId}:${endpointSlug}:${clientSteamId}:${clientToken}`));
  return hexEncode(mac);
}

/**
 * Resolves the verified player for a request. Mirrors `PlayerIdentity.ResolveAsync`. Throws `ProtocolError` on refusal.
 * `claimedSteamId` is the caller's first supplied claim (see {@link claimedSteamId}).
 */
export async function resolvePlayer(
  req: RequestCredentials,
  claimed: string | null,
  options: IdentityOptions,
): Promise<PlayerIdentity> {
  const sessionToken = readSessionToken(req);
  const creds = readSboxCredentials(req);
  const { token, clientSteamId, clientToken, proxySignature } = creds;
  const hasSboxCredentials = [token, clientSteamId, clientToken, proxySignature].some((value) => value !== null);

  // Projects that do not require s&box auth let legacy callers through with their claimed identity. Presented
  // session tokens are still validated, because the server issued them.
  if (!options.requireSboxAuth && sessionToken === null) {
    return { steamId: firstPresent(clientSteamId, claimed) ?? "anonymous", sessionId: null };
  }

  let verifiedSteamId: string | null = null;
  let sessionId: string | null = null;
  if (sessionToken !== null) {
    if (options.sessions === null) {
      throw new ProtocolError(403, "AUTH_SESSION_DISABLED", "Auth sessions are not enabled for this project.");
    }
    const claims = await requireActiveAuthSession(
      options.sessions.secret,
      sessionToken,
      options.projectId,
      options.nowMs,
      options.sessions.revocations,
    );
    assertSessionOwner(claims, options.ownerUserId);
    verifiedSteamId = claims.steamId;
    sessionId = claims.id;
  }

  if (hasSboxCredentials || sessionToken === null) {
    const resolved = await verifySboxCredentials(creds, claimed, options);
    if (verifiedSteamId !== null && verifiedSteamId !== resolved) {
      throw new ProtocolError(
        403,
        "AUTH_SESSION_STEAMID_MISMATCH",
        "Auth session and s&box token identify different players.",
      );
    }
    verifiedSteamId = resolved;
  }

  // Every supplied claim must match the verified identity, not only the highest-precedence one.
  const expectedClaim = clientSteamId === null ? verifiedSteamId : claimed;
  const claims = [
    req.header("x-steam-id"),
    req.header("x-sbox-steam-id"),
    req.query("steamId"),
    req.query("steamid"),
    bodyString(req, "steamId"),
  ];
  for (const claim of claims) {
    if (claim !== undefined && claim !== "" && claim !== expectedClaim) {
      throw new ProtocolError(
        403,
        "AUTH_SESSION_STEAMID_MISMATCH",
        "Supplied Steam ID does not match the verified identity.",
      );
    }
  }

  if (verifiedSteamId === null) {
    throw new ProtocolError(401, "SBOX_AUTH_FAILED", "Player identity could not be verified.");
  }
  return { steamId: verifiedSteamId, sessionId };
}

/** The steam id the caller claims, from the first supplied claim source. Matches the server's claim readers. */
export function claimedSteamId(req: RequestCredentials): string | null {
  return firstPresent(
    req.header("x-steam-id"),
    req.header("x-sbox-steam-id"),
    req.query("steamId"),
    req.query("steamid"),
    bodyString(req, "steamId"),
  );
}

/** The s&box token and proxy fields a request carries. Mirrors the server's ReadHostToken and proxy headers. */
interface SboxCredentials {
  token: string | null;
  clientSteamId: string | null;
  clientToken: string | null;
  proxySignature: string | null;
}

function readSboxCredentials(req: RequestCredentials): SboxCredentials {
  return {
    token: firstPresent(req.header("x-sbox-token"), req.header("x-sbox-auth-token"), req.query("token"), bodyString(req, "token")),
    clientSteamId: firstPresent(req.header("x-on-behalf-of")),
    clientToken: firstPresent(req.header("x-on-behalf-of-token")),
    proxySignature: firstPresent(req.header("x-proxy-signature")),
  };
}

/**
 * Verifies the player behind s&box credentials. A proxied request is also checked against the client's own token,
 * and that result is the verified identity.
 */
async function verifySboxCredentials(
  creds: SboxCredentials,
  claimed: string | null,
  options: IdentityOptions,
): Promise<string> {
  const { token, clientSteamId, clientToken, proxySignature } = creds;
  const checked = await checkSboxIdentity(
    { hostToken: token ?? "", hostSteamId: claimed ?? "", clientSteamId, clientToken, proxySignature },
    options,
  );
  return clientSteamId !== null
    ? await checkSboxIdentity(
      { hostToken: clientToken ?? "", hostSteamId: clientSteamId, clientSteamId: null, clientToken: null, proxySignature: null },
      options,
    )
    : checked;
}

/**
 * Verifies the s&box player for a session route. Unlike resolvePlayer this always checks Facepunch, whatever
 * `requireSboxAuth` says, and never accepts a presented session token. Throws `SBOX_AUTH_FAILED` on refusal.
 */
export function verifySboxPlayer(req: RequestCredentials, options: IdentityOptions): Promise<string> {
  return verifySboxCredentials(readSboxCredentials(req), claimValues(req, true)[0] ?? null, options);
}

/**
 * Non-blank, trimmed Steam ID claims in precedence order. The proxy host's x-sbox-steam-id is included only when asked.
 * Mirrors the server's ClaimValues.
 */
function claimValues(req: RequestCredentials, includeHostHeader: boolean): string[] {
  return [
    req.header("x-steam-id"),
    includeHostHeader ? req.header("x-sbox-steam-id") : undefined,
    req.query("steamId"),
    req.query("steamid"),
    bodyString(req, "steamId"),
  ]
    .map((value) => value?.trim() ?? "")
    .filter((value) => value !== "");
}

/** The Steam ID the caller names as the requested player. The proxy host's header is not a player claim. */
export function requestedSteamId(req: RequestCredentials): string | null {
  return claimValues(req, false)[0] ?? null;
}

/** A plausible numeric Steam ID. Mirrors the server's IsPlausibleSteamId. */
export function isPlausibleSteamId(value: string): boolean {
  return /^[79][0-9]{3,16}$/.test(value);
}

/**
 * True when every Steam ID the caller names equals the verified steam id, or the proxy host's steam id when the request
 * is delegated. Mirrors the server's RequestedClaimsMatch.
 */
export function requestedClaimsMatch(req: RequestCredentials, verifiedSteamId: string): boolean {
  const delegated = firstPresent(req.header("x-on-behalf-of")) !== null;
  const hostSteamId = delegated ? claimValues(req, true)[0] : undefined;
  return claimValues(req, false).every((claim) => claim === verifiedSteamId || claim === hostSteamId);
}

interface SboxCheck {
  hostToken: string;
  hostSteamId: string;
  clientSteamId: string | null;
  clientToken: string | null;
  proxySignature: string | null;
}

/** Checks a token against Facepunch, directly or through a proxy. Returns the verified steam id. */
async function checkSboxIdentity(check: SboxCheck, options: IdentityOptions): Promise<string> {
  const { clientSteamId, clientToken, proxySignature } = check;
  if (clientSteamId !== null && clientToken !== null && proxySignature !== null) {
    return verifyProxy({ ...check, clientSteamId, clientToken, proxySignature }, options);
  }
  if (clientSteamId !== null) {
    refuseSbox("Proxy request missing client token (x-on-behalf-of-token) or signature (x-proxy-signature)");
  }
  return verifyDirect(check.hostToken, check.hostSteamId, options);
}

interface ProxyCheck extends SboxCheck {
  clientSteamId: string;
  clientToken: string;
  proxySignature: string;
}

async function verifyProxy(check: ProxyCheck, options: IdentityOptions): Promise<string> {
  if (check.hostToken === "" || check.hostSteamId === "") {
    refuseSbox("Proxy auth: missing host token or steamId");
  }
  const expected = await computeProxySignature(
    options.apiKey,
    options.projectId,
    options.endpointSlug,
    check.clientSteamId,
    check.clientToken,
  );
  if (!constantTimeEqual(utf8(check.proxySignature), utf8(expected))) {
    refuseSbox(
      "Proxy auth: signature mismatch - request may have been tampered with or replayed from another server",
    );
  }
  try {
    await verifyDirect(check.hostToken, check.hostSteamId, options);
  } catch (error) {
    const message = error instanceof ProtocolError ? error.message : "Player identity could not be verified.";
    refuseSbox(`Proxy auth: host verification failed - ${message}`);
  }
  return check.clientSteamId;
}

async function verifyDirect(token: string, steamId: string, options: IdentityOptions): Promise<string> {
  if (token === "" || steamId === "") {
    refuseSbox(
      `Missing token or steamId. token=${token === "" ? "NO" : "YES"} steamId=${steamId === "" ? "NONE" : steamId}`,
    );
  }
  let response: Response;
  try {
    response = await options.fetch(FACEPUNCH_VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ steamid: steamId, token }),
      signal: AbortSignal.timeout(FACEPUNCH_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    refuseSbox(timedOut
      ? "Facepunch auth request timed out. Retry shortly."
      : "Could not reach Facepunch auth service. Retry shortly.");
  }
  const body = await response.text();
  if (!response.ok) {
    refuseFacepunchStatus(response.status);
  }
  const status = STATUS_PATTERN.exec(body)?.[1] ?? "unknown";
  const returnedSteamId = RETURNED_STEAM_ID_PATTERN.exec(body)?.[1] ?? "";
  if (status !== "ok") {
    refuseSbox(`Facepunch rejected the auth token. Status=${status}. Generate a fresh token and retry.`);
  }
  if (returnedSteamId !== steamId) {
    refuseSbox(
      `Steam ID mismatch: token=${returnedSteamId === "" ? "missing" : returnedSteamId} request=${steamId}`,
    );
  }
  return returnedSteamId;
}

function refuseFacepunchStatus(status: number): never {
  if (status >= 500) refuseSbox(`Facepunch auth service unavailable (HTTP ${status}). Retry shortly.`);
  if (status === 429) {
    refuseSbox(`Facepunch auth service rate limited this request (HTTP ${status}). Retry shortly.`);
  }
  if (status === 401 || status === 403) {
    refuseSbox(`Facepunch rejected the auth token (HTTP ${status}). Generate a fresh token and retry.`);
  }
  refuseSbox(`Facepunch returned HTTP ${status}.`);
}

function refuseSbox(message: string): never {
  throw new ProtocolError(401, "SBOX_AUTH_FAILED", message);
}

function assertSessionOwner(claims: AuthSessionClaims, ownerUserId: number): void {
  if (claims.userId !== ownerUserId || claims.steamId === "") {
    throw new ProtocolError(401, "AUTH_SESSION_INVALID", "Auth session does not belong to this project owner.");
  }
}

function bodyString(req: RequestCredentials, name: string): string | undefined {
  const value = req.body?.[name];
  return typeof value === "string" ? value : undefined;
}

/** First value that is present and non-empty, mirroring the server's `FirstNonEmpty`. */
function firstPresent(...values: (string | undefined | null)[]): string | null {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

/** Replay scope for an envelope: `type:value`, empty when the envelope binds nothing. */
export function identityKeyOf(raw: Readonly<Record<string, unknown>>): string {
  const identity = envelopeIdentity(raw);
  return `${identity.type}:${identity.value}`;
}
