import type { EndpointStorage, ExpectedVersion, RecordData, RecordWrite } from "../storage/index.js";
import { isRecord } from "../util/guards.js";
import {
  FETCH_LIMITS,
  FetchError,
  type FetchOutcome,
  type FetchPolicy,
  type ParsedFetch,
  parseFetchCall,
  refuseHost,
  sendFetch,
} from "./fetch.js";
import type {
  EndpointDefinition,
  EndpointGlobal,
  EndpointRequest,
  FetchOptions,
  FetchResponse,
  Ns,
  WorkflowFunction,
} from "./types.js";

// Thrown by ns.fail(). The backend maps it to a status and an error body.
export class ScriptFailure extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ScriptFailure";
    this.code = code;
    this.status = status;
  }
}

// Thrown when the caller's request was cancelled (client disconnect or host shutdown) before the run finished.
export class RunCancelled extends Error {
  constructor() {
    super("The endpoint run was cancelled.");
    this.name = "RunCancelled";
  }
}

export interface SecretStore {
  get(name: string): string | null | Promise<string | null>;
}

export interface RunEnvironment {
  storage: EndpointStorage;
  fetchPolicy: FetchPolicy;
  workflows: Readonly<Record<string, WorkflowFunction>>;
  globals: Readonly<Record<string, Readonly<Record<string, EndpointGlobal>>>>;
  secrets: SecretStore;
  now: () => number;
  log: (value: unknown) => void;
  // Aborts pending outbound requests and stops further passes.
  signal?: AbortSignal;
}

export interface RunOutcome {
  value: unknown;
  writes: RecordWrite[];
  // Versions of every stored record this run read. Passed to apply() so a concurrent write fails the run
  // with CONFLICT instead of being silently lost.
  expectedVersions: ExpectedVersion[];
}

// Runs an endpoint handler to completion. The handler may run several times:
//   - ns.fetch returns null on the first pass for each new request. Those requests are sent after
//     the pass, and the handler runs again with their results.
//   - A pass that throws while requests are pending is discarded, because it probably threw on the
//     null response. The next pass decides the outcome.
// Every pass that issues a new request adds at least one completed outcome, and new requests stop at
// FETCH_LIMITS.maxRequestsPerExecution, so the number of passes is bounded by that limit plus one.
// Writes are staged per pass and committed only when a pass completes without pending requests.
// Logs from discarded passes are dropped.
export async function runEndpoint(
  definition: EndpointDefinition,
  request: EndpointRequest,
  env: RunEnvironment,
): Promise<RunOutcome> {
  const completed = new Map<string, FetchOutcome>();
  for (;;) {
    throwIfCancelled(env.signal);
    const pass = new Pass(env, completed);
    let value: unknown;
    let failure: { error: unknown } | null = null;
    try {
      value = await definition.handle(request, pass.ns, { globals: env.globals });
    } catch (error) {
      failure = { error };
    }
    throwIfCancelled(env.signal);
    if (pass.pending.size === 0) {
      if (failure !== null) throw failure.error;
      for (const entry of pass.logs) env.log(entry);
      return { value, writes: pass.writes.stagedWrites(), expectedVersions: pass.writes.expectedVersions() };
    }
    const sent = await Promise.all(
      [...pass.pending.entries()].map(
        async ([key, call]) => [key, await sendFetch(call, env.fetchPolicy, env.signal)] as const,
      ),
    );
    for (const [key, outcome] of sent) completed.set(key, outcome);
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new RunCancelled();
}

// State for one pass of the handler.
class Pass {
  readonly pending = new Map<string, ParsedFetch>();
  readonly logs: unknown[] = [];
  readonly writes: RecordOverlay;
  readonly ns: Ns;
  private readonly env: RunEnvironment;
  private readonly completed: Map<string, FetchOutcome>;

  constructor(env: RunEnvironment, completed: Map<string, FetchOutcome>) {
    this.env = env;
    this.completed = completed;
    this.writes = new RecordOverlay(env.storage.records);
    this.ns = this.buildNs();
  }

  private buildNs(): Ns {
    return {
      records: {
        get: (collection, key) => this.writes.get(collection, key),
        put: (collection, key, data) => this.writes.put(collection, key, data),
        delete: (collection, key) => this.writes.delete(collection, key),
        list: (collection) => this.writes.list(collection),
      },
      values: {
        get: (path) => this.env.storage.values.get(path),
      },
      workflows: {
        run: (workflowId, input) => this.runWorkflow(workflowId, input),
      },
      secrets: {
        get: (name) => this.readSecret(name),
      },
      now: () => this.env.now(),
      log: (value) => {
        this.logs.push(value);
      },
      fail: (code, message, status = 400) => {
        throw new ScriptFailure(code, message, status);
      },
      fetch: (url, options) => this.fetch(url, options),
    };
  }

  // Workflow writes are rolled back when the workflow throws, so a failed workflow never leaves partial
  // state in this pass. Outbound requests already issued stay pending and are sent with the pass.
  private async runWorkflow(workflowId: string, input: unknown): Promise<unknown> {
    const workflow = typeof workflowId === "string" && Object.hasOwn(this.env.workflows, workflowId) ? this.env.workflows[workflowId] : undefined;
    if (workflow === undefined) {
      throw new ScriptFailure("WORKFLOW_NOT_FOUND", `ns.workflows.run: no workflow "${String(workflowId)}".`, 500);
    }
    if (input !== undefined && !isRecord(input)) {
      throw new TypeError("ns.workflows.run: input must be an object.");
    }
    const snapshot = this.writes.snapshot();
    try {
      return await workflow(input ?? {}, this.ns);
    } catch (error) {
      this.writes.restore(snapshot);
      throw error;
    }
  }

  private async readSecret(name: string): Promise<string | null> {
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError("ns.secrets.get: name must be a non-empty string.");
    }
    try {
      return await this.env.secrets.get(name);
    } catch {
      throw new ScriptFailure("SECRET_UNAVAILABLE", `ns.secrets.get: "${name}" is unavailable.`, 500);
    }
  }

  private fetch(url: string, options: FetchOptions | undefined): FetchResponse | null {
    const call = parseFetchCall(url, options);
    const done = this.completed.get(call.key);
    if (done !== undefined) return deliver(done);
    const refusal = refuseHost(call.host, this.env.fetchPolicy);
    if (refusal !== null) throw new FetchError(refusal.code, refusal.message);
    if (this.completed.size + this.pending.size >= FETCH_LIMITS.maxRequestsPerExecution) {
      throw new FetchError(
        "FETCH_LIMIT_EXCEEDED",
        `ns.fetch: one execution may make at most ${FETCH_LIMITS.maxRequestsPerExecution} outbound requests.`,
      );
    }
    this.pending.set(call.key, call);
    return null;
  }
}

