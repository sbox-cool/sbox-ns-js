import { DslResponse } from "../dsl/steps.js";
import { runEndpoint, type SecretStore } from "../endpoint/runtime.js";
import { PROFILES_COLLECTION, trackedFieldsOf, type Catalog } from "./catalog.js";
import { ProtocolError } from "../protocol/errors.js";
import { openV1Envelope } from "../protocol/envelope-v1.js";
import { openV2Envelope, sealV2Response, type V2ResponseKey } from "../protocol/envelope-v2.js";
import { readField } from "../protocol/fields.js";
import { clampReplayWindow, consumeRequestId } from "../protocol/replay.js";
import { claimedSteamId, readSessionToken, resolvePlayer } from "../protocol/identity.js";
import { isLibraryCaller, libraryErrorBody } from "../protocol/library.js";
import { withoutReservedKeys } from "../protocol/payload.js";
import { envelopeKindOf, securityDenial, type EnvelopeKind } from "../protocol/security.js";
import { verifyAuthSession } from "../protocol/sessions.js";
import { isRecord } from "../util/guards.js";
import { jsonResponse, traceIdentifier } from "../util/http.js";
import { identityOptionsFor, type RuntimeView, type ServerContext } from "./context.js";
import { KeyRefusal } from "./auth-failure.js";
import { targetsNext } from "./publish-target.js";
import { credentialsOf, describeError, describedErrorBody, errorResponse, readJsonBody, safeEqual } from "./http.js";
import type { LoadedRequestKey } from "../protocol/crypto.js";
import type { EndpointHandler, WorkflowFunction } from "../endpoint/types.js";
import type { ExecutionMode } from "../endpoint/execution.js";

// Keys that address the call rather than carry input. They never reach the handler.
const SHELL_KEYS = ["security", "_endpointSlug", "endpoint"] as const;

// No secrets are configured, so every name is absent. Handlers get null, never a value from elsewhere.
const NO_SECRETS: SecretStore = { get: () => null };

// Static endpoints from ServerOptions first, then the endpoints the editor pushed (compiled from DSL documents).
export function resolveEndpoint(
  ctx: ServerContext,
  catalog: Catalog,
  slug: string,
): { handler: EndpointHandler; requiresSecretKey: boolean; execution: ExecutionMode } | null {
  if (Object.hasOwn(ctx.options.endpoints, slug)) {
    return { handler: ctx.options.endpoints[slug]!, requiresSecretKey: false, execution: "scripted" };
  }
  const entry = catalog.endpoints.get(slug);
  // Internal endpoints are not served over HTTP. The reference answers them as not found.
  if (entry === undefined || !entry.enabled || entry.compiled.exposure === "internal") return null;
  return {
    handler: entry.compiled.handler,
    requiresSecretKey: entry.compiled.requiresSecretKey,
    execution: "declarative",
  };
}

// Static workflows from ServerOptions, overridden by the workflows the editor pushed.
function workflowsOf(ctx: ServerContext, catalog: Catalog): Record<string, WorkflowFunction> {
  const workflows: Record<string, WorkflowFunction> = { ...ctx.options.workflows };
  for (const [id, entry] of catalog.workflows) workflows[id] = entry.compiled.definition;
  return workflows;
}

// What a request has established so far. Errors are shaped from it, so it is filled in as the call progresses.
interface CallState {
  library: boolean;
  requestId: string | null;
  responseKey: V2ResponseKey | null;
}

// Access for a call. The secret arrives as x-secret-key or x-api-key; the public key as x-public-key, x-api-key, or the
// apiKey query parameter. Keys are compared in constant time.
export function authorize(ctx: ServerContext, request: Request, url: URL): { hasSecretKey: boolean } | null {
  const { options } = ctx;
  const apiKey = request.headers.get("x-api-key");
  const presentedSecret = request.headers.get("x-secret-key") ?? apiKey ?? "";
  const presentedPublic = request.headers.get("x-public-key") ?? apiKey ?? url.searchParams.get("apiKey") ?? "";
  const hasSecretKey = options.secretKey !== null && safeEqual(presentedSecret, options.secretKey);
  const hasPublicKey = safeEqual(presentedPublic, options.publicKey);
  if (!hasSecretKey && !hasPublicKey) return null;
  return { hasSecretKey };
}

