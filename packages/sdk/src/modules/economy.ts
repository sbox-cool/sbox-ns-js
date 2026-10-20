import type { SboxModule } from "./types.js";

// Ported from the server's economy starter kit (Modules/Catalog/economy.definitions.yml). Records are the
// catalog's authoring format; behaviour is whatever the server's DSL does with them.
export const economy: SboxModule = {
  id: "economy",
  version: "1.0.0",
  name: "Economy starter kit",
  description:
    "Currency balance with server-side earn and spend. Amounts come from the client but every limit is checked on the server; spends fail closed on insufficient funds and every change is ledger-tracked.",
  collections: [
    {
      id: "economy_balance",
      name: "economy_balance",
      description: "One record per player holding the kit's gold balance. Only kit endpoints change it.",
      collectionType: "per-steamid",
      accessMode: "endpoint",
      maxRecords: 1,
      allowRecordDelete: false,
      schema: {
        type: "object",
        properties: {
          gold: {
            type: "number",
            default: 0,
            min: 0,
            _ledger: true,
            description: "Spendable currency. Only kit endpoints change it.",
          },
        },
      },
    },
  ],
  gameValues: [
    {
      id: "economy_limits",
      type: "group",
      name: "Economy limits",
      entries: {
        max_earn_per_call: 1000,
        max_spend_per_call: 1000,
        starting_balance: 0,
      },
    },
  ],
  endpoints: [
    {
      id: "economy_earn",
      name: "Earn gold",
      description: "Adds gold up to the per-call limit. The amount is checked on the server, never trusted blindly.",
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
              { field: "input.amount", op: "<=", value: "{{values.economy_limits.max_earn_per_call}}" },
            ],
          },
          status: 422,
          errorCode: "INVALID_AMOUNT",
          message: "Amount must be between 1 and the per-call limit.",
        },
        {
          id: "give",
          type: "write",
          collection: "economy_balance",
          key: "{{steamId}}",
          ops: [{ op: "inc", path: "gold", value: "{{input.amount}}", source: "earn", reason: "Earned gold" }],
        },
      ],
      response: {
        status: 200,
        body: { success: true, earned: "{{input.amount}}" },
      },
    },
    {
      id: "economy_spend",
      name: "Spend gold",
      description:
        "Removes gold after checking the balance on the server. Fails with INSUFFICIENT_FUNDS instead of going negative.",
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
              { field: "input.amount", op: "<=", value: "{{values.economy_limits.max_spend_per_call}}" },
            ],
          },
          status: 422,
          errorCode: "INVALID_AMOUNT",
          message: "Amount must be between 1 and the per-call limit.",
        },
        { id: "player", type: "read", collection: "economy_balance", key: "{{steamId}}" },
        {
          id: "can_afford",
          type: "condition",
          check: { field: "player.gold|0", op: ">=", value: "{{input.amount}}" },
          onFail: {
            status: 409,
            error: "INSUFFICIENT_FUNDS",
            message: "Not enough gold to spend {{input.amount}}.",
          },
        },
        {
          id: "take",
          type: "write",
          collection: "economy_balance",
          key: "{{steamId}}",
          ops: [
            {
              op: "inc",
              path: "gold",
              valueExpression: "0 - {{input.amount}}",
              source: "spend",
              reason: "Spent gold",
            },
          ],
        },
      ],
      response: {
        status: 200,
        body: { success: true, spent: "{{input.amount}}" },
      },
    },
    {
      id: "economy_get_balance",
      name: "Get balance",
      description: "Reads the caller's gold balance.",
      method: "GET",
      steps: [{ id: "player", type: "read", collection: "economy_balance", key: "{{steamId}}" }],
      response: {
        status: 200,
        body: { success: true, gold: "{{player.gold|0}}" },
      },
    },
  ],
  queries: [],
};
