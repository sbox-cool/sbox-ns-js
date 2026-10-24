import { sha256Hex } from "../protocol/crypto.js";
import type { SecuritySettings } from "../protocol/config.js";
import { isEncryptedRequestMode } from "../protocol/security.js";
import type { ControlStateRow, ControlStateStore } from "../storage/control.js";
import { isRecord } from "../util/guards.js";
import { stableJson } from "../util/json.js";
import { cloneCatalog, commitCompiled, compileBatch, createCatalog, replaceCatalogContents, type Catalog, type Compiled } from "./catalog.js";
import type { ManagedSettings } from "./context.js";
import type { ServerOptions } from "./options.js";
import { parseQuery, type QueryDefinition } from "./query-routes.js";

// Opt-in durable control state. Without `ServerOptions.controlState` the server keeps its control state in memory
// and none of this module runs. With it, every control mutation commits through `commit`: the work runs on a copy,
// the document is written with a compare-and-set on its version, and only then does the copy replace the live state.
//
// Single-writer assumption: one server process owns a project's control state at a time. The compare-and-set detects
// a second writer and the process then fails closed until it restarts, but it does not coordinate writers.

export const CONTROL_STATE_SCHEMA_VERSION = 1;

export type ControlStartup = "restore" | "reset" | "import";

export interface ControlStateOptions {
  readonly store: ControlStateStore;
  // restore (default): load the persisted state; when none exists, seed it from ServerOptions and persist version 1.
  // reset: replace the persisted state with the ServerOptions seed.
  // import: replace the persisted state with `snapshot`, a document previously returned by exportControlState().
  readonly startup?: ControlStartup;
  readonly snapshot?: string;
}

// What a mutation works on. The catalog is a copy in durable mode; settings are replaced by assignment.
export interface ControlDraft {
  readonly catalog: Catalog;
  settings: ManagedSettings;
}

export interface DurableControl {
  // Resolves once the persisted state is loaded (or seeded). Rejects when startup fails closed.
  readonly ready: Promise<void>;
  commit<T>(work: (draft: ControlDraft) => T): Promise<T>;
  exportState(): Promise<string>;
  // Throws once a commit could not be confirmed. The process then serves no control writes or reads.
  assertHealthy(): void;
}

// Refuses a document that cannot be restored exactly: corrupt JSON, a checksum mismatch, an unknown schema version,
// another project's document, or a shape violation. The message names the cause; no state is loaded.
export class ControlStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlStateError";
  }
}

// The persisted document. Entries are stored as the records the editor sent; the compiled form and constant groups are
// rebuilt on load, so a restore cannot disagree with what compiles.
interface ControlDocument {
  readonly schemaVersion: number;
  readonly projectId: string;
  readonly settings: ManagedSettings;
  readonly catalog: {
    readonly endpoints: readonly Record<string, unknown>[];
    readonly collections: readonly Record<string, unknown>[];
    readonly workflows: readonly Record<string, unknown>[];
    readonly queries: readonly unknown[];
    readonly gameValues: readonly Record<string, unknown>[];
    readonly rateLimitRules: readonly Record<string, unknown>[];
    readonly tests: readonly Record<string, unknown>[];
    readonly gamePackage: Record<string, unknown> | null;
    readonly staged: {
      readonly endpoints: readonly [string, Record<string, unknown>][];
      readonly collections: readonly [string, Record<string, unknown>][];
    };
  };
}

type Parser = ServerOptions["parseYaml"];

function encodeDocument(projectId: string, settings: ManagedSettings, catalog: Catalog): string {
  const document: ControlDocument = {
    schemaVersion: CONTROL_STATE_SCHEMA_VERSION,
    projectId,
    settings: { security: settings.security, requireSboxAuth: settings.requireSboxAuth },
    catalog: {
      endpoints: [...catalog.endpoints.values()].map((entry) => entry.record),
      collections: [...catalog.collections.values()].map((entry) => entry.record),
      workflows: [...catalog.workflows.values()].map((entry) => entry.record),
      queries: [...catalog.queries.values()].map((stored) => stored.document),
      gameValues: [...catalog.gameValues.values()],
      rateLimitRules: catalog.rateLimitRules,
      tests: catalog.tests,
      gamePackage: catalog.gamePackage,
      staged: { endpoints: [...catalog.staged.endpoints], collections: [...catalog.staged.collections] },
    },
  };
  return stableJson(document);
}

