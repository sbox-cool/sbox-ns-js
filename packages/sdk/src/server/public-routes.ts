import { jsonResponse } from "../util/http.js";
import type { ServerContext } from "./context.js";
import { errorResponse, safeEqual } from "./http.js";

// GET /{v}/security-config/{project}. Public: the game fetches it before it has any secret.
export async function handleSecurityConfig(ctx: ServerContext, url: URL): Promise<Response> {
  const refresh = url.searchParams.get("refresh") === "1";
  const config = await ctx.config.current(ctx.now(), refresh);
  return jsonResponse(config, 200);
}

// GET /{v}/values/{project}. Needs the public key, so game values are not handed to anonymous callers.
export function handleValues(ctx: ServerContext, request: Request): Response {
  const key = request.headers.get("x-public-key") ?? request.headers.get("x-api-key") ?? "";
  if (!safeEqual(key, ctx.options.publicKey)) {
    return errorResponse({ status: 401, code: "UNAUTHORIZED", message: "The request has no valid public key." });
  }
  const values = ctx.options.values ?? { groups: {}, tables: {} };
  return jsonResponse({ groups: values.groups, tables: values.tables }, 200);
}
