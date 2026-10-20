import type { RecordData } from "../storage/types.js";
import type { FetchResponseData } from "./fetch.js";

export type { RecordData };

// Handlers must `await` records, values, workflows and secrets: the engine returns synchronously, this
// backend does not. `await` on a plain value is a no-op, so one handler runs on both.
export type MaybePromise<T> = T | Promise<T>;

export interface EndpointRequest {
  // Query parameters for GET, the JSON object body for POST. Reserved auth keys are removed.
  input: Record<string, unknown>;
  player: { steamId: string } | null;
  method: "GET" | "POST";
  endpoint: string;
  revision: string | null;
}

export interface NsRecords {
  get(collection: string, key: string): MaybePromise<RecordData | null>;
  put(collection: string, key: string, data: RecordData): MaybePromise<void>;
  delete(collection: string, key: string): MaybePromise<void>;
  list(collection: string): MaybePromise<RecordData[]>;
}

export interface NsValues {
  // "group" or "group.key". Resolves to null when absent.
  get(path: string): MaybePromise<unknown>;
}

export interface NsWorkflows {
  // Runs a workflow registered with the project. Record writes made by the workflow are rolled back
  // if it throws; the error then propagates to the caller.
  run(workflowId: string, input?: Record<string, unknown>): MaybePromise<unknown>;
}

export interface NsSecrets {
  // Resolves to null when the secret is not set. Throws SECRET_UNAVAILABLE when it exists but cannot be
  // read, for example because the secret store is unreachable.
  get(name: string): MaybePromise<string | null>;
}

export type FetchMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface FetchOptions {
  method?: FetchMethod;
  headers?: Record<string, string>;
  body?: string | Record<string, unknown> | unknown[];
  timeoutMs?: number;
}

export type FetchResponse = FetchResponseData;

export interface Ns {
  records: NsRecords;
  values: NsValues;
  workflows: NsWorkflows;
  secrets: NsSecrets;
  now(): number;
  log(value: unknown): void;
  fail(code: string, message: string, status?: number): never;
  // First run of a new URL returns null. The run is repeated with the response once it loads.
  fetch(url: string, options?: FetchOptions): FetchResponse | null;
}

// Mirrors the `globals` declared in ns.d.ts: exports of other endpoint modules, keyed by endpoint id.
export type EndpointGlobal = (req: EndpointRequest, ns: Ns) => unknown;

export interface EndpointScope {
  readonly globals: Readonly<Record<string, Readonly<Record<string, EndpointGlobal>>>>;
}

export type WorkflowFunction = (input: Record<string, unknown>, ns: Ns) => unknown;

export type EndpointHandler = (req: EndpointRequest, ns: Ns, scope: EndpointScope) => unknown;

export interface EndpointDefinition {
  handle: EndpointHandler;
}
