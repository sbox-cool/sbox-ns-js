import { isRecord } from "../util/guards.js";
import { ProtocolError } from "./errors.js";
const CLIENT_MODES = {
    legacy: true,
    session: true,
    encrypted: true,
    "session+encrypted": true,
};
const ENCRYPTED_REQUEST_MODES = {
    off: true,
    v1: true,
    "v2-preferred": true,
    "v2-required": true,
};
/** Which envelope kinds each mode accepts. `plain` is an unencrypted body. */
export const ENCRYPTED_REQUEST_ACCEPTS = {
    off: { plain: true, v1: false, v2: false },
    v1: { plain: false, v1: true, v2: false },
    "v2-preferred": { plain: false, v1: true, v2: true },
    "v2-required": { plain: false, v1: false, v2: true },
};
export function isEncryptedRequestMode(value) {
    return Object.hasOwn(ENCRYPTED_REQUEST_MODES, value);
}
/**
 * The effective mode. A valid stored mode wins. An absent stored mode maps the legacy flag (true to `v1`, otherwise
 * `off`). A stored value that is present but unknown fails closed to `v2-required`. It never falls back to `off`.
 */
export function resolveEncryptedRequestMode(stored, legacyEnabled) {
    if (stored === undefined || stored === null || stored.trim() === "")
        return legacyEnabled ? "v1" : "off";
    return isEncryptedRequestMode(stored) ? stored : "v2-required";
}
/** The envelope kind of an encrypted body, from `envelope.version`: missing or "1" is v1, "2" is v2, anything else is unsupported. */
export function envelopeKindOf(version) {
    if (version === "" || version === "1")
        return "v1";
    return version === "2" ? "v2" : "unsupported";
}
function denial(ctx, status, code, message, requestMode) {
    const mode = ctx.project.encryptedRequestMode;
    return new ProtocolError(status, code, message, {
        code,
        retrySafe: true,
        configVersion: ctx.configVersion,
        configSource: "project",
        requestMode,
        expected: {
            authSessions: ctx.project.enableAuthSessions ? "enabled" : "disabled",
            encryptedRequests: mode === "off" ? "disabled" : "required",
            encryptionMode: mode,
        },
    });
}
/**
 * The first security denial for this call, or null to continue. Port of `EndpointSecurityGate.Check`, in the
 * reference order: client mode, config version, session requirements, then the envelope matrix, then the v2 key.
 */
export function securityDenial(check) {
    const { project } = check;
    const ctx = { project, configVersion: check.configVersion };
    const encrypted = check.envelope !== "none";
    const security = isRecord(check.body) && isRecord(check.body.security) ? check.body.security : {};
    const clientMode = typeof security.clientMode === "string" ? security.clientMode.trim() : "";
    const clientConfigVersion = typeof security.configVersion === "string" ? security.configVersion.trim() : "";
    if (clientMode.length > 0 && !Object.hasOwn(CLIENT_MODES, clientMode)) {
        return denial(ctx, 400, "SECURITY_MODE_UNSUPPORTED", "The requested security mode is not supported.", clientMode);
    }
    if (clientConfigVersion.length > 0 && clientConfigVersion !== check.configVersion) {
        return denial(ctx, 409, "SECURITY_CONFIG_STALE", "The security config changed. Refresh the project config and retry.", clientMode);
    }
    if (project.requireAuthSessions && !check.presentedSession && !check.hasSecretKey) {
        return denial(ctx, 401, "SECURITY_SESSION_REQUIRED", "This project requires an auth session for endpoint calls.", encrypted ? "encrypted" : "legacy");
    }
    if (check.presentedSession && !check.hasSecretKey && !project.enableAuthSessions) {
        return denial(ctx, 403, "SECURITY_SESSION_DISABLED", "Auth sessions are not enabled for this project.", encrypted ? "session+encrypted" : "session");
    }
    const accepts = ENCRYPTED_REQUEST_ACCEPTS[project.encryptedRequestMode];
    const encryptedMode = check.presentedSession ? "session+encrypted" : "encrypted";
    const disabled = "Encrypted requests are not enabled for this project.";
    switch (check.envelope) {
        case "none":
            if (!accepts.plain) {
                return denial(ctx, 409, "SECURITY_ENCRYPTION_REQUIRED", "This project requires encrypted endpoint requests.", check.presentedSession ? "session" : "legacy");
            }
            break;
        case "v1":
            if (!accepts.v1) {
                return project.encryptedRequestMode === "off"
                    ? denial(ctx, 409, "SECURITY_ENCRYPTION_DISABLED", disabled, encryptedMode)
                    : denial(ctx, 409, "SECURITY_ENCRYPTION_REQUIRED", "This project requires v2 encrypted endpoint requests.", encryptedMode);
            }
            break;
        case "v2":
            if (!accepts.v2) {
                return project.encryptedRequestMode === "off"
                    ? denial(ctx, 409, "SECURITY_ENCRYPTION_DISABLED", disabled, encryptedMode)
                    : denial(ctx, 400, "SECURITY_MODE_UNSUPPORTED", "This project does not accept v2 encrypted requests.", encryptedMode);
            }
            break;
        case "unsupported":
            return denial(ctx, 400, "SECURITY_MODE_UNSUPPORTED", "The encrypted request envelope version is not supported.", encryptedMode);
    }
    if (check.envelope === "v2" && !check.envelopeKeyFound) {
        return denial(ctx, 409, "SECURITY_CONFIG_STALE", "The encryption key is unknown or expired. Refresh the project config and retry.", encryptedMode);
    }
    return null;
}
