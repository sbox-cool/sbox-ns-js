import { FetchError } from "../endpoint/fetch.js";
import { RunCancelled, ScriptFailure } from "../endpoint/runtime.js";
import { ProtocolError } from "../protocol/errors.js";
import type { RequestCredentials } from "../protocol/identity.js";
import { StorageError } from "../storage/errors.js";
import { isRecord } from "../util/guards.js";
import { jsonResponse } from "../util/http.js";

// Largest request body in bytes per route group, as the reference server sets them: game and auth-session routes
// 256 KiB, management 8 MiB, everything else 1 MiB.
const DATA_PLANE_BODY_BYTES = 256 * 1024;
const MANAGEMENT_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_BODY_BYTES = 1024 * 1024;

export function bodyLimitFor(url: URL): number {
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  if (parts[1] === "manage") return MANAGEMENT_BODY_BYTES;
  const gameRoute = parts[0] === "v1" || parts[0] === "v3" || parts[0] === "api" || parts[0] === "pages";
  if (gameRoute || parts[1] === "auth-sessions" || parts[1] === "sessions") return DATA_PLANE_BODY_BYTES;
  return DEFAULT_BODY_BYTES;
}

export interface ErrorDescription {
  status: number;
  code: string;
  message: string;
  security?: Readonly<Record<string, unknown>>;
  details?: Readonly<Record<string, unknown>>;
}

export function errorBody(code: string, message: string): Record<string, unknown> {
  return { ok: false, error: { code, message } };
}

export function errorResponse(description: ErrorDescription): Response {
  return jsonResponse(describedErrorBody(description), description.status);
}

export function describedErrorBody(description: ErrorDescription): Record<string, unknown> {
  const body = errorBody(description.code, description.message);
  if (description.details !== undefined) Object.assign(body, description.details);
  if (description.security !== undefined) body.security = description.security;
  return body;
}

// Maps any thrown value to a status and a code. Internal details never reach the caller.
export function describeError(error: unknown): ErrorDescription {
  if (error instanceof ProtocolError) {
    return { status: error.status, code: error.code, message: error.message, security: error.security };
  }
  if (error instanceof ScriptFailure) return { status: error.status, code: error.code, message: error.message, details: error.details };
  if (error instanceof FetchError) return { status: 502, code: error.code, message: error.message };
  if (error instanceof StorageError) return { status: error.status, code: error.code, message: error.message };
  if (error instanceof RunCancelled) return { status: 499, code: "REQUEST_CANCELLED", message: error.message };
  return { status: 500, code: "INTERNAL_ERROR", message: "The request could not be completed." };
}

// Compares two credentials in constant time over their bytes. Length is not hidden; key formats are fixed.
export function safeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let i = 0; i < left.byteLength; i += 1) difference |= left[i]! ^ right[i]!;
  return difference === 0;
}

// Reads a request body as text under the body limit of its route group.
export async function readBodyText(request: Request): Promise<string> {
  const limit = bodyLimitFor(new URL(request.url));
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > limit) {
    throw new ProtocolError(413, "PAYLOAD_TOO_LARGE", `Request body exceeds the ${limit}-byte limit for this route.`);
  }
  return new TextDecoder().decode(bytes);
}

// Reads a JSON body of any shape. An empty body is undefined.
export async function readJsonValue(request: Request): Promise<unknown> {
  const text = await readBodyText(request);
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolError(400, "INVALID_JSON", "The request body is not valid JSON.");
  }
}

// The message for a JSON body that parses but is not an object. Storage routes match on it to drop the detail.
export const BODY_NOT_OBJECT = "The request body must be a JSON object.";

// Reads a JSON object body. An empty body is an empty object.
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const parsed = await readJsonValue(request);
  if (parsed === undefined) return {};
  if (!isRecord(parsed)) throw new ProtocolError(400, "INVALID_BODY", BODY_NOT_OBJECT);
  return parsed;
}

export function credentialsOf(
  request: Request,
  url: URL,
  body: Readonly<Record<string, unknown>> | null,
): RequestCredentials {
  return {
    header: (name) => request.headers.get(name) ?? undefined,
    query: (name) => url.searchParams.get(name) ?? undefined,
    body,
  };
}

export function hasMethodBody(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

// Decodes one URL path segment. A malformed escape is the caller's fault, not a server error.
export function pathSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new ProtocolError(400, "INVALID_KEY", "The path contains an invalid escape sequence.");
  }
}