export async function handleEndpoint(
  ctx: ServerContext,
  request: Request,
  url: URL,
  pathSlug: string | null,
): Promise<Response> {
  const access = authorize(ctx, request, url);
  if (access === null) throw new KeyRefusal();
  const state: CallState = { library: false, requestId: null, responseKey: null };
  try {
    // Headers alone decide library status until the body is read, so an oversized body still gets the envelope.
    state.library = isLibraryCaller(request.headers, null);
    const body = request.method === "GET" ? null : await endpointBody(request);
    state.library = isLibraryCaller(request.headers, body);
    return await runCall(ctx, request, url, pathSlug, body, access.hasSecretKey, state);
  } catch (error) {
    return failureResponse(error, state);
  }
}

// The reference runs an endpoint with no input when its body is not valid JSON. Oversized bodies still fail.
async function endpointBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return await readJsonBody(request);
  } catch (error) {
    if (error instanceof ProtocolError && error.code === "INVALID_JSON") return null;
    throw error;
  }
}

// Library callers read the outcome from the body: they get HTTP 200 with an error envelope. Other callers get
// the real status. A sealed response carries the error in encrypted form either way.
async function failureResponse(error: unknown, state: CallState): Promise<Response> {
  const description = describeError(error);
  if (!state.library) {
    if (state.responseKey === null) return errorResponse(description);
    return jsonResponse(await sealV2Response(state.responseKey, describedErrorBody(description)), description.status);
  }
  const body = libraryErrorBody({
    status: description.status,
    code: description.code,
    message: description.message,
    requestId: state.requestId ?? traceIdentifier(),
    security: description.security,
    details: description.details,
    errorFields: description.errorFields,
  });
  if (state.responseKey === null) return jsonResponse(body, 200);
  return jsonResponse(await sealV2Response(state.responseKey, body), 200);
}

