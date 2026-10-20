// Limits and messages mirror the sbox-network-storage server's ScriptFetchSession and
import type { Bytes } from "../util/bytes.js";
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
} as const;

const METHODS: Record<string, true> = { GET: true, HEAD: true, POST: true, PUT: true, PATCH: true, DELETE: true };
const OPTION_KEYS: Record<string, true> = { method: true, headers: true, body: true, timeoutMs: true };
const FORBIDDEN_HEADERS: Record<string, true> = {
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
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FetchError";
    this.code = code;
  }
}

export interface FetchPolicy {
  // Exact hosts ("api.example.com"), wildcards for subdomains ("*.example.com", never the apex),
  // or IP literals. Empty means every request is refused.
  allowedHosts: readonly string[];
  // Resolves a DNS name to its addresses. Every hop's addresses are checked against the private,
  // loopback, link-local and metadata ranges before the request is sent. Required: without it a
  // DNS name could resolve to an internal address. See the README for the residual TOCTOU window.
  resolveHost: (host: string) => Promise<readonly string[]>;
}

export interface ParsedFetch {
  key: string;
  host: string;
  method: string;
  url: string;
  headers: [string, string][];
  body: string | null;
  timeoutMs: number;
}

export interface FetchFailure {
  code: string;
  message: string;
}

export interface FetchOutcome {
  response: FetchResponseData | null;
  failure: FetchFailure | null;
}

export interface FetchResponseData {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
  json: unknown;
}

export function parseFetchCall(rawUrl: unknown, rawOptions: unknown): ParsedFetch {
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

function parseUrl(raw: unknown): URL {
  const message = "the URL must be an absolute http or https URL without credentials.";
  if (typeof raw !== "string" || raw.length > FETCH_LIMITS.maxUrlLength) throw invalid(message);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid(message);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
    throw invalid(message);
  }
  return url;
}

function parseOptions(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid("options must be an object.");
  const options: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!Object.hasOwn(OPTION_KEYS, name)) throw invalid(`the option "${name}" is not supported.`);
    options[name] = value;
  }
  return options;
}

function parseMethod(raw: unknown): string {
  if (raw === undefined) return "GET";
  if (typeof raw !== "string") throw invalid("method must be a string.");
  const method = raw.toUpperCase();
  if (!Object.hasOwn(METHODS, method)) {
    throw invalid("method must be GET, HEAD, POST, PUT, PATCH or DELETE.");
  }
  return method;
}

