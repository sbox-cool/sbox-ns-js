// FetchAddressRules so an endpoint that works here fails the same way on the engine.
export const FETCH_LIMITS = {
    maxRequestsPerExecution: 5,
    maxRequestBodyBytes: 64 * 1024,
    maxResponseBytes: 256 * 1024,
    defaultTimeoutMs: 5000,
    minTimeoutMs: 100,
    maxTimeoutMs: 10000,
    maxUrlLength: 2048,
    maxHeaders: 32,
    maxHeaderValueLength: 4096,
    maxRedirects: 5,
};
const METHODS = { GET: true, HEAD: true, POST: true, PUT: true, PATCH: true, DELETE: true };
const OPTION_KEYS = { method: true, headers: true, body: true, timeoutMs: true };
const FORBIDDEN_HEADERS = {
    host: true,
    "content-length": true,
    "transfer-encoding": true,
    connection: true,
    upgrade: true,
    expect: true,
    te: true,
    trailer: true,
    "keep-alive": true,
};
export class FetchError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "FetchError";
        this.code = code;
    }
}
export function parseFetchCall(rawUrl, rawOptions) {
    const url = parseUrl(rawUrl);
    const options = parseOptions(rawOptions);
    const method = parseMethod(options.method);
    const headers = parseHeaders(options.headers);
    const body = parseBody(options.body, method);
    if (body.contentType !== null && !headers.some(([name]) => name === "content-type")) {
        headers.push(["content-type", body.contentType]);
    }
    const timeoutMs = parseTimeout(options.timeoutMs);
    const key = JSON.stringify([method, url.href, headers, body.text]);
    return { key, host: normalizeHost(url.hostname), method, url: url.href, headers, body: body.text, timeoutMs };
}
function parseUrl(raw) {
    const message = "the URL must be an absolute http or https URL without credentials.";
    if (typeof raw !== "string" || raw.length > FETCH_LIMITS.maxUrlLength)
        throw invalid(message);
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        throw invalid(message);
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
        throw invalid(message);
    }
    return url;
}
function parseOptions(raw) {
    if (raw === undefined || raw === null)
        return {};
    if (typeof raw !== "object" || Array.isArray(raw))
        throw invalid("options must be an object.");
    const options = {};
    for (const [name, value] of Object.entries(raw)) {
        if (!Object.hasOwn(OPTION_KEYS, name))
            throw invalid(`the option "${name}" is not supported.`);
        options[name] = value;
    }
    return options;
}
function parseMethod(raw) {
    if (raw === undefined)
        return "GET";
    if (typeof raw !== "string")
        throw invalid("method must be a string.");
    const method = raw.toUpperCase();
    if (!Object.hasOwn(METHODS, method)) {
        throw invalid("method must be GET, HEAD, POST, PUT, PATCH or DELETE.");
    }
    return method;
}
function parseHeaders(raw) {
    if (raw === undefined || raw === null)
        return [];
    if (typeof raw !== "object" || Array.isArray(raw))
        throw invalid("headers must be an object of strings.");
    const entries = Object.entries(raw);
    if (entries.length > FETCH_LIMITS.maxHeaders) {
        throw invalid(`at most ${FETCH_LIMITS.maxHeaders} headers are allowed.`);
    }
    const headers = [];
    for (const [rawName, value] of entries) {
        if (typeof value !== "string")
            throw invalid(`the header "${rawName}" must be a string.`);
        const name = rawName.toLowerCase();
        if (Object.hasOwn(FORBIDDEN_HEADERS, name) || name.startsWith("proxy-")) {
            throw invalid(`the header "${rawName}" cannot be sent.`);
        }
        if (value.length > FETCH_LIMITS.maxHeaderValueLength || /[\r\n\0]/.test(value)) {
            throw invalid(`the header "${rawName}" is not a valid value.`);
        }
        headers.push([name, value]);
    }
    return headers;
}
function parseBody(raw, method) {
    if (raw === undefined || raw === null)
        return { text: null, contentType: null };
    if (method === "GET" || method === "HEAD")
        throw invalid(`a ${method} request cannot have a body.`);
    let text;
    let contentType = null;
    if (typeof raw === "string") {
        text = raw;
    }
    else if (typeof raw === "object") {
        text = JSON.stringify(raw);
        contentType = "application/json";
    }
    else {
        throw invalid("body must be a string, an object or an array.");
    }
    if (new TextEncoder().encode(text).byteLength > FETCH_LIMITS.maxRequestBodyBytes) {
        throw invalid(`the body is larger than ${FETCH_LIMITS.maxRequestBodyBytes / 1024} KiB.`);
    }
    return { text, contentType };
}
function parseTimeout(raw) {
    if (raw === undefined || raw === null)
        return FETCH_LIMITS.defaultTimeoutMs;
    if (typeof raw !== "number" || !Number.isFinite(raw))
        throw invalid("timeoutMs must be a number.");
    return Math.min(FETCH_LIMITS.maxTimeoutMs, Math.max(FETCH_LIMITS.minTimeoutMs, Math.trunc(raw)));
}
function invalid(detail) {
    return new FetchError("FETCH_INVALID_REQUEST", `ns.fetch: ${detail}`);
}
export function normalizeHost(raw) {
    let text = raw.trim().toLowerCase();
    if (text.length > 1 && text.startsWith("[") && text.endsWith("]"))
        text = text.slice(1, -1);
    return text.replace(/\.+$/, "");
}
export function isAllowedHost(host, entries) {
    for (const entry of entries) {
        if (entry.startsWith("*.")) {
            if (host.endsWith(entry.slice(1)))
                return true;
        }
        else if (host === entry) {
            return true;
        }
    }
    return false;
}
// Refusal for a host, checked at call time (as the server does) and on every redirect hop. Returns
// null when the host may be contacted.
export function refuseHost(host, policy) {
    const reason = blockedAddressReason(host);
    if (reason !== null)
        return blockedFailure(host, reason);
    if (!isAllowedHost(host, policy.allowedHosts))
        return blockedFailure(host, "host_not_allowed");
    return null;
}
export function blockedFailure(host, reason) {
    return { code: "FETCH_BLOCKED", message: blockedMessage(host, reason) };
}
function blockedMessage(host, reason) {
    if (reason === "host_not_allowed") {
        return `ns.fetch: "${host}" is not on this project's outbound allow-list.`;
    }
    if (reason === "metadata_address") {
        return `ns.fetch: "${host}" is a cloud metadata address, which is always blocked.`;
    }
    if (reason === "reserved_address") {
        return `ns.fetch: "${host}" resolves to a reserved address, which is blocked.`;
    }
    return `ns.fetch: "${host}" resolves to a private network address, which is blocked.`;
}
// IP literals are checked against the same ranges as the server's FetchAddressRules, with private
// networks always blocked. DNS names are not resolved here, because portable runtimes such as
// Workers cannot resolve them. The allow-list is the control for names.
export function blockedAddressReason(host) {
    const v4 = parseIpv4(host);
    if (v4 !== null)
        return blockedIpv4(v4);
    const v6 = parseIpv6(host);
    if (v6 === null)
        return null;
    if (isIpv4Mapped(v6))
        return blockedIpv4(quadAt(v6, 12));
    if (bytesEqual(v6, METADATA_V6))
        return "metadata_address";
    if (hasPrefix(v6, [0x00, 0x64, 0xff, 0x9b], 96))
        return blockedIpv4(quadAt(v6, 12));
    if (hasPrefix(v6, [0x20, 0x02], 16))
        return blockedIpv4(quadAt(v6, 2));
    if (isPrivateV6(v6))
        return "private_address";
    if (hasPrefix(v6, [], 96) || hasPrefix(v6, [0x01, 0x00], 64) || hasPrefix(v6, [0x20, 0x01, 0x0d, 0xb8], 32)) {
        return "reserved_address";
    }
    return v6[0] === 0xff ? "reserved_address" : null;
}
const METADATA_V6 = [0xfd, 0x00, 0x0e, 0xc2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x02, 0x54];
function isIpv4Mapped(bytes) {
    return hasPrefix(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96);
}
function quadAt(bytes, start) {
    return [bytes[start] ?? 0, bytes[start + 1] ?? 0, bytes[start + 2] ?? 0, bytes[start + 3] ?? 0];
}
function isPrivateV6(bytes) {
    const first = bytes[0] ?? 0;
    const second = bytes[1] ?? 0;
    if (bytesEqual(bytes, [...new Array(15).fill(0), 1]))
        return true;
    if ((first & 0xfe) === 0xfc)
        return true;
    return first === 0xfe && (second & 0xc0) !== 0 && (second & 0x80) === 0x80;
}
function blockedIpv4(octets) {
    const [a, b, c, d] = octets;
    if (a === 169 && b === 254 && ((c === 169 && d === 254) || (c === 170 && d === 2)))
        return "metadata_address";
    if (a === 100 && b === 100 && c === 100 && d === 200)
        return "metadata_address";
    if (a === 0)
        return "reserved_address";
    if (a === 192 && b === 0 && (c === 0 || c === 2))
        return "reserved_address";
    if (a === 198 && (b === 18 || b === 19))
        return "reserved_address";
    if (a === 198 && b === 51 && c === 100)
        return "reserved_address";
    if (a === 203 && b === 0 && c === 113)
        return "reserved_address";
    if (a >= 224)
        return "reserved_address";
    if (a === 10 || a === 127)
        return "private_address";
    if (a === 172 && b >= 16 && b <= 31)
        return "private_address";
    if (a === 192 && b === 168)
        return "private_address";
    if (a === 100 && b >= 64 && b <= 127)
        return "private_address";
    if (a === 169 && b === 254)
        return "private_address";
    return null;
}
function parseIpv4(host) {
    const parts = host.split(".");
    if (parts.length !== 4)
        return null;
    const octets = [];
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part))
            return null;
        const value = Number(part);
        if (value > 255)
            return null;
        octets.push(value);
    }
    const [a, b, c, d] = octets;
    if (a === undefined || b === undefined || c === undefined || d === undefined)
        return null;
    return [a, b, c, d];
}
function parseIpv6(host) {
    if (!host.includes(":"))
        return null;
    const pieces = host.split("::");
    if (pieces.length > 2)
        return null;
    const headText = pieces[0] ?? "";
    const tailText = pieces[1] ?? "";
    const head = headText === "" ? [] : headText.split(":");
    const tail = pieces.length === 2 && tailText !== "" ? tailText.split(":") : [];
    const given = head.length + tail.length;
    if (pieces.length === 1 && given !== 8)
        return null;
    if (pieces.length === 2 && given > 7)
        return null;
    const zeros = pieces.length === 2 ? 8 - given : 0;
    const hextets = [...head, ...new Array(zeros).fill("0"), ...tail];
    const bytes = [];
    for (const hextet of hextets) {
        if (!/^[0-9a-f]{1,4}$/.test(hextet))
            return null;
        const value = Number.parseInt(hextet, 16);
        bytes.push(value >> 8, value & 0xff);
    }
    return bytes.length === 16 ? bytes : null;
}
function hasPrefix(bytes, prefix, bits) {
    const fullBytes = bits >> 3;
    for (let i = 0; i < fullBytes; i += 1) {
        const expected = i < prefix.length ? prefix[i] : 0;
        if (bytes[i] !== expected)
            return false;
    }
    return true;
}
function bytesEqual(a, b) {
    return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
// Performs one outbound request with manual redirects. Every hop is checked against the host policy
// and address rules. Caller headers are dropped when a redirect crosses origins. A 301 or 302 from
// POST, and any 303, switch to GET without a body, as fetch does.
export async function sendFetch(call, policy) {
    let url = call.url;
    let method = call.method;
    let body = call.body;
    let headers = call.headers;
    const origin = new URL(call.url).origin;
    const signal = AbortSignal.timeout(call.timeoutMs);
    try {
        for (let hop = 0;; hop += 1) {
            const target = new URL(url);
            const refusal = refuseHost(normalizeHost(target.hostname), policy);
            if (refusal !== null)
                return { response: null, failure: refusal };
            const response = await fetch(url, { method, headers, body, redirect: "manual", signal });
            const location = response.headers.get("location");
            if (!isRedirect(response.status) || location === null) {
                return await readOutcome(response, call.host);
            }
            await response.body?.cancel();
            if (hop >= FETCH_LIMITS.maxRedirects) {
                return { response: null, failure: { code: "FETCH_FAILED", message: failedMessage(call.host) } };
            }
            const next = new URL(location, url).href;
            if (new URL(next).origin !== origin)
                headers = [];
            if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
                method = "GET";
                body = null;
            }
            url = next;
        }
    }
    catch (error) {
        return { response: null, failure: failureFor(error, call.host) };
    }
}
function isRedirect(status) {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
async function readOutcome(response, host) {
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > FETCH_LIMITS.maxResponseBytes) {
        await response.body?.cancel();
        return { response: null, failure: tooLarge(host) };
    }
    const bytes = await readCapped(response);
    if (bytes === null)
        return { response: null, failure: tooLarge(host) };
    const text = new TextDecoder().decode(bytes);
    return {
        response: {
            status: response.status,
            ok: response.status >= 200 && response.status <= 299,
            headers: headerRecord(response.headers),
            body: text,
            json: parseJson(text),
        },
        failure: null,
    };
}
async function readCapped(response) {
    if (response.body === null)
        return new Uint8Array(0);
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const next = await reader.read();
        if (next.done)
            break;
        total += next.value.byteLength;
        if (total > FETCH_LIMITS.maxResponseBytes) {
            await reader.cancel();
            return null;
        }
        chunks.push(next.value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}
// Duplicate header names are joined with ", " as the server does. Names are lowercased by Headers.
function headerRecord(headers) {
    const merged = new Map();
    headers.forEach((value, name) => {
        const existing = merged.get(name);
        merged.set(name, existing === undefined ? value : `${existing}, ${value}`);
    });
    return Object.fromEntries(merged);
}
function parseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
function tooLarge(host) {
    return {
        code: "FETCH_RESPONSE_TOO_LARGE",
        message: `ns.fetch: the response from "${host}" is larger than ${FETCH_LIMITS.maxResponseBytes / 1024} KiB.`,
    };
}
function failedMessage(host) {
    return `ns.fetch: the request to "${host}" failed.`;
}
function failureFor(error, host) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        return { code: "FETCH_TIMEOUT", message: `ns.fetch: the request to "${host}" timed out.` };
    }
    return { code: "FETCH_FAILED", message: failedMessage(host) };
}
