import { ProtocolError } from "./errors.js";
/**
 * Reads an envelope field the way the server's `Str` helper does: strings are returned untrimmed, finite numbers as
 * their text, and anything else (including a missing field) as the empty string.
 */
export declare function readField(raw: Readonly<Record<string, unknown>>, name: string): string;
/** Envelope refusals are 401 `REQUEST_SIGNATURE_INVALID`, the same for v1 and v2 shape and binding failures. */
export declare function refuseEnvelope(message: string): ProtocolError;
