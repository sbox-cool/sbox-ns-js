/**
 * A protocol refusal. `status` is the real HTTP status. The response writer decides whether it goes
 * on the wire as-is (plain callers) or inside a library envelope with HTTP 200 (library callers).
 */
export class ProtocolError extends Error {
  readonly status: number;
  readonly code: string;
  readonly security: Readonly<Record<string, unknown>> | undefined;

  constructor(status: number, code: string, message: string, security?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "ProtocolError";
    this.status = status;
    this.code = code;
    this.security = security;
  }
}

export function isProtocolError(value: unknown): value is ProtocolError {
  return value instanceof ProtocolError;
}
