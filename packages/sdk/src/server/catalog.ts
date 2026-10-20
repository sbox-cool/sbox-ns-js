import {
  compileCollection,
  compileEndpoint,
  compileWorkflow,
  DefinitionError,
  type CompiledCollection,
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
  readonly document: Readonly<Record<string, unknown>>;
  readonly record: Readonly<Record<string, unknown>>;
  readonly compiled: CompiledEndpoint;
  readonly enabled: boolean;
}

export interface CollectionEntry {
  readonly document: Readonly<Record<string, unknown>>;
  readonly record: Readonly<Record<string, unknown>>;
  readonly compiled: CompiledCollection;
}

export interface WorkflowEntry {
  readonly document: Readonly<Record<string, unknown>>;
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
  const parser = record["sourceFormat"] === "json" ? (value: string): unknown => JSON.parse(value) : parse;
  if (parser === undefined) throw new Error("YAML sources need ServerOptions.parseYaml.");
  let parsed: unknown;
  try {
    parsed = parser(text);
  } catch {
    throw new Error("sourceText could not be parsed.");
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

function compileOne(kind: ResourceKind, record: unknown, parse: Parser): Compiled {
  if (!isRecord(record)) throw new Error("Each definition must be an object.");
  const document = documentFor(kind, record, parse);
  if (kind === "endpoints") {
    const compiled = compileEndpoint(document);
    return { kind, id: compiled.id, entry: { document, record, compiled, enabled: record["enabled"] !== false } };
  }
  if (kind === "collections") {
    const compiled = compileCollection(document);
    return { kind, id: compiled.definition.id, entry: { document, record, compiled } };
  }
  const compiled = compileWorkflow(document);
  return { kind, id: compiled.id, entry: { document, record, compiled } };
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
    else if (item.kind === "collections") catalog.collections.set(item.id, item.entry);
    else catalog.workflows.set(item.id, item.entry);
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
  if (removed) catalog.revision += 1;
  return removed;
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
  return { groups, tables };
}

// Upserts editor game values by id; the revision bump makes storage rebuild with the new values.
export function upsertGameValues(catalog: Catalog, items: readonly Record<string, unknown>[]): void {
  for (const item of items) catalog.gameValues.set(String(item["id"]), item);
  catalog.revision += 1;
}

// The stored document for one id, or undefined when no such resource exists.
export function documentOf(catalog: Catalog, kind: ResourceKind, id: string): Record<string, unknown> | undefined {
  const entry = kind === "endpoints" ? catalog.endpoints.get(id) : kind === "collections" ? catalog.collections.get(id) : catalog.workflows.get(id);
  return entry?.document;
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
  const user = [...catalog.collections.values()].map((entry) => entry.compiled.definition);
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
