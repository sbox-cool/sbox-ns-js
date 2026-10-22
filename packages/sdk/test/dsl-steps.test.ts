import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { compileEndpoint, compileWorkflow } from "../src/dsl/compile.js";
import { DslResponse } from "../src/dsl/steps.js";
import type { ExecutionMode } from "../src/endpoint/execution.js";
import { RunCancelled, ScriptFailure, runEndpoint, type RunEnvironment } from "../src/endpoint/runtime.js";
import type { EndpointHandler, WorkflowFunction } from "../src/endpoint/types.js";
import { createMemoryStorage } from "../src/storage/memory.js";
import { isRecord } from "../src/util/guards.js";

const CLOCK = 1_700_000_000_000;
const DISCORD_URL = "https://discord.com/api/webhooks/1/token";

type Body = Record<string, unknown>;

function environment(execution: ExecutionMode, workflows: Record<string, WorkflowFunction>, signal?: AbortSignal): RunEnvironment {
  return {
    storage: createMemoryStorage({ collections: [] }),
    fetchPolicy: { allowedHosts: [], resolveHost: async () => [] },
    workflows,
    globals: {},
    secrets: { get: () => null },
    now: () => CLOCK,
    trackedFields: () => [],
    log: () => undefined,
    signal,
    execution,
  };
}

function endpointDoc(steps: unknown[], body: unknown): unknown {
  return { sourceVersion: 1, kind: "endpoint", id: "probe", method: "GET", exposure: "public", steps, response: { status: 200, body } };
}

function request(input: Record<string, unknown>): { input: Record<string, unknown>; player: null; method: "GET"; endpoint: string; revision: null } {
  return { input, player: null, method: "GET", endpoint: "probe", revision: null };
}

async function runDoc(
  doc: unknown,
  input: Record<string, unknown> = {},
  execution: ExecutionMode = "declarative",
  signal?: AbortSignal,
): Promise<unknown> {
  const handler: EndpointHandler = compileEndpoint(doc).handler;
  const outcome = await runEndpoint(handler, request(input), environment(execution, {}, signal));
  return outcome.value;
}

// Runs a declarative endpoint and returns the body of its DSL response.
async function bodyOf(doc: unknown, input?: Record<string, unknown>): Promise<Body> {
  const value = await runDoc(doc, input);
  assert.ok(value instanceof DslResponse, "expected a DSL response");
  const body: unknown = value.body;
  assert.ok(isRecord(body), "expected an object body");
  return body;
}

async function failureOf(doc: unknown, input?: Record<string, unknown>): Promise<ScriptFailure> {
  try {
    await runDoc(doc, input);
  } catch (error) {
    if (error instanceof ScriptFailure) return error;
    throw error;
  }
  assert.fail("expected the run to fail");
}

// Lets promises queued so far run, so a sleep that is about to register its timer has done so.
function settle(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function idsOf(rows: unknown): unknown[] {
  assert.ok(Array.isArray(rows), "expected an array");
  return rows.map((row: unknown) => (isRecord(row) ? row["id"] : undefined));
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.timers.reset();
});

describe("sort step", () => {
  it("sorts by key descending with missing values last", async () => {
    const body = await bodyOf(
      endpointDoc([{ id: "ranked", type: "sort", source: "{{ input.rows }}", by: "score", direction: "desc" }], {
        ranked: "{{ ranked }}",
      }),
      {
        rows: [
          { id: "a", score: 2 },
          { id: "b", score: 9 },
          { id: "c" },
          { id: "d", score: 5 },
        ],
      },
    );
    assert.deepEqual(idsOf(body["ranked"]), ["b", "d", "a", "c"]);
  });
});

describe("switch step", () => {
  it("takes the first matching case, then the default", async () => {
    const doc = endpointDoc(
      [
        {
          id: "tier",
          type: "switch",
          cases: [
            { when: { field: "input.n", op: ">", value: 10 }, then: "big" },
            { when: { field: "input.n", op: ">", value: 0 }, then: "small" },
          ],
          default: "none",
        },
      ],
      { tier: "{{ tier }}" },
    );
    assert.equal((await bodyOf(doc, { n: 15 }))["tier"], "big");
    assert.equal((await bodyOf(doc, { n: 3 }))["tier"], "small");
    assert.equal((await bodyOf(doc, { n: 0 }))["tier"], "none");
  });
});

