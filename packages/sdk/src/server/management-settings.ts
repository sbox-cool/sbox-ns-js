import { ENCRYPTED_REQUEST_ACCEPTS, type EncryptedRequestMode } from "../protocol/security.js";
import { normalizeSessionTtl, DEFAULT_SESSION_TTL_SECONDS } from "../protocol/sessions.js";
import { clampReplayWindow } from "../protocol/replay.js";
import type { ServerOptions } from "./options.js";

// The project settings the management API reports. Field names and values follow the reference's
// ManagementSettings.View so editors read the same document from either server. This server stores the security
// settings it was configured with; the game revision and player-key fields have no configuration here, so they
// report the reference's defaults for a project that never set them.
export function managementSettingsView(options: ServerOptions): Record<string, unknown> {
  const { settings } = options;
  const mode: EncryptedRequestMode = settings.encryptedRequestMode;
  const view: Record<string, unknown> = {
    enabled: true,
    requireSboxAuth: options.requireSboxAuth === true,
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
