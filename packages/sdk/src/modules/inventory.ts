import type { SboxModule } from "./types.js";

// Ported from the server's inventory starter kit (Modules/Catalog/inventory.definitions.yml).
// One deliberate difference: the canonical `consume` ownership check uses `op: contains`, which the DSL's
// comparison operators do not support (the server throws "unknown comparison operator"). The equivalent
// owned-check below counts matching stacks and treats a missing inventory as empty.
export const inventory: SboxModule = {
  id: "inventory",
  version: "1.0.0",
  name: "Inventory starter kit",
  description:
    "Grant, consume and craft items with recipes stored in game values. Material costs are checked on the server and missing ingredients fail closed.",
  collections: [
    {
      id: "inventory_state",
      name: "inventory_state",
      description: "One record per player holding items and crafting materials. Only kit endpoints change it.",
      collectionType: "per-steamid",
      accessMode: "endpoint",
      maxRecords: 1,
      allowRecordDelete: false,
      schema: {
        type: "object",
        properties: {
          inventory: {
            type: "array",
            items: {
              type: "object",
              properties: {
                item_id: { type: "string" },
                name: { type: "string" },
              },
            },
          },
          materials: {
            type: "object",
            additionalProperties: { type: "number" },
          },
        },
      },
    },
  ],
  gameValues: [
    {
      id: "inventory_recipes",
      type: "table",
      name: "Crafting recipes",
      columns: [
        { key: "recipe_id", type: "string" },
        { key: "material", type: "string" },
        { key: "material_cost", type: "number" },
        { key: "output_item", type: "string" },
        { key: "output_name", type: "string" },
      ],
      rows: [
        {
          recipe_id: "copper_dagger",
          material: "copper",
          material_cost: 3,
          output_item: "copper_dagger",
          output_name: "Copper Dagger",
        },
        {
          recipe_id: "iron_sword",
          material: "iron",
          material_cost: 5,
          output_item: "iron_sword",
          output_name: "Iron Sword",
        },
      ],
    },
    {
      id: "inventory_consumables",
      type: "table",
      name: "Consumables",
      columns: [
        { key: "item_id", type: "string" },
        { key: "name", type: "string" },
        { key: "stat", type: "string" },
        { key: "amount", type: "number" },
      ],
      rows: [{ item_id: "small_potion", name: "Small Potion", stat: "health", amount: 25 }],
    },
  ],
  endpoints: [
    {
      id: "inventory_grant",
      name: "Grant item",
      description: "Adds an item to the caller's inventory. The server stamps the grant time.",
      method: "POST",
      input: {
        type: "object",
        properties: {
          item_id: { type: "string" },
          name: { type: "string" },
        },
        required: ["item_id", "name"],
      },
      steps: [
        {
          id: "give",
          type: "write",
          collection: "inventory_state",
          key: "{{steamId}}",
          ops: [
            {
              op: "push",
              path: "inventory",
              value: {
                item_id: "{{input.item_id}}",
                name: "{{input.name}}",
                granted_at: "{{now}}",
              },
            },
          ],
        },
      ],
      response: {
        status: 200,
        body: { success: true, item_id: "{{input.item_id}}" },
      },
    },
    {
      id: "inventory_consume",
      name: "Consume item",
      description: "Removes an owned consumable and applies its effect. Fails when the item is unknown or not owned.",
      method: "POST",
      input: {
        type: "object",
        properties: { item_id: { type: "string" } },
        required: ["item_id"],
      },
      steps: [
        { id: "player", type: "read", collection: "inventory_state", key: "{{steamId}}" },
        {
          id: "item",
          type: "lookup",
          source: "values",
          table: "inventory_consumables",
          where: { field: "item_id", op: "==", value: "{{input.item_id}}" },
          required: true,
          onMissing: {
            status: 404,
            errorCode: "UNKNOWN_ITEM",
            message: "{{input.item_id}} is not a consumable.",
          },
        },
        {
          id: "owns_item",
          type: "condition",
          check: {
            field: "{{player.inventory ? count(player.inventory, it => it.item_id == input.item_id) : 0}}",
            op: ">",
            value: 0,
          },
          onFail: {
            status: 400,
            error: "NOT_OWNED",
            message: "You do not have {{item.name}}.",
          },
        },
        {
          id: "consume",
          type: "write",
          collection: "inventory_state",
          key: "{{steamId}}",
          ops: [
            { op: "pull", path: "inventory", match: { item_id: "{{input.item_id}}" } },
            {
              op: "inc",
              path: "{{item.stat}}",
              value: "{{item.amount}}",
              source: "consumable",
              reason: "Used {{item.name}}",
            },
          ],
        },
      ],
      response: {
        status: 200,
        body: { success: true, used: "{{item.name}}" },
      },
    },
    {
      id: "inventory_craft",
      name: "Craft item",
      description:
        "Spends recipe materials and adds the crafted item. Missing ingredients fail with MISSING_MATERIALS.",
      method: "POST",
      input: {
        type: "object",
        properties: { recipe_id: { type: "string" } },
        required: ["recipe_id"],
      },
      steps: [
        { id: "player", type: "read", collection: "inventory_state", key: "{{steamId}}" },
        {
          id: "recipe",
          type: "lookup",
          source: "values",
          table: "inventory_recipes",
          where: { field: "recipe_id", op: "==", value: "{{input.recipe_id}}" },
          required: true,
          onMissing: {
            status: 404,
            errorCode: "UNKNOWN_RECIPE",
            message: "Unknown recipe {{input.recipe_id}}.",
          },
        },
        {
          id: "has_materials",
          type: "condition",
          check: {
            field: "player.materials.{{recipe.material}}",
            op: ">=",
            value: "{{recipe.material_cost}}",
          },
          onFail: {
            status: 400,
            error: "MISSING_MATERIALS",
            message: "You need {{recipe.material_cost}} {{recipe.material}}.",
          },
        },
        {
          id: "craft",
          type: "write",
          collection: "inventory_state",
          key: "{{steamId}}",
          ops: [
            {
              op: "inc",
              path: "materials.{{recipe.material}}",
              value: "{{-recipe.material_cost}}",
              source: "crafting",
              reason: "Crafted {{recipe.output_name}}",
            },
            {
              op: "push",
              path: "inventory",
              value: {
                item_id: "{{recipe.output_item}}",
                name: "{{recipe.output_name}}",
              },
            },
          ],
        },
      ],
      response: {
        status: 200,
        body: { success: true, crafted: "{{recipe.output_name}}" },
      },
    },
    {
      id: "inventory_get",
      name: "Get inventory",
      description: "Reads the caller's items and materials.",
      method: "GET",
      steps: [{ id: "player", type: "read", collection: "inventory_state", key: "{{steamId}}" }],
      response: {
        status: 200,
        body: { success: true },
      },
    },
  ],
  queries: [],
};
