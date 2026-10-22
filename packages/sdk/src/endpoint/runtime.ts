import type { EndpointStorage, ExpectedVersion, RecordData, RecordWrite, StoredRecord, VersionedRecord } from "../storage/index.js";
import { isRecord } from "../util/guards.js";
import { ledgerWritesOf } from "./ledger.js";
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
import type { EndpointGlobal, EndpointHandler, EndpointRequest, FetchOptions, FetchResponse, Ns, WorkflowFunction } from "./types.js";
import { RUN_INTERNALS, type ExecutionMode, type RunInternals } from "./execution.js";

// Thrown by ns.fail(). The backend maps it to a status and an error body. `details` join the body; `errorFields`
// join the `error` object (the reference's step failures carry docsUrl and step there).
export class ScriptFailure extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>>;
  readonly errorFields: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: string,
    message: string,
    status: number,
    details: Readonly<Record<string, unknown>> = {},
    errorFields?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ScriptFailure";
    this.code = code;
    this.status = status;
    this.details = details;
    this.errorFields = errorFields;
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
  // Dotted paths of the number fields marked _ledger on a collection. Empty for collections that are not ledgered.
  trackedFields: (collection: string) => readonly string[];
  log: (value: unknown) => void;
  // Aborts pending outbound requests and stops further passes.
  signal?: AbortSignal;
  // "scripted" runs never wait on sleep or send webhooks; see execution.ts.
  execution: ExecutionMode;
}

export interface RunOutcome {
  value: unknown;
  writes: RecordWrite[];
  // Versions of every stored record this run read. Passed to apply() so a concurrent write fails the run
  // with CONFLICT instead of being silently lost.
  expectedVersions: ExpectedVersion[];
}

// Caps for one run. A state round loads what the last pass read for the first time, so the round count is the depth of
// dependent reads. A round loads at most MAX_LOADS_PER_ROUND keys.
const MAX_STATE_ROUNDS = 8;
const MAX_LOADS_PER_ROUND = 64;

