import { DslResponse } from "../dsl/steps.js";
import { runEndpoint, ScriptFailure, type SecretStore } from "../endpoint/runtime.js";
import { PROFILES_COLLECTION, trackedFieldsOf, type Catalog } from "./catalog.js";
import { ProtocolError } from "../protocol/errors.js";
import { openV1Envelope } from "../protocol/envelope-v1.js";
import { openV2Envelope, sealV2Response, type V2ResponseKey } from "../protocol/envelope-v2.js";
import { readField } from "../protocol/fields.js";
import { clampReplayWindow, consumeRequestId } from "../protocol/replay.js";
import { claimedSteamId, readSessionToken, resolvePlayer } from "../protocol/identity.js";
import { isLibraryCaller, libraryErrorBody } from "../protocol/library.js";
import { envelopeKindOf, securityDenial, type EnvelopeKind } from "../protocol/security.js";
import { verifyAuthSession } from "../protocol/sessions.js";
import { isRecord } from "../util/guards.js";
import { jsonResponse, traceIdentifier } from "../util/http.js";
import { identityOptionsFor, type RuntimeView, type ServerContext } from "./context.js";
import { KeyRefusal } from "./auth-failure.js";
import { targetsNext } from "./publish-target.js";
import { credentialsOf, describeError, describedErrorBody, errorResponse, readJsonBody, safeEqual } from "./http.js";
import type { LoadedRequestKey } from "../protocol/crypto.js";
import type { EndpointHandler, ScriptModule, ScriptRunner, WorkflowFunction } from "../endpoint/types.js";
import type { ExecutionMode } from "../endpoint/execution.js";
import { aliasTable } from "../script/aliases.js";
import { loadScriptSandbox, ScriptEngineMissing } from "../script/load.js";
import { createScriptRunner } from "../script/sandbox.js";

// Query keys that carry auth or identity and never reach GET endpoint input. Matched case-insensitively, as the server does.
const RESERVED_QUERY_KEYS: Record<string, true> = {
  apikey: true,
  steamid: true,
  token: true,
  authsessiontoken: true,
  sessiontoken: true,
  encryptedrequestid: true,
  secretkey: true,
  networkstoragesecret: true,
  network_storage_secret_key: true,
};

// Routing fields removed from POST input. `_endpointSlug` is removed only when the body supplied the slug.
const ROUTING_KEYS = ["endpoint", "slug"] as const;

// No secrets are configured, so every name is absent. Handlers get null, never a value from elsewhere.
const NO_SECRETS: SecretStore = { get: () => null };

// The largest JSON body a script endpoint may return (the server's response limit).
const SCRIPT_RESPONSE_LIMIT_BYTES = 256 * 1024;

// Static endpoints from ServerOptions first, then the endpoints the editor pushed (compiled from DSL documents).
export function resolveEndpoint(
  ctx: ServerContext,
  catalog: Catalog,
  slug: string,
): { handler: EndpointHandler; requiresSecretKey: boolean; execution: ExecutionMode; script: ScriptModule | null } | null {
  if (Object.hasOwn(ctx.options.endpoints, slug)) {
    return { handler: ctx.options.endpoints[slug]!, requiresSecretKey: false, execution: "scripted", script: null };
  }
  const entry = catalog.endpoints.get(slug);
  // Internal endpoints are not served over HTTP. The reference answers them as not found.
  if (entry === undefined || !entry.enabled || entry.compiled.exposure === "internal" || entry.compiled.scope === "global") return null;
  return {
    handler: entry.compiled.handler,
    requiresSecretKey: entry.compiled.requiresSecretKey,
    script: entry.compiled.script?.module ?? null,
    execution: entry.compiled.script === null ? "declarative" : "scripted",
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
    request.method === "GET" ? queryInput(url) : bodyInput(commandBody, pathSlug !== null);

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
  readonly body: unknown;
}

// The modules a script endpoint can import, and the names it reads them under: each enabled global endpoint by its id and
// by its camelCase alias. A disabled global is not visible to scripts.
function scriptGlobalsOf(catalog: Catalog): { modules: ScriptModule[]; names: Map<string, string> } {
  const modules: ScriptModule[] = [];
  const ids: string[] = [];
  for (const entry of catalog.endpoints.values()) {
    if (!entry.enabled || entry.compiled.scope !== "global" || entry.compiled.script === null) continue;
    modules.push(entry.compiled.script.module);
    ids.push(entry.compiled.id);
  }
  const names = new Map(ids.map((id) => [id, id] as const));
  for (const [alias, id] of aliasTable(ids)) {
    if (!names.has(alias)) names.set(alias, id);
  }
  return { modules, names };
}

// The runner for one call. Its time budget is shared by every pass of the call. A missing engine is a typed 500.
async function scriptRunnerOf(ctx: ServerContext, catalog: Catalog): Promise<ScriptRunner> {
  try {
    await loadScriptSandbox();
  } catch (error) {
    if (error instanceof ScriptEngineMissing) throw new ScriptFailure("SCRIPT_ENGINE_MISSING", error.message, 500);
    throw error;
  }
  const globals = scriptGlobalsOf(catalog);
  const workflowIds = [...Object.keys(ctx.options.workflows ?? {}), ...catalog.workflows.keys()];
  return createScriptRunner({
    globals: globals.modules,
    globalNames: globals.names,
    workflowNames: aliasTable(workflowIds),
    budget: { spentMs: 0 },
  });
}

// Runs a resolved endpoint in process and applies its writes. Returns the status and success body the endpoint declares.
export async function executeEndpoint(
  ctx: ServerContext,
  view: RuntimeView,
  target: { readonly handler: EndpointHandler; readonly execution: ExecutionMode; readonly script: ScriptModule | null },
  call: EndpointCall,
): Promise<EndpointRun> {
  const { options } = ctx;
  const scripts = target.script === null ? undefined : await scriptRunnerOf(ctx, view.catalog);
  // Each secret a run reads is remembered, so the response and the writes can be checked for its value.
  const readSecrets = new Map<string, string>();
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
      secrets: recordingSecrets(options.secrets ?? NO_SECRETS, readSecrets),
      now: ctx.now,
      trackedFields: (collection) =>
        ctx.settings().security.legacyPlayerProjections === true ? trackedFieldsOf(view.catalog, collection) : [],
      log: options.log ?? (() => undefined),
      signal: call.signal,
      scripts,
    },
  ).catch((error: unknown) => {
    throw target.script === null ? error : publicScriptError(error);
  });
  // Declarative endpoints return a DslResponse, which carries the HTTP status the document declares.
  const response = outcome.value instanceof DslResponse ? outcome.value : null;
  const shown = redactSecrets(response === null ? outcome.value : response.body, readSecrets);
  // A script's return is its response as is. A declarative endpoint's success body carries `ok`.
  const body = target.script === null ? successBody(shown) : shown;
  if (target.script !== null && writesHoldSecret(outcome.writes, readSecrets)) {
    throw new ScriptFailure("SECRET_WRITE_FORBIDDEN", "Project secrets cannot be stored in records.", 400);
  }
  // A script's response is capped, and a rejected response never commits its writes.
  if (target.script !== null && new TextEncoder().encode(JSON.stringify(body)).byteLength > SCRIPT_RESPONSE_LIMIT_BYTES) {
    throw publicScriptError(new ScriptFailure("SCRIPT_LIMIT_EXCEEDED", "The endpoint exceeded a limit.", 500));
  }
  if (call.live && outcome.writes.length > 0) {
    await view.storage.apply(outcome.writes, { expectedVersions: outcome.expectedVersions });
  }
  if (call.live && call.steamId !== null) await markPlayerKnown(view, call.steamId);
  return { status: response?.status ?? 200, body };
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

