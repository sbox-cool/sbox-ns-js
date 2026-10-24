import { jsonResponse } from "../util/http.js";
import type { ServerContext } from "./context.js";
import { KeyRefusal } from "./auth-failure.js";
import { publicValuesOf } from "./catalog.js";
import { targetsNext } from "./publish-target.js";
import { safeEqual } from "./http.js";

// GET /{v}/security-config/{project}. Public: the game fetches it before it has any secret. The reference wraps the
// signed config under `config`, marks its source, and caches it unless `refresh=1` bypasses the cache.
export async function handleSecurityConfig(ctx: ServerContext, url: URL): Promise<Response> {
  const refresh = url.searchParams.get("refresh") === "1";
  const config = await ctx.config.current(ctx.now(), refresh);
  const cacheHeaders = refresh
    ? { "cache-control": "no-store, max-age=0", "x-security-config-cache": "bypass" }
    : { "cache-control": "public, max-age=15, s-maxage=60", "x-security-config-cache": "public" };
  return jsonResponse({ config, ok: true, source: "store" }, 200, {
    ...cacheHeaders,
    "x-security-config-source": "store",
    "x-security-config-version": config.configVersion,
  });
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