function corrupt(message: string): ControlStateError {
  return new ControlStateError(`Control state is unusable: ${message}`);
}

function recordsOf(value: unknown, field: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) throw corrupt(`${field} must be a list of objects.`);
  return value as Record<string, unknown>[];
}

function pairsOf(value: unknown, field: string): [string, Record<string, unknown>][] {
  if (!Array.isArray(value)) throw corrupt(`${field} must be a list of pairs.`);
  return value.map((pair) => {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || !isRecord(pair[1])) {
      throw corrupt(`${field} must be a list of [id, object] pairs.`);
    }
    return [pair[0], pair[1]] as [string, Record<string, unknown>];
  });
}

function securityOf(value: Record<string, unknown>): SecuritySettings {
  const enableAuthSessions = value["enableAuthSessions"];
  const requireAuthSessions = value["requireAuthSessions"];
  const encryptedRequestMode = value["encryptedRequestMode"];
  if (typeof enableAuthSessions !== "boolean" || typeof requireAuthSessions !== "boolean"
      || typeof encryptedRequestMode !== "string" || !isEncryptedRequestMode(encryptedRequestMode)) {
    throw corrupt("the security settings are malformed.");
  }
  const security: SecuritySettings = { enableAuthSessions, requireAuthSessions, encryptedRequestMode };
  for (const name of ["authSessionTtlSeconds", "encryptedRequestWindowSeconds"] as const) {
    const number = value[name];
    if (number !== undefined) {
      if (typeof number !== "number" || !Number.isFinite(number)) throw corrupt("a security duration is malformed.");
      security[name] = number;
    }
  }
  if (value["legacyPlayerProjections"] !== undefined) {
    if (typeof value["legacyPlayerProjections"] !== "boolean") throw corrupt("the legacy projection flag is malformed.");
    security.legacyPlayerProjections = value["legacyPlayerProjections"];
  }
  const analytics = value["analytics"];
  if (analytics !== undefined) {
    if (!isRecord(analytics)
        || (analytics["enabled"] !== undefined && typeof analytics["enabled"] !== "boolean")
        || (analytics["allowedEventTypes"] !== undefined
            && (!Array.isArray(analytics["allowedEventTypes"]) || !analytics["allowedEventTypes"].every((item: unknown) => typeof item === "string")))) {
      throw corrupt("the analytics settings are malformed.");
    }
    security.analytics = {};
    if (typeof analytics["enabled"] === "boolean") security.analytics.enabled = analytics["enabled"];
    if (Array.isArray(analytics["allowedEventTypes"])) security.analytics.allowedEventTypes = analytics["allowedEventTypes"] as string[];
  }
  return security;
}

