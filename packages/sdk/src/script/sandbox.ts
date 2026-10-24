import type { QuickJSContext, QuickJSRuntime } from "quickjs-emscripten";
import type { EndpointRequest, ScriptBridge, ScriptModule, ScriptRunner } from "../endpoint/types.js";
import { ScriptFailure } from "../endpoint/runtime.js";
import { currentSandbox } from "./load.js";

// Limits the sandbox enforces per run. The time budget is shared by every round of one request, as the server's is.
export const SCRIPT_TIME_LIMIT_MS = 1000;
export const SCRIPT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const SCRIPT_STACK_LIMIT_BYTES = 512 * 1024;
const LIMIT_MESSAGE = /interrupted|out of memory|stack overflow|call stack/i;

export interface ScriptBudget {
  spentMs: number;
}

export interface ScriptRunnerOptions {
  // Global modules available to `import ... from "globals/<id>"`. Each has the specifier `globals/<id>`.
  readonly globals: readonly ScriptModule[];
  // Names a script can read under `globals` (the endpoint id and its camelCase alias) to the endpoint id.
  readonly globalNames: ReadonlyMap<string, string>;
  // camelCase workflow alias to workflow id.
  readonly workflowNames: ReadonlyMap<string, string>;
  readonly budget: ScriptBudget;
}

interface Settled {
  readonly state: "pending" | "fulfilled" | "rejected";
  readonly value: unknown;
  readonly error: string | null;
}

// Builds the runner for one request. Each pass gets a fresh QuickJS context, so no state leaks between passes.
export function createScriptRunner(options: ScriptRunnerOptions): ScriptRunner {
  return {
    run: (entry, request, bridge) => runPass(options, entry, request, bridge),
  };
}

function runPass(options: ScriptRunnerOptions, entry: ScriptModule, request: EndpointRequest, bridge: ScriptBridge): unknown {
  const runtime = currentSandbox().newRuntime();
  const started = performance.now();
  // Failures the host recorded (ns.fail, a failed storage call) win over whatever the script does afterwards, even when
  // the script catches them, as on the server. Ordinary argument errors are not recorded; the script sees them as errors.
  const hostFailures: ScriptFailure[] = [];
  try {
    runtime.setMemoryLimit(SCRIPT_MEMORY_LIMIT_BYTES);
    runtime.setMaxStackSize(SCRIPT_STACK_LIMIT_BYTES);
    runtime.setInterruptHandler(() => options.budget.spentMs + (performance.now() - started) > SCRIPT_TIME_LIMIT_MS);
    const vm = runtime.newContext();
    try {
      const host = vm.newFunction("__host", (op, args) => {
        try {
          const value = bridge(vm.getString(op), JSON.parse(vm.getString(args)) as unknown[]);
          return vm.newString(JSON.stringify(value ?? null));
        } catch (error) {
          if (error instanceof ScriptFailure) hostFailures.push(error);
          throw error;
        }
      });
      vm.setProp(vm.global, "__host", host);
      host.dispose();

      evaluate(vm, programOf(options, entry, request), `${entry.specifier}.js`);
      drainJobs(runtime, vm);
      const value = outcomeOf(JSON.parse(evaluate(vm, "JSON.stringify(__out)", "settled.js")) as Settled);
      if (hostFailures.length > 0) throw hostFailures[0];
      return value;
    } catch (error) {
      throw hostFailures.length > 0 ? hostFailures[0] : error;
    } finally {
      vm.dispose();
    }
  } finally {
    options.budget.spentMs += performance.now() - started;
    runtime.dispose();
  }
}

function evaluate(vm: QuickJSContext, code: string, name: string): string {
  const result = vm.evalCode(code, name);
  if (result.error !== undefined) {
    const dumped = vm.dump(result.error);
    result.error.dispose();
    throw failureOf(dumped);
  }
  const text = vm.getString(result.value);
  result.value.dispose();
  return text;
}

function drainJobs(runtime: QuickJSRuntime, vm: QuickJSContext): void {
  const jobs = runtime.executePendingJobs();
  if (jobs.error !== undefined) {
    const dumped = vm.dump(jobs.error);
    jobs.error.dispose();
    throw failureOf(dumped);
  }
}

