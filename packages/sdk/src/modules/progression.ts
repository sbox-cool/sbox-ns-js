import type { SboxModule } from "./types.js";

// Ported from the server's progression starter kit (Modules/Catalog/progression.definitions.yml).
export const progression: SboxModule = {
  id: "progression",
  version: "1.0.0",
  name: "Progression starter kit",
  description:
    "XP and levels computed on the server from the xp_per_level game value. Granting 1200 XP at 500 per level returns level 3 (levels start at 1).",
  collections: [
    {
      id: "progression_profile",
      name: "progression_profile",
      description: "One record per player holding XP and level. Only the kit endpoint changes them.",
      collectionType: "per-steamid",
      accessMode: "endpoint",
      maxRecords: 1,
      allowRecordDelete: false,
      schema: {
        type: "object",
        properties: {
          xp: { type: "number", default: 0, min: 0 },
          level: { type: "number", default: 1, min: 1 },
        },
      },
    },
  ],
  gameValues: [
    {
      id: "progression_config",
      type: "group",
      name: "Progression config",
      entries: {
        xp_per_level: 500,
        max_grant_per_call: 10000,
      },
    },
  ],
  endpoints: [
    {
      id: "progression_grant_xp",
      name: "Grant XP",
      description: "Adds XP and recomputes the level on the server as floor(xp / xp_per_level) + 1.",
      method: "POST",
      input: {
        type: "object",
        properties: { amount: { type: "number" } },
        required: ["amount"],
      },
      steps: [
        {
          id: "amount_ok",
          type: "assert",
          check: {
            all: [
              { field: "input.amount", op: ">", value: 0 },
              { field: "input.amount", op: "<=", value: "{{values.progression_config.max_grant_per_call}}" },
            ],
          },
          status: 422,
          errorCode: "INVALID_AMOUNT",
          message: "Amount must be positive and within the per-call limit.",
        },
        { id: "player", type: "read", collection: "progression_profile", key: "{{steamId}}" },
        { id: "total", type: "transform", expression: "{{player.xp|0}} + {{input.amount}}" },
        {
          id: "level",
          type: "transform",
          expression: "floor({{total}} / max({{values.progression_config.xp_per_level}}, 1)) + 1",
        },
        {
          id: "save",
          type: "write",
          collection: "progression_profile",
          key: "{{steamId}}",
          ops: [
            { op: "set", path: "xp", value: "{{total}}" },
            { op: "set", path: "level", value: "{{level}}" },
          ],
        },
      ],
      response: {
        status: 200,
        body: { success: true, xp: "{{total}}", level: "{{level}}" },
      },
    },
    {
      id: "progression_get_level",
      name: "Get level",
      description: "Reads the caller's XP and level.",
      method: "GET",
      steps: [{ id: "player", type: "read", collection: "progression_profile", key: "{{steamId}}" }],
      response: {
        status: 200,
        body: {
          success: true,
          xp: "{{player.xp|0}}",
          level: "{{player.level|1}}",
        },
      },
    },
  ],
  queries: [],
};
