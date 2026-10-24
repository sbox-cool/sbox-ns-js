import { hexEncode, utf8 } from "../util/bytes.js";
import { stableJson } from "../util/json.js";
import { importRsaPrivatePem, rsaPkcs1Sign, rsaSpkiDer, sha256, spkiPem, type RequestKeyRing, type RsaPublicJwk } from "./crypto.js";
import { clampReplayWindow } from "./replay.js";
import { DEFAULT_SESSION_TTL_SECONDS, normalizeSessionTtl } from "./sessions.js";
import { ENCRYPTED_REQUEST_ACCEPTS, type EncryptedRequestMode, type SecurityProject } from "./security.js";

/** Config TTL the library caches for. Fixed by the wire contract. */
export const SECURITY_CONFIG_TTL_SECONDS = 60;

/** Analytics event names published when the owner sets no list. Matches the server's defaults. */
export const DEFAULT_ANALYTICS_EVENT_TYPES: readonly string[] = ["death", "respawn", "cast_line", "caught_fish", "sold_fish"];

export const V2_ALGORITHM = "rsa-oaep-256+aes-256-gcm";

export interface SecuritySettings extends SecurityProject {
  authSessionTtlSeconds?: number;
  encryptedRequestWindowSeconds?: number;
  /** Defaults to enabled, matching the reference. Accepted analytics events are stored in `_analytics`. */
  analytics?: { enabled?: boolean; allowedEventTypes?: readonly string[] };
  /**
   * Reference `legacyPlayerProjections`: when true, endpoint writes to `_ledger` number fields append
   * ledger rows. Off for new projects, so the ledger route is empty until a project opts in.
   */
  legacyPlayerProjections?: boolean;
}

export interface SecurityConfigInput {
  projectId: string;
  settings: SecuritySettings;
  /** PKCS#8 RSA PEM. The config signature is RSASSA-PKCS1-v1_5 SHA-256 under this key. */
  signingPrivateKeyPem: string;
  /** Required when the mode offers v2. Supplies the request key the config publishes. */
  requestKeys?: RequestKeyRing;
  /** Overrides the published signing key id. The server reads NETWORK_STORAGE_SECURITY_CONFIG_KEY_ID; the SDK takes this as input and never reads the environment. */
  signingKeyId?: string;
  nowMs: number;
}

export interface SignedSecurityConfig {
  schemaVersion: 1;
  projectId: string;
  configVersion: string;
  generatedAt: string;
  ttlSeconds: number;
  modes: {
    authSessions: "enabled" | "disabled";
    encryptedRequests: "required" | "disabled";
    analytics: "enabled" | "disabled";
  };
  settings: Record<string, unknown>;
  signing: {
    algorithm: "rsa-sha256";
    keyId: string;
    publicKeyPem: string;
    publicKeyJwk: RsaPublicJwk;
  };
  encryption?: {
    algorithm: typeof V2_ALGORITHM;
    keyId: string;
    publicKeyJwk: RsaPublicJwk;
    fingerprint: string;
    required: boolean;
  };
  signature: string;
}

/** The settings object the config version hashes and the config publishes. Mirrors `NetworkStorageSecurityConfigBuilder.SettingsOf`. */
export function securitySettingsDocument(settings: SecuritySettings): Record<string, unknown> {
  const mode: EncryptedRequestMode = settings.encryptedRequestMode;
  const analytics = settings.analytics ?? {};
  const document: Record<string, unknown> = {
    enableAuthSessions: settings.enableAuthSessions,
    authSessionTtlSeconds: normalizeSessionTtl(settings.authSessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS),
    enableEncryptedRequests: mode !== "off",
    encryptedRequestWindowSeconds: clampReplayWindow(settings.encryptedRequestWindowSeconds),
    analytics: {
      allowedEventTypes: [...(analytics.allowedEventTypes ?? DEFAULT_ANALYTICS_EVENT_TYPES)],
    },
  };
  if (ENCRYPTED_REQUEST_ACCEPTS[mode].v2) document.encryptedRequestMode = mode;
  return document;
}

/** Config version: first 16 hex characters of SHA-256 over the stable serialisation of the settings. */
export async function securityConfigVersion(settings: SecuritySettings): Promise<string> {
  return hexEncode(await sha256(utf8(stableJson(securitySettingsDocument(settings))))).slice(0, 16);
}

/** Builds and signs the config document a client verifies and caches. */
export async function buildSecurityConfig(input: SecurityConfigInput): Promise<SignedSecurityConfig> {
  const { settings } = input;
  const signingKey = await importRsaPrivatePem(input.signingPrivateKeyPem, "SHA-256");
  const publicKeyPem = spkiPem(await rsaSpkiDer(signingKey.publicJwk));

  const payload: Omit<SignedSecurityConfig, "signature"> = {
    schemaVersion: 1,
    projectId: input.projectId,
    configVersion: await securityConfigVersion(settings),
    generatedAt: new Date(input.nowMs).toISOString(),
    ttlSeconds: SECURITY_CONFIG_TTL_SECONDS,
    modes: {
      authSessions: settings.enableAuthSessions ? "enabled" : "disabled",
      encryptedRequests: settings.encryptedRequestMode === "off" ? "disabled" : "required",
      analytics: (settings.analytics?.enabled ?? true) ? "enabled" : "disabled",
    },
    settings: securitySettingsDocument(settings),
    signing: {
      algorithm: "rsa-sha256",
      keyId: input.signingKeyId?.trim() || hexEncode(await sha256(utf8(publicKeyPem))).slice(0, 16),
      publicKeyPem,
      publicKeyJwk: signingKey.publicJwk,
    },
  };

  if (ENCRYPTED_REQUEST_ACCEPTS[settings.encryptedRequestMode].v2) {
    payload.encryption = encryptionBlock(input.requestKeys, settings.encryptedRequestMode === "v2-required");
  }
  const signature = await rsaPkcs1Sign(input.signingPrivateKeyPem, utf8(stableJson(payload)));
  return { ...payload, signature };
}

function encryptionBlock(ring: RequestKeyRing | undefined, required: boolean): NonNullable<SignedSecurityConfig["encryption"]> {
  if (!ring) throw new Error("v2 encrypted requests need a request key ring");
  const current = ring.keys.find((key) => key.keyId === ring.currentKeyId);
  if (!current) throw new Error("request key ring has no current key");
  return {
    algorithm: V2_ALGORITHM,
    keyId: current.keyId,
    publicKeyJwk: current.publicJwk,
    fingerprint: current.fingerprint,
    required,
  };
}
