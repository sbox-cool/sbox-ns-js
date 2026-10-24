import type { EndpointHandler, EndpointRequest, Ns, WorkflowFunction } from "../endpoint/types.js";
import type { CollectionDefinition } from "../storage/types.js";
import { resolveTemplate } from "./expression.js";
import { conditionRoute, DslResponse, newRunState, recordStepFinding, routeOf, runSteps, STEP_TYPES, type RunState, type StepDef } from "./steps.js";
import { analyzeScript, ScriptModuleUnsupported, ScriptSyntaxError, type CompiledScript } from "../script/analysis.js";
import { scriptHandler } from "../script/handler.js";
import { ScriptEngineMissing } from "../script/load.js";

// Compiles declarative YAML documents (endpoint, workflow, collection) into the handler shapes the engine runs.
// Documents are validated up front, so a document that compiles never fails for structural reasons at runtime.

export class DefinitionError extends Error {
  constructor(
    readonly path: string,
    message: string,
    readonly code: string = "VALIDATION_FAILED",
  ) {
    super(`${path}: ${message}`);
    this.name = "DefinitionError";
  }
}

export interface CompiledEndpoint {
  id: string;
  method: "GET" | "POST";
  exposure: string;
  requiresSecretKey: boolean;
  scope: "public" | "global";
  script: CompiledScript | null;
  handler: EndpointHandler;
}

export interface CompiledWorkflow {
  id: string;
  definition: WorkflowFunction;
}

const ENDPOINT_FIELDS = ["sourceVersion", "kind", "id", "slug", "enabled", "name", "description", "exposure", "internal", "internalOnly", "method", "requiresSecretKey", "input", "steps", "response"];
// Top-level fields that make a document a script endpoint (the server's IsScriptedEndpoint).
const SCRIPT_FIELDS = ["runtime", "script", "scope", "scriptFile"];
const SCRIPT_MAX_BYTES = 64 * 1024;
const WORKFLOW_FIELDS = ["sourceVersion", "kind", "id", "name", "description", "definition"];
// The collection envelope. Every other top-level key is the body, which is the server's shape (see compileCollection).
const COLLECTION_ENVELOPE = ["sourceVersion", "kind", "id", "name", "description", "definition"];
// Collection keys the server accepts that this SDK does not implement. They fail the compile rather than being dropped.
const COLLECTION_UNSUPPORTED = ["fields", "tables", "webhookOnRateLimit"];
const ACCESS_MODES = ["public", "endpoint", "private"];
const INPUT_TYPES = ["string", "number", "integer", "boolean", "object", "array"];

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!isObject(value)) throw new DefinitionError(path, "must be an object.");
  return value;
}

const ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

function requireId(value: unknown, path: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new DefinitionError(path, "must be a lowercase id (a-z, 0-9, _ or -).");
  }
  return value;
}

function rejectUnknown(doc: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const field of Object.keys(doc)) {
    if (!allowed.includes(field)) throw new DefinitionError(`${path}.${field}`, "is not a recognised field.");
  }
}

function checkSourceVersion(doc: Record<string, unknown>, kind: string, path: string): void {
  // The server's rule: sourceVersion and kind are optional. When declared they must be 1 and this document's kind.
  if (doc["sourceVersion"] !== undefined && doc["sourceVersion"] !== 1) throw new DefinitionError(`${path}.sourceVersion`, "must be 1.");
  if (doc["kind"] !== undefined && doc["kind"] !== kind) throw new DefinitionError(`${path}.kind`, `must be "${kind}".`);
}

