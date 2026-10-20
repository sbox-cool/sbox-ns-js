import { handleAuthSession, type AuthSessionOp } from "./auth-routes.js";
import { handleManage } from "./manage-routes.js";
import { createServerContext, type ServerContext } from "./context.js";
import { handleEndpoint } from "./endpoints.js";
import { describeError, errorResponse, pathSegment } from "./http.js";
import { handleQuery } from "./query-routes.js";
import { handleSecurityConfig, handleValues } from "./public-routes.js";
import { handleStorage, rateLimitsResponse } from "./storage-routes.js";
import type { ServerOptions } from "./options.js";
import { jsonResponse } from "../util/http.js";

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

interface SplitRoute {
  readonly family: string | undefined;
  readonly project: string | undefined;
  readonly rest: readonly string[];
}

// /v1/{family}/{project}/..., /v3/{family}/{project}/..., and /api/{family}/{project}/... share one shape.
// /pages/{project}/... is the pages alias.
function splitRoute(parts: readonly string[]): SplitRoute | null {
  const first = parts[0];
  if (first === "v1" || first === "v3" || first === "api") {
    return { family: parts[1], project: parts[2], rest: parts.slice(3) };
  }
  if (first === "pages") return { family: "pages", project: parts[1], rest: parts.slice(2) };
  return null;
}

const NOT_FOUND = { status: 404, code: "ROUTE_NOT_FOUND", message: "No route matches this path." } as const;

async function route(ctx: ServerContext, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  const split = splitRoute(parts);
  if (split === null || split.family === undefined || split.project === undefined) return errorResponse(NOT_FOUND);
  const { family, project, rest } = split;

  // Deploy probe: answers for any project, before the project check.
  if (family === "storage" && project === "deploy-canary" && rest[0] === "ping") {
    return jsonResponse({ ok: true, owner: "@sbox-ns/sdk", probe: "deploy-canary" });
  }
  if (project !== ctx.options.projectId) {
    return errorResponse({ status: 404, code: "PROJECT_NOT_FOUND", message: "No project matches this path." });
  }
  const method = request.method;

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
  if (family === "storage") return handleStorage(ctx, request, url, rest, parts[0]!);
  if (family === "queries" && rest.length === 1 && rest[0] !== undefined && method === "GET") {
    return handleQuery(ctx, request, url, pathSegment(rest[0]));
  }
  if (family === "rate-limits" && rest.length === 0 && method === "GET") return rateLimitsResponse(ctx);
  if (family === "manage") return handleManage(ctx, request, url, rest);
  return errorResponse(NOT_FOUND);
}

function methodNotAllowed(): Response {
  return errorResponse({ status: 405, code: "METHOD_NOT_ALLOWED", message: "This method is not allowed here." });
}
