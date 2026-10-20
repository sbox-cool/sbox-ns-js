// HTTP harness that exposes the SDK's D1 and KV storage adapters over POST /call so the conformance
// suite can run against real D1 and Durable Object + KV bindings under `wrangler dev`. Every request
// builds storage from the request's config. Seeding is insert-if-absent, so rebuilding per request is safe.
//
// `reset` is a TEST-ONLY method. The D1 adapter keeps every namespace in one shared table with no prefix,
// so the suite clears it before each fresh store. KV needs no reset: each namespace is its own coordinator.
import {
  createD1Storage,
  createKvStorage,
  StorageError,
  type ApplyOptions,
  type CollectionDefinition,
  type EndpointStorage,
  type RecordWrite,
} from "../../../src/storage/index.js";
import { StorageCoordinator } from "../src/coordinator.js";

export { StorageCoordinator };

interface Env {
  COORDINATOR: DurableObjectNamespace<StorageCoordinator>;
  BLOBS: KVNamespace;
  DB: D1Database;
}

interface StorageConfig {
  namespace: string;
  collections: CollectionDefinition[];
  values?: Record<string, unknown>;
  seed?: Record<string, Record<string, Record<string, unknown>>>;
}

type CallMethod = "open" | "get" | "getVersioned" | "list" | "values" | "apply" | "reset";
type Backend = "d1" | "kv";

interface CallBody {
  backend: Backend;
  config: StorageConfig;
  method: CallMethod;
  args: unknown[];
}

const METHODS = new Set<string>(["open", "get", "getVersioned", "list", "values", "apply", "reset"]);
const BACKENDS = new Set<string>(["d1", "kv"]);

// Narrows the parsed request body. Anything malformed is rejected rather than cast.
function parseCall(value: unknown): CallBody | null {
  if (typeof value !== "object" || value === null || !("backend" in value) || !("config" in value) || !("method" in value) || !("args" in value)) return null;
  const { backend, config, method, args } = value;
  if (typeof backend !== "string" || !BACKENDS.has(backend)) return null;
  if (typeof method !== "string" || !METHODS.has(method) || !Array.isArray(args)) return null;
  if (typeof config !== "object" || config === null || !("namespace" in config) || !("collections" in config)) return null;
  if (typeof config.namespace !== "string" || !Array.isArray(config.collections)) return null;
  return { backend: backend as Backend, config: config as StorageConfig, method: method as CallMethod, args };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/call") return json({ error: { code: "NOT_FOUND", message: "not found" } }, 404);

    const call = parseCall(await request.json());
    if (call === null) return json({ error: { code: "INVALID_BATCH", message: "malformed harness request" } }, 400);

    try {
      const storage = call.backend === "d1"
        ? createD1Storage({
            db: env.DB,
            collections: call.config.collections,
            values: call.config.values,
            seed: call.config.seed,
          })
        : createKvStorage({
            collections: call.config.collections,
            values: call.config.values,
            seed: call.config.seed,
            coordinator: env.COORDINATOR,
            blobs: env.BLOBS,
            coordinatorName: call.config.namespace,
          });
      return json({ ok: await run(storage, call, env) }, 200);
    } catch (error) {
      if (error instanceof StorageError) {
        return json({ error: { code: error.code, message: error.message } }, error.status);
      }
      return json({ error: { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) } }, 500);
    }
  },
};

async function run(storage: EndpointStorage, call: CallBody, env: Env): Promise<unknown> {
  const [a, b] = call.args;
  switch (call.method) {
    case "open":
      return null;
    case "get":
      return storage.records.get(String(a), String(b));
    case "getVersioned":
      return storage.records.getVersioned(String(a), String(b));
    case "list":
      return storage.records.list(String(a));
    case "values":
      return storage.values.get(String(a));
    case "apply":
      await storage.apply(a as RecordWrite[], (b ?? {}) as ApplyOptions);
      return null;
    case "reset":
      // Creates the table through the adapter's own setup, then clears it. D1 only.
      if (call.backend === "d1") {
        await storage.records.list(call.config.collections[0].id);
        await env.DB.prepare("DELETE FROM ns_records").run();
      }
      return null;
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
