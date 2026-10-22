import { ProtocolError } from "../protocol/errors.js";
import { claimedSteamId, resolvePlayer, type PlayerIdentity } from "../protocol/identity.js";
import { applyWriteOps, OperationError } from "../dsl/operations.js";
import type { CollectionDefinition, EndpointStorage, ExpectedVersion, RecordData, VersionedRecord } from "../storage/types.js";
import { isRecord } from "../util/guards.js";
import { jsonResponse } from "../util/http.js";
import { identityOptionsFor, type ServerContext } from "./context.js";
import { authorize } from "./endpoints.js";
import { BODY_NOT_OBJECT, credentialsOf, pathSegment, readJsonBody, readJsonValue } from "./http.js";
import { KeyRefusal } from "./auth-failure.js";
import { handleQuery } from "./query-routes.js";
import { LEDGER_COLLECTION, ledgerSummaryOf } from "../endpoint/ledger.js";
import { PROFILES_COLLECTION } from "./catalog.js";

// Direct record access (/storage/{project}/{collection}/{key}) and the runtime families built on the same storage.
// Secret-key callers bypass the document rules. Everything else is checked here, before storage is touched.

interface Access {
  readonly hasSecretKey: boolean;
}

// Global-collection appends are limited per writer per collection per UTC day, as the reference server does
// (8640 saves a day). Counters of earlier days are dropped on rollover.
const APPEND_SAVES_PER_DAY = 8640;
const appendCounts = new WeakMap<ServerContext, Map<string, number>>();

function appendCountsOf(ctx: ServerContext): Map<string, number> {
  const counts = appendCounts.get(ctx) ?? new Map<string, number>();
  appendCounts.set(ctx, counts);
  return counts;
}

// Counts one append by `writer` to `collectionId` against the UTC day containing `nowMs`; throws once over the limit.
export function takeAppendQuota(counts: Map<string, number>, nowMs: number, collectionId: string, writer: string): void {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  for (const key of counts.keys()) {
    if (!key.endsWith(`:${day}`)) counts.delete(key);
  }
  const scope = `${collectionId}:${writer}:${day}`;
  const count = (counts.get(scope) ?? 0) + 1;
  counts.set(scope, count);
  if (count > APPEND_SAVES_PER_DAY) {
    const perHour = Math.round(APPEND_SAVES_PER_DAY / 24);
    const perMinute = (APPEND_SAVES_PER_DAY / 1440).toFixed(1);
    throw new ProtocolError(
      429,
      "RATE_LIMIT_DAILY",
      `Rate limit exceeded for this player: max ${APPEND_SAVES_PER_DAY} saves per day (~${perHour}/hr, ~${perMinute}/min). Resets at midnight UTC.`,
    );
  }
}

const STEAM_ID = /^\d{17}$/;

// A refusal in the envelope the direct collection routes use (reference StorageApiEndpoints), not the library envelope.
// handleStorage turns it into the response.
class StorageRefusal extends Error {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;

  constructor(status: number, body: Readonly<Record<string, unknown>>) {
    super("The collection request was refused.");
    this.name = "StorageRefusal";
    this.status = status;
    this.body = body;
  }
}

function accessOf(ctx: ServerContext, request: Request, url: URL): Access {
  const access = authorize(ctx, request, url);
  if (access === null) throw new KeyRefusal();
  return access;
}

function declared(ctx: ServerContext, collectionId: string): CollectionDefinition | undefined {
  return ctx.catalog.collections.get(collectionId)?.compiled.definition;
}

function requireDeclared(ctx: ServerContext, collectionId: string): CollectionDefinition {
  const definition = declared(ctx, collectionId);
  if (definition === undefined) throw new StorageRefusal(404, { error: "NOT_FOUND", detail: "Collection not found." });
  return definition;
}

// The steam id the caller acts as: a verified identity when the project requires s&box auth, otherwise the claim.
async function playerOf(
  ctx: ServerContext,
  request: Request,
  url: URL,
  body: Readonly<Record<string, unknown>> | null,
): Promise<string> {
  const req = credentialsOf(request, url, body);
  const identity: PlayerIdentity = await resolvePlayer(
    req,
    claimedSteamId(req),
    identityOptionsFor(ctx, "storage", ctx.now()),
  );
  return identity.steamId;
}

