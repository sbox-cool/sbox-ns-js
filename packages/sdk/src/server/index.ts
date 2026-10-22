import { handleAuthSession, type AuthSessionOp } from "./auth-routes.js";
import { handleManage } from "./manage-routes.js";
import { createServerContext, type ServerContext } from "./context.js";
import { handleEndpoint } from "./endpoints.js";
import { describeError, errorResponse, pathSegment } from "./http.js";
import { handleQuery } from "./query-routes.js";
import { handleSecurityConfig, handleValues } from "./public-routes.js";
import { handleStorage, rateLimitsResponse } from "./storage-routes.js";
import { KeyRefusal, keyFailureResponse, UnknownRoute, type KeyFamily } from "./auth-failure.js";
import { jsonResponse } from "../util/http.js";
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
        if (error instanceof KeyRefusal) return keyFailureResponse(familyOf(request), request, new URL(request.url));
        if (error instanceof UnknownRoute) return unknownRouteResponse(error.detail);
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

const ROUTE_NOT_RECOGNIZED = "This Network Storage route is not recognized. All /v3/ and /v1/ traffic is served by ASP.NET Core + Store.";
const STORAGE_NEEDS_PROJECT = "Network Storage v3 endpoints require a project id.";

// Capabilities this server implements. Add a name only when its behaviour is complete.
const SERVER_CAPABILITIES = ["library-error-envelope", "management-sync-jobs"] as const;

async function route(ctx: ServerContext, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  // Capability discovery. Lists only what this server implements; clients gate behaviour on these names.
  if (parts.length === 2 && parts[0] === "v3" && parts[1] === "server-info" && request.method === "GET") {
    return jsonResponse({ capabilities: SERVER_CAPABILITIES, api: { root: "/api", aliases: ["/v3", "/v1"] } });
  }
  const split = splitRoute(parts);
  if (split === null || split.family === undefined) return unknownRouteResponse(ROUTE_NOT_RECOGNIZED);
  if (split.project === undefined) {
    return unknownRouteResponse(split.family === "storage" ? STORAGE_NEEDS_PROJECT : ROUTE_NOT_RECOGNIZED);
  }
  const { family, project, rest } = split;
  const method = request.method;

  // Deploy probe: answers for any project, before the project check.
  if (family === "storage" && project === "deploy-canary" && rest[0] === "ping") {
    return jsonResponse({ ok: true, owner: "@sbox-ns/sdk", probe: "deploy-canary" }, 200, { "cache-control": "no-store" });
  }
  if (family === "security-config" && rest.length === 0 && method === "GET" && project !== ctx.options.projectId) {
    return securityConfigMissing(project);
  }
  if (project !== ctx.options.projectId) {
    if (family === "pages") return pagesNotFound();
    throw new KeyRefusal();
  }

  if (family === "security-config" && rest.length === 0 && method === "GET") {
    return handleSecurityConfig(ctx, url);
  }
  if (family === "values" && rest.length === 0 && method === "GET") {
    return handleValues(ctx, request, url);
  }
  if (family === "endpoints") {
    if (method !== "GET" && method !== "POST") return methodNotAllowed();
    if (rest.length === 0) return handleEndpoint(ctx, request, url, null);
    if (rest.length === 1) return handleEndpoint(ctx, request, url, pathSegment(rest[0]!));
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
  if (family === "pages") return pagesNotFound();
  return unknownRouteResponse(ROUTE_NOT_RECOGNIZED);
}

function methodNotAllowed(): Response {
  return errorResponse({ status: 405, code: "METHOD_NOT_ALLOWED", message: "This method is not allowed here." });
}

// Route-level misses use the flat envelope the reference returns for unrecognised paths (ok, error, detail).
function unknownRouteResponse(detail: string): Response {
  return jsonResponse({ detail, error: "NOT_FOUND", ok: false }, 404);
}

// Security config is the one public route with its own missing-project answer: the reference reports the project
// metadata as missing rather than rejecting a key.
function securityConfigMissing(projectId: string): Response {
  return jsonResponse(
    {
      error: {
        code: "SECURITY_CONFIG_NOT_FOUND",
        message: "Security config is unavailable because the project metadata was not found.",
      },
      ok: false,
      projectId,
      source: "missing",
    },
    404,
    {
      "cache-control": "public, max-age=15, s-maxage=60",
      "x-security-config-cache": "public",
      "x-security-config-source": "missing",
    },
  );
}

// The pages family answers any page of a project with no published page as "Project not found." (reference corpus
// 'runtime-pages'). The page content itself is not part of this server.
function pagesNotFound(): Response {
  return jsonResponse({ error: { code: "NOT_FOUND", message: "Project not found." } }, 404);
}

function familyOf(request: Request): KeyFamily {
  const parts = new URL(request.url).pathname.split("/").filter((part) => part.length > 0);
  const family = splitRoute(parts)?.family;
  switch (family) {
    case "manage":
    case "storage":
    case "values":
    case "queries":
    case "endpoints":
      return family;
    default:
      return "other";
  }
}
