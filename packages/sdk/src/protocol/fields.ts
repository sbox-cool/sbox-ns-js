import { ProtocolError } from "./errors.js";

/**
 * Reads an envelope field the way the server's `Str` helper does: strings are returned untrimmed, finite numbers as
 * their text, and anything else (including a missing field) as the empty string.
 */
export function readField(raw: Readonly<Record<string, unknown>>, name: string): string {
  const value = raw[name];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** Envelope refusals are 401 `REQUEST_SIGNATURE_INVALID`, the same for v1 and v2 shape and binding failures. */
export function refuseEnvelope(message: string): ProtocolError {
  return new ProtocolError(401, "REQUEST_SIGNATURE_INVALID", message);
}
