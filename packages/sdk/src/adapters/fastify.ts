import type { IncomingMessage, ServerResponse } from "node:http";
import { createNetworkStorageServer, type ServerOptions } from "../server/index.js";
import { nodeHandler } from "./node.js";

// The subset of a Fastify request/reply this adapter uses. Hijacking hands the raw Node response to the server.
export interface FastifyRequestLike {
  raw: IncomingMessage;
}
export interface FastifyReplyLike {
  hijack(): void;
  raw: ServerResponse;
}

// Fastify route handler: fastify.all("/*", fastifyHandler(options)). The route must not parse the body first; the
// server reads the raw stream, so the body is never consumed twice.
export function fastifyHandler(
  options: ServerOptions,
): (request: FastifyRequestLike, reply: FastifyReplyLike) => Promise<void> {
  const handle = nodeHandler(createNetworkStorageServer(options));
  return async (request, reply) => {
    reply.hijack();
    await handle(request.raw, reply.raw);
  };
}