// Parses and validates a document for this project. Throws ControlStateError on every mismatch, so no caller can
// half-load a state.
function decodeDocument(text: string, projectId: string): ControlDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw corrupt("the document is not valid JSON.");
  }
  if (!isRecord(raw)) throw corrupt("the document is not an object.");
  if (raw["schemaVersion"] !== CONTROL_STATE_SCHEMA_VERSION) {
    throw new ControlStateError(
      `Control state schema version is unsupported; this SDK reads version ${CONTROL_STATE_SCHEMA_VERSION}.`,
    );
  }
  if (raw["projectId"] !== projectId) throw corrupt("the document belongs to another project.");
  const settings = raw["settings"];
  if (!isRecord(settings) || !isRecord(settings["security"]) || typeof settings["requireSboxAuth"] !== "boolean") {
    throw corrupt("the settings are malformed.");
  }
  const catalog = raw["catalog"];
  if (!isRecord(catalog)) throw corrupt("the catalog is malformed.");
  const gamePackage = catalog["gamePackage"];
  if (gamePackage !== null && !isRecord(gamePackage)) throw corrupt("the game package is malformed.");
  const staged = catalog["staged"];
  if (!isRecord(staged)) throw corrupt("the staged revision is malformed.");
  if (!Array.isArray(catalog["queries"])) throw corrupt("the queries must be a list.");
  return {
    schemaVersion: CONTROL_STATE_SCHEMA_VERSION,
    projectId,
    settings: {
      security: securityOf(settings["security"]),
      requireSboxAuth: settings["requireSboxAuth"],
    },
    catalog: {
      endpoints: recordsOf(catalog["endpoints"], "endpoints"),
      collections: recordsOf(catalog["collections"], "collections"),
      workflows: recordsOf(catalog["workflows"], "workflows"),
      queries: catalog["queries"],
      gameValues: recordsOf(catalog["gameValues"], "gameValues"),
      rateLimitRules: recordsOf(catalog["rateLimitRules"], "rateLimitRules"),
      tests: recordsOf(catalog["tests"], "tests"),
      gamePackage: gamePackage as Record<string, unknown> | null,
      staged: {
        endpoints: pairsOf(staged["endpoints"], "staged.endpoints"),
        collections: pairsOf(staged["collections"], "staged.collections"),
      },
    },
  };
}

// Verifies a stored row's checksum, then decodes it. The checksum is checked before parsing, so a damaged row is
// reported as a checksum failure rather than as a parse error.
async function decodeRow(row: ControlStateRow, projectId: string): Promise<ControlDocument> {
  if ((await sha256Hex(row.document)) !== row.checksum) throw corrupt("the checksum does not match the document.");
  return decodeDocument(row.document, projectId);
}

function parseStoredQuery(document: unknown): QueryDefinition {
  try {
    return parseQuery(document);
  } catch {
    throw corrupt("a stored query does not parse.");
  }
}

// Rebuilds the live catalog from a decoded document. The document is the whole state, module-composed records included,
// so it replaces the live catalog rather than merging into it. Compile failures throw before anything is replaced, so a
// restore never serves a partly loaded catalog.
function populateCatalog(catalog: Catalog, document: ControlDocument, parse: Parser): void {
  const compiled: Compiled[] = [];
  for (const [kind, records] of [
    ["endpoints", document.catalog.endpoints],
    ["collections", document.catalog.collections],
    ["workflows", document.catalog.workflows],
  ] as const) {
    const batch = compileBatch(kind, records, parse);
    if (!batch.ok) {
      throw corrupt(`a stored ${kind} record does not compile.`);
    }
    compiled.push(...batch.compiled);
  }
  const loaded = createCatalog();
  commitCompiled(loaded, compiled);
  for (const query of document.catalog.queries) {
    const definition = parseStoredQuery(query);
    loaded.queries.set(definition.id, { document: query, definition });
  }
  for (const record of document.catalog.gameValues) loaded.gameValues.set(String(record["id"]), record);
  loaded.rateLimitRules = [...document.catalog.rateLimitRules];
  loaded.tests = [...document.catalog.tests];
  loaded.gamePackage = document.catalog.gamePackage;
  for (const [id, record] of document.catalog.staged.endpoints) loaded.staged.endpoints.set(id, record);
  for (const [id, record] of document.catalog.staged.collections) loaded.staged.collections.set(id, record);
  replaceCatalogContents(catalog, loaded);
}

export interface DurableControlInput {
  readonly projectId: string;
  readonly options: ControlStateOptions;
  readonly seed: ManagedSettings;
  readonly parseYaml: Parser;
  // The live catalog. Commits swap their contents in; the object itself keeps its identity.
  readonly catalog: Catalog;
  readonly settings: () => ManagedSettings;
  readonly adopt: (settings: ManagedSettings) => void;
  readonly log?: (value: unknown) => void;
}