// The direct-access rules, in order (reference AuthorizePublicDocumentAccessAsync): a secret key bypasses them; the
// collection must be public; deletes need allowRecordDelete; with s&box auth the caller is verified on every access,
// and non-global writes and deletes accept only the verified steam id or its save slots ("{steamId}_x").
async function guardAccess(
  ctx: ServerContext,
  request: Request,
  url: URL,
  definition: CollectionDefinition,
  op: "read" | "write" | "delete",
  key: string,
  access: Access,
  body: Readonly<Record<string, unknown>> | null,
): Promise<void> {
  if (access.hasSecretKey) return;
  const mode = String(definition.accessMode ?? "endpoint").toLowerCase();
  if (mode !== "public") {
    throw new StorageRefusal(403, { error: "ENDPOINT_ONLY", detail: "This collection can only be accessed through endpoints." });
  }
  if (op === "delete" && definition.allowRecordDelete !== true) {
    throw new StorageRefusal(403, { error: "RECORD_DELETE_DISABLED", detail: "Record deletion is not enabled for this collection." });
  }
  // Auth-disabled projects keep the unverified client identity and skip the ownership gate.
  if (!ctx.settings().requireSboxAuth) return;
  let steamId: string;
  try {
    steamId = await playerOf(ctx, request, url, body);
  } catch (error) {
    if (error instanceof ProtocolError) {
      throw new StorageRefusal(error.status, { error: error.code, detail: error.message });
    }
    throw error;
  }
  if (op === "read" || definition.collectionType === "global") return;
  if (!isOwnDocumentKey(key, steamId)) {
    throw new StorageRefusal(403, {
      error: "FORBIDDEN",
      detail: "Players can only modify their own documents: the key must be the verified Steam ID or start with '{steamId}_'.",
    });
  }
}

// A per-player document belongs to the player when keyed by their Steam ID or a save slot of it (reference IsOwnDocumentKey).
function isOwnDocumentKey(key: string, steamId: string): boolean {
  return key === steamId || (key.length > steamId.length + 1 && key.startsWith(`${steamId}_`));
}

function keyNotFound(): Response {
  return jsonResponse({ detail: "Key not found.", error: "NOT_FOUND" }, 404);
}

function recordNotFound(): Response {
  return jsonResponse(
    {
      error: {
        code: "RECORD_NOT_FOUND",
        docsUrl: "https://sboxcool.com/wiki/network-storage-v3/collections#save-slots",
        message: "Record not found.",
      },
    },
    404,
  );
}

function asDocument(body: unknown): RecordData {
  if (!isRecord(body)) throw new ProtocolError(400, "INVALID_BODY", BODY_NOT_OBJECT);
  return body;
}

// The planner rejects a put to any record the run has not observed. Routes read the target's version first and
// commit against it, so a concurrent change fails with CONFLICT instead of being overwritten.
function expecting(collection: string, key: string, observed: VersionedRecord): ExpectedVersion[] {
  return [{ collection, key, version: observed.version }];
}

function applyOps(existing: RecordData | null, ops: readonly unknown[]): RecordData {
  try {
    return applyWriteOps(existing, ops).data;
  } catch (error) {
    if (error instanceof OperationError) throw new ProtocolError(400, "INVALID_OPERATION", error.message);
    throw error;
  }
}

async function readDocument(
  ctx: ServerContext,
  request: Request,
  url: URL,
  collectionId: string,
  key: string,
  access: Access,
): Promise<Response> {
  const definition = declared(ctx, collectionId);
  // An undeclared collection has no definition to read against: the reference answers a plain miss (404 Key not found).
  if (definition === undefined) return keyNotFound();
  await guardAccess(ctx, request, url, definition, "read", key, access, null);
  const record = await ctx.storage().records.get(collectionId, key);
  if (record === null) return keyNotFound();
  return jsonResponse(record);
}

// The ledger rows for one player's _ledger fields, oldest first. A key with no record, no ledger rows, and no player
// marker is missing. The marker is written by endpoint calls and survives record deletes, as the reference profile does.
async function readLedger(
  ctx: ServerContext,
  request: Request,
  url: URL,
  collectionId: string,
  steamId: string,
  access: Access,
): Promise<Response> {
  const definition = declared(ctx, collectionId);
  if (definition !== undefined) await guardAccess(ctx, request, url, definition, "read", steamId, access, null);
  const storage = ctx.storage();
  const entries = (await storage.records.list(LEDGER_COLLECTION))
    .map((row) => row.data)
    .filter((row) => row["collection_id"] === collectionId && row["steam_id"] === steamId)
    .sort((a, b) => String(a["ts"]).localeCompare(String(b["ts"])));
  // Reference rule: a missing key has no ledger rows, no record, and no player profile. The _stats row and the
  // _profiles marker both stand in for the profile.
  if (entries.length === 0) {
    const record = definition === undefined ? null : await storage.records.get(collectionId, steamId);
    if (record === null && (await storage.records.get("_stats", steamId)) === null && (await storage.records.get(PROFILES_COLLECTION, steamId)) === null) {
      return keyNotFound();
    }
  }
  return jsonResponse({
    steamId,
    field: "all",
    from: null,
    to: null,
    entries,
    summary: ledgerSummaryOf(entries),
    cursor: null,
  });
}

