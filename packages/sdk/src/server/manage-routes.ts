import { ScriptFailure } from "../endpoint/runtime.js";
import { ProtocolError } from "../protocol/errors.js";
import { isRecord } from "../util/guards.js";
import { jsonResponse } from "../util/http.js";
import {
  checkRecord,
  deleteResource,
  KIND_LABEL,
  storedFor,
  documentOf,
  patchedRecord,
  promoteStaged,
  stagedRecordOf,
  rateLimitRuleView,
  storedRecordOf,
  upsertGameValues,
  writeCompiled,
  scriptGraphFault,
  type Compiled,
  type EndpointEntry,
  type RecordCheck,
  type StoredQuery,
  type ResourceKind,
  type Catalog,
} from "./catalog.js";
import type { ManagedSettings, RuntimeView, ServerContext } from "./context.js";
import { authorize, executeEndpoint, resolveEndpoint } from "./endpoints.js";
import { KeyRefusal, UnknownRoute } from "./auth-failure.js";
import { applySettingsText, managementSettingsView } from "./management-settings.js";
import { describeError, describedErrorBody, pathSegment, readBodyText, readJsonBody, readJsonValue, safeEqual } from "./http.js";
import { decidePublish, targetsNext, withPublishTarget, type PublishDecision } from "./publish-target.js";
import { parseQuery } from "./query-routes.js";
import { SYNC_JOB_MESSAGE_ACCEPTED, startEndpointSync, writeEndpointBatch } from "./sync-jobs.js";
import { upgradeSource } from "./source-upgrade.js";

// Editor-facing management API. Every route needs the secret key except revision-init, which the game client
// calls with its public key. Section writes are all-or-nothing: a batch that fails to compile changes nothing.

const KINDS: readonly ResourceKind[] = ["endpoints", "collections", "workflows"];
// One record of a section: the compiled form, or the check it failed.
interface SectionItem {
  readonly slot: number;
  readonly raw: unknown;
  readonly check: RecordCheck;
}

// A section of a request. A non-array value sets shapeError; otherwise every record is checked and the section is ok
// only when all of them passed.
interface Section {
  readonly kind: ResourceKind;
  readonly shapeError: string | null;
  readonly items: readonly SectionItem[];
  readonly compiled: readonly Compiled[];
  readonly ok: boolean;
  readonly message: string | null;
}

function noRoute(): UnknownRoute {
  return new UnknownRoute("This Network Storage route is not recognized.");
}

function requireSecret(ctx: ServerContext, request: Request): string {
  const secret = ctx.options.secretKey;
  const presented = request.headers.get("x-secret-key") ?? request.headers.get("x-api-key");
  if (secret === null || presented === null || !safeEqual(presented, secret)) {
    throw new KeyRefusal();
  }
  return secret;
}

function arrayOf(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ProtocolError(400, "VALIDATION_FAILED", `Body must be an array of ${label} objects.`);
  }
  return value;
}

// The name field a PUT record is identified by, besides its id.
const PUT_NAME_FIELD: Readonly<Record<ResourceKind, string>> = { endpoints: "slug", collections: "name", workflows: "name" };

// The checks a PUT body gets before any record compiles: an array of objects, each with its name field or an id. The
// messages are the reference's for each failure. Null when the body passes.
function putShapeError(kind: ResourceKind, value: unknown): string | null {
  const label = KIND_LABEL[kind];
  if (!Array.isArray(value)) return `Body must be an array of ${label} objects.`;
  const field = PUT_NAME_FIELD[kind];
  for (const item of value) {
    if (!isRecord(item)) return `Each ${label} must be an object.`;
    const named = [item[field], item["id"]].some((entry) => typeof entry === "string" && entry.trim() !== "");
    if (!named) return `Each ${label} must have '${field}' or 'id'.`;
  }
  return null;
}

function kindOfPath(segment: string | undefined): ResourceKind | null {
  return KINDS.find((kind) => kind === segment) ?? null;
}

// One section of a request, checked record by record. A non-array value fails the section, never the request. Nothing
// is committed unless every section passed.
function compileSection(ctx: ServerContext, catalog: Catalog, kind: ResourceKind, value: unknown): Section {
  if (!Array.isArray(value)) {
    const shapeError = `${KIND_LABEL[kind]}s must be an array`;
    return { kind, shapeError, items: [], compiled: [], ok: false, message: shapeError };
  }
  const items = value.map((raw, slot) => ({ slot, raw, check: checkRecord(kind, raw, ctx.options.parseYaml) }));
  const faults = items.flatMap((item) => (item.check.ok ? [] : [item.check.fault]));
  const compiled = items.flatMap((item) => (item.check.ok ? [item.check.item] : []));
  // Cross-document script checks run once every record compiles, over the catalog with this section applied.
  const graph = faults.length === 0 && kind === "endpoints" ? scriptGraphFault(catalog, compiled) : null;
  if (graph !== null) faults.push({ stage: "definition", code: graph.code, message: graph.message, sourcePath: null, suggestedFix: null });
  return {
    kind,
    shapeError: null,
    items,
    compiled,
    ok: faults.length === 0,
    message: faults[0]?.message ?? null,
  };
}

