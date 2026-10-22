import { buildSecurityConfig, SECURITY_CONFIG_TTL_SECONDS, type SecuritySettings, type SignedSecurityConfig } from "../protocol/config.js";
import type { ServerOptions } from "./options.js";

export interface ConfigSource {
  current(nowMs: number, refresh: boolean): Promise<SignedSecurityConfig>;
}

// Builds and caches the signed security config. The game verifies the signature, so caching only
// changes when a new signature is issued, never what the signature covers.
export function createConfigSource(options: ServerOptions, settings: () => SecuritySettings): ConfigSource {
  let cached: { expiresAtMs: number; settings: SecuritySettings; value: SignedSecurityConfig } | null = null;
  return {
    async current(nowMs, refresh) {
      const current = settings();
      if (!refresh && cached !== null && cached.settings === current && nowMs < cached.expiresAtMs) return cached.value;
      const value = await buildSecurityConfig({
        nowMs,
        projectId: options.projectId,
        settings: current,
        signingPrivateKeyPem: options.signingPrivateKeyPem,
        signingKeyId: options.signingKeyId,
        requestKeys: options.requestKeys,
      });
      cached = { expiresAtMs: nowMs + SECURITY_CONFIG_TTL_SECONDS * 1000, settings: current, value };
      return value;
    },
  };
}