async function runCall(
  ctx: ServerContext,
  request: Request,
  url: URL,
  pathSlug: string | null,
  body: Readonly<Record<string, unknown>> | null,
  hasSecretKey: boolean,
  state: CallState,
): Promise<Response> {
  const { options } = ctx;
  const envelope = body !== null && isEncryptedBody(body) ? body : null;
  const view = ctx.view(targetsNext(request, url));
  if (pathSlug !== null && resolveEndpoint(ctx, view.catalog, pathSlug) === null) {
    throw new ProtocolError(404, "ENDPOINT_NOT_FOUND", `Endpoint "${pathSlug}" was not found.`);
  }
  const slug = resolveSlug(pathSlug, body, envelope !== null);
  const target = resolveEndpoint(ctx, view.catalog, slug);
  if (target === null) {
    throw new ProtocolError(404, "ENDPOINT_NOT_FOUND", `Endpoint "${slug}" was not found.`);
  }
  if (target.requiresSecretKey && !hasSecretKey) {
    throw new ProtocolError(
      401,
      "SECRET_KEY_REQUIRED",
      `Endpoint "${slug}" requires a Network Storage secret key. Send it in the x-secret-key header.`,
    );
  }
  const nowMs = ctx.now();

  const headerCredentials = credentialsOf(request, url, envelope ?? body);
  const presentedToken = readSessionToken(headerCredentials);
  const sessionId =
    presentedToken !== null && options.sessionSecret !== null && ctx.settings().security.enableAuthSessions
      ? (await verifyAuthSession(options.sessionSecret, presentedToken, options.projectId, nowMs)).id
      : null;

  let commandBody: Readonly<Record<string, unknown>> | null = body;
  let envelopeKind: EnvelopeKind = "none";
  let envelopeKeyFound = false;
  if (envelope !== null) {
    const claimed = claimedSteamId(headerCredentials);
    envelopeKind = envelopeKindOf(readField(envelope, "version"));
    if (envelopeKind === "unsupported") {
      throw new ProtocolError(400, "ENVELOPE_UNSUPPORTED", "The encrypted request version is not supported.");
    }
    if (envelopeKind === "v1") {
      const opened = await openV1Envelope({
        raw: envelope,
        apiKey: options.publicKey,
        projectId: options.projectId,
        endpointSlug: slug,
        steamId: claimed,
        sessionId,
      });
      state.requestId = opened.requestId;
      commandBody = opened.payload;
      envelopeKeyFound = true;
      await consumeEnvelopeId(ctx, opened.requestId, opened.identityKey, nowMs);
    } else {
      const key = findRequestKey(ctx, readField(envelope, "keyId"), nowMs);
      if (key === null) {
        throw new ProtocolError(401, "REQUEST_SIGNATURE_INVALID", "The encrypted request key is not recognised.");
      }
      const opened = await openV2Envelope({
        raw: envelope,
        projectId: options.projectId,
        endpointSlug: slug,
        key,
        steamId: claimed,
        sessionId,
      });
      state.requestId = opened.requestId;
      state.responseKey = opened.responseKey;
      commandBody = opened.payload;
      envelopeKeyFound = true;
      await consumeEnvelopeId(ctx, opened.requestId, opened.identityKey, nowMs);
    }
  }

  const config = await ctx.config.current(nowMs, false);
  const denial = securityDenial({
    project: ctx.settings().security,
    configVersion: config.configVersion,
    body: commandBody,
    hasSecretKey,
    presentedSession: presentedToken !== null,
    envelope: envelopeKind,
    envelopeKeyFound,
  });
  if (denial !== null) throw denial;

  const credentials = credentialsOf(request, url, commandBody);
  const identity = await resolvePlayer(
    credentials,
    claimedSteamId(credentials),
    identityOptionsFor(ctx, slug, nowMs),
  );
  if (identity.sessionId !== null && (await ctx.revocations.isRevoked(identity.sessionId))) {
    throw new ProtocolError(401, "AUTH_SESSION_REVOKED", "The auth session was revoked.");
  }

  const input =
    request.method === "GET"
      ? withoutReservedKeys(omitKeys(Object.fromEntries(url.searchParams), SHELL_KEYS))
      : withoutReservedKeys(omitKeys(commandBody ?? {}, SHELL_KEYS));

  const run = await executeEndpoint(ctx, view, target, {
    slug,
    method: request.method === "GET" ? "GET" : "POST",
    input,
    steamId: identity.steamId === "anonymous" ? null : identity.steamId,
    signal: request.signal,
    live: true,
  });
  if (state.responseKey === null) return jsonResponse(run.body, run.status);
  return jsonResponse(await sealV2Response(state.responseKey, run.body), run.status);
}

export interface EndpointCall {
  readonly slug: string;
  readonly method: "GET" | "POST";
  readonly input: Record<string, unknown>;
  // The steam id the call acts as. Null is anonymous.
  readonly steamId: string | null;
  readonly signal: AbortSignal;
  // Live calls apply their writes. A preview (the auto-test) runs them in memory only, as the reference's non-live runs do.
  readonly live: boolean;
}