function parseHeaders(raw: unknown): [string, string][] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid("headers must be an object of strings.");
  const entries = Object.entries(raw);
  if (entries.length > FETCH_LIMITS.maxHeaders) {
    throw invalid(`at most ${FETCH_LIMITS.maxHeaders} headers are allowed.`);
  }
  const headers: [string, string][] = [];
  for (const [rawName, value] of entries) {
    if (typeof value !== "string") throw invalid(`the header "${rawName}" must be a string.`);
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

function parseBody(raw: unknown, method: string): { text: string | null; contentType: string | null } {
  if (raw === undefined || raw === null) return { text: null, contentType: null };
  if (method === "GET" || method === "HEAD") throw invalid(`a ${method} request cannot have a body.`);
  let text: string;
  let contentType: string | null = null;
  if (typeof raw === "string") {
    text = raw;
  } else if (typeof raw === "object") {
    text = JSON.stringify(raw);
    contentType = "application/json";
  } else {
    throw invalid("body must be a string, an object or an array.");
  }
  if (new TextEncoder().encode(text).byteLength > FETCH_LIMITS.maxRequestBodyBytes) {
    throw invalid(`the body is larger than ${FETCH_LIMITS.maxRequestBodyBytes / 1024} KiB.`);
  }
  return { text, contentType };
}

function parseTimeout(raw: unknown): number {
  if (raw === undefined || raw === null) return FETCH_LIMITS.defaultTimeoutMs;
  if (typeof raw !== "number" || !Number.isFinite(raw)) throw invalid("timeoutMs must be a number.");
  return Math.min(FETCH_LIMITS.maxTimeoutMs, Math.max(FETCH_LIMITS.minTimeoutMs, Math.trunc(raw)));
}

function invalid(detail: string): FetchError {
  return new FetchError("FETCH_INVALID_REQUEST", `ns.fetch: ${detail}`);
}

export function normalizeHost(raw: string): string {
  let text = raw.trim().toLowerCase();
  if (text.length > 1 && text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  return text.replace(/\.+$/, "");
}

// True for IPv4 dotted quads and IPv6 literals (normalizeHost has already stripped brackets).
export function isIpLiteral(host: string): boolean {
  return host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

export function isAllowedHost(host: string, entries: readonly string[]): boolean {
  for (const entry of entries) {
    if (entry.startsWith("*.")) {
      if (host.endsWith(entry.slice(1))) return true;
    } else if (host === entry) {
      return true;
    }
  }
  return false;
}

// Refusal for a host, checked at call time (as the server does) and on every redirect hop. Returns
// null when the host may be contacted.
export function refuseHost(host: string, policy: FetchPolicy): FetchFailure | null {
  const reason = blockedAddressReason(host);
  if (reason !== null) return blockedFailure(host, reason);
  if (!isAllowedHost(host, policy.allowedHosts)) return blockedFailure(host, "host_not_allowed");
  return null;
}

export function blockedFailure(host: string, reason: string): FetchFailure {
  return { code: "FETCH_BLOCKED", message: blockedMessage(host, reason) };
}

function blockedMessage(host: string, reason: string): string {
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
export function blockedAddressReason(host: string): string | null {
  const v4 = parseIpv4(host);
  if (v4 !== null) return blockedIpv4(v4);
  const v6 = parseIpv6(host);
  if (v6 === null) return null;
  if (isIpv4Mapped(v6)) return blockedIpv4(quadAt(v6, 12));
  if (bytesEqual(v6, METADATA_V6)) return "metadata_address";
  if (hasPrefix(v6, [0x00, 0x64, 0xff, 0x9b], 96)) return blockedIpv4(quadAt(v6, 12));
  if (hasPrefix(v6, [0x20, 0x02], 16)) return blockedIpv4(quadAt(v6, 2));
  if (isPrivateV6(v6)) return "private_address";
  if (hasPrefix(v6, [], 96) || hasPrefix(v6, [0x01, 0x00], 64) || hasPrefix(v6, [0x20, 0x01, 0x0d, 0xb8], 32)) {
    return "reserved_address";
  }
  return v6[0] === 0xff ? "reserved_address" : null;
}

const METADATA_V6 = [0xfd, 0x00, 0x0e, 0xc2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x02, 0x54];

type Quad = [number, number, number, number];

function isIpv4Mapped(bytes: number[]): boolean {
  return hasPrefix(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96);
}

function quadAt(bytes: number[], start: number): Quad {
  return [bytes[start] ?? 0, bytes[start + 1] ?? 0, bytes[start + 2] ?? 0, bytes[start + 3] ?? 0];
}

function isPrivateV6(bytes: number[]): boolean {
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  if (bytesEqual(bytes, [...new Array<number>(15).fill(0), 1])) return true;
  if ((first & 0xfe) === 0xfc) return true;
  return first === 0xfe && (second & 0xc0) !== 0 && (second & 0x80) === 0x80;
}

function blockedIpv4(octets: Quad): string | null {
  const [a, b, c, d] = octets;
  if (a === 169 && b === 254 && ((c === 169 && d === 254) || (c === 170 && d === 2))) return "metadata_address";
  if (a === 100 && b === 100 && c === 100 && d === 200) return "metadata_address";
  if (a === 0) return "reserved_address";
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return "reserved_address";
  if (a === 198 && (b === 18 || b === 19)) return "reserved_address";
  if (a === 198 && b === 51 && c === 100) return "reserved_address";
  if (a === 203 && b === 0 && c === 113) return "reserved_address";
  if (a >= 224) return "reserved_address";
  if (a === 10 || a === 127) return "private_address";
  if (a === 172 && b >= 16 && b <= 31) return "private_address";
  if (a === 192 && b === 168) return "private_address";
  if (a === 100 && b >= 64 && b <= 127) return "private_address";
  if (a === 169 && b === 254) return "private_address";
  return null;
}

function parseIpv4(host: string): Quad | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  const [a, b, c, d] = octets;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  return [a, b, c, d];
}

function parseIpv6(host: string): number[] | null {
  if (!host.includes(":")) return null;
  const pieces = host.split("::");
  if (pieces.length > 2) return null;
  const headText = pieces[0] ?? "";
  const tailText = pieces[1] ?? "";
  const head = headText === "" ? [] : headText.split(":");
  const tail = pieces.length === 2 && tailText !== "" ? tailText.split(":") : [];
  const given = head.length + tail.length;
  if (pieces.length === 1 && given !== 8) return null;
  if (pieces.length === 2 && given > 7) return null;
  const zeros = pieces.length === 2 ? 8 - given : 0;
  const hextets = [...head, ...new Array<string>(zeros).fill("0"), ...tail];
  const bytes: number[] = [];
  for (const hextet of hextets) {
    if (!/^[0-9a-f]{1,4}$/.test(hextet)) return null;
    const value = Number.parseInt(hextet, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

function hasPrefix(bytes: number[], prefix: number[], bits: number): boolean {
  const fullBytes = bits >> 3;
  for (let i = 0; i < fullBytes; i += 1) {
    const expected = i < prefix.length ? prefix[i] : 0;
    if (bytes[i] !== expected) return false;
  }
  return true;
}

function bytesEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

// Performs one outbound request with manual redirects. Every hop is checked against the host policy
// and address rules. Caller headers are dropped when a redirect crosses origins. A 301 or 302 from
// POST, and any 303, switch to GET without a body, as fetch does.
export async function sendFetch(call: ParsedFetch, policy: FetchPolicy, cancel?: AbortSignal): Promise<FetchOutcome> {
  let url = call.url;
  let method = call.method;
  let body = call.body;
  let headers = call.headers;
  const origin = new URL(call.url).origin;
  const timeout = AbortSignal.timeout(call.timeoutMs);
  const signal = cancel === undefined ? timeout : AbortSignal.any([timeout, cancel]);
  try {
    for (let hop = 0; ; hop += 1) {
      const target = new URL(url);
      const host = normalizeHost(target.hostname);
      const refusal = refuseHost(host, policy);
      if (refusal !== null) return { response: null, failure: refusal };
      if (!isIpLiteral(host)) {
        const addresses = await policy.resolveHost(host);
        if (addresses.length === 0) return { response: null, failure: blockedFailure(call.host, "dns_no_addresses") };
        for (const address of addresses) {
          const reason = blockedAddressReason(address);
          if (reason !== null) return { response: null, failure: blockedFailure(call.host, reason) };
        }
      }
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
      if (new URL(next).origin !== origin) headers = [];
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET";
        body = null;
      }
      url = next;
    }
  } catch (error) {
    return { response: null, failure: failureFor(error, call.host) };
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readOutcome(response: Response, host: string): Promise<FetchOutcome> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > FETCH_LIMITS.maxResponseBytes) {
    await response.body?.cancel();
    return { response: null, failure: tooLarge(host) };
  }
  const bytes = await readCapped(response);
  if (bytes === null) return { response: null, failure: tooLarge(host) };
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

async function readCapped(response: Response): Promise<Bytes | null> {
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Bytes[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
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
function headerRecord(headers: Headers): Record<string, string> {
  const merged = new Map<string, string>();
  headers.forEach((value, name) => {
    const existing = merged.get(name);
    merged.set(name, existing === undefined ? value : `${existing}, ${value}`);
  });
  return Object.fromEntries(merged);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function tooLarge(host: string): FetchFailure {
  return {
    code: "FETCH_RESPONSE_TOO_LARGE",
    message: `ns.fetch: the response from "${host}" is larger than ${FETCH_LIMITS.maxResponseBytes / 1024} KiB.`,
  };
}

function failedMessage(host: string): string {
  return `ns.fetch: the request to "${host}" failed.`;
}

function failureFor(error: unknown, host: string): FetchFailure {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return { code: "FETCH_TIMEOUT", message: `ns.fetch: the request to "${host}" timed out.` };
  }
  return { code: "FETCH_FAILED", message: failedMessage(host) };
}
