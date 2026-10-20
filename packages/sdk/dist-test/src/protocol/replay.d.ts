export declare const DEFAULT_REPLAY_WINDOW_SECONDS = 120;
export declare const MIN_REPLAY_WINDOW_SECONDS = 30;
export declare const MAX_REPLAY_WINDOW_SECONDS = 600;
/**
 * Claimed encrypted-request ids. `claim` MUST be atomic: a key that is already claimed and unexpired is refused.
 * Multi-instance deployments need a store shared between instances, such as a database unique key.
 */
export interface ReplayStore {
    claim(key: string, expiresAtMs: number, nowMs: number): Promise<boolean>;
}
export interface ReplayCheck {
    projectId: string;
    /** `type:value` of the envelope identity. */
    identityKey: string;
    requestId: string;
    windowSeconds: number;
    nowMs: number;
}
/** Clamps the configured window to the server's bounds. Unset means the default. */
export declare function clampReplayWindow(seconds: number | undefined): number;
/**
 * Validates the request id's format and time window, then claims it for the identity. Runs only once the endpoint is
 * known to exist, as on the server, so probes of unknown routes do not consume ids.
 */
export declare function consumeRequestId(store: ReplayStore, check: ReplayCheck): Promise<void>;
/** In-process replay store. Correct for one process; each instance keeps its own claims. */
export declare function createMemoryReplayStore(): ReplayStore;
