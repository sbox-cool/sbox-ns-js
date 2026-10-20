import { ProtocolError } from "./errors.js";
import type { Bytes } from "../util/bytes.js";
/** Fixed message for decrypt failures. The server appends .NET exception text; this SDK deliberately does not. */
export declare function undecryptable(): ProtocolError;
/** Parses decrypted bytes. Invalid JSON is a decrypt failure; a non-object body is a 400, as on the server. */
export declare function parsePayloadObject(plaintext: Bytes): Record<string, unknown>;
/** Rejects a payload whose `_endpointSlug` names a different route. An empty value is not a binding. */
export declare function assertPayloadSlug(payload: Readonly<Record<string, unknown>>, endpointSlug: string): void;
/** Drops identity and auth keys so endpoint code only sees caller data. */
export declare function withoutReservedKeys(payload: Readonly<Record<string, unknown>>): Record<string, unknown>;
