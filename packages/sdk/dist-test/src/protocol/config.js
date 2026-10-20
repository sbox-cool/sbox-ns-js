import { hexEncode, utf8 } from "../util/bytes.js";
import { stableJson } from "../util/json.js";
import { importRsaPrivatePem, rsaPkcs1Sign, rsaSpkiDer, sha256, spkiPem } from "./crypto.js";
import { clampReplayWindow } from "./replay.js";
import { DEFAULT_SESSION_TTL_SECONDS, normalizeSessionTtl } from "./sessions.js";
import { ENCRYPTED_REQUEST_ACCEPTS } from "./security.js";
/** Config TTL the library caches for. Fixed by the wire contract. */
export const SECURITY_CONFIG_TTL_SECONDS = 60;
/** Analytics event names published when the owner sets no list. Matches the server's defaults. */
export const DEFAULT_ANALYTICS_EVENT_TYPES = ["death", "respawn", "cast_line", "caught_fish", "sold_fish"];
export const V2_ALGORITHM = "rsa-oaep-256+aes-256-gcm";
/** The settings object the config version hashes and the config publishes. Mirrors `NetworkStorageSecurityConfigBuilder.SettingsOf`. */
export function securitySettingsDocument(settings) {
    const mode = settings.encryptedRequestMode;
    const analytics = settings.analytics ?? { enabled: false };
    const document = {
        enableAuthSessions: settings.enableAuthSessions,
        authSessionTtlSeconds: normalizeSessionTtl(settings.authSessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS),
        enableEncryptedRequests: mode !== "off",
        encryptedRequestWindowSeconds: clampReplayWindow(settings.encryptedRequestWindowSeconds),
        analytics: {
            enabled: analytics.enabled,
            allowedEventTypes: [...(analytics.allowedEventTypes ?? DEFAULT_ANALYTICS_EVENT_TYPES)],
        },
    };
    if (ENCRYPTED_REQUEST_ACCEPTS[mode].v2)
        document.encryptedRequestMode = mode;
    return document;
}
/** Config version: first 16 hex characters of SHA-256 over the stable serialisation of the settings. */
export async function securityConfigVersion(settings) {
    return hexEncode(await sha256(utf8(stableJson(securitySettingsDocument(settings))))).slice(0, 16);
}
/** Builds and signs the config document a client verifies and caches. */
export async function buildSecurityConfig(input) {
    const { settings } = input;
    const signingKey = await importRsaPrivatePem(input.signingPrivateKeyPem, "SHA-256");
    const publicKeyPem = spkiPem(await rsaSpkiDer(signingKey.publicJwk));
    const payload = {
        schemaVersion: 1,
        projectId: input.projectId,
        configVersion: await securityConfigVersion(settings),
        generatedAt: new Date(input.nowMs).toISOString(),
        ttlSeconds: SECURITY_CONFIG_TTL_SECONDS,
        modes: {
            authSessions: settings.enableAuthSessions ? "enabled" : "disabled",
            encryptedRequests: settings.encryptedRequestMode === "off" ? "disabled" : "required",
            analytics: settings.analytics?.enabled ? "enabled" : "disabled",
        },
        settings: securitySettingsDocument(settings),
        signing: {
            algorithm: "rsa-sha256",
            keyId: hexEncode(await sha256(utf8(publicKeyPem))).slice(0, 16),
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
function encryptionBlock(ring, required) {
    if (!ring)
        throw new Error("v2 encrypted requests need a request key ring");
    const current = ring.keys.find((key) => key.keyId === ring.currentKeyId);
    if (!current)
        throw new Error("request key ring has no current key");
    return {
        algorithm: V2_ALGORITHM,
        keyId: current.keyId,
        publicKeyJwk: current.publicJwk,
        fingerprint: current.fingerprint,
        required,
    };
}
