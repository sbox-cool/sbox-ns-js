import { ProtocolError } from "../protocol/errors.js";
import { isRecord } from "../util/guards.js";
import { jsonResponse } from "../util/http.js";
import {
  commitCompiled,
  compileBatch,
  deleteResource,
  documentOf,
  upsertGameValues,
  type BatchCompile,
  type RecordResult,
  type ResourceKind,
} from "./catalog.js";
import type { ServerContext } from "./context.js";
import { authorize, handleEndpoint } from "./endpoints.js";
import { pathSegment, readJsonBody, readJsonValue, safeEqual } from "./http.js";
import { parseQuery, type QueryDefinition } from "./query-routes.js";

// Editor-facing management API. Every route needs the secret key except revision-init, which the game client
// calls with its public key. Section writes are all-or-nothing: a batch that fails to compile changes nothing.

const KINDS: readonly ResourceKind[] = ["endpoints", "collections", "workflows"];
const KIND_LABEL: Record<ResourceKind, string> = { endpoints: "endpoint", collections: "collection", workflows: "workflow" };
// Fields of the editor's game package record that the server keeps. Raw editor payloads are not stored.
const GAME_PACKAGE_FIELDS = [
  "packageId",
  "packageIdent",
  "packageTitle",
  "orgIdent",
  "packageType",
  "runtimeClientType",
  "isEditorContext",
  "isPublishedGameBundle",
  "currentRevisionId",
  "latestRevisionId",
  "publishStatus",
] as const;

interface SectionReport {
  ok: boolean;
  error: string | null;
  message: string | null;
  results: readonly RecordResult[];
}

interface Section {
  readonly kind: ResourceKind;
  readonly batch: BatchCompile | null;
  readonly report: SectionReport;
}

interface TestResult {
  id: string;
  endpoint: string;
  method: "POST";
  ok: boolean;
  errors: string[];
  result: { status: number; body: unknown };
}

function noRoute(): ProtocolError {
  return new ProtocolError(404, "NOT_FOUND", "No manage route matches this path.");
}

function requireSecret(ctx: ServerContext, request: Request): string {
  const secret = ctx.options.secretKey;
  const presented = request.headers.get("x-secret-key") ?? request.headers.get("x-api-key");
  if (secret === null || presented === null || !safeEqual(presented, secret)) {
    throw new ProtocolError(401, "UNAUTHORIZED", "Invalid or missing API key.");
  }
  return secret;
}

function arrayOf(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ProtocolError(400, "VALIDATION_FAILED", `Body must be an array of ${label} objects.`);
  }
  return value;
}

function kindOfPath(segment: string | undefined): ResourceKind | null {
  return KINDS.find((kind) => kind === segment) ?? null;
}

function kindOfSingular(value: unknown): ResourceKind | null {
  switch (value) {
    case "endpoint":
      return "endpoints";
    case "collection":
      return "collections";
    case "workflow":
      return "workflows";
    default:
      return null;
  }
}

// Compiles one section without committing it. A non-array value fails the section, never the request.
function compileSection(ctx: ServerContext, kind: ResourceKind, value: unknown): Section {
  if (!Array.isArray(value)) {
    return {
      kind,
      batch: null,
      report: {
        ok: false,
        error: "VALIDATION_FAILED",
        message: `Body must be an array of ${KIND_LABEL[kind]} objects.`,
        results: [],
      },
    };
  }
  const batch = compileBatch(kind, value, ctx.options.parseYaml);
  const failure = batch.results.find((result) => !result.ok);
  return {
    kind,
    batch,
    report: {
      ok: batch.ok,
      error: batch.ok ? null : "VALIDATION_FAILED",
      message: failure?.message ?? null,
      results: batch.results,
    },
  };
}