// The id a record is listed and reported under in preflight: the first of slug/id/sourcePath (endpoints), name/id/
// sourcePath (collections), or id/name/sourcePath (workflows), else the kind and slot.
function previewId(kind: ResourceKind, record: unknown, slot: number): string {
  const field = (key: string): string | undefined => {
    if (!isRecord(record)) return undefined;
    const value = record[key];
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  };
  const order = kind === "endpoints" ? ["slug", "id"] : kind === "collections" ? ["name", "id"] : ["id", "name"];
  for (const key of [...order, "sourcePath"]) {
    const value = field(key);
    if (value !== undefined) return value;
  }
  return `${KIND_LABEL[kind]}[${slot}]`;
}

// Collection names should be lowercase letters, numbers, or underscores. A name outside that set is a warning; the
// push still stores it.
function nameWarnings(kind: ResourceKind, stored: Readonly<Record<string, unknown>>, resourceId: string): Record<string, unknown>[] {
  const name = stored["name"];
  if (kind !== "collections" || typeof name !== "string" || name === "" || /^[a-z0-9_]+$/.test(name)) return [];
  return [
    {
      severity: "warning",
      code: "COLLECTION_NAME_FORMAT",
      message: "Collection name should be lowercase letters, numbers, or underscores.",
      resourceKind: KIND_LABEL[kind],
      resourceId,
      sourcePath: "name",
      suggestedFix: "Use a collection name like player_data.",
    },
  ];
}

// One record's report. Sync answers the upsert or the fault that stopped it. Preflight answers the diagnostics a write
// would raise, and would_create or would_update for a record that passes.
function itemReport(
  catalog: Catalog,
  kind: ResourceKind,
  item: SectionItem,
  mode: "sync" | "preflight",
): { report: Record<string, unknown>; warnings: number } {
  const label = KIND_LABEL[kind];
  const check = item.check;
  if (mode === "sync") {
    if (check.ok) return { report: { ok: true, resourceKind: label, resourceId: check.item.id, action: "upsert" }, warnings: 0 };
    const message = check.fault.stage === "identifier" ? `${label} is missing a required identifier field.` : check.fault.message;
    const error = check.fault.stage === "source" ? "SOURCE_COMPILE_FAILED" : "VALIDATION_FAILED";
    return { report: { ok: false, resourceKind: label, resourceId: `${label}[${item.slot}]`, error, message }, warnings: 0 };
  }
  if (!check.ok) {
    const resourceId = previewId(kind, check.stored ?? item.raw, item.slot);
    const fault = check.fault;
    const diagnostic = { severity: "error", code: fault.code, message: fault.message, resourceKind: label, resourceId, sourcePath: fault.sourcePath, suggestedFix: fault.suggestedFix };
    return { report: { ok: false, resourceKind: label, resourceId, error: "VALIDATION_FAILED", diagnostics: [diagnostic] }, warnings: 0 };
  }
  const resourceId = previewId(kind, check.stored, item.slot);
  const diagnostics = nameWarnings(kind, check.stored, resourceId);
  const action = documentOf(catalog, kind, check.item.id) === undefined ? "would_create" : "would_update";
  return { report: { ok: true, resourceKind: label, resourceId, action, diagnostics }, warnings: diagnostics.length };
}

// One section's report. A non-array section fails with its message. Otherwise every record reports; a failing section
// makes the request a 400.
function sectionReport(catalog: Catalog, section: Section, mode: "sync" | "preflight"): Record<string, unknown> {
  if (section.shapeError !== null) {
    const failure = { ok: false, error: "VALIDATION_FAILED", message: section.shapeError, results: [] };
    return mode === "preflight" ? { ...failure, total: 0, passed: 0, failed: 1, warnings: 0 } : failure;
  }
  const reports = section.items.map((item) => itemReport(catalog, section.kind, item, mode));
  const results = reports.map((entry) => entry.report);
  if (mode === "sync") return { ok: section.ok, total: results.length, results };
  const failed = section.items.filter((item) => !item.check.ok).length;
  const warnings = reports.reduce((count, entry) => count + entry.warnings, 0);
  return { ok: section.ok, total: results.length, passed: results.length - failed, failed, warnings, results };
}

