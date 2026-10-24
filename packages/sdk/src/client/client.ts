import { isRecord } from "../util/guards.js";
import { SboxNsError } from "./errors.js";
import type { RecordData, StoredRecord } from "../storage/types.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface SboxNsClientOptions {
  /** Origin of the Network Storage server, for example `https://ns.example.com`. A trailing slash is ignored. */
  baseUrl: string;
  projectId: string;
  /**
   * The project secret key. It authorizes every call in this client, so it belongs on a server, a dedicated host,
   * a CI runner, or a bot. Never ship it to game code; the game uses the public key only.
   */
  secretKey: string;
  /** Replaces the global `fetch`, for tests and custom transports. The client never retries a call. */
  fetch?: FetchLike;
}

/** Operations accepted by `records.patch`: the same ops the server applies to a stored record. */
export type RecordOp = Readonly<Record<string, unknown>>;

/** A management resource kind. Each maps to a `/v1/manage/{project}/{kind}` route. */
export type ManageKind = "endpoints" | "collections" | "workflows";

export interface ManageSections {
  endpoints?: readonly unknown[];
  collections?: readonly unknown[];
  workflows?: readonly unknown[];
}

export interface SboxNsClient {
  readonly projectId: string;
  /** POST `/v1/endpoints/{project}/{slug}` with the secret key. Returns the endpoint's success body. */
  call<T = unknown>(slug: string, input?: Readonly<Record<string, unknown>>): Promise<T>;
  /** GET `/v1/endpoints/{project}/{slug}` with the secret key. Returns the endpoint's success body. */
  get<T = unknown>(slug: string): Promise<T>;
  records: {
    /** GET a document. Returns null when the key does not exist. */
    get(collection: string, key: string): Promise<StoredRecord | null>;
    /** POST a full document, replacing any existing data at the key. */
    put(collection: string, key: string, data: RecordData): Promise<void>;
    /** POST ops that the server applies to the stored document at the key. */
    patch(collection: string, key: string, ops: readonly RecordOp[]): Promise<void>;
    /** DELETE a document. Deleting a missing key is a server-side no-op. */
    delete(collection: string, key: string): Promise<void>;
    /** POST an append to a global collection. The server assigns the record id and timestamp. */
    append(collection: string, data: RecordData): Promise<unknown>;
  };
  queries: {
    /** GET a declared query by name, through the storage query route. */
    run<T = unknown>(name: string): Promise<T>;
    /** GET every declared query definition. */
    list(): Promise<unknown>;
    /** POST query definitions. Each replaces the definition with the same id; other queries are kept. */
    upsert(queries: readonly unknown[]): Promise<unknown>;
    /** DELETE one query definition by id. */
    remove(id: string): Promise<unknown>;
  };
  manage: {
    /** GET the project's validation summary and current revision. */
    validate(): Promise<unknown>;
    /** GET the project's config, including per-kind counts. */
    config(): Promise<unknown>;
    /** PUT endpoints, collections, and workflows. Each section replaces every record of its kind. */
    sync(sections: ManageSections): Promise<unknown>;
    /** POST a dry run of the given sections. Nothing is committed. */
    preflight(sections: ManageSections): Promise<unknown>;
    /** GET every stored document of one kind. */
    list(kind: ManageKind): Promise<unknown>;
    /** PATCH one document. It upserts by id and leaves the other records of its kind in place. */
    upsert(kind: ManageKind, record: Readonly<Record<string, unknown>>): Promise<unknown>;
    /** DELETE one document by id. */
    remove(kind: ManageKind, id: string): Promise<unknown>;
    gameValues: {
      /** GET the project's game values. */
      list(): Promise<unknown>;
      /** PUT game-value items. Each item upserts by id; other game values are kept. The API has no game-value delete. */
      put(items: readonly unknown[]): Promise<unknown>;
    };
  };
}

interface RequestSpec {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
}

interface Failure {
  status: number | null;
  code: string;
  message: string;
  requestId: string | null;
}

// Mirrors the server failure shapes. Library callers get HTTP 200 with `{ok:false, status, error:{code,message}}`;
// plain callers get the real HTTP status with `{ok:false, error:{code,message}}`. Storage routes answer a missing key
// with `{error:"NOT_FOUND", detail}` and no `ok`, so a non-OK HTTP status counts as a failure too.
function failureOf(body: unknown, httpOk: boolean): Failure | null {
  if (!isRecord(body) || body["ok"] === true) return null;
  if (httpOk && body["ok"] !== false) return null;
  const error = body["error"];
  const status = typeof body["status"] === "number" ? body["status"] : null;
  if (isRecord(error) && typeof error["code"] === "string") {
    return {
      status,
      code: error["code"],
      message: typeof error["message"] === "string" ? error["message"] : "Request failed.",
      requestId: typeof error["requestId"] === "string" ? error["requestId"] : null,
    };
  }
  if (typeof error === "string") {
    return {
      status,
      code: error,
      message: typeof body["detail"] === "string" ? body["detail"] : "Request failed.",
      requestId: null,
    };
  }
  // Section-based responses (sync) report each section's own error, e.g. { endpoints: { ok: false, error: "CODE" } }.
  for (const section of Object.values(body)) {
    if (isRecord(section) && section["ok"] === false && typeof section["error"] === "string") {
      return {
        status,
        code: section["error"],
        message: typeof section["message"] === "string" ? section["message"] : "Request failed.",
        requestId: null,
      };
    }
  }
  return null;
}

