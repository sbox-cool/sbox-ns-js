import type { Ns } from "../endpoint/types.js";
import { compareValues, evaluateCheck, evaluateExpression, inlineTemplates, resolveTemplate, toText, type Scope } from "./expression.js";
import { applyWriteOps, OperationError } from "./operations.js";

// Declarative step interpreter. Steps run against a scope object and touch records only through `ns`, so the
// engine's read-your-writes overlay, version tracking, and atomic flush apply to declarative and code endpoints alike.

export type StepDef = Readonly<Record<string, unknown>> & { type: string; id: string };

export interface RunState {
  readonly ns: Ns;
  readonly scope: Record<string, unknown>;
  // Set by a `return` route or `response` step. Remaining steps are skipped.
  returned: boolean;
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
];

function str(step: StepDef, field: string): string {
  const value = step[field];
  return typeof value === "string" ? value : "";
}

function scopeOf(state: RunState): { now: () => number } {
  return { now: () => state.ns.now() };
}

function render(template: unknown, state: RunState): unknown {
  return resolveTemplate(template, state.scope, scopeOf(state));
}

function renderMessage(template: unknown, state: RunState, fallback: string): string {
  if (typeof template !== "string") return fallback;
  return toText(render(template, state));
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

function runWorkflow(step: StepDef, state: RunState): void {
  const params = isObject(step["params"]) ? step["params"] : {};
  const input: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(params)) input[name] = render(value, state);
  state.scope[step.id] = state.ns.workflows.run(str(step, "workflow"), input);
}

function runStep(step: StepDef, state: RunState): void {
  const scope = state.scope;
  switch (step.type) {
    case "block":
      runSteps(Array.isArray(step["steps"]) ? (step["steps"] as StepDef[]) : [], state);
      return;
    case "read": {
      const collection = str(step, "collection");
      const key = toText(render(step["key"], state));
      const data = state.ns.records.get(collection, key);
      scope[typeof step["as"] === "string" ? step["as"] : step.id] = data;
      return;
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
      return;
    }
    case "delete": {
      const collection = str(step, "collection");
      const key = toText(render(step["key"], state));
      if (key === "") state.ns.fail("INVALID_KEY", `Delete "${step.id}": key resolved to empty.`, 400);
      state.ns.records.delete(collection, key);
      return;
    }
    case "condition": {
      if (evaluateCond(step["check"], state)) {
        scope[step.id] = true;
        return;
      }
      scope[step.id] = false;
      const onFail = step["onFail"];
      if (isObject(onFail)) {
        state.ns.fail(
          typeof onFail["error"] === "string" ? onFail["error"] : "CONDITION_FAILED",
          renderMessage(onFail["message"], state, "Condition failed."),
          typeof onFail["status"] === "number" ? onFail["status"] : 400,
        );
      }
      const route = isObject(step["routes"]) ? step["routes"]["false"] : undefined;
      if (!isObject(route) || route["action"] === "continue") return;
      if (route["action"] === "return") {
        state.returned = true;
        return;
      }
      if (route["action"] === "reject") {
        state.ns.fail(
          typeof route["error"] === "string" ? route["error"] : "CONDITION_FAILED",
          renderMessage(route["message"], state, "Condition check failed."),
          typeof route["status"] === "number" ? route["status"] : 400,
        );
      }
      state.ns.fail("INVALID_STEP", `Condition "${step.id}": unsupported route action.`, 500);
      return;
    }
    case "assert": {
      if (evaluateCond(step["check"], state)) {
        scope[step.id] = true;
        return;
      }
      state.ns.fail(
        typeof step["errorCode"] === "string" ? step["errorCode"] : "ASSERTION_FAILED",
        renderMessage(step["message"], state, "Assertion failed."),
        typeof step["status"] === "number" ? step["status"] : 400,
      );
      return;
    }
    case "transform": {
      const expression = step["expression"];
      if (typeof expression === "string") {
        const inlined = inlineTemplates(expression, scope, scopeOf(state));
        scope[step.id] = evaluateExpression(inlined, scope, scopeOf(state));
      } else {
        scope[step.id] = render(step["value"], state);
      }
      return;
    }
    case "object":
      scope[step.id] = render(isObject(step["fields"]) ? step["fields"] : {}, state);
      return;
    case "array":
      scope[step.id] = render(Array.isArray(step["items"]) ? step["items"] : [], state);
      return;
    case "merge": {
      const sources = Array.isArray(step["sources"]) ? step["sources"] : [];
      const merged: Record<string, unknown> = {};
      for (const [index, source] of sources.entries()) {
        const resolved = render(source, state);
        if (!isObject(resolved)) state.ns.fail("INVALID_STEP", `Merge "${step.id}": source[${index}] must resolve to an object.`, 400);
        Object.assign(merged, resolved);
      }
      scope[step.id] = merged;
      return;
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
      return;
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
      return;
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
      return;
    }
    case "random": {
      const mode = typeof step["mode"] === "string" ? step["mode"] : "int";
      const min = Number(render(step["min"] ?? 0, state));
      const max = Number(render(step["max"] ?? (mode === "int" ? 100 : 1), state));
      const unit = crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
      if (mode === "int") {
        const low = Math.floor(min);
        scope[step.id] = low + Math.floor(unit * (Math.floor(max) - low + 1));
        return;
      }
      if (mode === "float") {
        const precision = typeof step["precision"] === "number" ? step["precision"] : 2;
        scope[step.id] = Number((min + unit * (max - min)).toFixed(precision));
        return;
      }
      state.ns.fail("INVALID_STEP", `Random "${step.id}": unsupported mode "${mode}".`, 500);
      return;
    }
    case "workflow":
      runWorkflow(step, state);
      return;
    case "response":
      state.returned = true;
      return;
    default:
      state.ns.fail("UNSUPPORTED_STEP", `Step "${step.id}": unsupported step type "${step.type}".`, 500);
  }
}

// Runs steps in order. Stops early once a route or response step returns.
export function runSteps(steps: readonly StepDef[], state: RunState): void {
  for (const step of steps) {
    if (step.type !== "block" && isObject(step["when"]) && !evaluateCond(step["when"], state)) continue;
    runStep(step, state);
    if (state.returned) return;
  }
}
