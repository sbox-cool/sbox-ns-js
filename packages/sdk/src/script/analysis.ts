import type { ScriptModule } from "../endpoint/types.js";
import { ScriptEngineMissing, currentCompiler } from "./load.js";

export type ScriptRuntimeName = "javascript" | "typescript";

// A named or default import of a global module, e.g. `import { Inventory } from "globals/inventory"`.
// `names: null` is a namespace import (`import * as x`), which is not checked against the global's exports.
export interface ScriptImport {
  readonly id: string;
  readonly names: readonly string[] | null;
}

export interface CompiledScript {
  readonly runtime: ScriptRuntimeName;
  readonly module: ScriptModule;
  readonly exports: readonly string[];
  readonly imports: readonly ScriptImport[];
}

// Source that does not parse. `line` and `column` come from the compiler's location when it gives one.
export class ScriptSyntaxError extends Error {
  readonly line: number | undefined;
  readonly column: number | undefined;

  constructor(message: string, line: number | undefined, column: number | undefined) {
    super(message);
    this.name = "ScriptSyntaxError";
    this.line = line;
    this.column = column;
  }
}

// An import the sandbox does not provide. Only `globals/<endpoint id>` is importable.
export class ScriptModuleUnsupported extends Error {
  constructor(specifier: string) {
    super(`The script imports "${specifier}". Scripts may only import globals as "globals/<endpoint id>".`);
    this.name = "ScriptModuleUnsupported";
  }
}

export const GLOBAL_SPECIFIER = /^globals\/([a-z][a-z0-9_-]{0,63})$/;
const LOCATION = /\((\d+):(\d+)\)\s*$/;
const REQUIRE = /require\(\s*(["'])([^"']*)\1\s*\)/g;
const EXPORT = /exports\.([A-Za-z_$][\w$]*)\s*=/g;
const IMPORT = /import\s+(?:([\s\S]*?)\s+from\s+)?(["'])([^"']+)\2/g;

// Compiles one script to a CommonJS module the sandbox can evaluate. `specifier` is the name the module is registered
// under: "endpoint" for an endpoint, or "globals/<id>" for a global.
export function analyzeScript(source: string, runtime: ScriptRuntimeName, specifier: string): CompiledScript {
  const transforms = runtime === "typescript" ? (["typescript", "imports"] as const) : (["imports"] as const);
  let code: string;
  try {
    code = currentCompiler().transform(source, { transforms }).code;
  } catch (error) {
    if (error instanceof ScriptEngineMissing) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const location = LOCATION.exec(message);
    throw new ScriptSyntaxError(message, location ? Number(location[1]) : undefined, location ? Number(location[2]) : undefined);
  }

  for (const match of code.matchAll(REQUIRE)) {
    const target = match[2] ?? "";
    if (!GLOBAL_SPECIFIER.test(target)) throw new ScriptModuleUnsupported(target);
  }
  if (/\bimport\s*\(/.test(code)) throw new ScriptModuleUnsupported("import()");

  const exports = [...new Set([...code.matchAll(EXPORT)].map((match) => match[1] ?? ""))];
  return {
    runtime,
    module: { specifier, code },
    exports,
    imports: importsOf(source),
  };
}

function importsOf(source: string): ScriptImport[] {
  const imports: ScriptImport[] = [];
  for (const match of source.matchAll(IMPORT)) {
    const target = match[3] ?? "";
    const global = GLOBAL_SPECIFIER.exec(target);
    if (global === null) continue;
    const clause = match[1];
    imports.push({ id: global[1] ?? "", names: clause === undefined ? [] : namesOf(clause) });
  }
  return imports;
}

function namesOf(clause: string): string[] | null {
  if (clause.includes("*")) return null;
  const names: string[] = [];
  const named = /\{([\s\S]*?)\}/.exec(clause);
  const defaultName = clause.replace(/\{[\s\S]*?\}/, "").replace(/,/g, "").trim();
  if (defaultName !== "") names.push("default");
  for (const part of (named?.[1] ?? "").split(",")) {
    const name = part.trim().split(/\s+as\s+/)[0]?.trim() ?? "";
    if (name !== "") names.push(name);
  }
  return names;
}
