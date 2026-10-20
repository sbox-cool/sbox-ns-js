import type { EndpointHandler, EndpointRequest, Ns, WorkflowFunction } from "../endpoint/types.js";
import type { CollectionDefinition } from "../storage/types.js";
import { resolveTemplate } from "./expression.js";
import { DslResponse, newRunState, routeOf, runSteps, STEP_TYPES, type RunState, type StepDef } from "./steps.js";

// Compiles declarative YAML documents (endpoint, workflow, collection) into the handler shapes the engine runs.
// Documents are validated up front, so a document that compiles never fails for structural reasons at runtime.

export class DefinitionError extends Error {
  constructor(
    readonly path: string,
    message: string,
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
  handler: EndpointHandler;
}

export interface CompiledWorkflow {
  id: string;
  definition: WorkflowFunction;
}

const ENDPOINT_FIELDS = ["sourceVersion", "kind", "id", "name", "description", "exposure", "method", "requiresSecretKey", "input", "steps", "response"];
const WORKFLOW_FIELDS = ["sourceVersion", "kind", "id", "name", "description", "definition"];
const COLLECTION_FIELDS = ["sourceVersion", "kind", "id", "name", "description", "definition"];
const ACCESS_MODES = ["public", "endpoint", "private"];
const INPUT_TYPES = ["string", "number", "integer", "boolean", "object", "array"];

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!isObject(value)) throw new DefinitionError(path, "must be an object.");
  return value;
}

function requireId(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value)) {
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
  if (doc["sourceVersion"] !== 1) throw new DefinitionError(`${path}.sourceVersion`, "must be 1.");
  if (doc["kind"] !== kind) throw new DefinitionError(`${path}.kind`, `must be "${kind}".`);
}

// Validates a step list recursively. Step ids must be unique across the whole document. A goto target must name a step
// in this list or in an enclosing list (`enclosing`).
function validateSteps(steps: unknown, path: string, seen: Set<string>, enclosing: readonly string[]): void {
  if (!Array.isArray(steps)) throw new DefinitionError(path, "must be an array.");
  const entries = steps.map((raw, index) => {
    const at = `${path}[${index}]`;
    const step = requireObject(raw, at);
    const id = requireId(step["id"], `${at}.id`);
    if (seen.has(id)) throw new DefinitionError(`${at}.id`, `duplicate step id "${id}".`);
    seen.add(id);
    const type = step["type"];
    if (typeof type !== "string" || !STEP_TYPES.includes(type)) {
      throw new DefinitionError(`${at}.type`, `unsupported step type "${String(type)}".`);
    }
    return { at, step, id, type };
  });
  const visible = [...enclosing, ...entries.map((entry) => entry.id)];
  for (const { at, step, type } of entries) {
    if (type === "block") validateSteps(step["steps"] ?? [], `${at}.steps`, seen, visible);
    if (step["routes"] !== undefined) validateRoutes(step["routes"], `${at}.routes`, visible);
  }
}

function validateRoutes(routes: unknown, path: string, visible: readonly string[]): void {
  const table = requireObject(routes, path);
  for (const [outcome, raw] of Object.entries(table)) {
    if (outcome !== "true" && outcome !== "false") throw new DefinitionError(`${path}.${outcome}`, "must be true or false.");
    const route = routeOf(raw, outcome === "true" ? "continue" : "reject");
    if (route === null) throw new DefinitionError(`${path}.${outcome}`, "is not a valid route.");
    if (route.action === "goto" && !visible.includes(route.target)) {
      throw new DefinitionError(`${path}.${outcome}`, `goto target "${route.target}" is not a step in scope.`);
    }
  }
}

// Input schema check for endpoint requests: an object with optional typed properties and required names.
export function validateInput(schema: unknown, input: Record<string, unknown>, ns: Ns): void {
  if (!isObject(schema)) return;
  const properties = isObject(schema["properties"]) ? schema["properties"] : {};
  const required = Array.isArray(schema["required"]) ? schema["required"] : [];
  for (const name of required) {
    if (typeof name === "string" && input[name] === undefined) ns.fail("INVALID_INPUT", `Missing required field "${name}".`, 400);
  }
  for (const [name, spec] of Object.entries(properties)) {
    const value = input[name];
    if (value === undefined || !isObject(spec) || typeof spec["type"] !== "string") continue;
    if (!matchesType(spec["type"], value)) ns.fail("INVALID_INPUT", `Field "${name}" must be a ${spec["type"]}.`, 400);
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

export function compileEndpoint(source: unknown): CompiledEndpoint {
  const doc = requireObject(source, "endpoint");
  rejectUnknown(doc, ENDPOINT_FIELDS, "endpoint");
  checkSourceVersion(doc, "endpoint", "endpoint");
  const id = requireId(doc["id"], "endpoint.id");
  const method = doc["method"];
  if (method !== "GET" && method !== "POST") throw new DefinitionError("endpoint.method", "must be GET or POST.");
  const exposure = doc["exposure"];
  if (typeof exposure !== "string" || !ACCESS_MODES.includes(exposure)) {
    throw new DefinitionError("endpoint.exposure", `must be one of ${ACCESS_MODES.join(", ")}.`);
  }
  const requiresSecretKey = doc["requiresSecretKey"] === true;
  validateInputSchema(doc["input"], "endpoint.input");
  validateSteps(doc["steps"] ?? [], "endpoint.steps", new Set(), []);
  const response = requireObject(doc["response"] ?? { status: 200, body: {} }, "endpoint.response");
  const steps = (doc["steps"] ?? []) as readonly StepDef[];
  const inputSchema = doc["input"];

  const handler: EndpointHandler = (req: EndpointRequest, ns: Ns) => {
    validateInput(inputSchema, req.input, ns);
    const scope: Record<string, unknown> = {
      input: req.input,
      steamId: req.player?.steamId ?? "anonymous",
      method: req.method,
    };
    const state = newRunState(ns, scope);
    runSteps(steps, state);
    return renderResponse(response, state);
  };
  return { id, method, exposure, requiresSecretKey, handler };
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

export function compileCollection(source: unknown): CompiledCollection {
  const doc = requireObject(source, "collection");
  rejectUnknown(doc, COLLECTION_FIELDS, "collection");
  checkSourceVersion(doc, "collection", "collection");
  const id = requireId(doc["id"], "collection.id");
  const body = requireObject(doc["definition"], "collection.definition");
  rejectUnknown(body, ["collectionType", "accessMode", "maxRecords", "allowRecordDelete", "requireSaveVersion", "rateLimitAction", "rateLimits", "schema"], "collection.definition");
  const accessMode = body["accessMode"];
  if (accessMode !== undefined && (typeof accessMode !== "string" || !ACCESS_MODES.includes(accessMode))) {
    throw new DefinitionError("collection.definition.accessMode", `must be one of ${ACCESS_MODES.join(", ")}.`);
  }
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
  return { definition, modifiers };
}
