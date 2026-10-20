import { isRecord } from "../util/guards.js";
import { FETCH_LIMITS, FetchError, parseFetchCall, refuseHost, sendFetch, } from "./fetch.js";
// Thrown by ns.fail(). The backend maps it to a status and an error body.
export class ScriptFailure extends Error {
    code;
    status;
    constructor(code, message, status) {
        super(message);
        this.name = "ScriptFailure";
        this.code = code;
        this.status = status;
    }
}
// Runs an endpoint handler to completion. The handler may run several times:
//   - ns.fetch returns null on the first pass for each new request. Those requests are sent after
//     the pass, and the handler runs again with their results.
//   - A pass that throws while requests are pending is discarded, because it probably threw on the
//     null response. The next pass decides the outcome.
// Writes are staged per pass and committed only when a pass completes without pending requests.
// Logs from discarded passes are dropped.
export async function runEndpoint(definition, request, env) {
    const completed = new Map();
    for (;;) {
        const pass = new Pass(env, completed);
        let value;
        let failure = null;
        try {
            value = await definition.handle(request, pass.ns());
        }
        catch (error) {
            failure = { error };
        }
        if (pass.pending.size === 0) {
            if (failure !== null)
                throw failure.error;
            for (const entry of pass.logs)
                env.log(entry);
            return { value, writes: pass.writes.stagedWrites() };
        }
        const sent = await Promise.all([...pass.pending.entries()].map(async ([key, call]) => [key, await sendFetch(call, env.fetchPolicy)]));
        for (const [key, outcome] of sent)
            completed.set(key, outcome);
    }
}
// State for one pass of the handler.
class Pass {
    pending = new Map();
    logs = [];
    writes;
    env;
    completed;
    constructor(env, completed) {
        this.env = env;
        this.completed = completed;
        this.writes = new RecordOverlay(env.storage.records);
    }
    ns() {
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
    fetch(url, options) {
        const call = parseFetchCall(url, options);
        const done = this.completed.get(call.key);
        if (done !== undefined)
            return deliver(done);
        const refusal = refuseHost(call.host, this.env.fetchPolicy);
        if (refusal !== null)
            throw new FetchError(refusal.code, refusal.message);
        if (this.completed.size + this.pending.size >= FETCH_LIMITS.maxRequestsPerExecution) {
            throw new FetchError("FETCH_LIMIT_EXCEEDED", `ns.fetch: one execution may make at most ${FETCH_LIMITS.maxRequestsPerExecution} outbound requests.`);
        }
        this.pending.set(call.key, call);
        return null;
    }
}
function deliver(outcome) {
    if (outcome.response !== null)
        return outcome.response;
    const failure = outcome.failure;
    throw new FetchError(failure?.code ?? "FETCH_FAILED", failure?.message ?? "ns.fetch: the request failed.");
}
// Reads fall through to storage. Writes and deletes are held until the run commits.
class RecordOverlay {
    store;
    staged = new Map();
    constructor(store) {
        this.store = store;
    }
    async get(collection, key) {
        requireName(collection, key);
        const write = this.staged.get(stagedKey(collection, key));
        if (write !== undefined)
            return write.op === "put" ? copy(write.data) : null;
        const stored = await this.store.get(collection, key);
        return stored === null ? null : copy(stored);
    }
    async put(collection, key, data) {
        requireName(collection, key);
        if (!isRecord(data))
            throw new TypeError("ns.records.put: data must be an object.");
        this.staged.set(stagedKey(collection, key), { op: "put", collection, key, data: copy(data) });
    }
    async delete(collection, key) {
        requireName(collection, key);
        this.staged.set(stagedKey(collection, key), { op: "delete", collection, key });
    }
    async list(collection) {
        requireName(collection, undefined);
        const rows = new Map();
        for (const row of await this.store.list(collection))
            rows.set(row.key, row.data);
        for (const write of this.staged.values()) {
            if (write.collection !== collection)
                continue;
            if (write.op === "put")
                rows.set(write.key, write.data);
            else
                rows.delete(write.key);
        }
        return [...rows.values()].map((data) => copy(data));
    }
    stagedWrites() {
        return [...this.staged.values()];
    }
}
function stagedKey(collection, key) {
    return JSON.stringify([collection, key]);
}
function requireName(collection, key) {
    if (typeof collection !== "string" || (key !== undefined && typeof key !== "string")) {
        throw new TypeError("ns.records: collection and key must be strings.");
    }
}
function copy(data) {
    return JSON.parse(JSON.stringify(data));
}