// Builds the response for a set of sections. A failing section returns 400 and nothing is committed by the caller.
function sectionsResponse(
  catalog: Catalog,
  sections: readonly Section[],
  mode: "sync" | "preflight",
  decision: PublishDecision,
): Response {
  const reports: Record<string, Record<string, unknown>> = {};
  for (const section of sections) reports[section.kind] = sectionReport(catalog, section, mode);
  const ok = sections.every((section) => section.ok);
  if (mode === "preflight") return preflightResponse(reports, ok, decision === "staged" ? "next" : "live");
  return jsonResponse(withPublishTarget({ ok, source: "candidate", ...reports }, decision), ok ? 200 : 400);
}

// The reference's preflight envelope: mode, publish target, a summary across sections, and a top-level error when
// any section fails.
function preflightResponse(
  reports: Record<string, Record<string, unknown>>,
  ok: boolean,
  publishTarget: "live" | "next",
): Response {
  const values = Object.values(reports);
  const sum = (key: string): number =>
    values.reduce((total, report) => {
      const count = report[key];
      return typeof count === "number" ? total + count : total;
    }, 0);
  const failed = sum("failed");
  const warnings = sum("warnings");
  const nextAction =
    failed > 0
      ? "Fix the listed validation errors, then retry Push All."
      : warnings > 0
        ? "Review warnings, then Push All can proceed."
        : "Push All can proceed.";
  const outcome = ok
    ? { message: "Preflight validation passed. No resources were written." }
    : { error: "PREFLIGHT_VALIDATION_FAILED", message: "Preflight validation failed. No resources were written." };
  const summary = { total: sum("total"), success: sum("passed"), failed, warnings, nextAction };
  return jsonResponse({ ok, mode: "preflight", publishTarget, ...reports, summary, ...outcome }, ok ? 200 : 400);
}

// The documents a list returns. With includeStaged, the staged copies follow the live documents, marked as the next
// revision. Workflows have no staged revision.
function documentsOf(ctx: ServerContext, kind: ResourceKind, includeStaged: boolean): unknown[] {
  const live =
    kind === "endpoints"
      ? [...ctx.catalog.endpoints.values()].map((entry) => entry.stored)
      : kind === "collections"
        ? [...ctx.catalog.collections.values()].map((entry) => entry.stored)
        : [...ctx.catalog.workflows.values()].map((entry) => entry.stored);
  if (!includeStaged || kind === "workflows") return live;
  const staged = kind === "endpoints" ? ctx.catalog.staged.endpoints : ctx.catalog.staged.collections;
  const copies = [...staged.values()].map((record) => ({ ...storedFor(kind, record, ctx.options.parseYaml), revisionTarget: "next" }));
  return [...live, ...copies];
}

// Staged copies join a list only when asked for with includeStaged=true; revisionTarget=live keeps the list live.
function includeStagedOf(url: URL): boolean {
  if (url.searchParams.get("revisionTarget")?.trim().toLowerCase() === "live") return false;
  const flag = url.searchParams.get("includeStaged")?.trim().toLowerCase();
  return flag === "true" || flag === "1";
}

