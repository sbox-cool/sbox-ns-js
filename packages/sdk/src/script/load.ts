import { createRequire } from "node:module";
import type { QuickJSWASMModule } from "quickjs-emscripten";

// Scripted endpoints need two peer packages. The core has no runtime dependency on either, so each is loaded on first
// use. sucrase is CommonJS and loads synchronously, so compiling a script stays as synchronous as compiling a DSL
// document. quickjs-emscripten loads asynchronously, before a script runs. A missing package is a typed refusal.
export const SCRIPT_ENGINE_INSTALL = "npm install quickjs-emscripten sucrase";

export interface SucraseModule {
  transform(code: string, options: { readonly transforms: readonly ("typescript" | "imports")[] }): { readonly code: string };
}

export class ScriptEngineMissing extends Error {
  readonly code = "SCRIPT_ENGINE_MISSING";
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(`Scripted endpoints need ${missing.join(" and ")}, which is not installed. Install it in the project: ${SCRIPT_ENGINE_INSTALL}`);
    this.name = "ScriptEngineMissing";
    this.missing = missing;
  }
}

const requireFromSdk = createRequire(import.meta.url);
let compiler: SucraseModule | null = null;
let sandbox: QuickJSWASMModule | null = null;
let sandboxLoading: Promise<QuickJSWASMModule> | null = null;

// sucrase: TypeScript stripping and the import rewrite. Loaded on the first compile; throws ScriptEngineMissing if absent.
export function currentCompiler(): SucraseModule {
  if (compiler !== null) return compiler;
  try {
    compiler = requireFromSdk("sucrase") as SucraseModule;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "MODULE_NOT_FOUND") {
      throw new ScriptEngineMissing(["sucrase"]);
    }
    throw error;
  }
  return compiler;
}

// quickjs-emscripten's synchronous release build, loaded before a script runs. A failed load is retried on the next call.
export function loadScriptSandbox(): Promise<QuickJSWASMModule> {
  if (sandbox !== null) return Promise.resolve(sandbox);
  sandboxLoading ??= import("quickjs-emscripten").then(
    async ({ newQuickJSWASMModule, RELEASE_SYNC }) => {
      const module = await newQuickJSWASMModule(RELEASE_SYNC);
      sandbox = module;
      return module;
    },
    (error: unknown) => {
      sandboxLoading = null;
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
        throw new ScriptEngineMissing(["quickjs-emscripten"]);
      }
      throw error;
    },
  );
  return sandboxLoading;
}

// The loaded sandbox module, for the run path. Throws ScriptEngineMissing when the load was skipped.
export function currentSandbox(): QuickJSWASMModule {
  if (sandbox === null) throw new ScriptEngineMissing(["quickjs-emscripten"]);
  return sandbox;
}
