import type { IdentityOptions } from "../protocol/identity.js";
import type { EndpointStorage } from "../storage/types.js";
import { createCatalog, storageDefinitionOf, valuesOf, type Catalog } from "./catalog.js";
import { createConfigSource, type ConfigSource } from "./config.js";
import type { ServerOptions, SessionRevocations, ValuesDocument } from "./options.js";

export interface ServerContext {
  readonly options: ServerOptions;
  readonly config: ConfigSource;
  readonly revocations: SessionRevocations;
  readonly catalog: Catalog;
  now(): number;
  // Game values: static ServerOptions values merged with the ones the editor pushed.
  values(): ValuesDocument;
  // The storage for the current catalog. Rebuilt whenever the catalog revision changes.
  storage(): EndpointStorage;
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
  let cached: { readonly revision: number; readonly storage: EndpointStorage } | null = null;
  return {
    options,
    config: createConfigSource(options),
    revocations: options.sessionRevocations ?? createMemoryRevocations(),
    catalog,
    now: options.now ?? (() => Date.now()),
    values,
    storage() {
      if (cached === null || cached.revision !== catalog.revision) {
        cached = { revision: catalog.revision, storage: options.storage(storageDefinitionOf(catalog, values())) };
      }
      return cached.storage;
    },
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
    requireSboxAuth: options.requireSboxAuth ?? false,
    sessions: options.sessionSecret === null ? null : { secret: options.sessionSecret },
    nowMs,
    fetch: globalThis.fetch,
  };
}