// Validates a step list recursively. A problem with one step is recorded as a finding on that step (recordStepFinding):
// the step is stored and fails when it runs, as the hosted backend does. Step ids must be unique across the whole
// document. A goto target must name a step in this list or in an enclosing list (`enclosing`).
function validateSteps(steps: unknown, path: string, seen: Set<string>, enclosing: readonly string[]): void {
  if (!Array.isArray(steps)) throw new DefinitionError(path, "must be an array.");
  const entries = steps.map((raw, index) => {
    const at = `${path}[${index}]`;
    const step = requireObject(raw, at);
    const type = step["type"];
    if (typeof type !== "string" || !STEP_TYPES.includes(type)) {
      recordStepFinding(step, `${at}.type: unsupported step type "${String(type)}".`);
    }
    const id = stepIdOf(step, at, seen);
    if (type === "condition" && step["check"] === undefined) recordStepFinding(step, `${at}.check: a condition needs a check.`);
    return { at, step, id, type };
  });
  const visible = [...enclosing, ...entries.flatMap((entry) => (entry.id === null ? [] : [entry.id]))];
  for (const { at, step, type } of entries) {
    if (type === "block") {
      const nested = step["steps"] ?? [];
      if (Array.isArray(nested)) validateSteps(nested, `${at}.steps`, seen, visible);
      else recordStepFinding(step, `${at}.steps: must be a list of steps.`);
    }
    if (type === "condition") validateCondition(step, at, visible);
    else if (step["routes"] !== undefined) validateRoutes(step, `${at}.routes`, visible);
  }
}

// The step's id, or null when it is missing, malformed or already used. Each of those is a finding on the step.
function stepIdOf(step: Record<string, unknown>, at: string, seen: Set<string>): string | null {
  const id = step["id"];
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    recordStepFinding(step, `${at}.id: must be a lowercase id (a-z, 0-9, _ or -).`);
    return null;
  }
  if (seen.has(id)) {
    recordStepFinding(step, `${at}.id: duplicate step id "${id}".`);
    return null;
  }
  seen.add(id);
  return id;
}

function validateRoutes(step: Record<string, unknown>, path: string, visible: readonly string[]): void {
  const table = step["routes"];
  if (!isObject(table)) {
    recordStepFinding(step, `${path}: must be an object.`);
    return;
  }
  for (const [outcome, raw] of Object.entries(table)) {
    const at = `${path}.${outcome}`;
    if (outcome !== "true" && outcome !== "false") {
      recordStepFinding(step, `${at}: must be true or false.`);
      continue;
    }
    const route = routeOf(raw, outcome === "true" ? "continue" : "reject");
    if (route === null) recordStepFinding(step, `${at}: is not a valid route.`);
    else if (route.action === "goto" && !visible.includes(route.target)) {
      recordStepFinding(step, `${at}: goto target "${route.target}" is not a step in scope.`);
    }
  }
}

const CONDITION_ROUTE_KEYS = ["true", "false", "pass", "fail"];

// A condition's routes come from `routes`, `onTrue`/`onFalse`, or the legacy `onFail`. Every effective route must be valid,
// and a goto must name a step in scope. `retry` is accepted and ignored, as the reference does. Problems are findings on
// the step: it is stored and fails when it runs.
function validateCondition(step: Record<string, unknown>, at: string, visible: readonly string[]): void {
  if (step["routes"] !== undefined) {
    if (!isObject(step["routes"])) {
      recordStepFinding(step, `${at}.routes: must be an object.`);
      return;
    }
    for (const outcome of Object.keys(step["routes"])) {
      if (!CONDITION_ROUTE_KEYS.includes(outcome)) recordStepFinding(step, `${at}.routes.${outcome}: must be true, false, pass, or fail.`);
    }
  }
  const onFail = step["onFail"];
  if (onFail !== undefined && onFail !== null && onFail !== "skip" && !isObject(onFail)) {
    recordStepFinding(step, `${at}.onFail: must be an object or "skip".`);
  }
  for (const outcome of ["true", "false"] as const) {
    const route = conditionRoute(step, outcome);
    if (route === null) recordStepFinding(step, `${at}.${outcome}: is not a valid route.`);
    else if (route.action === "goto" && !visible.includes(route.target)) {
      recordStepFinding(step, `${at}.${outcome}: goto target "${route.target}" is not a step in scope.`);
    }
  }
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isObject(value);
    case "array":
      return Array.isArray(value);
    default:
      return false;
  }
}