export async function handleManage(
  ctx: ServerContext,
  request: Request,
  url: URL,
  rest: readonly string[],
): Promise<Response> {
  const [head, second] = rest;
  const method = request.method;
  if (head === "revision-init" && rest.length === 1 && method === "POST") {
    return revisionInit(ctx, request, url);
  }
  requireSecret(ctx, request);
  if (head === "validate" && rest.length === 1 && method === "GET") return validateRoute(ctx, request);
  if ((head === "settings" || head === "config") && rest.length === 1 && method === "GET") {
    return jsonResponse(settingsResponse(ctx, ctx.settings()), 200);
  }
  if (head === "settings" && rest.length === 1 && method === "PUT") return putSettings(ctx, request);
  if (head === "game-values" && rest.length === 1) return gameValuesRoute(ctx, request);
  if (head === "sync" && second === "preflight" && rest.length === 2 && method === "POST") {
    return preflight(ctx, request, url);
  }
  if (head === "sync" && rest.length === 1 && method === "PUT") return syncAll(ctx, request, url);
  if (head === "sync-jobs" && rest.length === 2 && method === "GET") {
    return syncJobRoute(ctx, pathSegment(second ?? ""));
  }
  if (head === "package-sync" && rest.length === 1 && method === "POST") return packageSync(ctx, request);
  if (head === "game-package" && rest.length === 1 && method === "GET") {
    const gamePackage = ctx.catalog.gamePackage;
    return jsonResponse({ ok: true, gamePackage: gamePackage === null ? null : withUnixTimestamps(gamePackage) }, 200);
  }
  if (head === "source-upgrade" && rest.length === 1 && method === "POST") return sourceUpgrade(ctx, request);
  if (head === "auto-test" && rest.length === 1 && method === "POST") return autoTest(ctx, request, url);
  if (head === "tests" && rest.length === 1 && method === "GET") {
    return jsonResponse({ ok: true, data: ctx.catalog.tests }, 200);
  }
  if (head === "tests" && rest.length === 1 && method === "PUT") return putTests(ctx, request);
  if (head === "rate-limit-rules" && rest.length === 1 && method === "GET") {
    return jsonResponse(
      { ok: true, projectId: ctx.options.projectId, source: "configuration", endpointRateLimits: null, rules: ctx.catalog.rateLimitRules.map(rateLimitRuleView) },
      200,
    );
  }
  if (head === "rate-limit-rules" && rest.length === 1 && (method === "PUT" || method === "POST")) {
    return putRateLimits(ctx, request);
  }
  if (head === "rate-limit-rules" && rest.length === 1 && method === "DELETE") {
    return ctx.commit((draft) => {
      draft.catalog.rateLimitRules = [];
      return jsonResponse({ ok: true, source: "candidate", resourceKind: "rate-limit-rules", action: "delete" }, 200);
    });
  }
  if (head === "queries") return queriesRoute(ctx, request, rest);
  const kind = kindOfPath(head);
  if (kind !== null) return kindRoute(ctx, request, url, kind, rest);
  throw noRoute();
}

// Reports the secret key (already checked) and the public key the editor sends in x-public-key. The public key must
// be this project's public key; a secret key sent in its place is named as such.
function validateRoute(ctx: ServerContext, request: Request): Response {
  const presented = request.headers.get("x-public-key") ?? "";
  let publicKey: { ok: boolean; message: string };
  if (presented === "") {
    publicKey = { ok: false, message: "Not provided" };
  } else if (safeEqual(presented, ctx.options.publicKey)) {
    publicKey = { ok: true, message: "Valid" };
  } else if (ctx.options.secretKey !== null && safeEqual(presented, ctx.options.secretKey)) {
    publicKey = { ok: false, message: "Not a public key" };
  } else {
    publicKey = { ok: false, message: "Invalid" };
  }
  return jsonResponse(
    {
      ok: true,
      project: { id: ctx.options.projectId, title: ctx.options.projectId, settings: { enabled: true } },
      checks: {
        projectId: { ok: true, message: "Found" },
        secretKey: { ok: true, message: "Valid" },
        publicKey,
      },
    },
    200,
  );
}

// Settings and config are the same document: the settings under both keys, plus the two flags the library reads.
function settingsResponse(ctx: ServerContext, source: ManagedSettings): Record<string, unknown> {
  const settings = managementSettingsView(source);
  return {
    ok: true,
    projectId: ctx.options.projectId,
    settings,
    config: settings,
    enableAuthSessions: settings["enableAuthSessions"],
    enableEncryptedRequests: settings["enableEncryptedRequests"],
  };
}

async function gameValuesRoute(ctx: ServerContext, request: Request): Promise<Response> {
  if (request.method === "GET") {
    return jsonResponse({ ok: true, data: { items: [...ctx.catalog.gameValues.values()] } }, 200);
  }
  if (request.method !== "PUT") throw noRoute();
  const body = await readJsonBody(request);
  const records: Record<string, unknown>[] = [];
  for (const item of arrayOf(body["items"], "game value")) {
    if (!isRecord(item) || typeof item["id"] !== "string" || (item["type"] !== "group" && item["type"] !== "table")) {
      throw new ProtocolError(400, "VALIDATION_FAILED", "Each game value needs an id and a type of group or table.");
    }
    records.push(item);
  }
  return ctx.commit((draft) => {
    upsertGameValues(draft.catalog, records);
    return jsonResponse({ ok: true, action: "upsert", resourceKind: "game-values", source: "candidate" }, 200);
  });
}

async function preflight(ctx: ServerContext, request: Request, url: URL): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof ProtocolError && error.code === "INVALID_JSON") {
      return jsonResponse({ ok: false, mode: "preflight", error: "INVALID_JSON", message: "Body must be valid JSON." }, 400);
    }
    throw error;
  }
  const sections = KINDS.filter((kind) => Object.hasOwn(body, kind)).map((kind) => compileSection(ctx, ctx.catalog, kind, body[kind]));
  return sectionsResponse(ctx.catalog, sections, "preflight", targetsNext(request, url) ? "staged" : "live");
}