export function openDurableControl(input: DurableControlInput): DurableControl {
  const { projectId, options, catalog } = input;
  const store = options.store;
  let current: ControlStateRow | null = null;
  let failure: Error | null = null;

  // Writes a state built from the live catalog and settings as the next version after `expectedVersion`.
  const persist = async (settings: ManagedSettings, expectedVersion: number): Promise<ControlStateRow> => {
    const document = encodeDocument(projectId, settings, catalog);
    const row: ControlStateRow = { version: expectedVersion + 1, document, checksum: await sha256Hex(document) };
    await store.save(projectId, expectedVersion, row);
    return row;
  };

  const startup = async (): Promise<ControlStateRow> => {
    const mode = options.startup ?? "restore";
    if (mode === "restore") {
      const row = await store.load(projectId);
      if (row === null) {
        input.adopt(input.seed);
        return persist(input.seed, 0);
      }
      const document = await decodeRow(row, projectId);
      populateCatalog(catalog, document, input.parseYaml);
      if (stableJson(input.seed) !== stableJson(document.settings)) {
        input.log?.({
          event: "control-state.settings-ignored",
          projectId,
          message: "Persisted managed settings take precedence over ServerOptions; the options values were not applied.",
        });
      }
      input.adopt(document.settings);
      return row;
    }
    if (mode === "reset") {
      const existing = await store.load(projectId);
      input.adopt(input.seed);
      return persist(input.seed, existing?.version ?? 0);
    }
    if (options.snapshot === undefined) throw new ControlStateError("Control state import requires a snapshot.");
    const document = decodeDocument(options.snapshot, projectId);
    populateCatalog(catalog, document, input.parseYaml);
    input.adopt(document.settings);
    const existing = await store.load(projectId);
    return persist(document.settings, existing?.version ?? 0);
  };

  const ready = startup().then((row) => {
    current = row;
  }, (error: unknown) => {
    if (error instanceof ControlStateError) throw error;
    throw new ControlStateError("Control state could not be loaded or saved; check the store connection and permissions.");
  });
  ready.catch((error: unknown) => {
    input.log?.({
      event: "control-state.startup-failed",
      projectId,
      message: error instanceof Error ? error.message : "Control state startup failed.",
    });
  });

  let queue: Promise<void> = ready.then(
    () => undefined,
    () => undefined,
  );

  const apply = async <T>(work: (draft: ControlDraft) => T): Promise<T> => {
    if (failure !== null) throw failure;
    if (current === null) throw new ControlStateError("Control state is not ready.");
    const base = current;
    const draft: ControlDraft = { catalog: cloneCatalog(catalog), settings: input.settings() };
    // A throw here means nothing was written and the live state is untouched.
    const result = work(draft);
    const document = encodeDocument(projectId, draft.settings, draft.catalog);
    if (document === base.document) return result;

    const next: ControlStateRow = { version: base.version + 1, document, checksum: await sha256Hex(document) };
    try {
      await store.save(projectId, base.version, next);
    } catch (error) {
      // The write may have landed even though the call failed. Reread before deciding what happened.
      let persisted: ControlStateRow | null;
      try {
        persisted = await store.load(projectId);
      } catch {
        failure = new ControlStateError("Control state could not be confirmed after a failed save; restart to recover.");
        throw failure;
      }
      if (persisted !== null && persisted.version === next.version && persisted.document === next.document && persisted.checksum === next.checksum) {
        // The write landed; fall through and adopt it.
      } else if (
        persisted !== null &&
        persisted.version === base.version &&
        persisted.checksum === base.checksum
      ) {
        throw error;
      } else {
        failure = new ControlStateError(
          "Control state changed outside this process after a failed save; restart to recover from the stored state.",
        );
        throw failure;
      }
    }
    replaceCatalogContents(catalog, draft.catalog);
    input.adopt(draft.settings);
    current = next;
    return result;
  };

  return {
    ready,
    commit<T>(work: (draft: ControlDraft) => T): Promise<T> {
      const run = queue.then(() => apply(work));
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    async exportState(): Promise<string> {
      await queue;
      if (failure !== null) throw failure;
      if (current === null) throw new ControlStateError("Control state is not ready.");
      return current.document;
    },
    assertHealthy(): void {
      if (failure !== null) throw failure;
    },
  };
}