function validateInputSchema(schema: unknown, path: string): void {
  if (schema === undefined) return;
  const spec = requireObject(schema, path);
  if (spec["type"] !== "object") throw new DefinitionError(`${path}.type`, "must be object.");
  const properties = spec["properties"] === undefined ? {} : requireObject(spec["properties"], `${path}.properties`);
  for (const [name, prop] of Object.entries(properties)) {
    const field = requireObject(prop, `${path}.properties.${name}`);
    if (typeof field["type"] !== "string" || !INPUT_TYPES.includes(field["type"])) {
      throw new DefinitionError(`${path}.properties.${name}.type`, `must be one of ${INPUT_TYPES.join(", ")}.`);
    }
  }
}

function scopeOf(ns: Ns): { now: () => number } {
  return { now: () => ns.now() };
}

// Builds the value a route returns: the rendered body, wrapped with its status.
function renderResponse(response: Record<string, unknown>, state: RunState): DslResponse {
  const status = typeof response["status"] === "number" ? response["status"] : 200;
  return new DslResponse(status, resolveTemplate(response["body"] ?? {}, state.scope, scopeOf(state.ns)));
}

// The server's script rules for one endpoint or global document (ValidateScriptEndpoint). Cross-document import
// checks (GLOBAL_NOT_FOUND, GLOBAL_EXPORT_NOT_FOUND, GLOBAL_CYCLE) run at sync, over the whole catalog.
function compileScript(doc: Record<string, unknown>, id: string): { scope: "public" | "global"; compiled: CompiledScript } {
  if (doc["steps"] !== undefined) throw new DefinitionError("endpoint.steps", "cannot be combined with script.", "SCRIPT_AND_STEPS");
  const runtime = doc["runtime"];
  if (runtime === undefined) throw new DefinitionError("endpoint.runtime", "is required for a script endpoint.", "MISSING_RUNTIME");
  if (runtime !== "javascript" && runtime !== "typescript") {
    throw new DefinitionError("endpoint.runtime", "must be javascript or typescript.", "INVALID_RUNTIME");
  }
  const scope = doc["scope"] ?? "public";
  if (scope !== "public" && scope !== "global") throw new DefinitionError("endpoint.scope", "must be public or global.", "INVALID_SCOPE");
  const source = doc["script"];
  if (source === undefined && doc["scriptFile"] !== undefined) {
    throw new DefinitionError("endpoint.scriptFile", "needs script: the script text is the source.", "SCRIPT_FILE_WITHOUT_SCRIPT");
  }
  if (source === undefined) throw new DefinitionError("endpoint.script", "is required for a script endpoint.", "MISSING_SCRIPT");
  if (typeof source !== "string") throw new DefinitionError("endpoint.script", "must be a string.", "INVALID_SCRIPT");
  if (new TextEncoder().encode(source).byteLength > SCRIPT_MAX_BYTES) {
    throw new DefinitionError("endpoint.script", `is larger than ${SCRIPT_MAX_BYTES} bytes.`, "SCRIPT_TOO_LARGE");
  }
  let compiled: CompiledScript;
  try {
    compiled = analyzeScript(source, runtime, scope === "global" ? `globals/${id}` : "endpoint");
  } catch (error) {
    if (error instanceof ScriptSyntaxError) throw new DefinitionError("endpoint.script", error.message, "SCRIPT_SYNTAX");
    if (error instanceof ScriptModuleUnsupported) throw new DefinitionError("endpoint.script", error.message, "SCRIPT_MODULE_UNSUPPORTED");
    if (error instanceof ScriptEngineMissing) throw new DefinitionError("endpoint.script", error.message, "SCRIPT_ENGINE_MISSING");
    throw error;
  }
  if (scope === "public" && !compiled.exports.includes("default")) {
    throw new DefinitionError("endpoint.script", "must export default function handle(req, ns).", "INVALID_SCRIPT");
  }
  return { scope, compiled };
}

