/**
 * A protocol refusal. `status` is the real HTTP status. The response writer decides whether it goes
 * on the wire as-is (plain callers) or inside a library envelope with HTTP 200 (library callers).
 */
export class ProtocolError extends Error {
    status;
    code;
    security;
    constructor(status, code, message, security) {
        super(message);
        this.name = "ProtocolError";
        this.status = status;
        this.code = code;
        this.security = security;
    }
}
export function isProtocolError(value) {
    return value instanceof ProtocolError;
}