async function writeDocument(
  ctx: ServerContext,
  request: Request,
  url: URL,
  collectionId: string,
  key: string,
  access: Access,
): Promise<Response> {
  const definition = requireDeclared(ctx, collectionId);
  const body = await readJsonValue(request);
  const document = asDocument(body);
  await guardAccess(ctx, request, url, definition, "write", key, access, document);
  const storage = ctx.storage();
  const ops = document["ops"];
  const observed = await storage.records.getVersioned(collectionId, key);
  const data = Array.isArray(ops) ? applyOps(observed.data, ops) : document;
  await storage.apply([{ op: "put", collection: collectionId, key, data }], { expectedVersions: expecting(collectionId, key, observed) });
  return jsonResponse({ ok: true });
}

async function deleteDocument(
  ctx: ServerContext,
  request: Request,
  url: URL,
  collectionId: string,
  key: string,
  access: Access,
): Promise<Response> {
  const definition = requireDeclared(ctx, collectionId);
  await guardAccess(ctx, request, url, definition, "delete", key, access, null);
  await ctx.storage().apply([{ op: "delete", collection: collectionId, key }]);
  return jsonResponse({ ok: true });
}

async function probeDocument(
  ctx: ServerContext,
  request: Request,
  url: URL,
  collectionId: string,
  key: string,
  access: Access,
): Promise<Response> {
  const definition = declared(ctx, collectionId);
  // An undeclared collection cannot hold a readable record here: the probe answers exists:false, as the read answers 404.
  if (definition === undefined) return jsonResponse({ exists: false, ok: true });
  await guardAccess(ctx, request, url, definition, "read", key, access, null);
  const record = await ctx.storage().records.get(collectionId, key);
  return jsonResponse({ exists: record !== null, ok: true });
}

function newId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

// Global collections: an append by the secret key creates a record with a server-assigned id and timestamp.
async function appendRecord(
  ctx: ServerContext,
  request: Request,
  url: URL,
  collectionId: string,
  access: Access,
): Promise<Response> {
  const definition = requireDeclared(ctx, collectionId);
  if (definition.collectionType !== "global") {
    throw new ProtocolError(400, "COLLECTION_TYPE_MISMATCH", "This is a per-steamid collection. Use an endpoint instead.");
  }
  if (!access.hasSecretKey) {
    throw new ProtocolError(403, "FORBIDDEN", "This secret key does not have execute access to collections.");
  }
  const body = await readJsonValue(request);
  if (!isRecord(body) || Object.keys(body).length === 0) {
    throw new ProtocolError(400, "INVALID_BODY", "Body must be a non-empty JSON object.");
  }

  const writer = await playerOf(ctx, request, url, body);
  takeAppendQuota(appendCountsOf(ctx), ctx.now(), collectionId, writer);
  const id = newId();
  const record = { ...body, _id: id, _timestamp: ctx.now(), _writerId: writer };
  const storage = ctx.storage();
  const observed = await storage.records.getVersioned(collectionId, id);
  await storage.apply([{ op: "put", collection: collectionId, key: id, data: record }], { expectedVersions: expecting(collectionId, id, observed) });
  return jsonResponse({ ok: true, record });
}

async function listRecords(ctx: ServerContext, collectionId: string): Promise<Response> {
  const records = await ctx.storage().records.list(collectionId);
  return jsonResponse({ cursor: null, records: records.map((record) => record.data) });
}

async function readRecord(ctx: ServerContext, collectionId: string, id: string): Promise<Response> {
  const record = await ctx.storage().records.get(collectionId, id);
  if (record === null) {
    return jsonResponse({ error: { code: "NOT_FOUND", message: "Record not found." } }, 404);
  }
  return jsonResponse(record);
}

