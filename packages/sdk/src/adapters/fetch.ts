import { createNetworkStorageServer, type NetworkStorageServer, type ServerOptions } from "../server/index.js";

// The Fetch-style handler for runtimes that call `(request) => Response`: Cloudflare Workers, Bun, Deno, and Node
// 18+ with a Fetch server. The handler owns no state beyond what `options` supplies.
export function fetchHandler(options: ServerOptions): (request: Request) => Promise<Response> {
  const server: NetworkStorageServer = createNetworkStorageServer(options);
  return (request) => server.fetch(request);
}
