// Client for recipes/cloudflare-kv/harness, run under `wrangler dev`. Every storage call is one POST to the
// Worker, which builds storage over the real D1 or KV+Durable Object binding and returns the result.
import { StorageError, type ApplyOptions, type EndpointStorage, type RecordData, type RecordWrite, type StorageErrorCode } from "../../src/storage/index.js";
import type { StoredRecord, VersionedRecord } from "../../src/storage/types.js";
import type { ConformanceFixture, StorageConfig } from "./conformance.js";

export const harnessUrl = process.env.NS_TEST_HARNESS_URL ?? "";
export const harnessSkip = harnessUrl === ""
  ? "NS_TEST_HARNESS_URL is not set (run `wrangler dev` in recipes/cloudflare-kv and set it to the URL)"
  : undefined;

type Backend = "d1" | "kv";
type Method = "open" | "get" | "getVersioned" | "list" | "values" | "apply" | "reset";

// backend "d1" shares one table across namespaces, so the first open of each store clears it.
export function remoteFixture(backend: Backend, url: string, skip: string | undefined): ConformanceFixture {
  const opened = new Set<string>();
  return {
    name: backend,
    persistent: true,
    skip,
    async open(config, store) {
      if (backend === "d1" && !opened.has(store)) {
        opened.add(store);
        // The reset call omits seed so nothing is inserted and then wiped; the next call seeds as usual.
        await post(url, { backend, config: { ...config, seed: undefined }, store, method: "reset", args: [] });
      }
      // "open" builds the storage in the harness with the full config, so construction-time validation and seeding run there.
      await post(url, { backend, config, store, method: "open", args: [] });
      return remoteStorage(backend, url, config, store);
    },
  };
}

function remoteStorage(backend: Backend, url: string, config: StorageConfig, store: string): EndpointStorage {
  const call = <T>(method: Method, args: unknown[]): Promise<T> => post<T>(url, { backend, config, store, method, args });
  const storage: EndpointStorage = {
    records: {
      get: (collection, key) => call<RecordData | null>("get", [collection, key]),
      getVersioned: (collection, key) => call<VersionedRecord>("getVersioned", [collection, key]),
      list: (collection) => call<StoredRecord[]>("list", [collection]),
    },
    values: {
      get: (path) => call<unknown>("values", [path]),
    },
    apply: async (writes: RecordWrite[], options?: ApplyOptions) => {
      await call<null>("apply", [writes, options ?? {}]);
    },
  };
  return storage;
}

interface PostInput {
  backend: Backend;
  config: Partial<StorageConfig>;
  store: string;
  method: Method;
  args: unknown[];
}

async function post<T>(url: string, input: PostInput): Promise<T> {
  const response = await fetch(`${url.replace(/\/$/, "")}/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      backend: input.backend,
      config: { ...input.config, namespace: input.store },
      method: input.method,
      args: input.args,
    }),
  });
  const body: unknown = await response.json();
  const failure = harnessError(body);
  if (failure !== null) throw new StorageError(failure.code, failure.message);
  if (typeof body !== "object" || body === null || !("ok" in body)) {
    throw new Error(`harness returned an unexpected body (HTTP ${response.status})`);
  }
  return body.ok as T;
}

function harnessError(body: unknown): { code: StorageErrorCode; message: string } | null {
  if (typeof body !== "object" || body === null || !("error" in body)) return null;
  const { error } = body;
  if (typeof error !== "object" || error === null || !("code" in error) || !("message" in error)) return null;
  if (typeof error.code !== "string" || typeof error.message !== "string") return null;
  return { code: error.code as StorageErrorCode, message: error.message };
}