// Save slots: per-player named saves stored under `{steamId}_{recordId}`.
const DEFAULT_SAVE_NAME = "Save";

async function listSaves(
  ctx: ServerContext,
  request: Request,
  url: URL,
  collectionId: string,
  steamId: string,
  access: Access,
): Promise<Response> {
  const definition = requireDeclared(ctx, collectionId);
  await guardAccess(ctx, request, url, definition, "read", `${steamId}_`, access, null);
  const prefix = `${steamId}_`;
  const stored = await ctx.storage().records.list(collectionId);
  const records = stored
    .filter((record) => record.key.startsWith(prefix))
    .map((record) => ({
      CreatedAt: record.data["createdAt"] ?? null,
      IsLegacy: false,
      RecordId: record.key.slice(prefix.length),
      RecordName: record.data["recordName"],
      UpdatedAt: record.data["updatedAt"] ?? null,
    }));
  return jsonResponse({ maxRecords: Math.max(1, definition.maxRecords ?? 0), records });
}

async function createSave(
  ctx: ServerContext,
  request: Request,
  url: URL,
  collectionId: string,
  steamId: string,
  access: Access,
): Promise<Response> {
  const definition = requireDeclared(ctx, collectionId);
  const body = await readJsonBody(request);
  const payload = body["data"];
  if (payload !== undefined && !isRecord(payload)) throw new ProtocolError(400, "INVALID_BODY", "data must be an object.");
  const name = typeof body["recordName"] === "string" && body["recordName"].trim() !== "" ? body["recordName"].trim() : DEFAULT_SAVE_NAME;
  const id = newId();
  const key = `${steamId}_${id}`;
  await guardAccess(ctx, request, url, definition, "write", key, access, body);
  const storage = ctx.storage();
  const observed = await storage.records.getVersioned(collectionId, key);
  const now = new Date(ctx.now()).toISOString();
  await storage.apply([{ op: "put", collection: collectionId, key, data: { recordName: name, data: payload ?? {}, createdAt: now, updatedAt: now } }], {
    expectedVersions: expecting(collectionId, key, observed),
  });
  return jsonResponse({ ok: true, recordId: id, recordName: name });
}

async function updateSave(
  ctx: ServerContext,
  request: Request,
  url: URL,
  collectionId: string,
  steamId: string,
  id: string,
  access: Access,
): Promise<Response> {
  const definition = requireDeclared(ctx, collectionId);
  const key = `${steamId}_${id}`;
  const body = await readJsonBody(request);
  await guardAccess(ctx, request, url, definition, "write", key, access, body);
  const storage = ctx.storage();
  const observed = await storage.records.getVersioned(collectionId, key);
  const existing = observed.data;
  if (existing === null) return recordNotFound();
  const name = typeof body["recordName"] === "string" ? body["recordName"] : existing["recordName"];
  const payload = isRecord(body["data"]) ? body["data"] : existing["data"];
  const now = new Date(ctx.now()).toISOString();
  await storage.apply([{ op: "put", collection: collectionId, key, data: { recordName: name, data: payload, createdAt: existing["createdAt"] ?? now, updatedAt: now } }], {
    expectedVersions: expecting(collectionId, key, observed),
  });
  return jsonResponse({ ok: true, recordId: id, recordName: name });
}

async function deleteSave(
  ctx: ServerContext,
  request: Request,
  url: URL,
  collectionId: string,
  steamId: string,
  id: string,
  access: Access,
): Promise<Response> {
  const definition = requireDeclared(ctx, collectionId);
  const key = `${steamId}_${id}`;
  await guardAccess(ctx, request, url, definition, "delete", key, access, null);
  const storage = ctx.storage();
  if ((await storage.records.get(collectionId, key)) === null) return recordNotFound();
  await storage.apply([{ op: "delete", collection: collectionId, key }]);
  return jsonResponse({ ok: true });
}

// Reference accrual (game-client-analytics-telemetry): credit the whole seconds elapsed since the previous
// heartbeat, clamped to [0, 120]. A first heartbeat, or one whose record has no prior timestamp, credits 2.
const HEARTBEAT_CREDIT_CAP_SECONDS = 120;
const HEARTBEAT_FALLBACK_SECONDS = 2;

function numberField(record: Record<string, unknown> | null, field: string): number {
  const value = record?.[field];
  return typeof value === "number" ? value : 0;
}

