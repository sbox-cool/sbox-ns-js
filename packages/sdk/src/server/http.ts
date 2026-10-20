import { FetchError } from "../endpoint/fetch.js";
import { RunCancelled, ScriptFailure } from "../endpoint/runtime.js";
import { ProtocolError } from "../protocol/errors.js";
import type { RequestCredentials } from "../protocol/identity.js";
import { StorageError } from "../storage/errors.js";
import { isRecord } from "../util/guards.js";
import { jsonResponse } from "../util/http.js";

// 1 MiB of JSON text. Bodies are measured in UTF-16 code units, which bounds the byte size from above.
const MAX_JSON_BODY_CHARS = 1024 * 1024;

export interface ErrorDescription {
  status: number;
  code: string;
  message: string;
  security?: Readonly<Record<string, unknown>>;
}

export function errorBody(code: string, message: string): Record<string, unknown> {
  return { ok: false, error: { code, message } };
}

export function errorResponse(description: ErrorDescription): Response {
  const body = errorBody(description.code, description.message);
  if (description.security !== undefined) body.security = description.security;
  return jsonResponse(body, description.status);
}

// Maps any thrown value to a status and a code. Internal details never reach the caller.
export function describeError(error: unknown): ErrorDescription {
  if (error instanceof ProtocolError) {
    return { status: error.status, code: error.code, message: error.message, security: error.security };
  }
  if (error instanceof ScriptFailure) return { status: error.status, code: error.code, message: error.message };
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

// Reads a request body as text under the JSON size limit.
export async function readBodyText(request: Request): Promise<string> {
  const text = await request.text();
  if (text.length > MAX_JSON_BODY_CHARS) {
    throw new ProtocolError(413, "BODY_TOO_LARGE", "The request body is too large.");
  }
  return text;
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

// Reads a JSON object body. An empty body is an empty object.
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const parsed = await readJsonValue(request);
  if (parsed === undefined) return {};
  if (!isRecord(parsed)) throw new ProtocolError(400, "INVALID_BODY", "The request body must be a JSON object.");
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
