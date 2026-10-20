import { ProtocolError } from "./errors.js";
export const DEFAULT_REPLAY_WINDOW_SECONDS = 120;
export const MIN_REPLAY_WINDOW_SECONDS = 30;
export const MAX_REPLAY_WINDOW_SECONDS = 600;
const CLEANUP_INTERVAL_MS = 10_000;
const REQUEST_ID_PATTERN = /^([0-9]{9,11})_([A-Za-z0-9_-]{6,})$/;
/** Clamps the configured window to the server's bounds. Unset means the default. */
export function clampReplayWindow(seconds) {
    if (seconds === undefined)
        return DEFAULT_REPLAY_WINDOW_SECONDS;
    return Math.min(MAX_REPLAY_WINDOW_SECONDS, Math.max(MIN_REPLAY_WINDOW_SECONDS, Math.trunc(seconds)));
}
/**
 * Validates the request id's format and time window, then claims it for the identity. Runs only once the endpoint is
 * known to exist, as on the server, so probes of unknown routes do not consume ids.
 */
export async function consumeRequestId(store, check) {
    const requestId = check.requestId.trim();
    const match = REQUEST_ID_PATTERN.exec(requestId);
    if (match === null) {
        throw new ProtocolError(400, "ENCRYPTED_REQUEST_INVALID_ID", "encryptedRequestId must use the format {unixSeconds}_{random6plus}.");
    }
    const issuedSeconds = Number(match[1]);
    const nowSeconds = Math.floor(check.nowMs / 1000);
    if (Math.abs(nowSeconds - issuedSeconds) > check.windowSeconds) {
        throw new ProtocolError(400, "ENCRYPTED_REQUEST_STALE", `encryptedRequestId is outside the accepted ${check.windowSeconds} second replay window.`);
    }
    // Expiry follows the id's issue time, not the arrival time, so a claim lives exactly as long as it can be replayed.
    const expiresAtMs = (issuedSeconds + check.windowSeconds) * 1000;
    const claimed = await store.claim(`${check.projectId}:${check.identityKey}:${requestId}`, expiresAtMs, check.nowMs);
    if (!claimed) {
        throw new ProtocolError(409, "ENCRYPTED_REQUEST_REPLAY_DETECTED", "This encrypted request id has already been accepted for this identity.");
    }
}
/** In-process replay store. Correct for one process; each instance keeps its own claims. */
export function createMemoryReplayStore() {
    const expiries = new Map();
    let lastCleanupMs = 0;
    return {
        async claim(key, expiresAtMs, nowMs) {
            if (nowMs - lastCleanupMs >= CLEANUP_INTERVAL_MS) {
                lastCleanupMs = nowMs;
                for (const [entry, expiry] of expiries) {
                    if (expiry <= nowMs)
                        expiries.delete(entry);
                }
            }
            const existing = expiries.get(key);
            if (existing !== undefined && existing > nowMs)
                return false;
            expiries.set(key, expiresAtMs);
            return true;
        },
    };
}