export function compileEndpoint(source: unknown): CompiledEndpoint {
  const doc = requireObject(source, "endpoint");
  rejectUnknown(doc, [...ENDPOINT_FIELDS, ...SCRIPT_FIELDS], "endpoint");
  checkSourceVersion(doc, "endpoint", "endpoint");
  const id = requireId(doc["id"], "endpoint.id");
  // The server routes an endpoint by slug. This SDK routes by id, so a declared slug must equal the id.
  if (doc["slug"] !== undefined && doc["slug"] !== id) throw new DefinitionError("endpoint.slug", "must equal endpoint.id; this SDK routes endpoints by id.");
  if (doc["enabled"] !== undefined && typeof doc["enabled"] !== "boolean") throw new DefinitionError("endpoint.enabled", "must be true or false.");
  const method = doc["method"];
  if (method !== "GET" && method !== "POST") throw new DefinitionError("endpoint.method", "must be GET or POST.");
  // The server's rule: exposure is optional and defaults to public. The legacy internal and internalOnly flags also make an endpoint internal.
  const declaredExposure: unknown = doc["exposure"] ?? "public";
  if (declaredExposure !== "public" && declaredExposure !== "internal") {
    throw new DefinitionError("endpoint.exposure", "must be public or internal.");
  }
  const legacyInternal = doc["internal"] === true || doc["internalOnly"] === true;
  const exposure = declaredExposure === "internal" || legacyInternal ? "internal" : "public";
  const requiresSecretKey = doc["requiresSecretKey"] === true;
  validateInputSchema(doc["input"], "endpoint.input");
  if (SCRIPT_FIELDS.some((field) => doc[field] !== undefined)) {
    const script = compileScript(doc, id);
    return { id, method, exposure, requiresSecretKey, scope: script.scope, script: script.compiled, handler: scriptHandler(script.compiled.module) };
  }
  validateSteps(doc["steps"] ?? [], "endpoint.steps", new Set(), []);
  const response = requireObject(doc["response"] ?? { status: 200, body: {} }, "endpoint.response");
  const steps = (doc["steps"] ?? []) as readonly StepDef[];

  const handler: EndpointHandler = (req: EndpointRequest, ns: Ns) => {
    const scope: Record<string, unknown> = {
      input: req.input,
      steamId: req.player?.steamId ?? "anonymous",
      method: req.method,
    };
    const state = newRunState(ns, scope);
    runSteps(steps, state);
    return renderResponse(response, state);
  };
  return { id, method, exposure, requiresSecretKey, scope: "public", script: null, handler };
}

export function compileWorkflow(source: unknown): CompiledWorkflow {
  const doc = requireObject(source, "workflow");
  rejectUnknown(doc, WORKFLOW_FIELDS, "workflow");
  checkSourceVersion(doc, "workflow", "workflow");
  const id = requireId(doc["id"], "workflow.id");
  const body = requireObject(doc["definition"], "workflow.definition");
  const params = body["params"] === undefined ? {} : requireObject(body["params"], "workflow.definition.params");
  validateSteps(body["steps"] ?? [], "workflow.definition.steps", new Set(), []);
  const steps = (body["steps"] ?? []) as readonly StepDef[];
  const returns = body["returns"] ?? {};

  const definition: WorkflowFunction = (input: Record<string, unknown>, ns: Ns) => {
    const scope: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(params)) {
      const declared = isObject(spec) && typeof spec["type"] === "string" ? spec["type"] : "";
      if (input[name] === undefined || (declared !== "" && !matchesType(declared, input[name]))) {
        ns.fail("INVALID_INPUT", `Workflow "${id}" parameter "${name}" must be a ${declared || "value"}.`, 400);
      }
      scope[name] = input[name];
    }
    const state = newRunState(ns, scope);
    runSteps(steps, state);
    return resolveTemplate(returns, scope, scopeOf(ns));
  };
  return { id, definition };
}

// Keywords the storage record editor accepts on a schema node. Any other key (ledger/unique/max flags, $ref) fails
// every write, so it is removed from the schema and returned as metadata instead.
const SCHEMA_KEYWORDS = new Set([
  "type", "properties", "required", "additionalProperties", "enum", "items",
  "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems",
  "description", "title", "default", "$schema",
]);

export interface CompiledCollection {
  definition: CollectionDefinition;
  // Stripped modifiers, keyed by schema path (e.g. "schema.properties.gold"), e.g. ["_ledger"].
  modifiers: Map<string, string[]>;
  // Game-value groups from the collection's constants, carrying the collection's visibility.
  constants: CollectionConstants[];
}

export interface CollectionConstants {
  id: string;
  visibility: string;
  entries: Record<string, unknown>;
}

