import type { SboxNsClient } from "../client/client.js";
import { isSboxNsError } from "../client/errors.js";
import { isRecord } from "../util/guards.js";
import { compileModule, type CompiledModule } from "./compile.js";
import { ModuleError } from "./errors.js";
import type { SboxModule } from "./types.js";

/**
 * Game-values group that records which modules are installed and at which version. It is written last during
 * install, so an interrupted install reruns cleanly. Uninstall keeps it with the modules that remain.
 */
export const REGISTRY_ID = "sbox_ns_modules";

type Item = Readonly<Record<string, unknown>>;

export interface ModuleInstallResult {
  readonly id: string;
  readonly version: string;
  readonly status: "installed" | "upgraded" | "unchanged";
  readonly previousVersion: string | null;
}

export interface ModuleInstallReport {
  readonly modules: readonly ModuleInstallResult[];
}

export interface ModuleUninstallOptions {
  /** Also delete the module's collections and their records. Off by default. */
  readonly removeCollections?: boolean;
}

export interface ModuleUninstallResult {
  readonly id: string;
  readonly status: "removed" | "not-installed";
}

export interface ModuleUninstallReport {
  readonly modules: readonly ModuleUninstallResult[];
}

function invalidResponse(label: string): ModuleError {
  return new ModuleError({
    code: "INVALID_RESPONSE",
    message: `The server returned an unexpected response for ${label}.`,
  });
}

function itemsOf(body: unknown): Item[] {
  const data = isRecord(body) ? body["data"] : undefined;
  const items = isRecord(data) ? data["items"] : undefined;
  if (!Array.isArray(items)) throw invalidResponse("game values");
  return items.filter(isRecord);
}

function registryOf(items: readonly Item[]): Record<string, string> {
  const item = items.find((candidate) => candidate["id"] === REGISTRY_ID);
  const entries = item !== undefined && isRecord(item["entries"]) ? item["entries"] : {};
  const registry: Record<string, string> = {};
  for (const [id, version] of Object.entries(entries)) {
    if (typeof version === "string") registry[id] = version;
  }
  return registry;
}

function registryItem(registry: Record<string, string>): Item {
  return { id: REGISTRY_ID, type: "group", name: "Installed modules", entries: registry };
}

// The management API has no delete for game values; it only upserts by id. Uninstall therefore blanks a removed
// module's game values to empty, which is the closest equivalent the API allows.
function emptiedGameValue(value: Readonly<Record<string, unknown>>): Item {
  const base = { id: value["id"], type: value["type"], name: value["name"] };
  return value["type"] === "table" ? { ...base, rows: [] } : { ...base, entries: {} };
}

// Compares dotted numeric versions (major.minor.patch). Returns a negative, zero, or positive number.
function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function assertUniqueModules(compiled: readonly CompiledModule[]): void {
  const seen = new Set<string>();
  for (const item of compiled) {
    if (seen.has(item.module.id)) {
      throw new ModuleError({
        code: "MODULE_CONFLICT",
        message: `Module "${item.module.id}" is listed more than once.`,
      });
    }
    seen.add(item.module.id);
  }
}

// Deleting something that is already gone is the intended end state for uninstall, so 404 is not an error here.
async function removeIgnoringMissing(remove: () => Promise<unknown>): Promise<void> {
  try {
    await remove();
  } catch (error) {
    if (isSboxNsError(error) && error.status === 404) return;
    throw error;
  }
}

/**
 * Installs modules into a live sbox-ns project through the management API. Each module's collections, endpoints,
 * queries, and game values are upserted within the module's own id namespace; nothing outside it is replaced.
 *
 * Installs are not atomic: records are written one at a time. Rerunning is safe because every write is an upsert,
 * and the version registry is written last. A module already installed at its version or newer is skipped.
 */
export async function installModules(
  client: SboxNsClient,
  modules: readonly SboxModule[],
): Promise<ModuleInstallReport> {
  const compiled = modules.map((module) => compileModule(module));
  assertUniqueModules(compiled);
  for (const item of compiled) {
    if (item.module.gameValues.some((value) => value["id"] === REGISTRY_ID)) {
      throw new ModuleError({
        code: "INVALID_MODULE",
        message: `Module "${item.module.id}" uses the reserved game value id "${REGISTRY_ID}".`,
      });
    }
  }

  const registry = registryOf(itemsOf(await client.manage.gameValues.list()));

  const plan = compiled.map((item) => {
    const previousVersion = registry[item.module.id] ?? null;
    const current = previousVersion !== null && compareVersions(previousVersion, item.module.version) >= 0;
    return { item, previousVersion, current };
  });

  const written: Item[] = [];
  for (const { item, current } of plan) {
    if (current) continue;
    const module = item.module;
    for (const collection of module.collections) await client.manage.upsert("collections", collection);
    for (const endpoint of module.endpoints) await client.manage.upsert("endpoints", endpoint);
    if (module.queries.length > 0) await client.queries.upsert(module.queries);
    written.push(...module.gameValues);
    registry[module.id] = module.version;
  }
  if (written.length > 0) await client.manage.gameValues.put([...written, registryItem(registry)]);

  return {
    modules: plan.map(({ item, previousVersion, current }) => ({
      id: item.module.id,
      version: item.module.version,
      status: current ? "unchanged" : previousVersion === null ? "installed" : "upgraded",
      previousVersion,
    })),
  };
}

/**
 * Removes installed modules: their endpoints and queries, their game values (blanked, since the API cannot delete
 * game values), and their registry entry. Collections, and their records, are removed only with
 * `removeCollections: true`. Modules that are not installed report `not-installed` and are left alone.
 */
export async function uninstallModules(
  client: SboxNsClient,
  modules: readonly SboxModule[],
  options: ModuleUninstallOptions = {},
): Promise<ModuleUninstallReport> {
  const compiled = modules.map((module) => compileModule(module));
  assertUniqueModules(compiled);

  const registry = registryOf(itemsOf(await client.manage.gameValues.list()));
  const results: ModuleUninstallResult[] = [];
  const blanked: Item[] = [];

  for (const item of compiled) {
    const module = item.module;
    if (registry[module.id] === undefined) {
      results.push({ id: module.id, status: "not-installed" });
      continue;
    }
    for (const endpoint of module.endpoints) {
      await removeIgnoringMissing(() => client.manage.remove("endpoints", String(endpoint["id"])));
    }
    for (const query of module.queries) {
      await removeIgnoringMissing(() => client.queries.remove(String(query["id"])));
    }
    if (options.removeCollections === true) {
      for (const collection of module.collections) {
        await removeIgnoringMissing(() => client.manage.remove("collections", String(collection["id"])));
      }
    }
    blanked.push(...module.gameValues.map(emptiedGameValue));
    delete registry[module.id];
    results.push({ id: module.id, status: "removed" });
  }

  if (blanked.length > 0) await client.manage.gameValues.put([...blanked, registryItem(registry)]);
  return { modules: results };
}
