import { createNetworkStorageServer, type ServerOptions } from "../server/index.js";

// The minimal Hono context this adapter reads: the Fetch Request is on `c.req.raw`.
export interface HonoContextLike {
  req: { raw: Request };
}

// Hono route handler: app.all("/*", honoHandler(options)). Hono passes the untouched Request, which the server reads.
export function honoHandler(options: ServerOptions): (c: HonoContextLike) => Promise<Response> {
  const server = createNetworkStorageServer(options);
  return (c) => server.fetch(c.req.raw);
}
