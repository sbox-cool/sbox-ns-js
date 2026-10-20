/**
 * A protocol refusal. `status` is the real HTTP status. The response writer decides whether it goes
 * on the wire as-is (plain callers) or inside a library envelope with HTTP 200 (library callers).
 */
export declare class ProtocolError extends Error {
    readonly status: number;
    readonly code: string;
    readonly security: Readonly<Record<string, unknown>> | undefined;
    constructor(status: number, code: string, message: string, security?: Readonly<Record<string, unknown>>);
}
export declare function isProtocolError(value: unknown): value is ProtocolError;