function addModifier(modifiers: Map<string, string[]>, path: string, key: string): void {
  modifiers.set(path, [...(modifiers.get(path) ?? []), key]);
}

function cleanFieldMap(map: Record<string, unknown>, path: string, modifiers: Map<string, string[]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(map)) out[key] = cleanSchemaNode(map[key], `${path}.${key}`, modifiers);
  return out;
}

function cleanSchemaNode(node: unknown, path: string, modifiers: Map<string, string[]>): unknown {
  if (!isObject(node)) return node;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (!SCHEMA_KEYWORDS.has(key)) {
      addModifier(modifiers, path, key);
    } else if (key === "properties" && isObject(value)) {
      out[key] = cleanFieldMap(value, `${path}.properties`, modifiers);
    } else if (key === "items") {
      out[key] = cleanSchemaNode(value, `${path}.items`, modifiers);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// A schema is either the standard keyword form (has a string `type` or `properties`) or a bare field map.
function cleanSchema(schema: unknown, modifiers: Map<string, string[]>): unknown {
  if (!isObject(schema)) return schema;
  const standard = typeof schema["type"] === "string" || isObject(schema["properties"]);
  return standard ? cleanSchemaNode(schema, "schema", modifiers) : cleanFieldMap(schema, "schema", modifiers);
}

// Two forms, as the server reads them: a list of groups, each carrying its id and entries (the editor's shape), or a map
// from group id to entries.
function constantGroupsOf(value: unknown, visibility: string): CollectionConstants[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    return value.map((group: unknown) => {
      const record = requireObject(group, "collection.constants");
      const id = requireId(record["id"], "collection.constants.id");
      return { id, visibility, entries: requireObject(record["entries"], `collection.constants.${id}.entries`) };
    });
  }
  const groups = requireObject(value, "collection.constants");
  return Object.entries(groups).map(([id, entries]) => ({ id, visibility, entries: requireObject(entries, `collection.constants.${id}`) }));
}

export function compileCollection(source: unknown): CompiledCollection {
  const doc = requireObject(source, "collection");
  checkSourceVersion(doc, "collection", "collection");
  const id = requireId(doc["id"], "collection.id");
  // The server's shape keeps the body beside the envelope. The wrapped `definition` form is still accepted.
  // Unknown keys are ignored, as the server ignores them. Keys the server accepts but this SDK does not implement fail.
  const body =
    doc["definition"] === undefined
      ? Object.fromEntries(Object.entries(doc).filter(([key]) => !COLLECTION_ENVELOPE.includes(key)))
      : requireObject(doc["definition"], "collection.definition");
  for (const key of COLLECTION_UNSUPPORTED) {
    if (Object.hasOwn(body, key)) throw new DefinitionError(`collection.${key}`, "is not supported by this SDK.");
  }
  const accessMode = body["accessMode"];
  if (accessMode !== undefined && (typeof accessMode !== "string" || !ACCESS_MODES.includes(accessMode))) {
    throw new DefinitionError("collection.accessMode", `must be one of ${ACCESS_MODES.join(", ")}.`);
  }
  // The server's default: public when accessMode is public, otherwise private.
  const visibility = body["visibility"] ?? (accessMode === "public" ? "public" : "private");
  if (typeof visibility !== "string") throw new DefinitionError("collection.visibility", "must be a string.");
  const modifiers = new Map<string, string[]>();
  const definition: CollectionDefinition = {
    id,
    name: typeof doc["name"] === "string" ? doc["name"] : id,
    collectionType: typeof body["collectionType"] === "string" ? body["collectionType"] : undefined,
    accessMode: typeof accessMode === "string" ? accessMode : undefined,
    maxRecords: typeof body["maxRecords"] === "number" ? body["maxRecords"] : undefined,
    allowRecordDelete: typeof body["allowRecordDelete"] === "boolean" ? body["allowRecordDelete"] : undefined,
    requireSaveVersion: typeof body["requireSaveVersion"] === "boolean" ? body["requireSaveVersion"] : undefined,
    schema: cleanSchema(body["schema"], modifiers),
  };
  return { definition, modifiers, constants: constantGroupsOf(body["constants"], visibility) };
}