// Mirrors the server's GET input: query string values minus reserved auth and identity keys.
function queryInput(url: URL): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    if (RESERVED_QUERY_KEYS[key.toLowerCase()] !== true) out[key] = value;
  }
  return out;
}

// Mirrors the server's POST input: the body, or its `input` / `args` object when present. Identity keys stay, since the server strips them only from encrypted payloads.
function bodyInput(body: Readonly<Record<string, unknown>> | null, slugFromPath: boolean): Record<string, unknown> {
  if (body === null) return {};
  const source = isRecord(body.input) ? body.input : isRecord(body.args) ? body.args : body;
  return omitKeys(source, slugFromPath ? ROUTING_KEYS : [...ROUTING_KEYS, "_endpointSlug"]);
}

// A handler may return any value. Objects keep their fields; anything else is returned under `result`.
function successBody(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return { ok: true };
  if (isRecord(value)) return { ...value, ok: true };
  return { ok: true, result: value };
}

// The server's message for a script's 5xx failure. It replaces the detail, so no internal text reaches the caller.
const GENERIC_SCRIPT_FAILURE = "An internal Network Storage error occurred while executing this endpoint.";

function publicScriptError(error: unknown): unknown {
  if (!(error instanceof ScriptFailure) || error.status < 500) return error;
  return new ScriptFailure(error.code, GENERIC_SCRIPT_FAILURE, error.status);
}

// Wraps the caller's secret store so every value a run reads is remembered under its name.
function recordingSecrets(store: SecretStore, read: Map<string, string>): SecretStore {
  return {
    get(name) {
      const found = store.get(name);
      if (found instanceof Promise) return found.then((value) => rememberSecret(name, value, read));
      return rememberSecret(name, found, read);
    },
  };
}

function rememberSecret(name: string, value: string | null, read: Map<string, string>): string | null {
  if (value !== null && value !== "") read.set(name, value);
  return value;
}

// Replaces each secret value a run read with `[secret:NAME]`, longest value first, in every string including keys.
function redactSecrets(value: unknown, read: ReadonlyMap<string, string>): unknown {
  if (read.size === 0) return value;
  const pairs = [...read].sort(longestFirst);
  return mapStrings(value, (text) => {
    let out = text;
    for (const [name, secret] of pairs) out = out.split(secret).join(`[secret:${name}]`);
    return out;
  });
}

// Whether any write carries a secret value a run read. The server rejects such a write rather than store it.
function writesHoldSecret(writes: unknown, read: ReadonlyMap<string, string>): boolean {
  if (read.size === 0) return false;
  let found = false;
  mapStrings(writes, (text) => {
    for (const secret of read.values()) {
      if (text.includes(secret)) found = true;
    }
    return text;
  });
  return found;
}

// Applies `fn` to every string of a JSON-like value: string leaves and object keys.
function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) items.push(mapStrings(item, fn));
    return items;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[fn(key)] = mapStrings(item, fn);
    return out;
  }
  return value;
}

function longestFirst(a: [string, string], b: [string, string]): number {
  return b[1].length - a[1].length;
}
