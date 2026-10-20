import { buildSecurityConfig, SECURITY_CONFIG_TTL_SECONDS, type SignedSecurityConfig } from "../protocol/config.js";
import type { ServerOptions } from "./options.js";

export interface ConfigSource {
  current(nowMs: number, refresh: boolean): Promise<SignedSecurityConfig>;
}

// Builds and caches the signed security config. The game verifies the signature, so caching only
// changes when a new signature is issued, never what the signature covers.
export function createConfigSource(options: ServerOptions): ConfigSource {
  let cached: { expiresAtMs: number; value: SignedSecurityConfig } | null = null;
  return {
    async current(nowMs, refresh) {
      if (!refresh && cached !== null && nowMs < cached.expiresAtMs) return cached.value;
      const value = await buildSecurityConfig({
        nowMs,
        projectId: options.projectId,
        settings: options.settings,
        signingPrivateKeyPem: options.signingPrivateKeyPem,
        signingKeyId: options.signingKeyId,
        requestKeys: options.requestKeys,
      });
      cached = { expiresAtMs: nowMs + SECURITY_CONFIG_TTL_SECONDS * 1000, value };
      return value;
    },
  };
}
