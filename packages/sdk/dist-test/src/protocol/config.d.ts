import { type RequestKeyRing, type RsaPublicJwk } from "./crypto.js";
import { type SecurityProject } from "./security.js";
/** Config TTL the library caches for. Fixed by the wire contract. */
export declare const SECURITY_CONFIG_TTL_SECONDS = 60;
/** Analytics event names published when the owner sets no list. Matches the server's defaults. */
export declare const DEFAULT_ANALYTICS_EVENT_TYPES: readonly string[];
export declare const V2_ALGORITHM = "rsa-oaep-256+aes-256-gcm";
export interface SecuritySettings extends SecurityProject {
    authSessionTtlSeconds?: number;
    encryptedRequestWindowSeconds?: number;
    /** The SDK does not ingest analytics, so this defaults to disabled. */
    analytics?: {
        enabled: boolean;
        allowedEventTypes?: readonly string[];
    };
}
export interface SecurityConfigInput {
    projectId: string;
    settings: SecuritySettings;
    /** PKCS#8 RSA PEM. The config signature is RSASSA-PKCS1-v1_5 SHA-256 under this key. */
    signingPrivateKeyPem: string;
    /** Required when the mode offers v2. Supplies the request key the config publishes. */
    requestKeys?: RequestKeyRing;
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
export declare function securitySettingsDocument(settings: SecuritySettings): Record<string, unknown>;
/** Config version: first 16 hex characters of SHA-256 over the stable serialisation of the settings. */
export declare function securityConfigVersion(settings: SecuritySettings): Promise<string>;
/** Builds and signs the config document a client verifies and caches. */
export declare function buildSecurityConfig(input: SecurityConfigInput): Promise<SignedSecurityConfig>;