async function heartbeat(ctx: ServerContext, request: Request, url: URL): Promise<Response> {
  const body = await readJsonBody(request);
  const steamId = await playerOf(ctx, request, url, body);
  if (!STEAM_ID.test(steamId)) throw new ProtocolError(400, "INVALID_BODY", "A steam id is required.");
  const storage = ctx.storage();
  const observed = await storage.records.getVersioned("_stats", steamId);
  const existing = observed.data;
  const nowMs = ctx.now();
  const lastHeartbeat = new Date(nowMs).toISOString();
  const previousMs = numberField(existing, "lastHeartbeatUnixMs");
  const credit =
    previousMs > 0
      ? Math.min(Math.max(Math.trunc((nowMs - previousMs) / 1000), 0), HEARTBEAT_CREDIT_CAP_SECONDS)
      : HEARTBEAT_FALLBACK_SECONDS;
  const totalSeconds = existing === null ? HEARTBEAT_FALLBACK_SECONDS : numberField(existing, "totalSeconds") + credit;
  const stats = {
    ...existing,
    steamId,
    lastHeartbeat,
    lastHeartbeatUnixMs: nowMs,
    totalSeconds,
    ...(existing === null ? { firstSeen: lastHeartbeat } : {}),
  };
  await storage.apply([{ op: "put", collection: "_stats", key: steamId, data: stats }], {
    expectedVersions: expecting("_stats", steamId, observed),
  });
  return jsonResponse({
    ok: true,
    persisted: true,
    steamId,
    projectId: ctx.options.projectId,
    totalSeconds,
    lastHeartbeat,
  });
}

async function readStats(ctx: ServerContext, steamId: string): Promise<Response> {
  const existing = await ctx.storage().records.get("_stats", steamId);
  if (existing === null) {
    return jsonResponse(
      { error: { code: "NOT_FOUND", message: "No stats found for this player." } },
      404,
    );
  }
  return jsonResponse(existing);
}

async function recordEvent(ctx: ServerContext, request: Request, url: URL): Promise<Response> {
  const body = await readJsonBody(request);
  const type = typeof body["type"] === "string" && body["type"] !== "" ? body["type"] : body["code"];
  if (typeof type !== "string" || type === "") {
    throw new ProtocolError(400, "INVALID_ANALYTICS_EVENT", "A valid analytics event type or code is required.");
  }
  const steamId = await playerOf(ctx, request, url, body);
  const key = `${steamId}_${newId()}`;
  const event = {
    steamId,
    type,
    severity: body["severity"] ?? null,
    label: body["label"] ?? null,
    message: body["message"] ?? null,
    stack: body["stack"] ?? null,
    context: body["context"] ?? null,
    playerName: body["playerName"] ?? null,
    createdAt: new Date(ctx.now()).toISOString(),
  };
  const storage = ctx.storage();
  const observed = await storage.records.getVersioned("_analytics", key);
  await storage.apply([{ op: "put", collection: "_analytics", key, data: event }], { expectedVersions: expecting("_analytics", key, observed) });
  return jsonResponse({ ok: true, stored: true, reason: null });
}

// Rules as the game client reads them. This server stores and serves the rules; it does not enforce them.
export function rateLimitsResponse(ctx: ServerContext): Response {
  return jsonResponse({ endpointRateLimits: {}, ok: true, projectId: ctx.options.projectId, rules: ctx.catalog.rateLimitRules, source: "store" }, 200);
}

// Storage refusals and body errors use the reference's flat envelope: { error: CODE, detail }. A body that cannot be
// parsed carries the code alone, and an oversized body repeats its limit in detail and message.
function storageErrorResponse(error: ProtocolError): Response {
  if (error.code === "PAYLOAD_TOO_LARGE") {
    return jsonResponse({ detail: error.message, error: "PAYLOAD_TOO_LARGE", message: error.message }, 413);
  }
  if (error.code === "INVALID_JSON" || (error.code === "INVALID_BODY" && error.message === BODY_NOT_OBJECT)) {
    return jsonResponse({ error: "INVALID_BODY" }, 400);
  }
  return jsonResponse({ detail: error.message, error: error.code }, error.status);
}

// Entry point for everything under /storage/{project}/... after the project check. `rest` excludes the project.
// `family` is the URL family (v1, v3, or api). The api alias serves queries and saves; leaderboard list is v1/v3 only.
export async function handleStorage(
  ctx: ServerContext,
  request: Request,
  url: URL,
  rest: readonly string[],
  family: string,
): Promise<Response> {
  try {
    return await dispatchStorage(ctx, request, url, rest, family);
  } catch (error) {
    if (error instanceof StorageRefusal) return jsonResponse(error.body, error.status);
    if (error instanceof ProtocolError) return storageErrorResponse(error);
    throw error;
  }
}