export interface EndpointRun {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

// Runs a resolved endpoint in process and applies its writes. Returns the status and success body the endpoint declares.
export async function executeEndpoint(
  ctx: ServerContext,
  view: RuntimeView,
  target: { readonly handler: EndpointHandler; readonly execution: ExecutionMode },
  call: EndpointCall,
): Promise<EndpointRun> {
  const { options } = ctx;
  const outcome = await runEndpoint(
    target.handler,
    {
      input: call.input,
      player: call.steamId === null ? null : { steamId: call.steamId },
      method: call.method,
      endpoint: call.slug,
      revision: null,
    },
    {
      storage: view.storage,
      execution: target.execution,
      fetchPolicy: options.fetchPolicy,
      workflows: workflowsOf(ctx, view.catalog),
      globals: options.globals ?? {},
      secrets: options.secrets ?? NO_SECRETS,
      now: ctx.now,
      trackedFields: (collection) =>
        ctx.settings().security.legacyPlayerProjections === true ? trackedFieldsOf(view.catalog, collection) : [],
      log: options.log ?? (() => undefined),
      signal: call.signal,
    },
  );
  if (call.live && outcome.writes.length > 0) {
    await view.storage.apply(outcome.writes, { expectedVersions: outcome.expectedVersions });
  }
  if (call.live && call.steamId !== null) await markPlayerKnown(view, call.steamId);
  // Declarative endpoints return a DslResponse, which carries the HTTP status the document declares.
  const response = outcome.value instanceof DslResponse ? outcome.value : null;
  return { status: response?.status ?? 200, body: successBody(response === null ? outcome.value : response.body) };
}

// The reference upserts the caller's profile on every endpoint call. The marker is that profile here: it survives
// record deletes. Best-effort, like the reference: a raced or failed marker never fails the call.
async function markPlayerKnown(view: RuntimeView, steamId: string): Promise<void> {
  try {
    if ((await view.storage.records.get(PROFILES_COLLECTION, steamId)) !== null) return;
    await view.storage.apply(
      [{ op: "put", collection: PROFILES_COLLECTION, key: steamId, data: { steam_id: steamId } }],
      { expectedVersions: [{ collection: PROFILES_COLLECTION, key: steamId, version: 0 }] },
    );
  } catch {
    // Another call created the marker first, or the write failed; neither fails the endpoint call.
  }
}

// The route slug, or the one the body claims for a plain call. Encrypted bodies claim it inside the envelope,
// which the envelope open already binds, so only the route or the envelope field is read here.
function resolveSlug(pathSlug: string | null, body: Readonly<Record<string, unknown>> | null, encrypted: boolean): string {
  const claim = encrypted
    ? nonEmpty(body === null ? undefined : body.endpointSlug)
    : nonEmpty(body?._endpointSlug) ?? nonEmpty(body?.endpoint);
  if (pathSlug === null) {
    if (claim === null) throw new ProtocolError(400, "INVALID_REQUEST", "Missing endpoint slug.");
    return claim;
  }
  if (claim !== null && claim !== pathSlug && !encrypted) {
    throw new ProtocolError(400, "ENDPOINT_SLUG_MISMATCH", "The body names a different endpoint than the route.");
  }
  return pathSlug;
}

async function consumeEnvelopeId(
  ctx: ServerContext,
  requestId: string,
  identityKey: string,
  nowMs: number,
): Promise<void> {
  await consumeRequestId(ctx.options.replayStore, {
    projectId: ctx.options.projectId,
    identityKey,
    requestId,
    windowSeconds: clampReplayWindow(ctx.settings().security.encryptedRequestWindowSeconds),
    nowMs,
  });
}

// Finds the request key for an envelope. A retired key is accepted only while its grace window is open.
function findRequestKey(ctx: ServerContext, keyId: string, nowMs: number): LoadedRequestKey | null {
  const ring = ctx.options.requestKeys;
  if (ring === undefined) return null;
  const key = ring.keys.find((candidate) => candidate.keyId === keyId);
  if (key === undefined) return null;
  if (key.retiredAt === null) return key;
  if (key.graceUntil === null) return null;
  return nowMs < Date.parse(key.graceUntil) ? key : null;
}

function isEncryptedBody(body: Readonly<Record<string, unknown>>): boolean {
  return body.encrypted === true || "encryptedPayload" in body || "ciphertext" in body;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function omitKeys(raw: Readonly<Record<string, unknown>>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!keys.includes(key)) out[key] = value;
  }
  return out;
}

// A handler may return any value. Objects keep their fields; anything else is returned under `result`.
function successBody(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return { ok: true };
  if (isRecord(value)) return { ...value, ok: true };
  return { ok: true, result: value };
}
