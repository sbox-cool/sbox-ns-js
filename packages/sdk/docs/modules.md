# Catalog modules

`@sbox-ns/sdk/modules` ships the sbox-ns catalog modules as code: **economy**, **inventory**, **progression**, and **leaderboards**. A module is a set of collections, game values, endpoints, and queries. It is installed into a project and runs on the same engine as the hosted service.

Two ways to use a module:

- **Custom backend.** `withModules(serverOptions, [economy, inventory])` wires the module into `createNetworkStorageServer` in process. Nothing is sent over the network.
- **Hosted project.** `installModules(client, [economy])` writes the module into a project through the manage API, using the secret-key client.

```ts
import { createNetworkStorageServer } from "@sbox-ns/sdk/server";
import { economy, inventory, leaderboards, withModules } from "@sbox-ns/sdk/modules";

const server = createNetworkStorageServer(withModules(options, [economy, inventory, leaderboards]));
```

## Source of truth

Each module's definitions are the server's canonical catalog (`Modules/Catalog/*.definitions.yml` and `*.module.yml`), ported verbatim. Identifiers, field names, validation, and semantics match the catalog. Module data is compiled by the same compiler the server uses for YAML definitions, so a module that compiles here is valid on the server.

`compileModule(module)` validates a module without running it and throws `ModuleError` with `INVALID_MODULE` on invalid input. `defineModule(module)` returns the same module for type inference.

## Module shape

```ts
interface SboxModule {
  id: string;          // lowercase letters, digits, underscores, hyphens; also the namespace prefix
  version: string;     // major.minor.patch
  name: string;
  description: string;
  collections: readonly ModuleRecord[];
  gameValues: readonly ModuleRecord[];
  endpoints: readonly ModuleRecord[];
  queries: readonly ModuleRecord[];
}
```

## Install and uninstall

`installModules(client, modules)` is merge-based: it upserts each declared collection, game value, endpoint, and query by id. It never replaces the whole project. A registry entry, the game-values group `sbox_ns_modules`, is written last and records each installed module's version.

- A module whose installed version is equal to or newer than the version in the package reports `unchanged`.
- A new module reports `installed`. A newer version over an older one reports `upgraded`.

`uninstallModules(client, modules)` removes the endpoints and queries the module declares, and its registry entry. The management API has no game-value delete, so the module's game values are **blanked** (groups become empty, tables lose their rows) rather than deleted. Collections are removed only with `removeCollections: true`, because they hold player data. Ids that are already gone are not an error.

Install is **not atomic**. If a request fails part way, the project keeps the entries written before the failure, and the registry is not updated, so re-running the install converges. The install does not check the server version; a module that needs newer server features will fail when the server rejects its definitions.

## Modules

### economy

Module id `economy`. Collection `economy_balance`; game values `economy_limits`. Endpoints `economy_earn`, `economy_spend`, `economy_get_balance`.

- `economy_earn` and `economy_spend` are **player-callable** in the canonical catalog. They are ported faithfully. Review them for your game before exposing them. The secret-key client can call them without a player.
- `starting_balance` from the catalog is **not implemented**. Initialise balances in your own code or with a collection seed.

### inventory

Module id `inventory`. Collection `inventory_state`; game values `inventory_recipes`, `inventory_consumables`. Endpoints `inventory_grant`, `inventory_consume`.

- `inventory_consume` checks ownership with `count(...)`. The DSL has no `contains` operator, so the check counts matching items and compares the result. Consume fails when the player does not own enough of the item, as in the catalog.

### progression

Module id `progression`. Collection `progression_profile`; game values `progression_config`. Endpoints `progression_grant_xp`, `progression_get_level`. Levels and XP use the catalog's curve and grant rules.

### leaderboards

Module id `leaderboards`. Ranked score collections and the `leaderboards_top` query.

- Entries use `name` for the display key. The catalog uses `key`. Clients that read the catalog shape must read `name`.

## Limits

- Generated project tests cover module install idempotency and the public query only. They cannot drive player-scoped endpoints (for example steamId-based calls) with the secret key, because those need a player session.
- For custom backends, module endpoints run in the same process as your server. Profile expensive modules before exposing them publicly.

## Custom modules

A power user can write a module with the same shape and install it with `installModules`, or wire it with `withModules`:

```ts
import { defineModule } from "@sbox-ns/sdk/modules";

export const dailyReward = defineModule({
  id: "daily_reward",
  version: "1.0.0",
  name: "Daily reward",
  description: "Grants one reward per player per day.",
  collections: [/* collection definitions */],
  gameValues: [/* game-value groups */],
  endpoints: [/* endpoint definitions */],
  queries: [],
});
```

Use `compileModule` to check it while you develop. Compile errors name the offending id and field.
