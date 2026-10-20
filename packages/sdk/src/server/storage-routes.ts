import { ProtocolError } from "../protocol/errors.js";
import { claimedSteamId, resolvePlayer, type PlayerIdentity } from "../protocol/identity.js";
import { applyWriteOps, OperationError } from "../dsl/operations.js";
import type { CollectionDefinition, EndpointStorage, ExpectedVersion, RecordData, VersionedRecord } from "../storage/types.js";
import { isRecord } from "../util/guards.js";
import { jsonResponse } from "../util/http.js";
import { identityOptionsFor, type ServerContext } from "./context.js";
import { authorize } from "./endpoints.js";
import { credentialsOf, pathSegment, readJsonBody, readJsonValue } from "./http.js";
import { handleQuery } from "./query-routes.js";
import { LEDGER_COLLECTION, ledgerSummaryOf } from "../endpoint/ledger.js";

// Direct record access (/storage/{project}/{collection}/{key}) and the runtime families built on the same storage.
// Secret-key callers bypass the document rules. Everything else is checked here, before storage is touched.

interface Access {
  readonly hasSecretKey: boolean;
}

// Successful Idempotency-Key appends, per server, so a replay returns the first response unchanged.
const idempotentAppends = new WeakMap<ServerContext, Map<string, Record<string, unknown>>>();

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
  if (access === null) throw new ProtocolError(401, "UNAUTHORIZED", "Invalid or missing API key.");
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
    throw new StorageRefusal(403, { ok: false, error: "ENDPOINT_ONLY", message: "This collection can only be accessed through endpoints." });
  }
  if (op === "delete" && definition.allowRecordDelete !== true) {
    throw new StorageRefusal(403, { ok: false, error: "RECORD_DELETE_DISABLED", message: "Record deletion is not enabled for this collection." });
  }
  // Auth-disabled projects keep the unverified client identity and skip the ownership gate.
  if (ctx.options.requireSboxAuth !== true) return;
  let steamId: string;
  try {
    steamId = await playerOf(ctx, request, url, body);
  } catch (error) {
    if (error instanceof ProtocolError) {
      throw new StorageRefusal(error.status, { ok: false, error: error.code, message: error.message });
    }
    throw error;
  }
  if (op === "read" || definition.collectionType === "global") return;
  if (!isOwnDocumentKey(key, steamId)) {
    throw new StorageRefusal(403, {
      ok: false,
      error: "FORBIDDEN",
      message: "Players can only modify their own documents: the key must be the verified Steam ID or start with '{steamId}_'.",
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
      ok: false,
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
  if (!isRecord(body)) throw new ProtocolError(400, "INVALID_BODY", "Body must be a JSON object.");
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
  // An undeclared collection keeps the plain read path: a stored document is still returned, a miss is 404.
  if (definition !== undefined) await guardAccess(ctx, request, url, definition, "read", key, access, null);
  const record = await ctx.storage().records.get(collectionId, key);
  if (record === null) return keyNotFound();
  return jsonResponse(record);
}

// The ledger rows for one player's _ledger fields, oldest first. A key with no record and no ledger rows is missing.
// The SDK has no separate player profile, so the record alone marks a player known.
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
  // Reference rule: a missing key has no ledger rows, no record, and no player profile. The stats row stands in for the profile.
  if (entries.length === 0) {
    const record = definition === undefined ? null : await storage.records.get(collectionId, steamId);
    if (record === null && (await storage.records.get("_stats", steamId)) === null) return keyNotFound();
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
  // The existence probe shares the read path: an undeclared collection answers from storage, not a fixed false.
  if (definition !== undefined) await guardAccess(ctx, request, url, definition, "read", key, access, null);
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
    throw new ProtocolError(400, "COLLECTION_TYPE_MISMATCH", "Only global collections accept appends.");
  }
  if (!access.hasSecretKey) {
    throw new ProtocolError(403, "FORBIDDEN", "Appending to this collection requires the secret key.");
  }
  const body = await readJsonValue(request);
  if (!isRecord(body) || Object.keys(body).length === 0) {
    throw new ProtocolError(400, "INVALID_BODY", "Body must be a non-empty JSON object.");
  }
  const idempotencyKey = request.headers.get("Idempotency-Key");
  const replays = idempotentAppends.get(ctx) ?? new Map<string, Record<string, unknown>>();
  idempotentAppends.set(ctx, replays);
  const replayKey = idempotencyKey === null ? null : `${collectionId}:${idempotencyKey}`;
  const replay = replayKey === null ? undefined : replays.get(replayKey);
  if (replay !== undefined) return jsonResponse(replay);

  const writer = await playerOf(ctx, request, url, body);
  takeAppendQuota(appendCountsOf(ctx), ctx.now(), collectionId, writer);
  const id = newId();
  const record = { ...body, _id: id, _timestamp: ctx.now(), _writerId: writer };
  const storage = ctx.storage();
  const observed = await storage.records.getVersioned(collectionId, id);
  await storage.apply([{ op: "put", collection: collectionId, key: id, data: record }], { expectedVersions: expecting(collectionId, id, observed) });
  const response = { ok: true, record };
  if (replayKey !== null) replays.set(replayKey, response);
  return jsonResponse(response);
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
  return jsonResponse({ ok: true, record });
}

// Save slots: per-player named saves stored under `{steamId}_{recordId}`.
const DEFAULT_SAVE_NAME = "Untitled save";

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
    .map((record) => ({ id: record.key.slice(prefix.length), recordName: record.data["recordName"], data: record.data["data"] }));
  return jsonResponse({ ok: true, maxRecords: Math.max(1, definition.maxRecords ?? 0), records });
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
  await storage.apply([{ op: "put", collection: collectionId, key, data: { recordName: name, data: payload ?? {} } }], {
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
  await storage.apply([{ op: "put", collection: collectionId, key, data: { recordName: name, data: payload } }], {
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

// Per-player stats: one record per steam id, with the latest seconds reported for each session.
function numbersOf(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(value)) return out;
  for (const [sessionId, seconds] of Object.entries(value)) {
    if (typeof seconds === "number") out[sessionId] = seconds;
  }
  return out;
}

async function heartbeat(ctx: ServerContext, request: Request, url: URL): Promise<Response> {
  const body = await readJsonBody(request);
  const steamId = await playerOf(ctx, request, url, body);
  if (!STEAM_ID.test(steamId)) throw new ProtocolError(400, "INVALID_BODY", "A steam id is required.");
  const sessionId = typeof body["sessionId"] === "string" ? body["sessionId"] : "default";
  const sessionSeconds = typeof body["sessionSeconds"] === "number" && body["sessionSeconds"] >= 0 ? body["sessionSeconds"] : 0;
  const storage = ctx.storage();
  const observed = await storage.records.getVersioned("_stats", steamId);
  const existing = observed.data;
  const sessions = { ...numbersOf(existing?.["sessions"]), [sessionId]: sessionSeconds };
  const totalSeconds = Object.values(sessions).reduce((sum, seconds) => sum + seconds, 0);
  const lastHeartbeat = new Date(ctx.now()).toISOString();
  await storage.apply([{ op: "put", collection: "_stats", key: steamId, data: { sessions, totalSeconds, lastHeartbeat } }], {
    expectedVersions: expecting("_stats", steamId, observed),
  });
  return jsonResponse({
    ok: true,
    persisted: true,
    projectId: ctx.options.projectId,
    steamId,
    totalSeconds,
    lastHeartbeat,
  });
}

async function readStats(ctx: ServerContext, steamId: string): Promise<Response> {
  const existing = await ctx.storage().records.get("_stats", steamId);
  return jsonResponse({
    ok: true,
    projectId: ctx.options.projectId,
    steamId,
    totalSeconds: existing?.["totalSeconds"] ?? 0,
    lastHeartbeat: existing?.["lastHeartbeat"] ?? null,
  });
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
  return jsonResponse({ ok: true, projectId: ctx.options.projectId, rules: ctx.catalog.rateLimitRules }, 200);
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
