import { isRecord } from "../util/guards.js";
// Mirrors server Compat/ClientIdentity.cs: a request is a library caller when it sends a
// non-blank x-ns-library-version, a recognised x-ns-client-type, or a body `security` object.
const LIBRARY_CLIENT_TYPES = { game: true, editor: true, dedicated: true };
export function parseClientType(raw) {
    const value = raw?.trim().toLowerCase() ?? "";
    return Object.hasOwn(LIBRARY_CLIENT_TYPES, value) ? value : null;
}
export function isLibraryCaller(headers, body) {
    if ((headers.get("x-ns-library-version") ?? "").trim() !== "")
        return true;
    if (parseClientType(headers.get("x-ns-client-type")) !== null)
        return true;
    return isRecord(body) && isRecord(body.security);
}
// Mirrors server Compat/LibraryErrorEnvelope.cs Build(). The wire status is always 200 for library
// callers; the real status travels in the body. Success bodies are never wrapped.
export function libraryErrorBody(input) {
    const error = {
        ...input.errorFields,
        code: input.code,
        message: input.message,
        requestId: input.requestId,
    };
    const body = {
        ok: false,
        status: input.status,
        error,
        message: input.message,
        _requestId: input.requestId,
    };
    if (input.security !== undefined) {
        error.security = input.security;
        body.security = input.security;
        body.retrySafe = true;
    }
    return body;
}
