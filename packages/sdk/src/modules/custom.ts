import type { EndpointHandler } from "../endpoint/types.js";
import { createCatalog, valuesOf } from "../server/catalog.js";
import type { QueryDefinition } from "../server/query-routes.js";
import type { ServerOptions, StorageFactory } from "../server/options.js";
import type { CollectionDefinition } from "../storage/types.js";
import { ModuleError } from "./errors.js";
import { compileModule, type CompiledModule } from "./compile.js";
import type { SboxModule } from "./types.js";

function conflict(moduleId: string, id: string): ModuleError {
  return new ModuleError({
    code: "MODULE_CONFLICT",
    message: `Module "${moduleId}": "${id}" is already defined by the server or another module.`,
  });
}

function claim(taken: Set<string>, id: string, moduleId: string): void {
  if (taken.has(id)) throw conflict(moduleId, id);
  taken.add(id);
}

// Reads a dotted path such as "score" or "ores.stone" from a record. Only finite numbers rank.
function numberAt(data: Readonly<Record<string, unknown>>, path: string): number | null {
  let current: unknown = data;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return null;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "number" && Number.isFinite(current) ? current : null;
}

// A query on a custom backend. It reads the same collection through the endpoint runtime, so it follows the
// server's query semantics (field, order, limit) without the server's query route. Custom handlers do not
// receive record keys, so each entry carries the record's `name` field instead of the key.
function queryEndpoint(query: QueryDefinition): EndpointHandler {
  return (_req, ns) => {
    const generatedAt = new Date(ns.now()).toISOString();
    const rows = ns.records.list(query.collectionId);
    if (query.type === "count") {
      return {
        ok: true,
        queryId: query.id,
        type: "count",
        columns: ["count"],
        entries: [{ count: rows.length }],
        count: rows.length,
        generatedAt,
        lastran: generatedAt,
      };
    }
    const field = query.field ?? "";
    const ranked = rows
      .flatMap((data) => {
        const value = numberAt(data, field);
        if (value === null) return [];
        return [{ name: typeof data["name"] === "string" ? data["name"] : null, value }];
      })
      .sort((a, b) => (query.order === "asc" ? a.value - b.value : b.value - a.value))
      .slice(0, query.limit);
    return {
      ok: true,
      queryId: query.id,
      type: "leaderboard",
      field,
      fieldLabel: field,
      columns: ["rank", "name", "value"],
      entries: ranked.map((row, index) => ({ rank: index + 1, name: row.name, value: row.value })),
      generatedAt,
      lastran: generatedAt,
    };
  };
}

/**
 * Adds modules to a custom backend's server options. Endpoints become code handlers, collections join the storage
 * definition, and game values merge into `values`. Throws `ModuleError` on invalid modules or any id conflict.
 *
 * ```ts
 * createNetworkStorageServer(withModules(options, [economy, inventory]));
 * ```
 */
export function withModules(options: ServerOptions, modules: readonly SboxModule[]): ServerOptions {
  const compiled: CompiledModule[] = modules.map((module) => compileModule(module));

  const moduleIds = new Set<string>();
  for (const item of compiled) claim(moduleIds, item.module.id, item.module.id);

  const endpoints: Record<string, EndpointHandler> = { ...options.endpoints };
  const takenEndpoints = new Set(Object.keys(options.endpoints));
  const takenValues = new Set([
    ...Object.keys(options.values?.groups ?? {}),
    ...Object.keys(options.values?.tables ?? {}),
  ]);
  const takenCollections = new Set<string>();
  const collections: CollectionDefinition[] = [];
  const catalog = createCatalog();

  for (const item of compiled) {
    const moduleId = item.module.id;
    for (const endpoint of item.endpoints) {
      if (endpoint.entry.compiled.requiresSecretKey) {
        throw new ModuleError({
          code: "MODULE_UNSUPPORTED",
          message: `Module "${moduleId}": endpoint "${endpoint.id}" requires the secret key, which custom backends cannot enforce.`,
        });
      }
      claim(takenEndpoints, endpoint.id, moduleId);
      endpoints[endpoint.id] = endpoint.entry.compiled.handler;
    }
    for (const query of item.queries) {
      if (query.requiresSecretKey) {
        throw new ModuleError({
          code: "MODULE_UNSUPPORTED",
          message: `Module "${moduleId}": query "${query.id}" requires the secret key, which custom backends cannot enforce.`,
        });
      }
      claim(takenEndpoints, query.id, moduleId);
      endpoints[query.id] = queryEndpoint(query);
    }
    for (const collection of item.collections) {
      claim(takenCollections, collection.id, moduleId);
      collections.push(collection.entry.compiled.definition);
    }
    for (const value of item.module.gameValues) {
      const valueId = String(value["id"]);
      claim(takenValues, valueId, moduleId);
      catalog.gameValues.set(valueId, { ...value });
    }
  }

  const values = catalog.gameValues.size > 0 ? valuesOf(catalog, options.values) : options.values;

  const storage: StorageFactory = (definition) => {
    const existing = new Set(definition.collections.map((collection) => collection.id));
    for (const collection of collections) {
      if (existing.has(collection.id)) {
        throw new ModuleError({
          code: "MODULE_CONFLICT",
          message: `Collection "${collection.id}" is already defined by the server.`,
        });
      }
    }
    return options.storage({
      ...definition,
      collections: [...definition.collections, ...collections],
    });
  };

  return { ...options, endpoints, storage, values };
}