async function dispatchStorage(
  ctx: ServerContext,
  request: Request,
  url: URL,
  rest: readonly string[],
  family: string,
): Promise<Response> {
  const access = accessOf(ctx, request, url);
  const method = request.method;
  const head = rest[0];
  const second = rest[1];
  const third = rest[2];

  if (head === undefined) {
    return jsonResponse({ detail: "Network Storage v3 endpoints require a project id.", error: "NOT_FOUND", ok: false }, 404);
  }
  if (head === "queries" && rest.length === 2 && second !== undefined && method === "GET") {
    return handleQuery(ctx, request, url, pathSegment(second));
  }
  if (head === "rate-limits" && rest.length === 1 && method === "GET") return rateLimitsResponse(ctx);
  if (head === "stats" && rest.length === 2 && second === "heartbeat" && method === "POST") {
    return heartbeat(ctx, request, url);
  }
  if (head === "stats" && rest.length === 2 && second !== undefined && method === "GET") {
    return readStats(ctx, pathSegment(second));
  }
  if (head === "analytics" && rest.length === 2 && second === "events" && method === "POST") {
    return recordEvent(ctx, request, url);
  }

  const collectionId = pathSegment(head);
  if (collectionId.includes("/") || collectionId.includes("\\") || collectionId === "." || collectionId === "..") {
    return jsonResponse({ detail: "Collection not found.", error: "NOT_FOUND" }, 404);
  }
  if (rest.length === 2 && second === "append" && method === "POST") {
    return appendRecord(ctx, request, url, collectionId, access);
  }
  if (
    rest.length === 2 &&
    second === "list" &&
    method === "GET" &&
    family !== "api" &&
    declared(ctx, collectionId)?.collectionType === "global"
  ) {
    await guardAccess(ctx, request, url, requireDeclared(ctx, collectionId), "read", "", access, null);
    return listRecords(ctx, collectionId);
  }
  if (
    rest.length === 3 &&
    second === "record" &&
    third !== undefined &&
    method === "GET" &&
    declared(ctx, collectionId)?.collectionType === "global"
  ) {
    await guardAccess(ctx, request, url, requireDeclared(ctx, collectionId), "read", "", access, null);
    return readRecord(ctx, collectionId, pathSegment(third));
  }
  if (rest.length === 3 && third === "probe" && second !== undefined && method === "GET") {
    return probeDocument(ctx, request, url, collectionId, pathSegment(second), access);
  }
  if (rest.length === 3 && third === "records" && second !== undefined && method === "GET") {
    return listSaves(ctx, request, url, collectionId, pathSegment(second), access);
  }
  if (rest.length === 3 && third === "records" && second !== undefined && method === "POST") {
    return createSave(ctx, request, url, collectionId, pathSegment(second), access);
  }
  const saveId = rest[3];
  if (rest.length === 4 && rest[2] === "records" && second !== undefined && saveId !== undefined && method === "PATCH") {
    return updateSave(ctx, request, url, collectionId, pathSegment(second), pathSegment(saveId), access);
  }
  if (rest.length === 4 && rest[2] === "records" && second !== undefined && saveId !== undefined && method === "DELETE") {
    return deleteSave(ctx, request, url, collectionId, pathSegment(second), pathSegment(saveId), access);
  }
  if (rest.length === 3 && third === "ledger" && second !== undefined && method === "GET") {
    const steamId = pathSegment(second);
    if (steamId.includes("/") || steamId.includes("\\") || steamId === "." || steamId === "..") return keyNotFound();
    return readLedger(ctx, request, url, collectionId, steamId, access);
  }
  if (rest.length === 2 && second !== undefined) {
    const key = pathSegment(second);
    if (key.includes("/") || key.includes("\\") || key === "." || key === "..") return keyNotFound();
    if (method === "GET") return readDocument(ctx, request, url, collectionId, key, access);
    if (method === "POST") return writeDocument(ctx, request, url, collectionId, key, access);
    if (method === "DELETE") return deleteDocument(ctx, request, url, collectionId, key, access);
  }
  return jsonResponse({ detail: "No route matches this path.", error: "NOT_FOUND", ok: false }, 404);
}
