import { ProtocolError } from "../protocol/errors.js";
import type { RecordData } from "../storage/types.js";
import { isRecord } from "../util/guards.js";
import { jsonResponse } from "../util/http.js";
import type { ServerContext } from "./context.js";
import { authorize } from "./endpoints.js";

// Queries are named reads over one collection. The runtime runs them on the server, so collection access rules
// do not apply; a query marked requiresSecretKey needs the secret.

export interface QueryDefinition {
  readonly id: string;
  readonly name: string;
  readonly type: "leaderboard" | "count";
  readonly requiresSecretKey: boolean;
  readonly collectionId: string;
  readonly field: string | null;
  readonly order: "asc" | "desc";
  readonly limit: number;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 1000;

// Validates one editor query record. Throws a plain Error with the reason; the caller decides how to report it.
export function parseQuery(value: unknown): QueryDefinition {
  if (!isRecord(value)) throw new Error("Each query must be an object.");
  const id = typeof value["id"] === "string" && value["id"] !== "" ? value["id"] : null;
  if (id === null) throw new Error("Each query must have an id.");
  const type = value["type"];
  if (type !== "leaderboard" && type !== "count") throw new Error(`Query "${id}" has an unknown type.`);
  const sources = value["sources"];
  const first = Array.isArray(sources) ? sources[0] : undefined;
  const collectionId = isRecord(first) && typeof first["collectionId"] === "string" ? first["collectionId"] : "";
  if (collectionId === "") throw new Error(`Query "${id}" needs a source collection.`);
  const config = isRecord(value["config"]) ? value["config"] : {};
  const field = typeof config["field"] === "string" && config["field"] !== "" ? config["field"] : null;
  if (type === "leaderboard" && field === null) throw new Error(`Leaderboard query "${id}" needs config.field.`);
  const configuredLimit = config["limit"];
  const limit =
    typeof configuredLimit === "number" && configuredLimit >= 1
      ? Math.min(Math.floor(configuredLimit), MAX_LIMIT)
      : DEFAULT_LIMIT;
  return {
    id,
    name: typeof value["name"] === "string" && value["name"] !== "" ? value["name"] : id,
    type,
    requiresSecretKey: value["requiresSecretKey"] === true,
    collectionId,
    field,
    order: config["order"] === "asc" ? "asc" : "desc",
    limit,
  };
}

// Reads a dotted path such as "ores.stone" from a record. Only finite numbers rank.
function numberAt(data: RecordData, path: string): number | null {
  let current: unknown = data;
  for (const part of path.split(".")) {
    if (!isRecord(current)) return null;
    current = current[part];
  }
  return typeof current === "number" && Number.isFinite(current) ? current : null;
}

// Runs one query by id. A source collection that is not declared yet reads as empty.
export async function handleQuery(
  ctx: ServerContext,
  request: Request,
  url: URL,
  queryId: string,
): Promise<Response> {
  const access = authorize(ctx, request, url);
  if (access === null) throw new ProtocolError(401, "UNAUTHORIZED", "Invalid or missing API key.");
  const query = ctx.catalog.queries.get(queryId);
  if (query === undefined) {
    return jsonResponse({ error: { code: "NOT_FOUND", message: "Query not found." } }, 404);
  }
  if (query.requiresSecretKey && !access.hasSecretKey) {
    throw new ProtocolError(
      401,
      "SECRET_KEY_REQUIRED",
      "This query requires a Network Storage secret key. Send it in the x-secret-key header.",
    );
  }
  const generatedAt = new Date(ctx.now()).toISOString();
  const rows = ctx.catalog.collections.has(query.collectionId)
    ? await ctx.storage().records.list(query.collectionId)
    : [];
  if (query.type === "count") {
    return jsonResponse({
      ok: true,
      queryId,
      type: "count",
      columns: ["count"],
      entries: [{ count: rows.length }],
      count: rows.length,
      generatedAt,
      lastran: generatedAt,
    });
  }
  const field = query.field ?? "";
  const ranked = rows
    .map((row) => ({ key: row.key, value: numberAt(row.data, field) }))
    .filter((row): row is { key: string; value: number } => row.value !== null)
    .sort((a, b) => (query.order === "asc" ? a.value - b.value : b.value - a.value))
    .slice(0, query.limit);
  return jsonResponse({
    ok: true,
    queryId,
    type: "leaderboard",
    field,
    fieldLabel: field,
    columns: ["rank", "key", "value"],
    entries: ranked.map((row, index) => ({ rank: index + 1, key: row.key, value: row.value })),
    generatedAt,
    lastran: generatedAt,
  });
}
