export declare const FETCH_LIMITS: {
    readonly maxRequestsPerExecution: 5;
    readonly maxRequestBodyBytes: number;
    readonly maxResponseBytes: number;
    readonly defaultTimeoutMs: 5000;
    readonly minTimeoutMs: 100;
    readonly maxTimeoutMs: 10000;
    readonly maxUrlLength: 2048;
    readonly maxHeaders: 32;
    readonly maxHeaderValueLength: 4096;
    readonly maxRedirects: 5;
};
export declare class FetchError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export interface FetchPolicy {
    allowedHosts: readonly string[];
}
export interface ParsedFetch {
    key: string;
    host: string;
    method: string;
    url: string;
    headers: [string, string][];
    body: string | null;
    timeoutMs: number;
}
export interface FetchFailure {
    code: string;
    message: string;
}
export interface FetchOutcome {
    response: FetchResponseData | null;
    failure: FetchFailure | null;
}
export interface FetchResponseData {
    status: number;
    ok: boolean;
    headers: Record<string, string>;
    body: string;
    json: unknown;
}
export declare function parseFetchCall(rawUrl: unknown, rawOptions: unknown): ParsedFetch;
export declare function normalizeHost(raw: string): string;
export declare function isAllowedHost(host: string, entries: readonly string[]): boolean;
export declare function refuseHost(host: string, policy: FetchPolicy): FetchFailure | null;
export declare function blockedFailure(host: string, reason: string): FetchFailure;
export declare function blockedAddressReason(host: string): string | null;
export declare function sendFetch(call: ParsedFetch, policy: FetchPolicy): Promise<FetchOutcome>;
