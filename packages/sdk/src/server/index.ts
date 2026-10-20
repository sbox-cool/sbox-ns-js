import { handleAuthSession, type AuthSessionOp } from "./auth-routes.js";
import { createServerContext, type ServerContext } from "./context.js";
import { handleEndpoint } from "./endpoints.js";
import { describeError, errorResponse } from "./http.js";
import { handleSecurityConfig, handleValues } from "./public-routes.js";
import type { ServerOptions } from "./options.js";

export type { ServerOptions, SessionRevocations, ValuesDocument } from "./options.js";

export interface NetworkStorageServer {
  fetch(request: Request): Promise<Response>;
}

// Builds the network-storage HTTP surface over the Fetch API. The result runs on any runtime that has Request and
// Response, and the adapters wrap it for Node, Express, Hono, and Fastify.
export function createNetworkStorageServer(options: ServerOptions): NetworkStorageServer {
  const ctx = createServerContext(options);
  return {
    async fetch(request: Request): Promise<Response> {
      try {
        return await route(ctx, request);
      } catch (error) {
        return errorResponse(describeError(error));
      }
    },
  };
}

const AUTH_OPS: Readonly<Record<string, AuthSessionOp>> = {
  create: "create",
  refresh: "refresh",
  reauth: "reauth",
  revoke: "revoke",
};

// v3 families the SDK does not serve yet. They answer 501 so clients never mistake them for a missing route.
const UNBUILT_FAMILIES: Readonly<Record<string, true>> = {
  storage: true,
  queries: true,
  "game-logs": true,
  media: true,
  "server-info": true,
  manage: true,
  pages: true,
};

async function route(ctx: ServerContext, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  const version = parts[0];
  if (version !== "v1" && version !== "v3") {
    return errorResponse({ status: 404, code: "ROUTE_NOT_FOUND", message: "No route matches this path." });
  }
  const family = parts[1];
  const project = parts[2];
  if (project === undefined) {
    return errorResponse({ status: 404, code: "ROUTE_NOT_FOUND", message: "No route matches this path." });
  }
  if (project !== ctx.options.projectId) {
    return errorResponse({ status: 404, code: "PROJECT_NOT_FOUND", message: "No project matches this path." });
  }
  const method = request.method;
  const rest = parts.slice(3);

  if (family === "security-config" && rest.length === 0 && method === "GET") {
    return handleSecurityConfig(ctx, url);
  }
  if (family === "values" && rest.length === 0 && method === "GET") {
    return handleValues(ctx, request);
  }
  if (family === "endpoints") {
    if (method !== "GET" && method !== "POST") return methodNotAllowed();
    if (rest.length === 0) return handleEndpoint(ctx, request, url, null);
    if (rest.length === 1) return handleEndpoint(ctx, request, url, rest[0]!);
  }
  if (family === "auth-sessions" && rest.length === 1 && method === "POST") {
    const op = AUTH_OPS[rest[0]!];
    if (op !== undefined) return handleAuthSession(ctx, request, url, op);
  }
  if (family === "sessions" && rest.length === 1 && rest[0] === "refresh" && method === "POST") {
    return handleAuthSession(ctx, request, url, "refresh");
  }
  if (family !== undefined && Object.hasOwn(UNBUILT_FAMILIES, family)) {
    return errorResponse({ status: 501, code: "ROUTE_NOT_IMPLEMENTED", message: "This route family is not implemented by @sbox-ns/sdk yet." });
  }
  return errorResponse({ status: 404, code: "ROUTE_NOT_FOUND", message: "No route matches this path." });
}

function methodNotAllowed(): Response {
  return errorResponse({ status: 405, code: "METHOD_NOT_ALLOWED", message: "This method is not allowed here." });
}