async function syncAll(ctx: ServerContext, request: Request, url: URL): Promise<Response> {
  const body = await readJsonBody(request);
  const next = targetsNext(request, url);
  return ctx.commit((draft) => {
    const decision = decidePublish(next, draft.catalog.gamePackage);
    const sections = KINDS.filter((kind) => Object.hasOwn(body, kind)).map((kind) => compileSection(ctx, draft.catalog, kind, body[kind]));
    // All-or-nothing across kinds: nothing is committed unless every section compiled.
    if (sections.every((section) => section.ok)) {
      for (const section of sections) writeCompiled(draft.catalog, section.compiled, decision === "staged");
    }
    return sectionsResponse(draft.catalog, sections, "sync", decision);
  });
}

// A failed write answers 400 with the reference's error envelope and commits nothing.
function writeFailure(kind: ResourceKind, message: string | null, decision: PublishDecision = "live"): Response {
  return jsonResponse(
    withPublishTarget(
      { ok: false, resourceKind: KIND_LABEL[kind], error: { code: "VALIDATION_FAILED", message: message ?? "Validation failed." } },
      decision,
    ),
    400,
  );
}

// PUT endpoints?async=true. The body is parsed and written by a background job that the caller polls. The reference
// answers 202 without a publish target.
async function asyncEndpointSync(ctx: ServerContext, request: Request, url: URL): Promise<Response> {
  const text = await readBodyText(request);
  const jobId = startEndpointSync(ctx, text, targetsNext(request, url), url.searchParams.get("replaceAll") === "true");
  return jsonResponse({ ok: true, jobId, status: "accepted", message: SYNC_JOB_MESSAGE_ACCEPTED }, 202);
}

async function kindRoute(
  ctx: ServerContext,
  request: Request,
  url: URL,
  kind: ResourceKind,
  rest: readonly string[],
): Promise<Response> {
  const method = request.method;
  const label = KIND_LABEL[kind];
  if (rest.length === 1 && method === "GET") {
    return jsonResponse({ ok: true, data: documentsOf(ctx, kind, includeStagedOf(url)) }, 200);
  }
  // Workflows have no staged revision and always publish live. The publish target is decided inside each commit, from
  // the catalog the write lands on.
  const next = targetsNext(request, url);
  if (rest.length === 1 && method === "PUT") {
    if (kind === "endpoints" && url.searchParams.get("async") === "true") {
      return asyncEndpointSync(ctx, request, url);
    }
    const records = await readJsonValue(request);
    const replaceAll = url.searchParams.get("replaceAll") === "true";
    return ctx.commit((draft) => {
      const decision: PublishDecision = kind === "workflows" ? "live" : decidePublish(next, draft.catalog.gamePackage);
      const staged = decision === "staged";
      const shapeError = putShapeError(kind, records);
      if (shapeError !== null) return writeFailure(kind, shapeError, decision);
      const section = compileSection(ctx, draft.catalog, kind, records);
      if (!section.ok) return writeFailure(kind, section.message, decision);
      if (kind === "endpoints") {
        writeEndpointBatch(draft.catalog, section.compiled, staged, replaceAll);
      } else {
        writeCompiled(draft.catalog, section.compiled, staged);
      }
      const results = section.compiled.map((item) => ({ action: "upsert", ok: true, resourceId: item.id, resourceKind: label }));
      return jsonResponse(withPublishTarget({ ok: true, resourceKind: label, results, source: "candidate" }, decision), 200);
    });
  }
  if (rest.length === 1 && method === "PATCH") {
    const value = await readJsonValue(request);
    return ctx.commit((draft) => {
      const decision: PublishDecision = kind === "workflows" ? "live" : decidePublish(next, draft.catalog.gamePackage);
      const staged = decision === "staged";
      // A single resource may arrive bare or nested under its kind name.
      const incoming = isRecord(value) && isRecord(value[label]) && value["id"] === undefined ? value[label] : value;
      if (!isRecord(incoming)) return writeFailure(kind, `Body must contain a ${label} object.`, decision);
      const first = compileSection(ctx, draft.catalog, kind, [incoming]);
      const [only] = first.compiled;
      if (only === undefined || !first.ok) return writeFailure(kind, first.message, decision);
      // A staged patch merges over the staged copy when one exists, otherwise over the stored record. The existing
      // document is the one the patch applies to, so it decides between created, updated and unchanged.
      const stagedRecord = staged ? stagedRecordOf(draft.catalog, kind, only.id) : undefined;
      const existing =
        stagedRecord === undefined
          ? documentOf(draft.catalog, kind, only.id)
          : storedFor(kind, stagedRecord, ctx.options.parseYaml);
      const merged = patchedRecord(stagedRecord ?? storedRecordOf(draft.catalog, kind, only.id), incoming);
      const section = compileSection(ctx, draft.catalog, kind, [merged]);
      const [item] = section.compiled;
      if (item === undefined || !section.ok) return writeFailure(kind, section.message, decision);
      const action =
        existing === undefined
          ? "created"
          : JSON.stringify(existing) === JSON.stringify(item.entry.stored)
            ? "unchanged"
            : "updated";
      if (action !== "unchanged") writeCompiled(draft.catalog, [item], staged);
      // An unchanged patch is answered as skipped, as the reference does.
      const skipped = action === "unchanged" ? { skipped: true } : {};
      return jsonResponse(
        withPublishTarget({ ok: true, source: "candidate", resourceKind: label, resourceId: item.id, id: item.id, action, ...skipped }, decision),
        200,
      );
    });
  }
  const id = rest[1];
  if (rest.length === 2 && id !== undefined && method === "DELETE") {
    const key = pathSegment(id);
    // Idempotent, as in the reference: deleting an absent resource still answers 200.
    return ctx.commit((draft) => {
      deleteResource(draft.catalog, kind, key);
      return jsonResponse({ ok: true, source: "candidate", resourceKind: label, action: "delete", resourceId: key }, 200);
    });
  }
  throw noRoute();
}

