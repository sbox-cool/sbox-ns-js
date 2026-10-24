import { isRecord } from "../util/guards.js";

// Resolves a host name to its addresses over DNS-over-HTTPS. Used where `node:dns` is unavailable, such as Workers.
// The answer is checked by the fetch policy, which refuses private, loopback, and metadata addresses.
export const DEFAULT_DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

// DNS record types for IPv4 and IPv6 addresses.
const RECORD_TYPE_A = 1;
const RECORD_TYPE_AAAA = 28;

// Builds a resolver for `resolveHost`. A failed query throws; an empty answer returns an empty list, which the
// fetch check refuses as `dns_no_addresses`.
export function dohResolver(endpoint: string = DEFAULT_DOH_ENDPOINT): (host: string) => Promise<readonly string[]> {
  return async (host) => {
    const [v4, v6] = await Promise.all([query(endpoint, host, "A"), query(endpoint, host, "AAAA")]);
    return [...v4, ...v6];
  };
}

async function query(endpoint: string, host: string, type: "A" | "AAAA"): Promise<string[]> {
  const url = new URL(endpoint);
  url.searchParams.set("name", host);
  url.searchParams.set("type", type);
  const response = await fetch(url, { headers: { accept: "application/dns-json" } });
  if (!response.ok) {
    throw new Error(`DNS-over-HTTPS query for ${type} ${host} failed with HTTP ${response.status}.`);
  }
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.Status !== "number") {
    throw new Error(`DNS-over-HTTPS answer for ${type} ${host} is malformed.`);
  }
  if (body.Status !== 0) return [];
  const wanted = type === "A" ? RECORD_TYPE_A : RECORD_TYPE_AAAA;
  const answers = Array.isArray(body.Answer) ? body.Answer : [];
  const addresses: string[] = [];
  for (const answer of answers) {
    if (isRecord(answer) && answer.type === wanted && typeof answer.data === "string") addresses.push(answer.data);
  }
  return addresses;
}
