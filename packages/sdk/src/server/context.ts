import type { IdentityOptions } from "../protocol/identity.js";
import type { SecuritySettings } from "../protocol/config.js";
import type { EndpointStorage } from "../storage/types.js";
import { createCatalog, stagedCatalogOf, storageDefinitionOf, valuesOf, type Catalog } from "./catalog.js";
import { createConfigSource, type ConfigSource } from "./config.js";
import { openDurableControl, type ControlDraft, type DurableControl } from "./control-state.js";
import type { ServerOptions, SessionRevocations, ValuesDocument } from "./options.js";
import { createSyncJobs, type SyncJobs } from "./sync-jobs.js";

// What a request reads: the catalog and the storage built from it. The live view is the committed catalog; the next
// view layers the staged revision on top.
export interface RuntimeView {
  readonly catalog: Catalog;
  readonly storage: EndpointStorage;
}

// The settings a management write changes. The security settings feed the protocol and the signed config; the
// request-facing flag is read per call too.
export interface ManagedSettings {
  readonly security: SecuritySettings;
  readonly requireSboxAuth: boolean;
}

export interface ServerContext {
  readonly options: ServerOptions;
  readonly config: ConfigSource;
  readonly revocations: SessionRevocations;
  readonly catalog: Catalog;
  readonly syncJobs: SyncJobs;
  now(): number;
  // Game values: static ServerOptions values merged with the ones the editor pushed.
  values(): ValuesDocument;
  // The storage for the current catalog. Rebuilt whenever the catalog revision changes.
  storage(): EndpointStorage;
  // The runtime for a publish target. next=false reads the live catalog; next=true reads it with the staged revision applied.
  view(next: boolean): RuntimeView;
  // The settings management writes change. Requests read them per call, so a change applies to the next request.
  settings(): ManagedSettings;
  // Runs one control mutation. In durable mode `work` runs on a copy and nothing becomes visible until the write is
  // acknowledged. In memory mode it runs on the live state, so `work` validates before it mutates.
  commit<T>(work: (draft: ControlDraft) => T): Promise<T>;
  // Resolves once durable control state is loaded. Always resolved in memory mode.
  readonly ready: Promise<void>;
  // The persisted control document. Durable mode only.
  exportControlState(): Promise<string>;
  // Throws when a durable commit could not be confirmed; the process then fails closed until restart.
  assertHealthy(): void;
}

// In-process revocation list. Entries live until their session would have expired anyway. Multi-instance
// deployments must supply a shared store, or a logout only applies to the instance that received it.
function createMemoryRevocations(): SessionRevocations {
  const revoked = new Map<string, number>();
  return {
    async revoke(sessionId, expiresAtMs) {
      revoked.set(sessionId, expiresAtMs);
    },
    async isRevoked(sessionId) {
      return revoked.has(sessionId);
    },
  };
}

export function createServerContext(options: ServerOptions): ServerContext {
  const catalog = createCatalog();
  const values = (): ValuesDocument => valuesOf(catalog, options.values);
  const now = options.now ?? (() => Date.now());
  let cached: { readonly revision: number; readonly storage: EndpointStorage } | null = null;
  let overlay: { readonly revision: number; readonly view: RuntimeView } | null = null;
  let managed: ManagedSettings = { security: options.settings, requireSboxAuth: options.requireSboxAuth ?? false };
  // Durable mode: writes go through the store, and the live catalog is replaced only once a write is acknowledged.
  const durable: DurableControl | null =
    options.controlState === undefined
      ? null
      : openDurableControl({
          projectId: options.projectId,
          options: options.controlState,
          seed: managed,
          parseYaml: options.parseYaml,
          catalog,
          settings: () => managed,
          adopt: (next) => {
            managed = next;
          },
          log: options.log,
        });
  // Memory mode: work runs against the live state synchronously, as it always has.
  const memoryCommit = <T>(work: (draft: ControlDraft) => T): Promise<T> => {
    const draft: ControlDraft = { catalog, settings: managed };
    try {
      const result = work(draft);
      managed = draft.settings;
      return Promise.resolve(result);
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const liveStorage = (): EndpointStorage => {
    if (cached === null || cached.revision !== catalog.revision) {
      cached = { revision: catalog.revision, storage: options.storage(storageDefinitionOf(catalog, values())) };
    }
    return cached.storage;
  };
  return {
    options,
    config: createConfigSource(options, () => managed.security),
    revocations: options.sessionRevocations ?? createMemoryRevocations(),
    catalog,
    syncJobs: createSyncJobs(now, options.projectId),
    now,
    values,
    storage: liveStorage,
    view(next) {
      if (!next) return { catalog, storage: liveStorage() };
      if (overlay === null || overlay.revision !== catalog.revision) {
        const staged = stagedCatalogOf(catalog, options.parseYaml);
        const storage = staged === catalog ? liveStorage() : options.storage(storageDefinitionOf(staged, values()));
        overlay = { revision: catalog.revision, view: { catalog: staged, storage } };
      }
      return overlay.view;
    },
    settings: () => managed,
    commit: durable === null ? memoryCommit : durable.commit,
    ready: durable === null ? Promise.resolve() : durable.ready,
    exportControlState: () =>
      durable === null ? Promise.reject(new Error("exportControlState requires ServerOptions.controlState.")) : durable.exportState(),
    assertHealthy: () => durable?.assertHealthy(),
  };
}

export function identityOptionsFor(
  ctx: ServerContext,
  endpointSlug: string,
  nowMs: number,
): IdentityOptions {
  const { options } = ctx;
  return {
    projectId: options.projectId,
    endpointSlug,
    apiKey: options.publicKey,
    ownerUserId: options.ownerUserId,
    requireSboxAuth: ctx.settings().requireSboxAuth,
    sessions: options.sessionSecret === null ? null : { secret: options.sessionSecret },
    nowMs,
    fetch: globalThis.fetch,
  };
}
