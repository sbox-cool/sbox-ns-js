import type { SboxModule } from "./types.js";

// Ported from the server's leaderboards starter kit (Modules/Catalog/leaderboards.definitions.yml).
export const leaderboards: SboxModule = {
  id: "leaderboards",
  version: "1.0.0",
  name: "Leaderboards starter kit",
  description:
    "High-score submit with server-side validation plus a top-scores query. A submit below the stored best keeps the best.",
  collections: [
    {
      id: "leaderboards_scores",
      name: "leaderboards_scores",
      description: "One record per player holding their best score. Only the kit endpoint changes it.",
      collectionType: "per-steamid",
      accessMode: "endpoint",
      maxRecords: 1,
      allowRecordDelete: false,
      schema: {
        type: "object",
        properties: {
          score: { type: "number", default: 0, min: 0 },
          name: { type: "string" },
        },
      },
    },
  ],
  gameValues: [
    {
      id: "leaderboards_config",
      type: "group",
      name: "Leaderboard config",
      entries: {
        max_score: 999999,
        top_limit: 10,
      },
    },
  ],
  endpoints: [
    {
      id: "leaderboards_submit",
      name: "Submit score",
      description:
        "Validates the score on the server and keeps the caller's best. Scores outside 0..max_score are rejected.",
      method: "POST",
      input: {
        type: "object",
        properties: {
          score: { type: "number" },
          name: { type: "string" },
        },
        required: ["score", "name"],
      },
      steps: [
        {
          id: "score_ok",
          type: "assert",
          check: {
            all: [
              { field: "input.score", op: ">=", value: 0 },
              { field: "input.score", op: "<=", value: "{{values.leaderboards_config.max_score}}" },
            ],
          },
          status: 422,
          errorCode: "INVALID_SCORE",
          message: "Score must be between 0 and the configured maximum.",
        },
        { id: "entry", type: "read", collection: "leaderboards_scores", key: "{{steamId}}" },
        { id: "best", type: "transform", expression: "max({{entry.score|0}}, {{input.score}})" },
        {
          id: "save",
          type: "write",
          collection: "leaderboards_scores",
          key: "{{steamId}}",
          ops: [
            { op: "set", path: "score", value: "{{best}}" },
            { op: "set", path: "name", value: "{{input.name}}" },
            { op: "set", path: "submitted_at", value: "{{now}}" },
          ],
        },
      ],
      response: {
        status: 200,
        body: { success: true, score: "{{best}}" },
      },
    },
  ],
  queries: [
    {
      id: "leaderboards_top",
      name: "Top scores",
      type: "leaderboard",
      sources: [{ collectionId: "leaderboards_scores", alias: "entry" }],
      config: {
        field: "score",
        order: "desc",
        limit: 10,
        fields: ["name", "score"],
      },
      cache: { ttlSeconds: 60 },
      requiresSecretKey: false,
    },
  ],
};
