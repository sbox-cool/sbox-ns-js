import type { RequestKeyRing } from "../protocol/crypto.js";
import { ENCRYPTED_REQUEST_ACCEPTS, type EncryptedRequestMode } from "../protocol/security.js";
import type { SecuritySettings } from "../protocol/config.js";
import {
  DEFAULT_SESSION_TTL_SECONDS,
  MAX_SESSION_TTL_SECONDS,
  MIN_SESSION_TTL_SECONDS,
  normalizeSessionTtl,
} from "../protocol/sessions.js";
import {
  clampReplayWindow,
  DEFAULT_REPLAY_WINDOW_SECONDS,
  MAX_REPLAY_WINDOW_SECONDS,
  MIN_REPLAY_WINDOW_SECONDS,
} from "../protocol/replay.js";
import { stableJson } from "../util/json.js";
import type { ManagedSettings } from "./context.js";

// The project settings the management API reports. Field names and values follow the reference's
// ManagementSettings.View so editors read the same document from either server. This server stores the security
// settings and the request-facing require-sbox-auth flag; the game revision and player-key fields have no
// configuration here, so they report the reference's defaults for a project that never set them.
export function managementSettingsView(current: ManagedSettings): Record<string, unknown> {
  const settings = current.security;
  const mode: EncryptedRequestMode = settings.encryptedRequestMode;
  const view: Record<string, unknown> = {
    enabled: true,
    requireSboxAuth: current.requireSboxAuth,
    requireAuthSessions: settings.requireAuthSessions,
    enableAuthSessions: settings.enableAuthSessions,
    authSessionTtlSeconds: normalizeSessionTtl(settings.authSessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS),
    enableEncryptedRequests: mode !== "off",
    // The view reports the reference's management default (300 seconds) when no window is configured; the runtime
    // config keeps the protocol default (120 seconds), so the two can differ for an unconfigured server.
    encryptedRequestWindowSeconds: settings.encryptedRequestWindowSeconds === undefined ? 300 : clampReplayWindow(settings.encryptedRequestWindowSeconds),
    playerKeyMode: "public",
    revisionEnforcementEnabled: false,
    revisionEnforcementMode: "allow_continue",
    revisionGracePeriodMinutes: null,
    revisionPostGraceAction: "block_writes",
    revisionForceEndpointUpgrade: false,
    revisionNotifyMessage: "",
    revisionShowDefaultMessage: false,
    revisionShowNewVersionBanner: true,
    revisionShowUpdateOptions: true,
    revisionEscalateAfterMinutes: null,
    revisionShowPopupOnce: true,
    revisionTestOutdatedEditor: false,
    revisionTestOutdatedLive: false,
  };
  if (ENCRYPTED_REQUEST_ACCEPTS[mode].v2) view["encryptedRequestMode"] = mode;
  return view;
}

// Keys the reference rejects by name because this server cannot store them.
const NEVER_STORED = ["spacetimeBackendMode", "storageBackendMode"] as const;

// Keys the reference stores but this server does not. A PUT may carry one only when it repeats the value the view
// already reports, so a GET-edit-PUT round trip succeeds and a changed value is never silently dropped.
const VIEW_ONLY = [
  "enabled",
  "playerKeyMode",
  "revisionEnforcementEnabled",
  "revisionEnforcementMode",
  "revisionGracePeriodMinutes",
  "revisionPostGraceAction",
  "revisionForceEndpointUpgrade",
  "revisionNotifyMessage",
  "revisionShowDefaultMessage",
  "revisionShowNewVersionBanner",
  "revisionShowUpdateOptions",
  "revisionEscalateAfterMinutes",
  "revisionShowPopupOnce",
  "revisionTestOutdatedEditor",
  "revisionTestOutdatedLive",
  "revisionMinimumRevisionId",
  "revisionInGraceAction",
  "revisionServerEnforcementEnabled",
  "revisionRetentionCount",
] as const;

const MODES: readonly string[] = ["off", "v1", "v2-preferred", "v2-required"];

export type SettingsUpdate =
  | { readonly ok: true; readonly settings: ManagedSettings }
  | { readonly ok: false; readonly body: Record<string, unknown> };

