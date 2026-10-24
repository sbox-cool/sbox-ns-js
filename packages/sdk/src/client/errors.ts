// Codes the server documents for secret-key callers. The union keeps autocomplete honest; `(string & {})` keeps
// unknown codes typed as strings so a newer server never breaks the client.
export type SboxNsErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "ROUTE_NOT_FOUND"
  | "PROJECT_NOT_FOUND"
  | "ENDPOINT_NOT_FOUND"
  | "SECRET_KEY_REQUIRED"
  | "VALIDATION_FAILED"
  | "INVALID_OPERATION"
  | "INVALID_BODY"
  | "METHOD_NOT_ALLOWED"
  | "COLLECTION_TYPE_MISMATCH"
  | "NETWORK_ERROR"
  | "INVALID_RESPONSE"
  | "HTTP_ERROR"
  | (string & {});

export interface SboxNsErrorInit {
  status: number;
  code: string;
  message: string;
  requestId?: string | null;
  body?: unknown;
}

/**
 * A failed call. `status` is the real HTTP status: library callers receive HTTP 200 on the wire with the real status
 * in the body, and the client reads it from there. `status` is 0 when the request never reached the server.
 */
export class SboxNsError extends Error {
  readonly status: number;
  readonly code: SboxNsErrorCode;
  readonly requestId: string | null;
  readonly body: unknown;

  constructor(init: SboxNsErrorInit) {
    super(init.message);
    this.name = "SboxNsError";
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId ?? null;
    this.body = init.body;
  }
}

export function isSboxNsError(value: unknown): value is SboxNsError {
  return value instanceof SboxNsError;
}
