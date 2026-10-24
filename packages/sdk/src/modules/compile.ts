import { compileBatch, type Compiled, type RecordResult } from "../server/catalog.js";
import { parseQuery, type QueryDefinition } from "../server/query-routes.js";
import { ModuleError } from "./errors.js";
import type { ModuleRecord, SboxModule } from "./types.js";

const MODULE_ID = /^[a-z][a-z0-9_-]*$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const GAME_VALUE_TYPES: Record<string, true> = { group: true, table: true };

export type CompiledEndpoint = Extract<Compiled, { kind: "endpoints" }>;
export type CompiledCollection = Extract<Compiled, { kind: "collections" }>;

export interface CompiledModule {
  readonly module: SboxModule;
  readonly endpoints: readonly CompiledEndpoint[];
  readonly collections: readonly CompiledCollection[];
  readonly queries: readonly QueryDefinition[];
}

function invalid(
  moduleId: string,
  message: string,
  details: readonly { id: string; message: string }[] = [],
): ModuleError {
  return new ModuleError({ code: "INVALID_MODULE", message: `Module "${moduleId}": ${message}`, details });
}

function idOf(record: ModuleRecord): string | null {
  return typeof record["id"] === "string" && record["id"] !== "" ? record["id"] : null;
}

function namespaced(module: SboxModule, records: readonly ModuleRecord[], label: string): void {
  for (const record of records) {
    const id = idOf(record);
    if (id === null) throw invalid(module.id, `every ${label} needs a string id.`);
    if (!id.startsWith(`${module.id}_`)) {
      throw invalid(module.id, `${label} "${id}" must start with "${module.id}_".`, [
        { id, message: `Ids must start with "${module.id}_".` },
      ]);
    }
  }
}

function failures(moduleId: string, label: string, results: readonly RecordResult[]): ModuleError | null {
  const bad = results.filter((result) => !result.ok);
  if (bad.length === 0) return null;
  return invalid(
    moduleId,
    `${label} failed to compile: ${bad.map((result) => result.id).join(", ")}.`,
    bad.map((result) => ({ id: result.id, message: result.message ?? "The definition is invalid." })),
  );
}

/**
 * Validates a module and compiles its records with the server's own compiler. Throws `ModuleError`
 * (`INVALID_MODULE`) and never returns a partially compiled module.
 */
export function compileModule(module: SboxModule): CompiledModule {
  if (!MODULE_ID.test(module.id)) {
    throw invalid(String(module.id), "id must start with a letter and use only lowercase letters, digits, '_' or '-'.");
  }
  if (!VERSION.test(module.version)) throw invalid(module.id, `version "${module.version}" must be major.minor.patch.`);
  if (typeof module.name !== "string" || module.name === "") throw invalid(module.id, "name is required.");
  if (typeof module.description !== "string") throw invalid(module.id, "description must be a string.");

  namespaced(module, module.endpoints, "endpoint");
  namespaced(module, module.collections, "collection");
  namespaced(module, module.queries, "query");
  namespaced(module, module.gameValues, "game value");
  for (const item of module.gameValues) {
    if (GAME_VALUE_TYPES[String(item["type"])] !== true) {
      throw invalid(module.id, `game value "${String(item["id"])}" must be type "group" or "table".`);
    }
  }

  const collections = compileBatch("collections", module.collections, undefined);
  const collectionFailure = failures(module.id, "collections", collections.results);
  if (collectionFailure !== null) throw collectionFailure;

  const endpoints = compileBatch("endpoints", module.endpoints, undefined);
  const endpointFailure = failures(module.id, "endpoints", endpoints.results);
  if (endpointFailure !== null) throw endpointFailure;

  const declared = new Set(module.collections.map((record) => idOf(record)));
  const queries: QueryDefinition[] = [];
  const queryFailures: { id: string; message: string }[] = [];
  for (const record of module.queries) {
    try {
      const query = parseQuery(record);
      if (!declared.has(query.collectionId)) {
        throw new Error(`reads "${query.collectionId}", which this module does not declare.`);
      }
      queries.push(query);
    } catch (error) {
      queryFailures.push({
        id: String(idOf(record)),
        message: error instanceof Error ? error.message : "The query is invalid.",
      });
    }
  }
  if (queryFailures.length > 0) {
    throw invalid(
      module.id,
      `queries failed to compile: ${queryFailures.map((failure) => failure.id).join(", ")}.`,
      queryFailures,
    );
  }

  const compiledEndpoints = endpoints.compiled.filter(
    (item): item is CompiledEndpoint => item.kind === "endpoints",
  );
  const compiledCollections = collections.compiled.filter(
    (item): item is CompiledCollection => item.kind === "collections",
  );
  return { module, endpoints: compiledEndpoints, collections: compiledCollections, queries };
}

/**
 * Validates a module definition and returns it. Use it to check a power-user module (a plain object of catalog
 * records under the module's namespace) before passing it to `withModules` or `installModules`.
 */
export function defineModule(module: SboxModule): SboxModule {
  return compileModule(module).module;
}
