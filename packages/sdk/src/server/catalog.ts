import {
  compileCollection,
  compileEndpoint,
  compileWorkflow,
  DefinitionError,
  type CompiledCollection,
  type CollectionConstants,
  type CompiledEndpoint,
  type CompiledWorkflow,
} from "../dsl/compile.js";
import { isRecord } from "../util/guards.js";
import { LEDGER_COLLECTION } from "../endpoint/ledger.js";
import type { StorageDefinition, ValuesDocument } from "./options.js";
import type { CollectionDefinition } from "../storage/types.js";
import type { QueryDefinition } from "./query-routes.js";

// Management records are the editor's JSON shapes. This module turns them into compiled documents and keeps the
// live catalog that the runtime reads. Compilation is all-or-nothing per batch: nothing is committed unless every
// record in the batch compiles.

export type ResourceKind = "endpoints" | "collections" | "workflows";

// Editor bookkeeping. These describe a record rather than define it, so they never reach the compiler.
const MANAGEMENT_KEYS = new Set([
  "slug",
  "enabled",
  "authoringMode",
  "sourcePath",
  "sourceFormat",
  "sourceText",
  "builtIn",
  "kind",
  "sourceVersion",
]);

export interface EndpointEntry {
  // The record as the reference stores and lists it. See storedOf.
  readonly stored: Readonly<Record<string, unknown>>;
  readonly record: Readonly<Record<string, unknown>>;
  readonly compiled: CompiledEndpoint;
  readonly enabled: boolean;
}

export interface CollectionEntry {
  readonly stored: Readonly<Record<string, unknown>>;
  readonly record: Readonly<Record<string, unknown>>;
  readonly compiled: CompiledCollection;
}

export interface WorkflowEntry {
  readonly stored: Readonly<Record<string, unknown>>;
  readonly record: Readonly<Record<string, unknown>>;
  readonly compiled: CompiledWorkflow;
}

export interface Catalog {
  revision: number;
  readonly endpoints: Map<string, EndpointEntry>;
  readonly collections: Map<string, CollectionEntry>;
  readonly workflows: Map<string, WorkflowEntry>;
  readonly queries: Map<string, QueryDefinition>;
  // Game values as the editor sent them, keyed by item id.
  readonly gameValues: Map<string, Record<string, unknown>>;
  // Constant groups from collections, keyed by group id. Each records its collection, so a commit or delete replaces it.
  readonly constantGroups: Map<string, { readonly collection: string; readonly visibility: string; readonly entries: Record<string, unknown> }>;
  rateLimitRules: Record<string, unknown>[];
  tests: Record<string, unknown>[];
  gamePackage: Record<string, unknown> | null;
  // The staged ("next") revision: records written with a next target, keyed by id, waiting for promotion.
  readonly staged: { readonly endpoints: Map<string, Record<string, unknown>>; readonly collections: Map<string, Record<string, unknown>> };
}

export function createCatalog(): Catalog {
  return {
    revision: 0,
    endpoints: new Map(),
    collections: new Map(),
    workflows: new Map(),
    queries: new Map(),
    gameValues: new Map(),
    constantGroups: new Map(),
    rateLimitRules: [],
    tests: [],
    gamePackage: null,
    staged: { endpoints: new Map(), collections: new Map() },
  };
}

export type Compiled =
  | { readonly kind: "endpoints"; readonly id: string; readonly entry: EndpointEntry }
  | { readonly kind: "collections"; readonly id: string; readonly entry: CollectionEntry }
  | { readonly kind: "workflows"; readonly id: string; readonly entry: WorkflowEntry };

export interface RecordResult {
  readonly id: string;
  readonly ok: boolean;
  readonly message: string | null;
}

export interface BatchCompile {
  readonly ok: boolean;
  readonly results: readonly RecordResult[];
  readonly compiled: readonly Compiled[];
}

type Parser = ((text: string) => unknown) | undefined;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "The definition is invalid.";
}

function withoutKeys(record: Readonly<Record<string, unknown>>, keys: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!keys.has(key)) out[key] = value;
  }
  return out;
}

// A record with sourceText is the authored document: JSON, or YAML through the configured parser.
function sourceOf(record: Readonly<Record<string, unknown>>, parse: Parser, text: string): Record<string, unknown> {
  const json = record["sourceFormat"] === "json";
  const parser = json ? (value: string): unknown => JSON.parse(value) : parse;
  if (parser === undefined) throw new Error("YAML sources need ServerOptions.parseYaml.");
  let parsed: unknown;
  try {
    parsed = parser(text);
  } catch (error) {
    throw new Error(`Invalid ${json ? "JSON" : "YAML"} source: ${messageOf(error)}`);
  }
  if (!isRecord(parsed)) throw new Error("sourceText must parse to an object.");
  return parsed;
}