// Handlers read state synchronously, as server scripts do. A read the run has not loaded yet returns null and records
// a need. A pass that recorded a need is discarded: the needs are loaded from storage and the handler runs again.
// Outbound requests are sent only from a pass whose state is complete. That pass is discarded, the requests are sent,
// and the handler runs again with the responses. Writes are staged per pass and committed only when a pass completes
// with no needs and no pending requests. Logs from discarded passes are dropped.
export async function runEndpoint(
  handler: EndpointHandler,
  request: EndpointRequest,
  env: RunEnvironment,
): Promise<RunOutcome> {
  const memo: RunMemo = { fetches: new Map(), results: new Map() };
  const state: RunState = { records: new Map(), lists: new Map(), values: new Map(), secrets: new Map() };
  let stateRounds = 0;
  for (;;) {
    throwIfCancelled(env.signal);
    const pass = new Pass(env, state, memo);
    let value: unknown;
    let failure: { error: unknown } | null = null;
    try {
      value = handler(request, pass.ns, { globals: env.globals });
      if (isThenable(value)) {
        // The rejection is observed here, so it cannot surface as an unhandled promise rejection.
        Promise.resolve(value).catch(() => undefined);
        throw new TypeError("Endpoint handlers must be synchronous; ns reads and writes are synchronous.");
      }
    } catch (error) {
      failure = { error };
    }
    throwIfCancelled(env.signal);
    if (pass.needs.size > 0) {
      stateRounds += 1;
      if (stateRounds > MAX_STATE_ROUNDS) {
        throw new ScriptFailure(
          "STATE_ROUNDS_EXCEEDED",
          `The endpoint run read dependent state in more than ${MAX_STATE_ROUNDS} rounds.`,
          500,
        );
      }
      if (pass.needs.size > MAX_LOADS_PER_ROUND) {
        throw new ScriptFailure(
          "STATE_LOADS_EXCEEDED",
          `The endpoint run loaded more than ${MAX_LOADS_PER_ROUND} state keys in one round.`,
          500,
        );
      }
      await Promise.all([...pass.needs.values()].map((load) => load()));
      continue;
    }
    if (pass.pending.size > 0) {
      const sent = await Promise.all(
        [...pass.pending.entries()].map(
          async ([key, call]) => [key, await sendFetch(call, env.fetchPolicy, env.signal)] as const,
        ),
      );
      for (const [key, outcome] of sent) memo.fetches.set(key, outcome);
      continue;
    }
    if (pass.suspension !== null) {
      const { key, perform } = pass.suspension;
      memo.results.set(key, await perform(env.signal));
      continue;
    }
    if (failure !== null) throw failure.error;
    for (const entry of pass.logs) env.log(entry);
    const staged = pass.writes.stagedWrites();
    const ledger = ledgerWritesOf({
      writes: staged,
      before: (collection, key) => state.records.get(stagedKey(collection, key))?.data ?? null,
      trackedFields: env.trackedFields,
      source: request.endpoint,
      now: env.now(),
      newId: () => crypto.randomUUID().replaceAll("-", ""),
    });
    return {
      value,
      writes: [...staged, ...ledger.writes],
      expectedVersions: [...pass.writes.expectedVersions(), ...ledger.expectedVersions],
    };
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new RunCancelled();
}

function isThenable(value: unknown): boolean {
  return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}

// State loaded from storage for one run. Shared across passes so every pass sees the same snapshot.
interface RunState {
  records: Map<string, VersionedRecord>;
  lists: Map<string, StoredRecord[]>;
  values: Map<string, unknown>;
  secrets: Map<string, string | null>;
}

// Results shared across the passes of one run.
interface RunMemo {
  // Outbound responses, keyed by request.
  fetches: Map<string, FetchOutcome>;
  // Memoized computations and performed effects, keyed by name and occurrence.
  results: Map<string, unknown>;
}

// Thrown when the handler reaches an effect the run has not performed yet. The pass is discarded.
class Suspended extends Error {}
const SUSPENDED = new Suspended("effect pending");

// State for one pass of the handler.
class Pass {
  readonly pending = new Map<string, ParsedFetch>();
  readonly needs = new Map<string, () => Promise<void>>();
  readonly logs: unknown[] = [];
  readonly writes: RecordOverlay;
  readonly ns: Ns;
  private readonly env: RunEnvironment;
  private readonly state: RunState;
  private readonly memo: RunMemo;
  private readonly occurrences = new Map<string, number>();
  suspension: { key: string; perform: (signal: AbortSignal | undefined) => Promise<unknown> } | null = null;

  constructor(env: RunEnvironment, state: RunState, memo: RunMemo) {
    this.env = env;
    this.state = state;
    this.memo = memo;
    this.writes = new RecordOverlay(env, state, this.needs);
    this.ns = this.buildNs();
    Object.defineProperty(this.ns, RUN_INTERNALS, { value: this.internals() });
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
        get: (path) => this.readValue(path),
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

  // Internal channel for the DSL interpreter, bound to this pass and to the run's memo.
  private internals(): RunInternals {
    return {
      mode: this.env.execution,
      memo: <T>(name: string, compute: () => T): T => {
        const key = this.occurrenceKey(name);
        if (this.memo.results.has(key)) return this.memo.results.get(key) as T;
        const value = compute();
        this.memo.results.set(key, value);
        return value;
      },
      effect: <T>(name: string, perform: (signal: AbortSignal | undefined) => Promise<T>): T => {
        const key = this.occurrenceKey(name);
        if (this.memo.results.has(key)) return this.memo.results.get(key) as T;
        if (this.env.execution === "scripted") {
          throw new TypeError(`ns: effect "${name}" is not available to scripted runs.`);
        }
        this.suspension ??= { key, perform };
        throw SUSPENDED;
      },
    };
  }

  // Each call of a name within one pass takes the next occurrence number, so the same call in every pass maps to the same key.
  private occurrenceKey(name: string): string {
    const occurrence = this.occurrences.get(name) ?? 0;
    this.occurrences.set(name, occurrence + 1);
    return JSON.stringify([name, occurrence]);
  }

  // Workflow writes are rolled back when the workflow throws, so a failed workflow never leaves partial
  // state in this pass. Outbound requests already issued stay pending and are sent with the pass.
  private runWorkflow(workflowId: string, input: unknown): unknown {
    const workflow = typeof workflowId === "string" && Object.hasOwn(this.env.workflows, workflowId) ? this.env.workflows[workflowId] : undefined;
    if (workflow === undefined) {
      throw new ScriptFailure("WORKFLOW_NOT_FOUND", `ns.workflows.run: no workflow "${String(workflowId)}".`, 500);
    }
    if (input !== undefined && !isRecord(input)) {
      throw new TypeError("ns.workflows.run: input must be an object.");
    }
    const snapshot = this.writes.snapshot();
    try {
      const result = workflow(input ?? {}, this.ns);
      if (isThenable(result)) {
        Promise.resolve(result).catch(() => undefined);
        throw new TypeError("ns.workflows.run: workflows must be synchronous.");
      }
      return result;
    } catch (error) {
      this.writes.restore(snapshot);
      throw error;
    }
  }

  private readValue(path: string): unknown {
    if (typeof path !== "string") throw new TypeError("ns.values.get: path must be a string.");
    if (this.state.values.has(path)) return this.state.values.get(path) ?? null;
    this.needs.set(JSON.stringify(["value", path]), async () => {
      this.state.values.set(path, await this.env.storage.values.get(path));
    });
    return null;
  }

  private readSecret(name: string): string | null {
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError("ns.secrets.get: name must be a non-empty string.");
    }
    if (this.state.secrets.has(name)) return this.state.secrets.get(name) ?? null;
    this.needs.set(JSON.stringify(["secret", name]), async () => {
      try {
        this.state.secrets.set(name, await this.env.secrets.get(name));
      } catch {
        throw new ScriptFailure("SECRET_UNAVAILABLE", `ns.secrets.get: "${name}" is unavailable.`, 500);
      }
    });
    return null;
  }

  private fetch(url: string, options: FetchOptions | undefined): FetchResponse | null {
    const call = parseFetchCall(url, options);
    const done = this.memo.fetches.get(call.key);
    if (done !== undefined) return deliver(done);
    const refusal = refuseHost(call.host, this.env.fetchPolicy);
    if (refusal !== null) throw new FetchError(refusal.code, refusal.message);
    if (this.memo.fetches.size + this.pending.size >= FETCH_LIMITS.maxRequestsPerExecution) {
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

// Reads fall through to the run's loaded state. Writes and deletes are held until the run commits.
class RecordOverlay {
  private readonly env: RunEnvironment;
  private readonly state: RunState;
  private readonly needs: Map<string, () => Promise<void>>;
  private staged = new Map<string, RecordWrite>();
  private readonly versions = new Map<string, ExpectedVersion>();

  constructor(env: RunEnvironment, state: RunState, needs: Map<string, () => Promise<void>>) {
    this.env = env;
    this.state = state;
    this.needs = needs;
  }

  get(collection: string, key: string): RecordData | null {
    requireName(collection, key);
    const id = stagedKey(collection, key);
    const write = this.staged.get(id);
    if (write !== undefined) return write.op === "put" ? copy(write.data) : null;
    const loaded = this.state.records.get(id);
    if (loaded === undefined) {
      this.needs.set(JSON.stringify(["record", collection, key]), async () => {
        this.state.records.set(id, await this.env.storage.records.getVersioned(collection, key));
      });
      return null;
    }
    this.observe(collection, key, loaded.version);
    return loaded.data === null ? null : copy(loaded.data);
  }

  put(collection: string, key: string, data: unknown): void {
    requireName(collection, key);
    if (!isRecord(data)) throw new TypeError("ns.records.put: data must be an object.");
    this.staged.set(stagedKey(collection, key), { op: "put", collection, key, data: copy(data) });
  }

  delete(collection: string, key: string): void {
    requireName(collection, key);
    this.staged.set(stagedKey(collection, key), { op: "delete", collection, key });
  }

  list(collection: string): RecordData[] {
    requireName(collection, undefined);
    const rows = this.state.lists.get(collection);
    if (rows === undefined) {
      this.needs.set(JSON.stringify(["list", collection]), async () => {
        this.state.lists.set(collection, await this.env.storage.records.list(collection));
      });
      return [];
    }
    const merged = new Map<string, RecordData>();
    for (const row of rows) {
      this.observe(collection, row.key, row.version);
      merged.set(row.key, row.data);
    }
    for (const write of this.staged.values()) {
      if (write.collection !== collection) continue;
      if (write.op === "put") merged.set(write.key, write.data);
      else merged.delete(write.key);
    }
    return [...merged.values()].map((data) => copy(data));
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