// Sync and preflight answer per kind. Preflight writes nothing and reports would_create or would_update; sync
// reports upsert per record. A failing section makes the whole request a 400.
function sectionReport(ctx: ServerContext, section: Section, mode: "sync" | "preflight"): Record<string, unknown> {
  const label = KIND_LABEL[section.kind];
  if (section.batch === null) {
    return { ok: false, error: section.report.error, message: section.report.message, results: [] };
  }
  const results = section.report.results.map((result) => {
    if (!result.ok) {
      const failure: Record<string, unknown> = { ok: false, error: "VALIDATION_FAILED", resourceId: result.id, resourceKind: label };
      if (mode === "preflight") {
        failure["diagnostics"] = [{ code: "VALIDATION_FAILED", message: result.message, resourceId: result.id, resourceKind: label, severity: "error" }];
      }
      return failure;
    }
    if (mode === "sync") return { action: "upsert", ok: true, resourceId: result.id, resourceKind: label };
    const action = documentOf(ctx.catalog, section.kind, result.id) === undefined ? "would_create" : "would_update";
    return { action, ok: true, resourceId: result.id, resourceKind: label, diagnostics: [] };
  });
  const failed = section.report.results.filter((result) => !result.ok).length;
  const counts = mode === "sync" ? { total: results.length } : { passed: results.length - failed, failed, total: results.length, warnings: 0 };
  const failure = section.report.ok ? {} : { error: section.report.error, message: section.report.message };
  return { ok: section.report.ok, ...counts, results, ...failure };
}

// Builds the response for a set of sections. A failing section returns 400 and nothing is committed by the caller.
function sectionsResponse(ctx: ServerContext, sections: readonly Section[], mode: "sync" | "preflight"): Response {
  const body: Record<string, unknown> = {};
  for (const section of sections) body[section.kind] = sectionReport(ctx, section, mode);
  const ok = sections.every((section) => section.report.ok);
  return jsonResponse(mode === "sync" ? { ok, source: "candidate", ...body } : { ok, ...body }, ok ? 200 : 400);
}

function documentsOf(ctx: ServerContext, kind: ResourceKind): unknown[] {
  if (kind === "endpoints") {
    return [...ctx.catalog.endpoints.values()].map((entry) => ({ ...entry.document, enabled: entry.enabled }));
  }
  if (kind === "collections") return [...ctx.catalog.collections.values()].map((entry) => entry.document);
  return [...ctx.catalog.workflows.values()].map((entry) => entry.document);
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
  if (head === "validate" && rest.length === 1 && method === "GET") {
    return jsonResponse({ ok: true, projectId: ctx.options.projectId, revision: ctx.catalog.revision }, 200);
  }
  if (head === "settings" && rest.length === 1 && method === "GET") {
    return jsonResponse({ ok: true, projectId: ctx.options.projectId, settings: ctx.options.settings }, 200);
  }
  if (head === "config" && rest.length === 1 && method === "GET") {
    return jsonResponse(
      {
        ok: true,
        projectId: ctx.options.projectId,
        revision: ctx.catalog.revision,
        counts: {
          endpoints: ctx.catalog.endpoints.size,
          collections: ctx.catalog.collections.size,
          workflows: ctx.catalog.workflows.size,
          queries: ctx.catalog.queries.size,
          gameValues: ctx.catalog.gameValues.size,
        },
      },
      200,
    );
  }
  if (head === "game-values" && rest.length === 1) return gameValuesRoute(ctx, request);
  if (head === "sync" && second === "preflight" && rest.length === 2 && method === "POST") {
    return preflight(ctx, request);
  }
  if (head === "sync" && rest.length === 1 && method === "PUT") return syncAll(ctx, request);
  if (head === "sync-jobs" && rest.length === 2 && method === "GET") {
    // Sync runs synchronously and keeps no job history, so no job exists to report.
    return jsonResponse({ ok: true, jobId: pathSegment(second ?? ""), found: false }, 200);
  }
  if (head === "package-sync" && rest.length === 1 && method === "POST") return packageSync(ctx, request);
  if (head === "game-package" && rest.length === 1 && method === "GET") {
    const gamePackage = ctx.catalog.gamePackage;
    if (gamePackage === null) {
      throw new ProtocolError(404, "NOT_FOUND", "No game package has been synced for this project.");
    }
    return jsonResponse({ ok: true, gamePackage }, 200);
  }
  if (head === "source-upgrade" && rest.length === 1 && method === "POST") return sourceUpgrade(ctx, request);
  if (head === "auto-test" && rest.length === 1 && method === "POST") return autoTest(ctx, request, url);
  if (head === "tests" && rest.length === 1 && method === "GET") {
    return jsonResponse({ ok: true, data: ctx.catalog.tests }, 200);
  }
  if (head === "tests" && rest.length === 1 && method === "PUT") return putTests(ctx, request);
  if (head === "rate-limit-rules" && rest.length === 1 && method === "GET") {
    return jsonResponse({ ok: true, rules: ctx.catalog.rateLimitRules }, 200);
  }
  if (head === "rate-limit-rules" && rest.length === 1 && method === "PUT") return putRateLimits(ctx, request);
  if (head === "queries") return queriesRoute(ctx, request, rest);
  const kind = kindOfPath(head);
  if (kind !== null) return kindRoute(ctx, request, kind, rest);
  throw noRoute();
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
  upsertGameValues(ctx.catalog, records);
  return jsonResponse({ ok: true, action: "upsert", resourceKind: "game-values", source: "candidate" }, 200);
}