// The editor's legacy endpoint record becomes a DSL endpoint document. Unknown fields stay in place, so the
// compiler rejects them instead of dropping them.
function endpointDocument(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const id = typeof record["id"] === "string" ? record["id"] : record["slug"];
  if (typeof id !== "string" || id.length === 0) throw new Error("Each endpoint must have 'slug' or 'id'.");
  return {
    ...withoutKeys(record, MANAGEMENT_KEYS),
    sourceVersion: 1,
    kind: "endpoint",
    id,
    exposure: record["exposure"] ?? "public",
  };
}

function collectionDocument(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const id = typeof record["id"] === "string" ? record["id"] : record["name"];
  if (typeof id !== "string" || id.length === 0) throw new Error("Each collection must have an 'id' or 'name'.");
  const name = record["name"];
  const description = record["description"];
  const definition = withoutKeys(record, new Set([...MANAGEMENT_KEYS, "id", "name", "description"]));
  return {
    sourceVersion: 1,
    kind: "collection",
    id,
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof description === "string" ? { description } : {}),
    definition,
  };
}

// The editor's legacy workflow carries one guard: a condition with a failure response. It becomes the first step.
function workflowDocument(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const id = typeof record["id"] === "string" ? record["id"] : record["name"];
  if (typeof id !== "string" || id.length === 0) throw new Error("Each workflow must have an 'id' or 'name'.");
  const steps: unknown[] = Array.isArray(record["steps"]) ? [...record["steps"]] : [];
  const onFail = record["onFail"];
  if (isRecord(record["condition"])) {
    const guard: Record<string, unknown> = { id: "guard", type: "condition", check: record["condition"] };
    if (isRecord(onFail)) {
      guard["onFail"] = {
        status: onFail["status"],
        error: onFail["errorCode"],
        message: onFail["errorMessage"],
      };
    }
    steps.unshift(guard);
  }
  return {
    sourceVersion: 1,
    kind: "workflow",
    id,
    ...(typeof record["name"] === "string" ? { name: record["name"] } : {}),
    ...(typeof record["description"] === "string" ? { description: record["description"] } : {}),
    definition: {
      params: record["requires"] ?? record["params"] ?? {},
      steps,
      returns: record["returns"] ?? {},
    },
  };
}

export function documentFor(kind: ResourceKind, record: Readonly<Record<string, unknown>>, parse: Parser): Record<string, unknown> {
  const text = record["sourceText"];
  if (typeof text === "string") return sourceOf(record, parse, text);
  if (kind === "endpoints") return endpointDocument(record);
  if (kind === "collections") return collectionDocument(record);
  return workflowDocument(record);
}

// Editor-facing fields that a source-backed record carries alongside its source text. The reference copies them into
// the stored definition when present.
const SOURCE_RECORD_FIELDS = ["authoringMode", "sourceFormat", "sourcePath", "sourceText", "sourceVersion"] as const;

// The reference's UnwrapSourceBody. A source keeps its body under the kind name, or under `resource`, or under
// `definition` merged with the document's own top-level fields. The wrapper keys are dropped from the merge.
function unwrapSource(source: Readonly<Record<string, unknown>>, kind: ResourceKind): Record<string, unknown> {
  const label = kind === "endpoints" ? "endpoint" : kind === "collections" ? "collection" : "workflow";
  const named = source[label];
  if (isRecord(named)) return mergeExcept(source, named, [label, "resource"]);
  const resource = source["resource"];
  if (isRecord(resource)) return mergeExcept(source, resource, ["resource", label]);
  const definition = source["definition"];
  if (isRecord(definition)) return mergeExcept(definition, source, ["definition", label, "resource"]);
  return { ...source };
}