describe("compute step", () => {
  it("evaluates values that depend on sibling values regardless of declaration order", async () => {
    const body = await bodyOf(
      endpointDoc([{ id: "calc", type: "compute", values: { total: "doubled + 1", doubled: "input.base * 2" } }], {
        calc: "{{ calc }}",
      }),
      { base: 5 },
    );
    assert.deepEqual(body["calc"], { total: 11, doubled: 10 });
  });

  it("fails with a circular-dependency error for values that reference each other", async () => {
    const failure = await failureOf(endpointDoc([{ id: "calc", type: "compute", values: { a: "b + 1", b: "a + 1" } }], {}));
    assert.equal(failure.status, 400);
    assert.match(failure.message, /circular or missing dependency/);
  });

  it("fails for a name that nothing defines", async () => {
    const failure = await failureOf(endpointDoc([{ id: "calc", type: "compute", values: { a: "nothere + 1" } }], {}));
    assert.equal(failure.status, 400);
    assert.match(failure.message, /circular or missing dependency/);
  });
});

describe("step findings", () => {
  it("stores a condition with no id or check, and answers ENDPOINT_ERROR.CONDITION 400 when it runs", async () => {
    const doc = endpointDoc([{ type: "condition", field: "player", operator: "is_null", onFail: "return" }], {});
    const failure = await failureOf(doc);
    assert.equal(failure.code, "ENDPOINT_ERROR.CONDITION");
    assert.equal(failure.status, 400);
  });

  it("stores an unsupported step type and fails when it is reached", async () => {
    const failure = await failureOf(endpointDoc([{ id: "x", type: "teleport" }], {}));
    assert.equal(failure.code, "ENDPOINT_ERROR.TELEPORT");
    assert.equal(failure.status, 400);
    assert.match(failure.message, /unsupported step type "teleport"/);
  });

  it("stores a duplicate step id and fails at the second step, not the first", async () => {
    const doc = endpointDoc(
      [
        { id: "calc", type: "compute", values: { a: "1" } },
        { id: "calc", type: "compute", values: { b: "2" } },
      ],
      {},
    );
    const failure = await failureOf(doc);
    assert.equal(failure.code, "ENDPOINT_ERROR.COMPUTE");
    assert.match(failure.message, /duplicate step id "calc"/);
  });
});

describe("random step", () => {
  it("int mode draws from [min, max) only", async () => {
    const doc = endpointDoc([{ id: "roll", type: "random", mode: "int", min: 1, max: 4 }], { roll: "{{ roll }}" });
    for (let i = 0; i < 200; i++) {
      const roll = (await bodyOf(doc))["roll"];
      assert.equal(typeof roll, "number");
      assert.ok(typeof roll === "number" && Number.isInteger(roll) && roll >= 1 && roll < 4, `roll ${String(roll)} outside [1, 4)`);
    }
  });

  it("weighted mode never selects a zero-weight item", async () => {
    const doc = endpointDoc(
      [
        {
          id: "pick",
          type: "random",
          mode: "weighted",
          items: [
            { id: "never", weight: 0 },
            { id: "always", weight: 3 },
          ],
        },
      ],
      { pick: "{{ pick }}" },
    );
    for (let i = 0; i < 100; i++) {
      const pick = (await bodyOf(doc))["pick"];
      assert.ok(isRecord(pick));
      assert.equal(pick["id"], "always");
    }
  });
});

describe("goto, skip and visit limits", () => {
  it("skip jumps over the next step when the route is taken", async () => {
    const body = await bodyOf(
      endpointDoc(
        [
          { id: "gate", type: "condition", check: { field: "input.open", op: "==", value: true }, routes: { true: { action: "skip", count: 1 } } },
          { id: "marker", type: "compute", values: { hit: "true" } },
          { id: "after", type: "compute", values: { ran: "true" } },
        ],
        { marker: "{{ marker }}", after: "{{ after }}" },
      ),
      { open: true },
    );
    assert.equal(body["marker"], undefined);
    assert.deepEqual(body["after"], { ran: true });
  });

  it("goto moves to a later step in the same list", async () => {
    const body = await bodyOf(
      endpointDoc(
        [
          { id: "jump", type: "condition", check: { field: "input.jump", op: "==", value: true }, routes: { true: { action: "goto", target: "end" } } },
          { id: "skipped", type: "compute", values: { v: "1" } },
          { id: "end", type: "compute", values: { v: "2" } },
        ],
        { skipped: "{{ skipped }}", end: "{{ end }}" },
      ),
      { jump: true },
    );
    assert.equal(body["skipped"], undefined);
    assert.deepEqual(body["end"], { v: 2 });
  });

  it("a goto loop fails at the visit limit", async () => {
    const failure = await failureOf(
      endpointDoc([{ id: "loop", type: "condition", check: { field: "input.x", op: "==", value: 1 }, routes: { true: "loop" } }], {}),
      { x: 1 },
    );
    assert.equal(failure.status, 400);
    assert.match(failure.message, /exceeded visit limit/);
  });

  it("stores a goto to a step that is not in scope and fails when the step runs", async () => {
    const doc = endpointDoc(
      [{ id: "a", type: "condition", check: { field: "input.x", op: "==", value: 1 }, routes: { true: { action: "goto", target: "nowhere" } } }],
      {},
    );
    const failure = await failureOf(doc, { x: 1 });
    assert.equal(failure.code, "ENDPOINT_ERROR.CONDITION");
    assert.match(failure.message, /goto target "nowhere" is not a step in scope/);
  });
});