async function preflight(ctx: ServerContext, request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  const sections = KINDS.filter((kind) => Object.hasOwn(body, kind)).map((kind) => compileSection(ctx, kind, body[kind]));
  return sectionsResponse(ctx, sections, "preflight");
}

async function syncAll(ctx: ServerContext, request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  const sections = KINDS.filter((kind) => Object.hasOwn(body, kind)).map((kind) => compileSection(ctx, kind, body[kind]));
  // All-or-nothing across kinds: nothing is committed unless every section compiled.
  if (sections.every((section) => section.report.ok)) {
    for (const section of sections) {
      if (section.batch !== null) commitCompiled(ctx.catalog, section.batch.compiled);
    }
  }
  return sectionsResponse(ctx, sections, "sync");
}

// A failed write answers 400 with the reference's error envelope and commits nothing.
function writeFailure(kind: ResourceKind, message: string | null): Response {
  return jsonResponse(
    { ok: false, resourceKind: KIND_LABEL[kind], error: { code: "VALIDATION_FAILED", message: message ?? "Validation failed." } },
    400,
  );
}

async function kindRoute(
  ctx: ServerContext,
  request: Request,
  kind: ResourceKind,
  rest: readonly string[],
): Promise<Response> {
  const method = request.method;
  const label = KIND_LABEL[kind];
  if (rest.length === 1 && method === "GET") {
    return jsonResponse({ ok: true, data: documentsOf(ctx, kind) }, 200);
  }
  if (rest.length === 1 && method === "PUT") {
    const section = compileSection(ctx, kind, await readJsonValue(request));
    if (section.batch === null || !section.report.ok) return writeFailure(kind, section.report.message);
    commitCompiled(ctx.catalog, section.batch.compiled);
    const results = section.batch.compiled.map((item) => ({ action: "upsert", ok: true, resourceId: item.id, resourceKind: label }));
    return jsonResponse({ ok: true, resourceKind: label, results, source: "candidate" }, 200);
  }
  if (rest.length === 1 && method === "PATCH") {
    const value = await readJsonValue(request);
    // A single resource may arrive bare or nested under its kind name.
    const incoming = isRecord(value) && isRecord(value[label]) && value["id"] === undefined ? value[label] : value;
    if (!isRecord(incoming)) return writeFailure(kind, `Body must contain a ${label} object.`);
    const first = compileSection(ctx, kind, [incoming]);
    const [only] = first.batch?.compiled ?? [];
    if (only === undefined || !first.report.ok) return writeFailure(kind, first.report.message);
    // Merge the patch over the stored definition, then recompile the whole definition.
    const existing = documentOf(ctx.catalog, kind, only.id);
    const merged = existing === undefined ? incoming : { ...existing, ...incoming };
    const section = compileSection(ctx, kind, [merged]);
    const [item] = section.batch?.compiled ?? [];
    if (item === undefined || !section.report.ok) return writeFailure(kind, section.report.message);
    const action =
      existing === undefined
        ? "created"
        : JSON.stringify(existing) === JSON.stringify(item.entry.document)
          ? "unchanged"
          : "updated";
    if (action !== "unchanged") commitCompiled(ctx.catalog, [item]);
    return jsonResponse({ ok: true, source: "candidate", resourceKind: label, resourceId: item.id, id: item.id, action }, 200);
  }
  const id = rest[1];
  if (rest.length === 2 && id !== undefined && method === "DELETE") {
    const key = pathSegment(id);
    // Idempotent, as in the reference: deleting an absent resource still answers 200.
    deleteResource(ctx.catalog, kind, key);
    return jsonResponse({ ok: true, source: "candidate", resourceKind: label, action: "delete", resourceId: key }, 200);
  }
  throw noRoute();
}