function deliver(outcome: FetchOutcome): FetchResponse {
  if (outcome.response !== null) return outcome.response;
  const failure = outcome.failure;
  throw new FetchError(failure?.code ?? "FETCH_FAILED", failure?.message ?? "ns.fetch: the request failed.");
}

// Reads fall through to storage. Writes and deletes are held until the run commits.
class RecordOverlay {
  private readonly store: EndpointStorage["records"];
  private staged = new Map<string, RecordWrite>();
  private readonly versions = new Map<string, ExpectedVersion>();

  constructor(store: EndpointStorage["records"]) {
    this.store = store;
  }

  async get(collection: string, key: string): Promise<RecordData | null> {
    requireName(collection, key);
    const write = this.staged.get(stagedKey(collection, key));
    if (write !== undefined) return write.op === "put" ? copy(write.data) : null;
    const stored = await this.store.getVersioned(collection, key);
    this.observe(collection, key, stored.version);
    return stored.data === null ? null : copy(stored.data);
  }

  async put(collection: string, key: string, data: unknown): Promise<void> {
    requireName(collection, key);
    if (!isRecord(data)) throw new TypeError("ns.records.put: data must be an object.");
    this.staged.set(stagedKey(collection, key), { op: "put", collection, key, data: copy(data) });
  }

  async delete(collection: string, key: string): Promise<void> {
    requireName(collection, key);
    this.staged.set(stagedKey(collection, key), { op: "delete", collection, key });
  }

  async list(collection: string): Promise<RecordData[]> {
    requireName(collection, undefined);
    const rows = new Map<string, RecordData>();
    for (const row of await this.store.list(collection)) {
      this.observe(collection, row.key, row.version);
      rows.set(row.key, row.data);
    }
    for (const write of this.staged.values()) {
      if (write.collection !== collection) continue;
      if (write.op === "put") rows.set(write.key, write.data);
      else rows.delete(write.key);
    }
    return [...rows.values()].map((data) => copy(data));
  }

  // The first read of a key fixes the version the run depends on. Later reads see the same version.
  private observe(collection: string, key: string, version: number): void {
    const id = stagedKey(collection, key);
    if (!this.versions.has(id)) this.versions.set(id, { collection, key, version });
  }

  expectedVersions(): ExpectedVersion[] {
    return [...this.versions.values()];
  }

  snapshot(): Map<string, RecordWrite> {
    return new Map(this.staged);
  }

  restore(snapshot: Map<string, RecordWrite>): void {
    this.staged = new Map(snapshot);
  }

  stagedWrites(): RecordWrite[] {
    return [...this.staged.values()];
  }
}

function stagedKey(collection: string, key: string): string {
  return JSON.stringify([collection, key]);
}

function requireName(collection: string, key: string | undefined): void {
  if (typeof collection !== "string" || (key !== undefined && typeof key !== "string")) {
    throw new TypeError("ns.records: collection and key must be strings.");
  }
}

function copy(data: RecordData): RecordData {
  return JSON.parse(JSON.stringify(data));
}