export function createSboxNsClient(options: SboxNsClientOptions): SboxNsClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const project = encodeURIComponent(options.projectId);
  const fetchFn: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  // One request, one attempt. Failures become SboxNsError with the real status, whatever the wire status was.
  async function request<T>(spec: RequestSpec): Promise<T> {
    const headers: Record<string, string> = {
      "x-secret-key": options.secretKey,
      "x-ns-client-type": "dedicated",
      accept: "application/json",
    };
    const init: RequestInit = { method: spec.method, headers };
    if (spec.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(spec.body);
    }
    const url = `${base}${spec.path}`;

    let response: Response;
    try {
      response = await fetchFn(url, init);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new SboxNsError({ status: 0, code: "NETWORK_ERROR", message: `Could not reach ${base}: ${message}` });
    }

    const text = await response.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new SboxNsError({
          status: response.status,
          code: "INVALID_RESPONSE",
          message: `${spec.method} ${spec.path} returned a body that is not JSON.`,
        });
      }
    }

    const failure = failureOf(body, response.ok);
    if (failure !== null) {
      throw new SboxNsError({
        status: failure.status ?? response.status,
        code: failure.code,
        message: failure.message,
        requestId: failure.requestId,
        body,
      });
    }
    if (!response.ok) {
      throw new SboxNsError({
        status: response.status,
        code: "HTTP_ERROR",
        message: `${spec.method} ${spec.path} failed with HTTP ${response.status}.`,
        body,
      });
    }
    return body as T;
  }

  const recordPath = (collection: string, key: string): string =>
    `/v1/storage/${project}/${encodeURIComponent(collection)}/${encodeURIComponent(key)}`;
  const managePath = (kind: string): string => `/v1/manage/${project}/${kind}`;

  return {
    projectId: options.projectId,
    call: (slug, input) =>
      request({ method: "POST", path: `/v1/endpoints/${project}/${encodeURIComponent(slug)}`, body: input ?? {} }),
    get: (slug) => request({ method: "GET", path: `/v1/endpoints/${project}/${encodeURIComponent(slug)}` }),
    records: {
      get: async (collection, key) => {
        try {
          return await request<StoredRecord>({ method: "GET", path: recordPath(collection, key) });
        } catch (error) {
          if (error instanceof SboxNsError && error.code === "NOT_FOUND" && error.status === 404) return null;
          throw error;
        }
      },
      put: async (collection, key, data) => {
        await request({ method: "POST", path: recordPath(collection, key), body: data });
      },
      patch: async (collection, key, ops) => {
        await request({ method: "POST", path: recordPath(collection, key), body: { ops } });
      },
      delete: async (collection, key) => {
        await request({ method: "DELETE", path: recordPath(collection, key) });
      },
      append: (collection, data) =>
        request({ method: "POST", path: `/v1/storage/${project}/${encodeURIComponent(collection)}/append`, body: data }),
    },
    queries: {
      run: (name) => request({ method: "GET", path: `/v1/storage/${project}/queries/${encodeURIComponent(name)}` }),
      list: () => request({ method: "GET", path: managePath("queries") }),
      upsert: (queries) => request({ method: "POST", path: managePath("queries"), body: queries }),
      remove: (id) => request({ method: "DELETE", path: `${managePath("queries")}/${encodeURIComponent(id)}` }),
    },
    manage: {
      validate: () => request({ method: "GET", path: `/v1/manage/${project}/validate` }),
      config: () => request({ method: "GET", path: `/v1/manage/${project}/config` }),
      sync: (sections) => request({ method: "PUT", path: `/v1/manage/${project}/sync`, body: sections }),
      preflight: (sections) => request({ method: "POST", path: `/v1/manage/${project}/sync/preflight`, body: sections }),
      list: (kind) => request({ method: "GET", path: managePath(kind) }),
      upsert: (kind, record) => request({ method: "PATCH", path: managePath(kind), body: record }),
      remove: (kind, id) => request({ method: "DELETE", path: `${managePath(kind)}/${encodeURIComponent(id)}` }),
      gameValues: {
        list: () => request({ method: "GET", path: managePath("game-values") }),
        put: (items) => request({ method: "PUT", path: managePath("game-values"), body: { items } }),
      },
    },
  };
}