describe("sleep step", () => {
  it("awaits its timer and reports the slept duration", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const doc = endpointDoc([{ id: "pause", type: "sleep", durationMs: 20 }], { slept: "{{ pause.sleptMs }}" });
    let finished = false;
    const pending = runDoc(doc).then((value) => {
      finished = true;
      return value;
    });
    await settle();
    assert.equal(finished, false, "sleep finished before its timer fired");
    mock.timers.tick(20);
    const value = await pending;
    assert.ok(value instanceof DslResponse);
    assert.deepEqual(value.body, { slept: 20 });
  });

  it("rejects a duration over five minutes", async () => {
    const failure = await failureOf(endpointDoc([{ id: "pause", type: "sleep", durationMs: 300001 }], {}));
    assert.equal(failure.status, 400);
    assert.match(failure.message, /exceeds max 300000ms/);
  });

  it("cancels a declarative sleep when the run is aborted", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const controller = new AbortController();
    const pending = runDoc(endpointDoc([{ id: "pause", type: "sleep", durationMs: 60000 }], {}), {}, "declarative", controller.signal);
    await settle();
    controller.abort();
    await assert.rejects(pending, RunCancelled);
  });

  it("is skipped under the scripted budget and reports the requested duration", async () => {
    const handler: EndpointHandler = compileEndpoint(
      endpointDoc([{ id: "pause", type: "sleep", durationMs: 300000 }], { slept: "{{ pause.sleptMs }}" }),
    ).handler;
    const outcome = await runEndpoint(handler, request({}), environment("scripted", {}));
    assert.ok(outcome.value instanceof DslResponse);
    assert.deepEqual(outcome.value.body, { slept: 300000 });
  });
});

describe("webhook step", () => {
  it("rejects a URL that is not a Discord webhook", async () => {
    const failure = await failureOf(endpointDoc([{ id: "hook", type: "webhook", url: "https://example.com/hook", title: "t" }], {}));
    assert.equal(failure.status, 400);
  });

  it("posts the embed to Discord and returns the real result", async () => {
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body ?? "") });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const body = await bodyOf(
      endpointDoc([{ id: "hook", type: "webhook", url: DISCORD_URL, title: "Hello", description: "World", color: "ff0000" }], {
        hook: "{{ hook }}",
      }),
    );
    assert.deepEqual(body["hook"], { ok: true, status: 204 });
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(call !== undefined);
    assert.equal(call.url, DISCORD_URL);
    const sent = JSON.parse(call.body);
    assert.equal(sent.embeds[0].title, "Hello");
    assert.equal(sent.embeds[0].description, "World");
    assert.equal(sent.embeds[0].color, 0xff0000);
  });

  it("is refused inside a workflow run by a scripted endpoint", async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const workflow = compileWorkflow({
      sourceVersion: 1,
      kind: "workflow",
      id: "notify",
      definition: {
        steps: [{ id: "hook", type: "webhook", url: DISCORD_URL, title: "t" }],
        returns: { hook: "{{ hook }}" },
      },
    }).definition;
    const handler: EndpointHandler = (_request, ns) => ns.workflows.run("notify", {});
    const outcome = await runEndpoint(handler, request({}), environment("scripted", { notify: workflow }));
    assert.deepEqual(outcome.value, {
      hook: { ok: false, status: 0, error: "webhooks are not available to scripted endpoints" },
    });
    assert.equal(fetched, false);
  });
});