function parseQueries(value: unknown): QueryDefinition[] {
  return arrayOf(value, "query").map((item) => {
    try {
      return parseQuery(item);
    } catch (error) {
      throw new ProtocolError(400, "VALIDATION_FAILED", error instanceof Error ? error.message : "Invalid query.");
    }
  });
}

async function queriesRoute(ctx: ServerContext, request: Request, rest: readonly string[]): Promise<Response> {
  const method = request.method;
  if (rest.length === 1 && method === "GET") {
    return jsonResponse({ ok: true, data: [...ctx.catalog.queries.values()] }, 200);
  }
  if (rest.length === 1 && method === "POST") {
    const queries = parseQueries(await readJsonValue(request));
    for (const query of queries) ctx.catalog.queries.set(query.id, query);
    return jsonResponse({ ok: true, count: queries.length }, 200);
  }
  if (rest.length === 1 && method === "PUT") {
    const queries = parseQueries(await readJsonValue(request));
    ctx.catalog.queries.clear();
    for (const query of queries) ctx.catalog.queries.set(query.id, query);
    return jsonResponse({ ok: true, count: queries.length }, 200);
  }
  const id = rest[1];
  if (rest.length === 2 && id !== undefined && method === "DELETE") {
    const key = pathSegment(id);
    if (!ctx.catalog.queries.delete(key)) {
      throw new ProtocolError(404, "NOT_FOUND", `No query named "${key}".`);
    }
    return jsonResponse({ ok: true, id: key }, 200);
  }
  throw noRoute();
}

async function putRateLimits(ctx: ServerContext, request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  const rules = body["rules"];
  if (!Array.isArray(rules) || !rules.every(isRecord)) {
    throw new ProtocolError(400, "VALIDATION_FAILED", "rules must be an array of rule objects.");
  }
  ctx.catalog.rateLimitRules = rules;
  return jsonResponse({ ok: true, count: rules.length }, 200);
}

async function putTests(ctx: ServerContext, request: Request): Promise<Response> {
  const tests: Record<string, unknown>[] = [];
  for (const item of arrayOf(await readJsonValue(request), "test")) {
    if (!isRecord(item) || typeof item["id"] !== "string" || typeof item["endpoint"] !== "string") {
      throw new ProtocolError(400, "VALIDATION_FAILED", "Each test needs an id and an endpoint.");
    }
    tests.push(item);
  }
  ctx.catalog.tests = tests;
  return jsonResponse({ ok: true, count: tests.length }, 200);
}

