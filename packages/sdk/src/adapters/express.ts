import type { IncomingMessage, ServerResponse } from "node:http";
import { createNetworkStorageServer, type ServerOptions } from "../server/index.js";
import { nodeHandler } from "./node.js";

// Express middleware: mount it on the path the project's routes live under, for example app.use(expressHandler(options)).
// Express reads the raw body only when this handler does, so do not register a body parser ahead of it.
export function expressHandler(options: ServerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return nodeHandler(createNetworkStorageServer(options));
}