function outcomeOf(settled: Settled): unknown {
  if (settled.state === "fulfilled") return settled.value;
  if (settled.state === "pending") throw new ScriptFailure("SCRIPT_LIMIT_EXCEEDED", "The endpoint exceeded a limit.", 500);
  throw failureOf(settled.error);
}

// A guest error becomes a typed failure. Interrupts (time budget), memory exhaustion, and stack overflow are limits.
function failureOf(dumped: unknown): ScriptFailure {
  const message = typeof dumped === "object" && dumped !== null && "message" in dumped ? String(dumped.message) : String(dumped);
  if (LIMIT_MESSAGE.test(message)) return new ScriptFailure("SCRIPT_LIMIT_EXCEEDED", "The endpoint exceeded a limit.", 500);
  return new ScriptFailure("SCRIPT_ERROR", "The endpoint script failed.", 500);
}

// The guest program for one pass. Modules are registered as factories and evaluated lazily, so a global runs only
// when the endpoint reads it. The host's ns calls go through __host and return JSON.
function programOf(options: ScriptRunnerOptions, entry: ScriptModule, request: EndpointRequest): string {
  const factories = [entry, ...options.globals]
    .map((module) => `${JSON.stringify(module.specifier)}: function (exports, require) {\n${module.code}\n}`)
    .join(",\n");
  const globals = [...options.globalNames]
    .map(
      ([name, id]) =>
        `Object.defineProperty(globals, ${JSON.stringify(name)}, { enumerable: true, get: function () { return __require(${JSON.stringify(`globals/${id}`)}); } });`,
    )
    .join("\n");
  const workflows = [...options.workflowNames]
    .map(([alias, id]) => `workflows[${JSON.stringify(alias)}] = function (input) { return ns.workflows.run(${JSON.stringify(id)}, input); };`)
    .join("\n");

  return `var __factories = {
${factories}
};
var __cache = {};
function __require(spec) {
  if (Object.prototype.hasOwnProperty.call(__cache, spec)) return __cache[spec].exports;
  if (!Object.prototype.hasOwnProperty.call(__factories, spec)) throw new Error("Module not found: " + spec);
  var module = { exports: {} };
  __cache[spec] = module;
  __factories[spec](module.exports, __require);
  return module.exports;
}
function __call(op, args) { return JSON.parse(__host(op, JSON.stringify(args))); }
var ns = {
  records: {
    get: function (collection, key) { return __call("records.get", [collection, key]); },
    put: function (collection, key, data) { __call("records.put", [collection, key, data]); },
    delete: function (collection, key) { __call("records.delete", [collection, key]); },
    list: function (collection) { return __call("records.list", [collection]); }
  },
  values: { get: function (path) { return __call("values.get", [path]); } },
  workflows: { run: function (id, input) { return __call("workflows.run", [id, input === undefined ? null : input]); } },
  secrets: { get: function (name) { return __call("secrets.get", [name]); } },
  now: function () { return __call("now", []); },
  log: function (value) { __call("log", [value === undefined ? null : value]); },
  fail: function (code, message, status) { __call("fail", [code, message, status === undefined ? null : status]); },
  fetch: function (url, options) { return __call("fetch", [url, options === undefined ? null : options]); }
};
var globals = {};
${globals}
var workflows = {};
${workflows}
var __request = ${JSON.stringify(request)};
var __out = { state: "pending", value: null, error: null };
function __message(error) { return error && typeof error.message === "string" ? error.message : String(error); }
try {
  var __handle = __require(${JSON.stringify(entry.specifier)})["default"];
  if (typeof __handle !== "function") throw new TypeError("The script must export default function handle(req, ns).");
  Promise.resolve(__handle(__request, ns)).then(
    function (value) { __out = { state: "fulfilled", value: value === undefined ? null : value, error: null }; },
    function (error) { __out = { state: "rejected", value: null, error: __message(error) }; }
  );
} catch (error) {
  __out = { state: "rejected", value: null, error: __message(error) };
}`;
}
