import { utf8Decode } from "../util/bytes.js";
import { ProtocolError } from "./errors.js";
import { readField, refuseEnvelope } from "./fields.js";
import { RESERVED_PAYLOAD_KEYS } from "./identity.js";
import type { Bytes } from "../util/bytes.js";

/** Fixed message for decrypt failures. The server appends .NET exception text; this SDK deliberately does not. */
export function undecryptable(): ProtocolError {
  return new ProtocolError(401, "REQUEST_SIGNATURE_INVALID", "Encrypted request payload could not be decrypted.");
}

/** Parses decrypted bytes. Invalid JSON is a decrypt failure; a non-object body is a 400, as on the server. */
export function parsePayloadObject(plaintext: Bytes): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(plaintext));
  } catch {
    throw undecryptable();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProtocolError(400, "INVALID_BODY", "Decrypted request payload must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

/** Rejects a payload whose `_endpointSlug` names a different route. An empty value is not a binding. */
export function assertPayloadSlug(payload: Readonly<Record<string, unknown>>, endpointSlug: string): void {
  const payloadSlug = readField(payload, "_endpointSlug").trim();
  if (payloadSlug !== "" && endpointSlug !== "" && payloadSlug !== endpointSlug) {
    throw refuseEnvelope("Encrypted request _endpointSlug does not match the URL.");
  }
}

/** Drops identity and auth keys so endpoint code only sees caller data. */
export function withoutReservedKeys(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!RESERVED_PAYLOAD_KEYS[key]) out[key] = value;
  }
  return out;
}