function validationFailed(message: string): SettingsUpdate {
  return {
    ok: false,
    body: { ok: false, resourceKind: "project-settings", error: { code: "VALIDATION_FAILED", message } },
  };
}

function modeFailed(message: string): SettingsUpdate {
  return { ok: false, body: { ok: false, error: "VALIDATION_FAILED", message } };
}

// Parses and applies a PUT body, in the reference's order: body shape, unstored keys, mode, then the stored fields.
// Field rules follow the reference's ManagementSettings.Apply.
export function applySettingsText(current: ManagedSettings, text: string, requestKeys: RequestKeyRing | undefined): SettingsUpdate {
  if (text.trim() === "") return validationFailed("Request body is empty.");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (error) {
    return validationFailed(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(body)) return validationFailed("Body must be a project settings object.");
  const view = managementSettingsView(current);
  const neverStored = NEVER_STORED.find((key) => key in body);
  const unstored =
    neverStored ??
    VIEW_ONLY.find((key) => key in body && (!(key in view) || stableJson(body[key]) !== stableJson(view[key])));
  if (unstored !== undefined) {
    return {
      ok: false,
      body: { ok: false, error: "SETTING_NOT_STORED", message: `'${unstored}' is not a setting this server stores.` },
    };
  }

  let mode: EncryptedRequestMode = current.security.encryptedRequestMode;
  if ("encryptedRequestMode" in body) {
    const requested = body["encryptedRequestMode"];
    if (typeof requested !== "string" || !MODES.includes(requested)) {
      return modeFailed("encryptedRequestMode must be off, v1, v2-preferred, or v2-required.");
    }
    mode = requested as EncryptedRequestMode;
  } else if ("enableEncryptedRequests" in body) {
    mode = flagOf(body["enableEncryptedRequests"]) ? "v1" : "off";
  }
  // The signed config carries the request key, so a v2 mode is unservable until a current key is configured.
  if (ENCRYPTED_REQUEST_ACCEPTS[mode].v2 && requestKeys?.keys.some((key) => key.keyId === requestKeys.currentKeyId) !== true) {
    return modeFailed(`encryptedRequestMode ${mode} needs a request key configured on this server.`);
  }

  const security: SecuritySettings = {
    ...current.security,
    enableAuthSessions: "enableAuthSessions" in body ? flagOf(body["enableAuthSessions"]) : current.security.enableAuthSessions,
    requireAuthSessions: "requireAuthSessions" in body ? flagOf(body["requireAuthSessions"]) : current.security.requireAuthSessions,
    authSessionTtlSeconds:
      "authSessionTtlSeconds" in body
        ? normalizeSessionTtl(clampedOr(body["authSessionTtlSeconds"], DEFAULT_SESSION_TTL_SECONDS, MIN_SESSION_TTL_SECONDS, MAX_SESSION_TTL_SECONDS))
        : current.security.authSessionTtlSeconds,
    encryptedRequestWindowSeconds:
      "encryptedRequestWindowSeconds" in body
        ? clampedOr(body["encryptedRequestWindowSeconds"], DEFAULT_REPLAY_WINDOW_SECONDS, MIN_REPLAY_WINDOW_SECONDS, MAX_REPLAY_WINDOW_SECONDS)
        : current.security.encryptedRequestWindowSeconds,
    encryptedRequestMode: mode,
  };
  const requireSboxAuth = "requireSboxAuth" in body ? flagOf(body["requireSboxAuth"]) : current.requireSboxAuth;
  return { ok: true, settings: { security, requireSboxAuth } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The reference's truthy test for flag fields: a JSON true, the number 1, or one of "true", "on", "yes", "1".
function flagOf(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "number") return value === 1;
  return typeof value === "string" && ["true", "on", "yes", "1"].includes(value.toLowerCase());
}

// The reference's ParseIntLike: a finite number's integer part, or the leading integer of a string. Null otherwise.
function intOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value !== "string") return null;
  const match = /^\s*[+-]?\d+/.exec(value);
  return match === null ? null : Number.parseInt(match[0], 10);
}

function clampedOr(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = intOf(value);
  return parsed === null ? fallback : Math.min(max, Math.max(min, parsed));
}
