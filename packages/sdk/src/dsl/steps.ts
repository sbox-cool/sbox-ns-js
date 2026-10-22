import type { Ns } from "../endpoint/types.js";
import { internalsOf } from "../endpoint/execution.js";
import {
  compareValues,
  ExpressionError,
  evaluateCheck,
  evaluateExpression,
  inlineTemplates,
  resolveTemplate,
  toNumber,
  toText,
  type EvalOptions,
} from "./expression.js";
import { fitEmbed, isDiscordWebhookUrl, MAX_SLEEP_MS, postDiscordWebhook, sleepFor, type DiscordEmbed, type DiscordField, type DiscordPayload } from "./effects.js";
import { applyWriteOps, OperationError } from "./operations.js";
import { betaSample, randomFloat, randomInt, weightedSelect } from "./random.js";

// Declarative step interpreter. Steps run against a scope object and touch records only through `ns`, so the
// engine's read-your-writes overlay, version tracking, and atomic flush apply to declarative and code endpoints alike.
//
// Effects that wait on the outside world (sleep, webhook) go through `internalsOf(ns).effect`. A declarative run
// suspends there, performs the effect asynchronously, and re-runs the pass with the recorded result. A scripted run
// never performs them (sleep is skipped, webhooks are refused), so this module stays synchronous for user code.

export type StepDef = Readonly<Record<string, unknown>> & { type: string; id: string };

export interface RunState {
  readonly ns: Ns;
  readonly scope: Record<string, unknown>;
  // Set by a `return` route or `response` step. Remaining steps are skipped.
  returned: boolean;
  // Executions of each step key in this pass. A step that runs more than MAX_STEP_VISITS times fails the endpoint.
  readonly visits: Map<string, number>;
}

export function newRunState(ns: Ns, scope: Record<string, unknown>): RunState {
  return { ns, scope, returned: false, visits: new Map() };
}

// A declarative endpoint's success result. `status` is the response.status from the endpoint document.
export class DslResponse {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}

export const STEP_TYPES: readonly string[] = [
  "block",
  "read",
  "write",
  "delete",
  "condition",
  "assert",
  "transform",
  "object",
  "array",
  "merge",
  "lookup",
  "filter",
  "lookup_many",
  "random",
  "workflow",
  "response",
  "sleep",
  "webhook",
  "sort",
  "switch",
  "compute",
];

// What a condition route asks for. `goto` names a step in the same list or an enclosing one; `skip` jumps over the
// next `count` steps; `run` invokes a workflow and stores its result under `as` (default `<id>_run`).
export type Route =
  | { action: "continue" }
  | { action: "return" }
  | { action: "reject"; error?: string; message?: unknown; status?: number }
  | { action: "goto"; target: string }
  | { action: "skip"; count: number }
  | { action: "run"; workflow: string; params: unknown; as?: string };

export const MAX_STEP_VISITS = 100;

const DEFAULT_WEBHOOK_COLOR = 0x5865f2;

// Normalizes one route value. A string is an action name, `skip` (one step), or otherwise a goto target. An object
// names its action with `action`; without one, its keys decide (`step`/`target`/`goto`, `workflow`/`flow`/`endpoint`,
// `skip`), and an object with none of those takes the fallback action. Returns null for an invalid route.
export function routeOf(raw: unknown, fallback: "continue" | "reject"): Route | null {
  if (raw === undefined || raw === null) return { action: fallback };
  if (typeof raw === "string") {
    if (raw === "continue" || raw === "return" || raw === "reject") return { action: raw };
    if (raw === "skip") return { action: "skip", count: 1 };
    return raw === "" ? null : { action: "goto", target: raw };
  }
  if (!isObject(raw)) return null;
  if (typeof raw["action"] === "string") return routeByAction(raw["action"], raw);
  if (raw["step"] !== undefined || raw["target"] !== undefined || raw["goto"] !== undefined) {
    return routeByAction("goto", raw);
  }
  if (raw["workflow"] !== undefined || raw["flow"] !== undefined || raw["endpoint"] !== undefined) {
    return routeByAction("run", raw);
  }
  if (raw["skip"] !== undefined) return routeByAction("skip", raw);
  return routeByAction(fallback, raw);
}

