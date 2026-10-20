import { lookup } from "node:dns/promises";
import type { FetchPolicy } from "../endpoint/fetch.js";

// Resolves a host with the operating system resolver, every address the name maps to, IPv4 and IPv6.
export async function nodeResolveHost(host: string): Promise<readonly string[]> {
  const records = await lookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

// The fetch policy for Node: the allow-listed hosts plus the system resolver. Requests check every resolved
// address before connecting, but the connection itself is made by Node's fetch, so a DNS change between that check
// and the connect is not pinned. The README documents this limit.
export function nodeFetchPolicy(allowedHosts: readonly string[]): FetchPolicy {
  return { allowedHosts, resolveHost: nodeResolveHost };
}

export { nodeHandler } from "../adapters/node.js";
