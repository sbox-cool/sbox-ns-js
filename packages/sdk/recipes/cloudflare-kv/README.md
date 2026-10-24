# Cloudflare KV storage recipe

Deploys the KV storage adapter: a Durable Object coordinator (`src/coordinator.ts`) that owns record metadata, plus KV blobs for payloads. Semantics and limits are in `packages/sdk/docs/storage.md` (Cloudflare KV section).

`harness/worker.ts` is a test harness, not a production endpoint. It exposes `POST /call` so the SDK conformance suite can drive D1 and KV through the real bindings.

## Setup

1. Create the resources and replace the placeholders in `wrangler.jsonc`:

   ```sh
   npx wrangler kv namespace create ns-storage-blobs        # -> BLOBS id
   npx wrangler d1 create ns-storage-harness                # -> DB database_id
   ```

   `REPLACE_WITH_KV_NAMESPACE_ID` and `REPLACE_WITH_D1_DATABASE_ID` must be replaced before the Worker can run in production. Local dev (`--local`) accepts placeholder ids. The adapters create their own tables on setup, so no manual migration is needed.

2. Run the harness locally from this directory. Pass the config by absolute path. Wrangler resolves a relative `--config` against the nearest `package.json` (here `packages/sdk`), which breaks the lookup:

   ```sh
   cd packages/sdk/recipes/cloudflare-kv
   npx --yes wrangler@4 dev --local --port 8787 --config "$(pwd)/wrangler.jsonc"
   ```

   `--local` runs D1, KV, and the Durable Object in local emulation. Verified against wrangler 4.151.2.

3. Run the SDK storage tests against it, from `packages/sdk`. Set `NS_TEST_HARNESS_URL` to the URL printed by `wrangler dev`:

   ```sh
   /path/to/node_modules/.bin/tsc -p tsconfig.test.json
   NS_TEST_HARNESS_URL=http://127.0.0.1:8787 node --test dist-test/test/storage-d1.test.js dist-test/test/storage-kv.test.js
   ```

   Result at last run: 46 pass, 0 fail (23 D1, 23 KV).

## Notes

- The Durable Object `COORDINATOR` is one instance per `coordinatorName`. Records in one coordinator commit atomically together; records in different coordinators do not.
- The D1 harness uses one shared table. The harness's `reset` method (test-only) clears it between suites.
- The harness builds storage on each request from the request's config. Construction errors (invalid collections, bad seeds) return a JSON `StorageError` with HTTP 4xx/5xx, never an HTML error page.
- Orphan KV blobs can remain after a crash or an ambiguous commit. No sweeper ships in this recipe.