function parseQueries(value: unknown): StoredQuery[] {
  return arrayOf(value, "query").map((item) => {
    try {
      return { document: item, definition: parseQuery(item) };
    } catch (error) {
      throw new ProtocolError(400, "VALIDATION_FAILED", error instanceof Error ? error.message : "Invalid query.");
    }
  });
}

async function queriesRoute(ctx: ServerContext, request: Request, rest: readonly string[]): Promise<Response> {
  const method = request.method;
  if (rest.length === 1 && method === "GET") {
    return jsonResponse({ ok: true, data: [...ctx.catalog.queries.values()].map((stored) => stored.document) }, 200);
  }
  if (rest.length === 1 && method === "POST") {
    const queries = parseQueries(await readJsonValue(request));
    return ctx.commit((draft) => {
      for (const stored of queries) draft.catalog.queries.set(stored.definition.id, stored);
      return jsonResponse({ ok: true, source: "candidate", resourceKind: "query", action: "upsert" }, 200);
    });
  }
  const id = rest[1];
  if (rest.length === 2 && id !== undefined && method === "DELETE") {
    const key = pathSegment(id);
    return ctx.commit((draft) => {
      draft.catalog.queries.delete(key);
      return jsonResponse({ ok: true, source: "candidate", resourceKind: "query", action: "delete", resourceId: key }, 200);
    });
  }
  throw noRoute();
}

async function putRateLimits(ctx: ServerContext, request: Request): Promise<Response> {
  const root = await readJsonValue(request);
  // The documented shape wraps the array ({rules: [...]}); the store keeps the bare array.
  const rules = isRecord(root) && "rules" in root ? root["rules"] : root;
  if (!Array.isArray(rules) || !rules.every(isRecord)) {
    return jsonResponse(
      { ok: false, resourceKind: "rate-limit-rules", error: { code: "VALIDATION_FAILED", message: "rules must be an array of rule objects." } },
      400,
    );
  }
  return ctx.commit((draft) => {
    draft.catalog.rateLimitRules = rules;
    return jsonResponse({ ok: true, source: "candidate", resourceKind: "rate-limit-rules", action: "upsert" }, 200);
  });
}

// PUT /v3/manage/{project}/settings, as the reference's PutSettingsAsync. The stored fields replace the settings the
// protocol reads from the next request on; the signed config follows at its next build.
async function putSettings(ctx: ServerContext, request: Request): Promise<Response> {
  const text = await readBodyText(request);
  return ctx.commit((draft) => {
    const outcome = applySettingsText(draft.settings, text, ctx.options.requestKeys);
    if (!outcome.ok) return jsonResponse(outcome.body, 400);
    draft.settings = outcome.settings;
    return jsonResponse(settingsResponse(ctx, outcome.settings), 200);
  });
}