function mergeExcept(first: Readonly<Record<string, unknown>>, second: Readonly<Record<string, unknown>>, excluded: readonly string[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const skip = new Set(excluded);
  for (const [key, value] of Object.entries(first)) if (!skip.has(key)) merged[key] = value;
  for (const [key, value] of Object.entries(second)) if (!skip.has(key)) merged[key] = value;
  return merged;
}

// The record as the reference stores it and lists it. A source-backed record stores its unwrapped body without the
// kind markers, plus its authoring fields, and the id/name/slug/visibility fields the list reads from the store
// columns when the body omits them. A legacy record is stored as sent, with the same list fill-ins.
export function storedOf(kind: ResourceKind, record: Readonly<Record<string, unknown>>, document: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const sourced = typeof record["sourceText"] === "string";
  const stored = sourced
    ? withoutKeys(unwrapSource(document, kind), new Set(["kind", "resourceKind"]))
    : { ...record };
  if (sourced) {
    for (const field of SOURCE_RECORD_FIELDS) {
      if (record[field] !== undefined) stored[field] = record[field];
    }
  }
  const wrapperId = typeof record["id"] === "string" && record["id"].trim() !== "" ? record["id"] : undefined;
  if (stored["id"] === undefined && wrapperId !== undefined) stored["id"] = wrapperId;
  const id = typeof stored["id"] === "string" && stored["id"].trim() !== "" ? stored["id"] : undefined;
  if (kind === "endpoints" && stored["slug"] === undefined && id !== undefined) stored["slug"] = id;
  if (kind !== "endpoints" && stored["name"] === undefined && id !== undefined) stored["name"] = id;
  if (kind === "collections" && stored["visibility"] === undefined) stored["visibility"] = "private";
  return stored;
}

// The stored form of a record as it would be written, used for listing staged copies.
export function storedFor(kind: ResourceKind, record: Readonly<Record<string, unknown>>, parse: Parser): Record<string, unknown> {
  return storedOf(kind, record, documentFor(kind, record, parse));
}

function compileOne(kind: ResourceKind, record: unknown, parse: Parser): Compiled {
  if (!isRecord(record)) throw new Error("Each definition must be an object.");
  const document = documentFor(kind, record, parse);
  const stored = storedOf(kind, record, document);
  if (kind === "endpoints") {
    const compiled = compileEndpoint(document);
    return { kind, id: compiled.id, entry: { stored, record, compiled, enabled: record["enabled"] !== false } };
  }
  if (kind === "collections") {
    const compiled = compileCollection(document);
    return { kind, id: compiled.definition.id, entry: { stored, record, compiled } };
  }
  const compiled = compileWorkflow(document);
  return { kind, id: compiled.id, entry: { stored, record, compiled } };
}

// Compiles every record in a batch. The caller decides whether a failed batch is an error or a preflight answer.
export function compileBatch(kind: ResourceKind, records: readonly unknown[], parse: Parser): BatchCompile {
  const results: RecordResult[] = [];
  const compiled: Compiled[] = [];
  for (const record of records) {
    const id = isRecord(record) && typeof record["id"] === "string" ? record["id"] : "";
    try {
      const item = compileOne(kind, record, parse);
      compiled.push(item);
      results.push({ id: item.id, ok: true, message: null });
    } catch (error) {
      results.push({ id, ok: false, message: messageOf(error) });
    }
  }
  return { ok: results.every((result) => result.ok), results, compiled };
}

export const KIND_LABEL: Readonly<Record<ResourceKind, string>> = { endpoints: "endpoint", collections: "collection", workflows: "workflow" };

// The first check a record fails. `code` is its preflight diagnostic code; `stage` names the check.
export interface RecordFault {
  readonly stage: "shape" | "source" | "identifier" | "definition";
  readonly code: string;
  readonly message: string;
  readonly sourcePath: string | null;
  readonly suggestedFix: string | null;
}

export type RecordCheck =
  | { readonly ok: true; readonly item: Compiled; readonly stored: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly stored: Readonly<Record<string, unknown>> | null; readonly fault: RecordFault };

// The fields that identify a stored record. Any one of them, non-blank, is enough.
const IDENTIFIER_FIELDS: Readonly<Record<ResourceKind, readonly string[]>> = {
  endpoints: ["slug", "id"],
  collections: ["name", "id"],
  workflows: ["id", "name"],
};

const IDENTIFIER_FAULTS: Readonly<Record<ResourceKind, RecordFault>> = {
  endpoints: { stage: "identifier", code: "ENDPOINT_SLUG_REQUIRED", message: "Endpoint slug is required.", sourcePath: "slug", suggestedFix: "Add a slug (or id) to the endpoint." },
  collections: { stage: "identifier", code: "COLLECTION_NAME_REQUIRED", message: "Collection name is required.", sourcePath: "name", suggestedFix: "Use a collection name like player_data." },
  workflows: { stage: "identifier", code: "WORKFLOW_ID_OR_NAME_REQUIRED", message: "Workflow id or name is required.", sourcePath: "id", suggestedFix: "Add an id (or name) to the workflow." },
};

// Checks one record the way the reference write does: shape, then source text, then identifier, then the definition
// compile. A legacy record has no source to read, so its identifier is checked as sent.
export function checkRecord(kind: ResourceKind, record: unknown, parse: Parser): RecordCheck {
  if (!isRecord(record)) {
    return { ok: false, stored: null, fault: { stage: "shape", code: "VALIDATION_FAILED", message: `Each ${KIND_LABEL[kind]} must be an object.`, sourcePath: null, suggestedFix: null } };
  }
  let stored: Record<string, unknown>;
  if (typeof record["sourceText"] === "string") {
    try {
      stored = storedFor(kind, record, parse);
    } catch (error) {
      return { ok: false, stored: null, fault: { stage: "source", code: "SOURCE_COMPILE_FAILED", message: messageOf(error), sourcePath: "sourceText", suggestedFix: "Fix the source syntax and retry." } };
    }
  } else {
    stored = storedOf(kind, record, record);
  }
  const identified = IDENTIFIER_FIELDS[kind].some((field) => {
    const value = stored[field];
    return typeof value === "string" && value.trim() !== "";
  });
  if (!identified) return { ok: false, stored, fault: IDENTIFIER_FAULTS[kind] };
  try {
    const item = compileOne(kind, record, parse);
    return { ok: true, item, stored: item.entry.stored };
  } catch (error) {
    return { ok: false, stored, fault: { stage: "definition", code: "VALIDATION_FAILED", message: messageOf(error), sourcePath: null, suggestedFix: null } };
  }
}

// Compile-checks one record without committing it. A DSL error reports the path it failed at; any other failure reports the root.
export function definitionFault(kind: ResourceKind, record: Readonly<Record<string, unknown>>, parse: Parser): { path: string; message: string } | null {
  try {
    compileOne(kind, record, parse);
    return null;
  } catch (error) {
    if (error instanceof DefinitionError) return { path: error.path, message: error.message };
    return { path: "/", message: messageOf(error) };
  }
}

export function commitCompiled(catalog: Catalog, items: readonly Compiled[]): void {
  for (const item of items) {
    if (item.kind === "endpoints") catalog.endpoints.set(item.id, item.entry);
    else if (item.kind === "collections") {
      catalog.collections.set(item.id, item.entry);
      replaceConstantGroups(catalog, item.id, item.entry.compiled.constants);
    } else catalog.workflows.set(item.id, item.entry);
  }
  catalog.revision += 1;
}

// Writes compiled items to the live catalog, or to the staged revision for a next-targeted write. Workflows have no
// staged revision and always write live.
export function writeCompiled(catalog: Catalog, items: readonly Compiled[], staged: boolean): void {
  if (!staged) {
    commitCompiled(catalog, items);
    return;
  }
  const next = items.filter(isStagedItem);
  const live = items.filter((item) => !isStagedItem(item));
  if (next.length > 0) stageCompiled(catalog, next);
  if (live.length > 0) commitCompiled(catalog, live);
}

type StagedItem = Extract<Compiled, { readonly kind: "endpoints" | "collections" }>;

function isStagedItem(item: Compiled): item is StagedItem {
  return item.kind !== "workflows";
}

function stageCompiled(catalog: Catalog, items: readonly StagedItem[]): void {
  for (const item of items) {
    const { record } = item.entry;
    const stored = record["id"] === undefined ? { ...record, id: item.id } : record;
    (item.kind === "endpoints" ? catalog.staged.endpoints : catalog.staged.collections).set(item.id, stored);
  }
  catalog.revision += 1;
}

// The staged record for one id. Workflows never have one.
export function stagedRecordOf(
  catalog: Catalog,
  kind: ResourceKind,
  id: string,
): Readonly<Record<string, unknown>> | undefined {
  if (kind === "endpoints") return catalog.staged.endpoints.get(id);
  if (kind === "collections") return catalog.staged.collections.get(id);
  return undefined;
}

export interface StagedCompile {
  readonly ok: boolean;
  readonly message: string | null;
  readonly compiled: readonly Compiled[];
}

// The staged revision as a run or a promotion sees it: each staged record merged over its live counterpart, then compiled.
function compileStaged(catalog: Catalog, parse: Parser): StagedCompile {
  const endpoints = compileBatch(
    "endpoints",
    [...catalog.staged.endpoints].map(([id, record]) => patchedRecord(catalog.endpoints.get(id)?.record, record)),
    parse,
  );
  const collections = compileBatch(
    "collections",
    [...catalog.staged.collections].map(([id, record]) => patchedRecord(catalog.collections.get(id)?.record, record)),
    parse,
  );
  const failure = [...endpoints.results, ...collections.results].find((result) => !result.ok);
  return {
    ok: endpoints.ok && collections.ok,
    message: failure?.message ?? null,
    compiled: [...endpoints.compiled, ...collections.compiled],
  };
}

// The catalog a next-targeted run reads: staged records replace or add to the live ones. Returns the live catalog
// itself when nothing is staged. Throws when the staged revision does not compile, since nothing can run it.
export function stagedCatalogOf(catalog: Catalog, parse: Parser): Catalog {
  if (catalog.staged.endpoints.size === 0 && catalog.staged.collections.size === 0) return catalog;
  const staged = compileStaged(catalog, parse);
  if (!staged.ok) throw new Error(`The staged revision does not compile: ${staged.message ?? "unknown error"}`);
  const endpoints = new Map(catalog.endpoints);
  const collections = new Map(catalog.collections);
  for (const item of staged.compiled) {
    if (item.kind === "endpoints") endpoints.set(item.id, item.entry);
    else if (item.kind === "collections") collections.set(item.id, item.entry);
  }
  return { ...catalog, endpoints, collections };
}

export interface PromotionResult {
  readonly endpointCount: number;
  readonly collectionCount: number;
  readonly promoted: boolean;
}

// Promotes the staged revision into the live catalog. Nothing is written unless every staged record compiles; a failed
// promotion keeps the staged revision so it can be fixed and promoted again.
export function promoteStaged(catalog: Catalog, parse: Parser): PromotionResult {
  const endpointCount = catalog.staged.endpoints.size;
  const collectionCount = catalog.staged.collections.size;
  if (endpointCount + collectionCount === 0) return { endpointCount: 0, collectionCount: 0, promoted: false };
  const staged = compileStaged(catalog, parse);
  if (!staged.ok) return { endpointCount: 0, collectionCount: 0, promoted: false };
  commitCompiled(catalog, staged.compiled);
  catalog.staged.endpoints.clear();
  catalog.staged.collections.clear();
  return { endpointCount, collectionCount, promoted: true };
}

// A full replacement removes the live endpoints the push did not name.
export function removeEndpoints(catalog: Catalog, keep: ReadonlySet<string>): void {
  for (const id of [...catalog.endpoints.keys()]) {
    if (!keep.has(id)) deleteResource(catalog, "endpoints", id);
  }
}

export function deleteResource(catalog: Catalog, kind: ResourceKind, id: string): boolean {
  const removed =
    kind === "endpoints"
      ? catalog.endpoints.delete(id)
      : kind === "collections"
        ? catalog.collections.delete(id)
        : catalog.workflows.delete(id);
  if (removed && kind === "collections") replaceConstantGroups(catalog, id, []);
  if (removed) catalog.revision += 1;
  return removed;
}

// A collection's constant groups are replaced whole on every commit or delete, so a removed group does not linger.
function replaceConstantGroups(catalog: Catalog, collection: string, groups: readonly CollectionConstants[]): void {
  for (const [id, group] of catalog.constantGroups) {
    if (group.collection === collection) catalog.constantGroups.delete(id);
  }
  for (const group of groups) {
    catalog.constantGroups.set(group.id, { collection, visibility: group.visibility, entries: group.entries });
  }
}

// Game values: groups hold entries, tables hold rows. Editor items win over the static values in ServerOptions.
export function valuesOf(catalog: Catalog, base: ValuesDocument | undefined): ValuesDocument {
  const groups: Record<string, unknown> = { ...base?.groups };
  const tables: Record<string, unknown> = { ...base?.tables };
  for (const [id, item] of catalog.gameValues) {
    if (item["type"] === "table") {
      tables[id] = { id, type: "table", name: item["name"], description: item["description"], columns: item["columns"], rows: item["rows"] };
    } else {
      groups[id] = { name: item["name"], description: item["description"], values: item["entries"] };
    }
  }
  for (const [id, group] of catalog.constantGroups) groups[id] = { name: id, values: group.entries };
  return { groups, tables };
}

// Client-facing values: constant groups from private collections are left out, as the reference's client format does.
export function publicValuesOf(catalog: Catalog, base: ValuesDocument | undefined): ValuesDocument {
  const values = valuesOf(catalog, base);
  const groups = Object.fromEntries(Object.entries(values.groups).filter(([id]) => catalog.constantGroups.get(id)?.visibility !== "private"));
  return { groups, tables: values.tables };
}

// Upserts editor game values by id; the revision bump makes storage rebuild with the new values.
export function upsertGameValues(catalog: Catalog, items: readonly Record<string, unknown>[]): void {
  for (const item of items) catalog.gameValues.set(String(item["id"]), item);
  catalog.revision += 1;
}

// The stored record for one id, or undefined when no such resource exists.
export function documentOf(catalog: Catalog, kind: ResourceKind, id: string): Record<string, unknown> | undefined {
  const entry = kind === "endpoints" ? catalog.endpoints.get(id) : kind === "collections" ? catalog.collections.get(id) : catalog.workflows.get(id);
  return entry?.stored;
}

// The accepted legacy record for one id. A PATCH merges over it, as the reference does.
export function storedRecordOf(catalog: Catalog, kind: ResourceKind, id: string): Readonly<Record<string, unknown>> | undefined {
  const entry = kind === "endpoints" ? catalog.endpoints.get(id) : kind === "collections" ? catalog.collections.get(id) : catalog.workflows.get(id);
  return entry?.record;
}

// Source metadata says where a record came from. A plain patch drops it so stale source cannot override the patch.
const SOURCE_AUTHORING_FIELDS: ReadonlySet<string> = new Set(["authoringMode", "sourceFormat", "sourcePath", "sourceText", "sourceVersion"]);

// The record a PATCH compiles: a source-backed patch replaces the stored record; a plain patch merges over it.
export function patchedRecord(stored: Readonly<Record<string, unknown>> | undefined, incoming: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (stored === undefined || typeof incoming["sourceText"] === "string") return { ...incoming };
  return { ...withoutKeys(stored, SOURCE_AUTHORING_FIELDS), ...incoming };
}

const INTERNAL_COLLECTIONS: readonly CollectionDefinition[] = [
  // Per-player heartbeat totals written by the stats route.
  { id: "_stats", collectionType: "per-steamid", accessMode: "endpoint", schema: { type: "object" } },
  // Analytics events, one record per event. Global so the per-player maxRecords limit does not apply.
  { id: "_analytics", collectionType: "global", accessMode: "endpoint", schema: { type: "object" } },
  // Ledger rows for _ledger number fields. Only endpoint writes create them (endpoint/ledger.ts).
  { id: LEDGER_COLLECTION, collectionType: "global", accessMode: "endpoint", schema: { type: "object" } },
];

export function storageDefinitionOf(catalog: Catalog, values: ValuesDocument): StorageDefinition {
  // A collection without a schema holds constants only: it has no records, so storage does not get it.
  const user = [...catalog.collections.values()].map((entry) => entry.compiled.definition).filter((definition) => definition.schema !== undefined);
  const reserved = new Set(INTERNAL_COLLECTIONS.map((definition) => definition.id));
  return {
    collections: [...INTERNAL_COLLECTIONS, ...user.filter((definition) => !reserved.has(definition.id))],
    values: flatValuesOf(values),
  };
}

// Dotted paths of the number fields marked _ledger on a per-steamid collection. Endpoint writes to these fields
// append ledger rows. A global collection has no player to attribute a row to, so it has none.
export function trackedFieldsOf(catalog: Catalog, collectionId: string): readonly string[] {
  const entry = catalog.collections.get(collectionId);
  if (entry === undefined) return [];
  const collectionType = entry.compiled.definition.collectionType;
  if (typeof collectionType === "string" && collectionType.toLowerCase() === "global") return [];
  const fields: string[] = [];
  for (const [path, markers] of entry.compiled.modifiers) {
    if (!markers.includes("_ledger")) continue;
    // A modifier path is "schema.properties.<name>" per level. Item paths have no field name and are not tracked.
    const parts = path.split(".");
    if (parts[0] !== "schema" || parts.includes("items")) continue;
    fields.push(parts.slice(1).filter((part, index, all) => !(part === "properties" && index + 1 < all.length)).join("."));
  }
  return fields;
}

// Storage reads values by id: a group's entries under the group id, a table's rows under the table id.
function flatValuesOf(values: ValuesDocument): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const [id, group] of Object.entries(values.groups)) flat[id] = isRecord(group) ? group["values"] : undefined;
  for (const [id, table] of Object.entries(values.tables)) flat[id] = isRecord(table) ? table["rows"] : undefined;
  return flat;
}
