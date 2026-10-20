import {
  compileCollection,
  compileEndpoint,
  compileWorkflow,
  type CompiledCollection,
  type CompiledEndpoint,
  type CompiledWorkflow,
} from "../dsl/compile.js";
import { isRecord } from "../util/guards.js";
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
  readonly compiled: CompiledEndpoint;
  readonly enabled: boolean;
}

export interface CollectionEntry {
  readonly document: Readonly<Record<string, unknown>>;
  readonly compiled: CompiledCollection;
}

export interface WorkflowEntry {
  readonly document: Readonly<Record<string, unknown>>;
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

function documentFor(kind: ResourceKind, record: Readonly<Record<string, unknown>>, parse: Parser): Record<string, unknown> {
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
    return { kind, id: compiled.id, entry: { document, compiled, enabled: record["enabled"] !== false } };
  }
  if (kind === "collections") {
    const compiled = compileCollection(document);
    return { kind, id: compiled.definition.id, entry: { document, compiled } };
  }
  const compiled = compileWorkflow(document);
  return { kind, id: compiled.id, entry: { document, compiled } };
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

export function commitCompiled(catalog: Catalog, items: readonly Compiled[]): void {
  for (const item of items) {
    if (item.kind === "endpoints") catalog.endpoints.set(item.id, item.entry);
    else if (item.kind === "collections") catalog.collections.set(item.id, item.entry);
    else catalog.workflows.set(item.id, item.entry);
  }
  catalog.revision += 1;
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
      tables[id] = { name: item["name"], description: item["description"], columns: item["columns"], rows: item["rows"] };
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

const INTERNAL_COLLECTIONS: readonly CollectionDefinition[] = [
  // Per-player heartbeat totals written by the stats route.
  { id: "_stats", collectionType: "per-steamid", accessMode: "endpoint", schema: { type: "object" } },
  // Analytics events written by the analytics route.
  { id: "_analytics", collectionType: "per-steamid", accessMode: "endpoint", schema: { type: "object" } },
];

export function storageDefinitionOf(catalog: Catalog, values: ValuesDocument): StorageDefinition {
  const user = [...catalog.collections.values()].map((entry) => entry.compiled.definition);
  const reserved = new Set(INTERNAL_COLLECTIONS.map((definition) => definition.id));
  return {
    collections: [...INTERNAL_COLLECTIONS, ...user.filter((definition) => !reserved.has(definition.id))],
    values: flatValuesOf(values),
  };
}

// Storage reads values by id: a group's entries under the group id, a table's rows under the table id.
function flatValuesOf(values: ValuesDocument): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const [id, group] of Object.entries(values.groups)) flat[id] = isRecord(group) ? group["values"] : undefined;
  for (const [id, table] of Object.entries(values.tables)) flat[id] = isRecord(table) ? table["rows"] : undefined;
  return flat;
}