function routeByAction(action: string, raw: Readonly<Record<string, unknown>>): Route | null {
  switch (action) {
    case "continue":
    case "return":
      return { action };
    case "reject": {
      const error = typeof raw["errorCode"] === "string" ? raw["errorCode"] : raw["error"];
      const message = raw["errorMessage"] ?? raw["message"];
      const status = typeof raw["status"] === "number" ? raw["status"] : undefined;
      return {
        action: "reject",
        ...(typeof error === "string" ? { error } : {}),
        ...(message === undefined ? {} : { message }),
        ...(status === undefined ? {} : { status }),
      };
    }
    case "goto": {
      const target = [raw["step"], raw["target"], raw["goto"]].find((value) => typeof value === "string");
      return typeof target === "string" && target !== "" ? { action: "goto", target } : null;
    }
    case "skip": {
      const count = raw["count"] ?? raw["skip"] ?? 1;
      return typeof count === "number" && Number.isInteger(count) && count > 0 ? { action: "skip", count } : null;
    }
    case "run": {
      const workflow = [raw["flow"], raw["workflow"], raw["endpoint"], raw["target"]].find((value) => typeof value === "string");
      if (typeof workflow !== "string" || workflow === "") return null;
      const as = typeof raw["as"] === "string" ? raw["as"] : undefined;
      return { action: "run", workflow, params: raw["params"], ...(as === undefined ? {} : { as }) };
    }
    default:
      return null;
  }
}

// Flow requested by a step to the list that holds it.
type Flow = { kind: "goto"; target: string } | { kind: "skip"; count: number };

function str(step: StepDef, field: string): string {
  const value = step[field];
  return typeof value === "string" ? value : "";
}

function asKeyOf(step: StepDef): string {
  return typeof step["as"] === "string" ? step["as"] : step.id;
}

function stepErrorCode(step: StepDef): string {
  return `ENDPOINT_ERROR.${step.type.toUpperCase()}`;
}

function scopeOf(state: RunState): EvalOptions {
  return { now: () => state.ns.now() };
}

function render(template: unknown, state: RunState): unknown {
  return resolveTemplate(template, state.scope, scopeOf(state));
}

function renderMessage(template: unknown, state: RunState, fallback: string): string {
  if (typeof template !== "string") return fallback;
  return toText(render(template, state));
}

// Text of a template, with null and undefined rendering as the empty string.
function textOf(template: unknown, state: RunState): string {
  const value = render(template, state);
  return value === undefined || value === null ? "" : toText(value);
}

