import { jsonResponse } from "../util/http.js";
import type { ServerContext } from "./context.js";
import { KeyRefusal } from "./auth-failure.js";
import { publicValuesOf } from "./catalog.js";
import { targetsNext } from "./publish-target.js";
import { safeEqual } from "./http.js";

// GET /{v}/security-config/{project}. Public: the game fetches it before it has any secret.
export async function handleSecurityConfig(ctx: ServerContext, url: URL): Promise<Response> {
  const refresh = url.searchParams.get("refresh") === "1";
  const config = await ctx.config.current(ctx.now(), refresh);
  return jsonResponse(config, 200);
}

// GET /{v}/values/{project}. Needs the public key, so game values are not handed to anonymous callers.
export function handleValues(ctx: ServerContext, request: Request, url: URL): Response {
  const key = request.headers.get("x-public-key") ?? request.headers.get("x-api-key") ?? "";
  if (!safeEqual(key, ctx.options.publicKey)) {
    throw new KeyRefusal();
  }
  const values = publicValuesOf(ctx.view(targetsNext(request, url)).catalog, ctx.options.values);
  // The reference reports no values version or update time for a project synced from the editor.
  return jsonResponse({ groups: values.groups, tables: values.tables, updatedAt: null, version: null }, 200);
}