async function putTests(ctx: ServerContext, request: Request): Promise<Response> {
  const root = await readJsonValue(request);
  // The documented shape wraps the array ({tests: [...]}); the store keeps the bare array.
  const list = isRecord(root) && "tests" in root ? root["tests"] : root;
  const tests: Record<string, unknown>[] = [];
  for (const item of arrayOf(list, "test")) {
    if (!isRecord(item) || typeof item["id"] !== "string" || typeof item["endpoint"] !== "string") {
      throw new ProtocolError(400, "VALIDATION_FAILED", "Each test needs an id and an endpoint.");
    }
    tests.push(item);
  }
  return ctx.commit((draft) => {
    draft.catalog.tests = tests;
    return jsonResponse({ ok: true, source: "candidate", resourceKind: "tests", action: "replace", total: tests.length }, 200);
  });
}

// The reference runs each endpoint in process as a synthetic player and reports what happened. The auto-test
// runs with the secret key already checked by the management route.
const AUTO_TEST_STEAM_ID = "76561198000000000";
const AUTO_TEST_UNSUPPORTED = "The native executor does not support this endpoint definition.";

async function autoTest(ctx: ServerContext, request: Request, url: URL): Promise<Response> {
  const body = await readJsonBody(request);
  const requestedValue = body["slug"];
  const requested = typeof requestedValue === "string" && requestedValue.trim() !== "" ? requestedValue : null;
  const view = ctx.view(targetsNext(request, url));
  // The reference lists endpoints in ordinal slug order.
  const selected = [...view.catalog.endpoints]
    .filter(([slug]) => requested === null || slug.toLowerCase() === requested.toLowerCase())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (requested !== null && selected.length === 0) {
    throw new ProtocolError(400, "ENDPOINT_NOT_FOUND", `Endpoint '${requested}' was not found.`);
  }
  const results: Record<string, unknown>[] = [];
  for (const [slug, entry] of selected) results.push(await autoTestEndpoint(ctx, view, slug, entry, request.signal));
  if (requested !== null) return jsonResponse({ ok: true, ...results[0] }, 200);
  const passed = results.filter((result) => result["passed"] === true).length;
  return jsonResponse({ ok: true, results, summary: { total: results.length, passed, failed: results.length - passed } }, 200);
}

async function autoTestEndpoint(
  ctx: ServerContext,
  view: RuntimeView,
  slug: string,
  entry: EndpointEntry,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const report = {
    name: `Auto-test ${slug}`,
    endpoint: slug,
    method: entry.compiled.method,
    deprecated: entry.stored["deprecated"] === true,
    warnings: [],
  };
  const target = resolveEndpoint(ctx, view.catalog, slug);
  if (target === null) return { ...report, passed: false, errors: [AUTO_TEST_UNSUPPORTED], result: null };
  try {
    const run = await executeEndpoint(ctx, view, target, {
      slug,
      method: entry.compiled.method,
      input: autoTestInput(entry.stored),
      steamId: AUTO_TEST_STEAM_ID,
      signal,
      live: false,
    });
    const passed = run.status < 300;
    return {
      ...report,
      passed,
      errors: passed ? [] : [`Endpoint returned HTTP ${run.status}.`],
      result: { status: run.status, body: run.body },
    };
  } catch (error) {
    if (!(error instanceof ProtocolError || error instanceof ScriptFailure)) {
      return { ...report, passed: false, errors: [error instanceof Error ? error.message : String(error)], result: null };
    }
    const description = describeError(error);
    const failure = describedErrorBody(description);
    delete failure["ok"];
    return {
      ...report,
      passed: false,
      errors: [`Endpoint returned HTTP ${description.status}.`],
      result: { status: description.status, body: failure },
    };
  }
}

// Each declared input takes its default, or a placeholder of its type, as the reference runner builds it.
function autoTestInput(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const schema = record["input"];
  const properties = isRecord(schema) && isRecord(schema["properties"]) ? schema["properties"] : {};
  return Object.fromEntries(
    Object.entries(properties).map(([name, prop]) => {
      const spec = isRecord(prop) ? prop : {};
      return [name, "default" in spec ? spec["default"] : autoTestDefault(spec["type"])];
    }),
  );
}

function autoTestDefault(type: unknown): unknown {
  switch (type) {
    case "string":
      return "test";
    case "integer":
    case "number":
      return 1;
    case "boolean":
      return true;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return null;
  }
}

