import type { IdentityOptions } from "../protocol/identity.js";
import type { ServerOptions, SessionRevocations } from "./options.js";
import { createConfigSource, type ConfigSource } from "./config.js";

export interface ServerContext {
  readonly options: ServerOptions;
  readonly config: ConfigSource;
  readonly revocations: SessionRevocations;
  now(): number;
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
  return {
    options,
    config: createConfigSource(options),
    revocations: options.sessionRevocations ?? createMemoryRevocations(),
    now: options.now ?? (() => Date.now()),
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