// Numeric template value; missing or non-numeric values fall back.
function numberOf(template: unknown, state: RunState, fallback: number): number {
  if (template === undefined || template === null) return fallback;
  const value = toNumber(render(template, state));
  return Number.isNaN(value) ? fallback : value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nested(value: unknown, path: string): unknown {
  let cursor = value;
  for (const part of path.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = Reflect.get(cursor, part);
  }
  return cursor;
}

function stepsOf(step: StepDef): readonly StepDef[] {
  return Array.isArray(step["steps"]) ? (step["steps"] as StepDef[]) : [];
}

function evaluateCond(check: unknown, state: RunState): boolean {
  if (!isObject(check)) state.ns.fail("INVALID_STEP", "A check must be an object with field, op and value.", 500);
  return evaluateCheck(check as { field: unknown; op: string; value: unknown }, state.scope, scopeOf(state));
}

// Where clause of lookup/filter steps. The field is read from the candidate row; the value is templated.
function matchesWhere(where: Readonly<Record<string, unknown>>, row: unknown, state: RunState): boolean {
  const field = typeof where["field"] === "string" ? where["field"] : "";
  const op = typeof where["op"] === "string" ? where["op"] : "==";
  return compareValues(nested(row, field), op, render(where["value"], state));
}

function tableRows(step: StepDef, state: RunState): readonly unknown[] {
  if (step["source"] !== "values") state.ns.fail("INVALID_STEP", `Step "${step.id}": only the values source is supported.`, 500);
  const rows = state.ns.values.get(str(step, "table"));
  if (!Array.isArray(rows)) state.ns.fail("INVALID_STEP", `Step "${step.id}": game-values table "${str(step, "table")}" has no rows.`, 500);
  return rows;
}

function runWorkflowInto(key: string, workflow: string, params: unknown, state: RunState): void {
  const input: Record<string, unknown> = {};
  if (isObject(params)) for (const [name, value] of Object.entries(params)) input[name] = render(value, state);
  state.scope[key] = state.ns.workflows.run(workflow, input);
}

// Applies a condition route. Returns the flow the route requests, or null to continue with the next step.
function applyRoute(step: StepDef, outcome: "true" | "false", state: RunState): Flow | null {
  const routes = isObject(step["routes"]) ? step["routes"] : {};
  const route = routeOf(routes[outcome], outcome === "true" ? "continue" : "reject");
  if (route === null) state.ns.fail("INVALID_STEP", `Condition "${step.id}": unsupported route action.`, 500);
  switch (route.action) {
    case "continue":
      return null;
    case "return":
      state.returned = true;
      return null;
    case "reject":
      state.ns.fail(route.error ?? "CONDITION_FAILED", renderMessage(route.message, state, "Condition check failed."), route.status ?? 400);
    case "goto":
      return { kind: "goto", target: route.target };
    case "skip":
      return { kind: "skip", count: route.count };
    case "run":
      runWorkflowInto(route.as ?? `${step.id}_run`, route.workflow, route.params, state);
      return null;
  }
}

function runWorkflow(step: StepDef, state: RunState): void {
  runWorkflowInto(step.id, str(step, "workflow"), step["params"], state);
}

// Random ---------------------------------------------------------------------------------------------------------

function runRandom(step: StepDef, state: RunState): void {
  const internals = internalsOf(state.ns);
  const mode = typeof step["mode"] === "string" ? step["mode"] : "int";
  const name = `random:${step.id}`;
  if (mode === "int") {
    const min = Math.floor(numberOf(step["min"], state, 0));
    const max = Math.floor(numberOf(step["max"], state, 100));
    state.scope[step.id] = internals.memo(name, () => randomInt(min, max));
    return;
  }
  if (mode === "float") {
    const min = numberOf(step["min"], state, 0);
    const max = numberOf(step["max"], state, 1);
    const precision = precisionOf(step);
    state.scope[step.id] = internals.memo(name, () => roundTo(randomFloat(min, max), precision));
    return;
  }
  if (mode === "weighted") {
    const items = randomItemsOf(step, state);
    if (items === null || items.length === 0) {
      state.ns.fail(stepErrorCode(step), `Random "${step.id}": could not resolve item source.`, 400);
    }
    const eligible = filterByWhere(items, step["where"], state);
    const weightField = typeof step["weightField"] === "string" ? step["weightField"] : "weight";
    state.scope[step.id] = internals.memo(name, () => weightedSelect(eligible, weightField));
    return;
  }
  if (mode === "beta") {
    const alpha = numberOf(step["alpha"], state, 1);
    const beta = numberOf(step["beta"], state, 1);
    const min = numberOf(step["min"], state, 0);
    const max = numberOf(step["max"], state, 1);
    const precision = precisionOf(step);
    state.scope[step.id] = internals.memo(name, () => roundTo(betaSample(alpha, beta, min, max), precision));
    return;
  }
  state.ns.fail(stepErrorCode(step), `Random "${step.id}": unknown mode "${mode}".`, 400);
}

function precisionOf(step: StepDef): number {
  return typeof step["precision"] === "number" ? Math.trunc(step["precision"]) : 2;
}

function roundTo(value: number, precision: number): number {
  return Number(value.toFixed(precision));
}

// Item source of a weighted random step: inline items, then a `from` template resolving to an array, then a values
// table. Returns null when none resolves.
function randomItemsOf(step: StepDef, state: RunState): unknown[] | null {
  if (Array.isArray(step["items"])) return step["items"].map((item) => render(item, state));
  if (typeof step["from"] === "string") {
    const resolved = render(step["from"], state);
    if (Array.isArray(resolved)) return resolved;
  }
  if (step["source"] === "values" && typeof step["table"] === "string") {
    const rows = state.ns.values.get(step["table"]);
    if (Array.isArray(rows)) return rows;
  }
  return null;
}

// Where filter for weighted items. The field is read from the item (a leading `item.` is allowed); the value is
// templated with the item in scope. A where without both field and op filters nothing.
function filterByWhere(items: readonly unknown[], where: unknown, state: RunState): unknown[] {
  if (!isObject(where) || Object.keys(where).length === 0) return [...items];
  const field = typeof where["field"] === "string" ? where["field"] : typeof where["left"] === "string" ? where["left"] : undefined;
  const op = typeof where["op"] === "string" ? where["op"] : undefined;
  if (field === undefined || op === undefined) return [...items];
  const path = field.startsWith("item.") ? field.slice("item.".length) : field;
  return items.filter((item) =>
    compareValues(nested(item, path), op, resolveTemplate(where["value"], { ...state.scope, item }, scopeOf(state))),
  );
}

// Sleep and webhook -----------------------------------------------------------------------------------------------

// Sleep waits in declarative runs only. Script-budget (scripted) runs record the duration and continue at once.
function runSleep(step: StepDef, state: RunState): void {
  const raw = step["durationMs"] ?? step["ms"] ?? step["sleepMs"] ?? 0;
  const duration = typeof raw === "number" ? raw : 0;
  if (!Number.isFinite(duration) || duration < 0 || duration > MAX_SLEEP_MS) {
    state.ns.fail(stepErrorCode(step), `Sleep step "${step.id}" duration ${duration}ms exceeds max ${MAX_SLEEP_MS}ms.`, 400);
  }
  const internals = internalsOf(state.ns);
  if (duration > 0 && internals.mode === "declarative") {
    internals.effect(`sleep:${step.id}`, (signal) => sleepFor(duration, signal));
  }
  state.scope[asKeyOf(step)] = { sleptMs: duration };
}

function runWebhook(step: StepDef, state: RunState): void {
  const url = textOf(step["url"], state);
  if (!isDiscordWebhookUrl(url)) {
    state.ns.fail(stepErrorCode(step), `Webhook step "${step.id}": invalid or missing Discord webhook URL.`, 400);
  }
  const payload: DiscordPayload = { embeds: [fitEmbed(embedOf(step, state))] };
  const internals = internalsOf(state.ns);
  if (internals.mode === "scripted") {
    state.scope[asKeyOf(step)] = { ok: false, status: 0, error: "webhooks are not available to scripted endpoints" };
    return;
  }
  state.scope[asKeyOf(step)] = internals.effect(`webhook:${step.id}`, (signal) => postDiscordWebhook(url, payload, signal));
}

function embedOf(step: StepDef, state: RunState): DiscordEmbed {
  return {
    title: textOf(step["title"], state),
    description: textOf(step["description"], state),
    color: colorOf(step["color"]),
    fields: fieldsOf(step, state),
    timestamp: new Date(state.ns.now()).toISOString(),
  };
}

// Hex color as the reference parses it: up to eight hex digits, read as a two's-complement 32-bit value.
function colorOf(value: unknown): number {
  if (typeof value !== "string" || !/^\s*[0-9a-fA-F]+\s*$/.test(value)) return DEFAULT_WEBHOOK_COLOR;
  const parsed = parseInt(value, 16);
  return parsed <= 0xffffffff ? parsed | 0 : DEFAULT_WEBHOOK_COLOR;
}

function fieldsOf(step: StepDef, state: RunState): DiscordField[] {
  const fields: DiscordField[] = [];
  for (const field of Array.isArray(step["fields"]) ? step["fields"] : []) {
    if (!isObject(field)) continue;
    fields.push({ name: textOf(field["name"], state), value: textOf(field["value"], state), inline: field["inline"] === true });
  }
  return fields;
}

// Sort, switch, compute -------------------------------------------------------------------------------------------

function runSort(step: StepDef, state: RunState): void {
  const source = render(step["source"], state);
  if (!Array.isArray(source)) state.ns.fail(stepErrorCode(step), `Sort "${step.id}": source must resolve to an array.`, 400);
  const direction = typeof step["direction"] === "string" && step["direction"].toLowerCase() === "desc" ? -1 : 1;
  const keyOf = sortKeyOf(step, state);
  const keyed = source.map((item: unknown, index: number) => ({ item, index, key: keyOf(item, index) }));
  keyed.sort((left, right) => compareSortEntries(left.key, right.key, direction) || left.index - right.index);
  state.scope[step.id] = keyed.map((entry) => entry.item);
}

function sortKeyOf(step: StepDef, state: RunState): (item: unknown, index: number) => unknown {
  const expression = step["expression"];
  if (typeof expression === "string") {
    return (item, index) => evaluateExpression(expression, { ...state.scope, item, index }, scopeOf(state));
  }
  const by = step["by"];
  if (typeof by === "string" && by.includes("{{")) {
    return (item) => resolveTemplate(by, { ...state.scope, item }, scopeOf(state));
  }
  if (typeof by === "string") return (item) => nested(item, by);
  return (item) => item;
}

// Missing values sort last whatever the direction, so they are ordered outside the direction multiplier.
function compareSortEntries(left: unknown, right: unknown, direction: number): number {
  const leftMissing = left === null || left === undefined;
  const rightMissing = right === null || right === undefined;
  if (leftMissing || rightMissing) return leftMissing === rightMissing ? 0 : leftMissing ? 1 : -1;
  return compareSortValues(left, right) * direction;
}

function compareSortValues(left: unknown, right: unknown): number {
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  if (typeof left === "string" && typeof right === "string") return compareAscending(left, right);
  if (typeof left === "number" && typeof right === "number") return compareAscending(left, right);
  const leftNumber = toNumber(left);
  const rightNumber = toNumber(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  return compareAscending(toText(left), toText(right));
}

function compareAscending(left: string | number, right: string | number): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function runSwitch(step: StepDef, state: RunState): void {
  const cases = step["cases"];
  if (!Array.isArray(cases)) state.ns.fail(stepErrorCode(step), `Switch "${step.id}": cases must be an array.`, 400);
  let result: unknown = null;
  for (const [index, entry] of cases.entries()) {
    if (!isObject(entry)) state.ns.fail(stepErrorCode(step), `Switch "${step.id}": case[${index}] must be an object.`, 400);
    if (!isObject(entry["when"])) {
      state.ns.fail(stepErrorCode(step), `Switch "${step.id}": case[${index}] requires a "when" condition object.`, 400);
    }
    if (evaluateCond(entry["when"], state)) {
      result = render(entry["then"], state) ?? null;
      state.scope[step.id] = result;
      return;
    }
  }
  result = step["default"] === undefined ? null : render(step["default"], state);
  state.scope[step.id] = result;
}

// Compute values reference each other by name, so each pass resolves the keys whose inputs are already known. A
// value that reads an unknown name or a missing property is deferred to a later pass; any other error fails the step.
function runCompute(step: StepDef, state: RunState): void {
  const defs = step["values"] ?? step["fields"];
  if (!isObject(defs)) state.ns.fail(stepErrorCode(step), `Compute "${step.id}": values must be an object.`, 400);
  const mode = step["mode"];
  const output: Record<string, unknown> = {};
  const options: EvalOptions = { ...scopeOf(state), strict: true };
  const scope = { ...state.scope, [step.id]: output };
  let pending = Object.keys(defs);
  const maxPasses = pending.length + 1;
  for (let pass = 0; pass < maxPasses && pending.length > 0; pass++) {
    const resolved: string[] = [];
    for (const key of pending) {
      try {
        output[key] = computeValue(defs[key], { ...scope, ...output }, mode, options);
        resolved.push(key);
      } catch (error) {
        if (!isDeferrable(error)) throw error;
      }
    }
    if (resolved.length === 0) {
      state.ns.fail(stepErrorCode(step), `Compute "${step.id}": Cannot resolve "${pending[0]}": circular or missing dependency`, 400);
    }
    pending = pending.filter((key) => !resolved.includes(key));
  }
  if (step["output"] === "scalars") {
    for (const [key, value] of Object.entries(output)) state.scope[key] = value;
  } else {
    state.scope[step.id] = output;
  }
}

function computeValue(def: unknown, scope: Record<string, unknown>, mode: unknown, options: EvalOptions): unknown {
  if (isObject(def)) {
    if (def["expression"] !== undefined && def["expression"] !== null) {
      return evaluateExpression(toText(def["expression"]), scope, options);
    }
    if ("value" in def) return resolveTemplate(def["value"], scope, options);
    return resolveTemplate(def, scope, options);
  }
  if (typeof def === "string") {
    return mode === "template" ? resolveTemplate(def, scope, options) : evaluateExpression(def, scope, options);
  }
  return def;
}

function isDeferrable(error: unknown): boolean {
  return error instanceof ExpressionError && (error.message.includes("Unresolved variable") || error.message.includes("has no property"));
}

// Step dispatch --------------------------------------------------------------------------------------------------

function runStep(step: StepDef, state: RunState): Flow | null {
  const scope = state.scope;
  switch (step.type) {
    case "block": {
      const target = runList(stepsOf(step), state);
      return target === null ? null : { kind: "goto", target };
    }
    case "read": {
      const collection = str(step, "collection");
      const key = toText(render(step["key"], state));
      const data = state.ns.records.get(collection, key);
      scope[asKeyOf(step)] = data;
      return null;
    }
    case "write": {
      const collection = str(step, "collection");
      const key = toText(render(step["key"], state));
      if (key === "") state.ns.fail("INVALID_KEY", `Write "${step.id}": key resolved to empty.`, 400);
      const existing = state.ns.records.get(collection, key);
      const ops = Array.isArray(step["ops"]) ? (step["ops"] as unknown[]) : [];
      try {
        const outcome = applyWriteOps(existing, ops.map((op) => render(op, state)));
        state.ns.records.put(collection, key, outcome.data);
      } catch (error) {
        if (error instanceof OperationError) state.ns.fail("INVALID_OPERATION", `Write "${step.id}": ${error.message}`, 400);
        throw error;
      }
      return null;
    }
    case "delete": {
      const collection = str(step, "collection");
      const key = toText(render(step["key"], state));
      if (key === "") state.ns.fail("INVALID_KEY", `Delete "${step.id}": key resolved to empty.`, 400);
      state.ns.records.delete(collection, key);
      return null;
    }
    case "condition": {
      if (step.id === undefined || step["check"] === undefined) {
        state.ns.fail(stepErrorCode(step), "A condition needs an id and a check.", 400);
      }
      const passed = evaluateCond(step["check"], state);
      scope[step.id] = passed;
      const onFail = step["onFail"];
      if (!passed && isObject(onFail)) {
        state.ns.fail(
          typeof onFail["error"] === "string" ? onFail["error"] : "CONDITION_FAILED",
          renderMessage(onFail["message"], state, "Condition failed."),
          typeof onFail["status"] === "number" ? onFail["status"] : 400,
        );
      }
      return applyRoute(step, passed ? "true" : "false", state);
    }
    case "assert": {
      if (evaluateCond(step["check"], state)) {
        scope[step.id] = true;
        return null;
      }
      state.ns.fail(
        typeof step["errorCode"] === "string" ? step["errorCode"] : "ASSERTION_FAILED",
        renderMessage(step["message"], state, "Assertion failed."),
        typeof step["status"] === "number" ? step["status"] : 400,
      );
    }
    case "transform": {
      const expression = step["expression"];
      if (typeof expression === "string") {
        const inlined = inlineTemplates(expression, scope, scopeOf(state));
        scope[step.id] = evaluateExpression(inlined, scope, scopeOf(state));
      } else {
        scope[step.id] = render(step["value"], state);
      }
      return null;
    }
    case "object":
      scope[step.id] = render(isObject(step["fields"]) ? step["fields"] : {}, state);
      return null;
    case "array":
      scope[step.id] = render(Array.isArray(step["items"]) ? step["items"] : [], state);
      return null;
    case "merge": {
      const sources = Array.isArray(step["sources"]) ? step["sources"] : [];
      const merged: Record<string, unknown> = {};
      for (const [index, source] of sources.entries()) {
        const resolved = render(source, state);
        if (!isObject(resolved)) state.ns.fail("INVALID_STEP", `Merge "${step.id}": source[${index}] must resolve to an object.`, 400);
        Object.assign(merged, resolved);
      }
      scope[step.id] = merged;
      return null;
    }
    case "lookup": {
      const where = step["where"];
      if (!isObject(where) || typeof where["field"] !== "string") {
        state.ns.fail("INVALID_STEP", `Lookup "${step.id}" requires a where clause.`, 500);
      }
      const rows = tableRows(step, state);
      const found = rows.find((row) => matchesWhere(where as Record<string, unknown>, row, state)) ?? null;
      if (found === null && step["required"] === true) {
        const onMissing = isObject(step["onMissing"]) ? step["onMissing"] : {};
        state.ns.fail(
          typeof onMissing["errorCode"] === "string" ? onMissing["errorCode"] : "NOT_FOUND",
          renderMessage(onMissing["message"], state, "Not found."),
          typeof onMissing["status"] === "number" ? onMissing["status"] : 400,
        );
      }
      scope[step.id] = found;
      return null;
    }
    case "filter": {
      const where = step["where"];
      if (!isObject(where) || typeof where["field"] !== "string") {
        state.ns.fail("INVALID_STEP", `Filter "${step.id}" requires a where clause.`, 500);
      }
      const rows = tableRows(step, state);
      const matches = rows.filter((row) => matchesWhere(where as Record<string, unknown>, row, state));
      if (matches.length === 0 && step["required"] === true) {
        state.ns.fail("NOT_FOUND", renderMessage(step["message"], state, "No matching rows."), 400);
      }
      scope[step.id] = matches;
      return null;
    }
    case "lookup_many": {
      const keys = render(step["keys"], state);
      if (!Array.isArray(keys) || keys.length === 0) {
        state.ns.fail("INVALID_STEP", `Lookup "${step.id}" requires a non-empty keys array.`, 400);
      }
      const keyField = typeof step["keyField"] === "string" ? step["keyField"] : "id";
      const byKey = new Map<string, unknown>();
      for (const row of tableRows(step, state)) {
        const value = nested(row, keyField);
        if (value !== null && value !== undefined) byKey.set(toText(value), row);
      }
      scope[step.id] = keys.map((key) => byKey.get(toText(key)) ?? null);
      return null;
    }
    case "random":
      runRandom(step, state);
      return null;
    case "workflow":
      runWorkflow(step, state);
      return null;
    case "response":
      state.returned = true;
      return null;
    case "sleep":
      runSleep(step, state);
      return null;
    case "webhook":
      runWebhook(step, state);
      return null;
    case "sort":
      runSort(step, state);
      return null;
    case "switch":
      runSwitch(step, state);
      return null;
    case "compute":
      runCompute(step, state);
      return null;
    default:
      state.ns.fail("UNSUPPORTED_STEP", `Step "${step.id}": unsupported step type "${step.type}".`, 500);
  }
}

// Runs one step, converting an expression failure into a step failure as the reference does.
function runStepGuarded(step: StepDef, state: RunState): Flow | null {
  try {
    return runStep(step, state);
  } catch (error) {
    if (error instanceof ExpressionError) {
      state.ns.fail(stepErrorCode(step), `${step.type} step "${step.id}" failed: ${error.message}`, 400);
    }
    throw error;
  }
}

function countVisit(step: StepDef, pc: number, state: RunState): void {
  const key = typeof step["as"] === "string" ? step["as"] : step.id || `step_${pc}`;
  const visits = (state.visits.get(key) ?? 0) + 1;
  if (visits > MAX_STEP_VISITS) {
    state.ns.fail(stepErrorCode(step), `Step "${key}" exceeded visit limit (${MAX_STEP_VISITS}).`, 400);
  }
  state.visits.set(key, visits);
}

// Runs a list with a program counter. A goto to a step in this list moves the counter; a goto to a step outside it
// is returned so the enclosing list can take it. A `return` stops the whole run.
function runList(steps: readonly StepDef[], state: RunState): string | null {
  let pc = 0;
  while (pc < steps.length) {
    const step = steps[pc]!;
    countVisit(step, pc, state);
    if (step.type !== "block" && isObject(step["when"]) && !evaluateCond(step["when"], state)) {
      pc++;
      continue;
    }
    const flow = runStepGuarded(step, state);
    if (state.returned) return null;
    if (flow === null) {
      pc++;
      continue;
    }
    if (flow.kind === "skip") {
      pc += flow.count + 1;
      continue;
    }
    const index = steps.findIndex((candidate) => candidate.id === flow.target);
    if (index < 0) return flow.target;
    pc = index;
  }
  return null;
}

// Runs the top-level steps of an endpoint or workflow. Stops early once a route or response step returns.
export function runSteps(steps: readonly StepDef[], state: RunState): void {
  const target = runList(steps, state);
  if (target !== null) state.ns.fail("INVALID_STEP", `Goto "${target}" does not name a step in scope.`, 500);
}