async function sourceUpgrade(ctx: ServerContext, request: Request): Promise<Response> {
  const root = await readJsonValue(request);
  // A source wrapped in a `resource` object or array is the payload; otherwise the body itself is.
  const wrapped = isRecord(root) ? root["resource"] : undefined;
  const payload = isRecord(wrapped) || Array.isArray(wrapped) ? wrapped : root;
  if (!isRecord(payload)) throw new ProtocolError(400, "VALIDATION_FAILED", "Body must be a source resource object.");
  const outcome = upgradeSource(payload, { parseYaml: ctx.options.parseYaml, stringifyYaml: ctx.options.stringifyYaml });
  return jsonResponse(outcome.body, outcome.ok ? 200 : 400);
}

// A sync job while the server keeps it. The reference answers a blank id, an expired job, and an unknown job with
// distinct codes; an expired job is forgotten once it has been reported.
function syncJobRoute(ctx: ServerContext, jobId: string): Response {
  if (jobId.trim() === "") return jsonResponse({ ok: false, error: "MISSING_JOB_ID" }, 400);
  const lookup = ctx.syncJobs.lookup(jobId);
  if (lookup.state === "found") return jsonResponse({ ok: true, job: lookup.job }, 200);
  if (lookup.state === "expired") {
    return jsonResponse({ ok: false, error: "JOB_EXPIRED", message: "Sync job has expired and been cleaned up." }, 404);
  }
  return jsonResponse({ ok: false, error: "JOB_NOT_FOUND" }, 404);
}

// The stored package plus the Unix-second fields the reference derives from its ISO timestamps.
function withUnixTimestamps(gamePackage: Record<string, unknown>): Record<string, unknown> {
  return {
    ...gamePackage,
    revisionFirstSyncedAtUnix: unixSeconds(gamePackage["revisionPublishedAt"]),
    lastSyncedAtUnix: unixSeconds(gamePackage["lastSyncedAt"]),
  };
}

function unixSeconds(value: unknown): number | null {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

// Merges the body over the stored package, as the reference does. A changed revision resets the publish anchor and
// promotes the staged revision; a first sync has no earlier revision to replace.
async function packageSync(ctx: ServerContext, request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  const now = new Date(ctx.now()).toISOString();
  return ctx.commit((draft) => {
    const previousId = draft.catalog.gamePackage?.["currentRevisionId"];
    const previousRevisionId = typeof previousId === "number" ? previousId : null;
    const gamePackage: Record<string, unknown> = {
      ...draft.catalog.gamePackage,
      ...body,
      lastSyncedAt: now,
      publishStatus: "published",
    };
    delete gamePackage["revisionFirstSyncedAtUnix"];
    delete gamePackage["lastSyncedAtUnix"];
    const currentId = gamePackage["currentRevisionId"];
    const currentRevisionId = typeof currentId === "number" ? currentId : null;
    const revisionChanged = previousRevisionId !== null && currentRevisionId !== null && previousRevisionId !== currentRevisionId;
    if (revisionChanged || !("revisionPublishedAt" in gamePackage)) gamePackage["revisionPublishedAt"] = now;
    draft.catalog.gamePackage = gamePackage;
    const promotedRevisionOverrides = revisionChanged
      ? promoteStaged(draft.catalog, ctx.options.parseYaml)
      : { endpointCount: 0, collectionCount: 0, promoted: false };
    return jsonResponse(
      {
        ok: true,
        gamePackage: withUnixTimestamps(gamePackage),
        previousRevisionId,
        revisionChanged,
        promotedRevisionOverrides,
      },
      200,
    );
  });
}

// The reference reads revision numbers as 64-bit integers; anything else is absent.
function integerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

async function revisionInit(ctx: ServerContext, request: Request, url: URL): Promise<Response> {
  if (authorize(ctx, request, url) === null) {
    throw new KeyRefusal();
  }
  const header = request.headers.get("x-ns-revision-id");
  const body = await readJsonBody(request);
  // The client's revision is the body's revisionId, else the x-ns-revision-id header. Absent is not an error.
  const client = integerOrNull(body["revisionId"]) ?? integerOrNull(header === null || header === "" ? undefined : Number(header));
  const pkg = ctx.catalog.gamePackage;
  const current = integerOrNull(pkg?.["currentRevisionId"]);
  const latest = integerOrNull(pkg?.["latestRevisionId"]) ?? current;
  const outdated = client !== null && current !== null && client < current;
  const message =
    client === null
      ? "Client revision unknown; reporting the server's latest revision."
      : current === null
        ? "No synced game package; nothing to compare against."
        : outdated
          ? `Revision ${client} is outdated. Latest is ${current}.`
          : "Revision is current.";
  // Null fields are left out of the response, as the reference serializer does.
  const fields = { ok: true, playerRevision: client, currentRevisionId: current, latestRevisionId: latest, revisionOutdated: outdated, message };
  return jsonResponse(Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null)), 200);
}