// Runs one test case through the real endpoint handler, in process, with the secret key.
async function runTest(
  ctx: ServerContext,
  url: URL,
  secret: string,
  test: Record<string, unknown>,
): Promise<TestResult> {
  const id = typeof test["id"] === "string" ? test["id"] : "";
  const endpoint = typeof test["endpoint"] === "string" ? test["endpoint"] : "";
  const input = isRecord(test["input"]) ? test["input"] : {};
  const expect = isRecord(test["expect"]) ? test["expect"] : {};
  const wanted = typeof expect["status"] === "number" ? expect["status"] : 200;
  const call = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-secret-key": secret },
    body: JSON.stringify(input),
  });
  const response = await handleEndpoint(ctx, call, url, endpoint);
  const body: unknown = await response.json().catch(() => null);
  const errors = response.status === wanted ? [] : [`Expected status ${wanted} but got ${response.status}.`];
  return { id, endpoint, method: "POST", ok: errors.length === 0, errors, result: { status: response.status, body } };
}

async function autoTest(ctx: ServerContext, request: Request, url: URL): Promise<Response> {
  const secret = requireSecret(ctx, request);
  const body = await readJsonBody(request);
  const slug = typeof body["slug"] === "string" ? body["slug"] : null;
  const selected = ctx.catalog.tests.filter((test) => slug === null || test["endpoint"] === slug);
  const results: TestResult[] = [];
  for (const test of selected) results.push(await runTest(ctx, url, secret, test));
  const failed = results.filter((result) => !result.ok).length;
  return jsonResponse({ ok: failed === 0, passed: results.length - failed, failed, results }, 200);
}

async function sourceUpgrade(ctx: ServerContext, request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  const kind = kindOfSingular(body["kind"]);
  if (kind === null) {
    throw new ProtocolError(400, "VALIDATION_FAILED", "kind must be endpoint, collection, or workflow.");
  }
  // The source is already in the current DSL; this validates it against that version and reports it.
  const section = compileSection(ctx, kind, [body]);
  if (!section.report.ok) return writeFailure(kind, section.report.message);
  return jsonResponse(
    { ok: true, kind: body["kind"], id: section.report.results[0]?.id ?? null, sourceVersion: 1 },
    200,
  );
}

async function packageSync(ctx: ServerContext, request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  const packageIdent = body["packageIdent"];
  const currentRevisionId = body["currentRevisionId"];
  if (typeof packageIdent !== "string" || packageIdent === "" || typeof currentRevisionId !== "number") {
    throw new ProtocolError(400, "VALIDATION_FAILED", "packageIdent and currentRevisionId are required.");
  }
  const gamePackage: Record<string, unknown> = { projectId: ctx.options.projectId };
  for (const field of GAME_PACKAGE_FIELDS) {
    if (Object.hasOwn(body, field)) gamePackage[field] = body[field];
  }
  const previous = ctx.catalog.gamePackage;
  const revisionChanged = previous !== null && previous["currentRevisionId"] !== currentRevisionId;
  ctx.catalog.gamePackage = gamePackage;
  // This server keeps one live revision per project, so a sync promotes no revision overrides.
  return jsonResponse({ ok: true, gamePackage, revisionChanged, promotedRevisionOverrides: [] }, 200);
}

async function revisionInit(ctx: ServerContext, request: Request, url: URL): Promise<Response> {
  if (authorize(ctx, request, url) === null) {
    throw new ProtocolError(401, "UNAUTHORIZED", "Invalid or missing API key.");
  }
  const header = request.headers.get("x-ns-revision-id");
  const body = await readJsonBody(request);
  const claimed: unknown = header !== null && header !== "" ? Number(header) : body["revisionId"];
  if (typeof claimed !== "number" || !Number.isInteger(claimed)) {
    throw new ProtocolError(400, "VALIDATION_FAILED", "A revision id is required.");
  }
  const current = ctx.catalog.gamePackage?.["currentRevisionId"];
  const currentRevisionId = typeof current === "number" ? current : null;
  return jsonResponse(
    {
      ok: true,
      projectId: ctx.options.projectId,
      revisionId: claimed,
      currentRevisionId,
      outdated: currentRevisionId !== null && claimed < currentRevisionId,
    },
    200,
  );
}
