import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isProtocolError } from "../src/protocol/errors.js";
import { createMemoryReplayStore, type ReplayStore } from "../src/protocol/index.js";
import { consumeRequestId } from "../src/protocol/replay.js";

const WINDOW = 120;
const ISSUED = 1_800_000_000;
const PROJECT = "proj_replay";
const IDENTITY = "steam:76561198000000001";
const OTHER_IDENTITY = "steam:76561198000000002";

const REPLAY = "ENCRYPTED_REQUEST_REPLAY_DETECTED";
const STALE = "ENCRYPTED_REQUEST_STALE";


// One consume at `nowMs`: `accepted`, or the refusal code.
async function consume(
  store: ReplayStore,
  requestId: string,
  nowMs: number,
  options: { windowSeconds?: number; identityKey?: string } = {},
): Promise<string> {
  try {
    await consumeRequestId(store, {
      projectId: PROJECT,
      identityKey: options.identityKey ?? IDENTITY,
      requestId,
      windowSeconds: options.windowSeconds ?? WINDOW,
      nowMs,
    });
    return "accepted";
  } catch (error) {
    if (isProtocolError(error)) return error.code;
    throw error;
  }
}

// The first and last millisecond of every second in the inclusive range.
function secondEdges(fromSeconds: number, toSeconds: number): number[] {
  const instants: number[] = [];
  for (let second = fromSeconds; second <= toSeconds; second += 1) {
    instants.push(second * 1000, second * 1000 + 999);
  }
  return instants;
}

describe("encrypted request replay window boundary", () => {
    it("keeps a past-issued id blocked through the last accepted millisecond", async () => {
      const store = createMemoryReplayStore();
      const requestId = `${ISSUED}_pastId`;
      assert.equal(await consume(store, requestId, ISSUED * 1000), "accepted");
      for (const nowMs of secondEdges(ISSUED, ISSUED + WINDOW)) {
        assert.equal(await consume(store, requestId, nowMs), REPLAY, `replay at ${nowMs} must be blocked`);
      }
      assert.equal(await consume(store, requestId, (ISSUED + WINDOW + 1) * 1000), STALE);
      assert.equal(await consume(store, requestId, (ISSUED + WINDOW + 1) * 1000 + 5_000), STALE);
    });

    it("blocks a replay at the inclusive window edge when the first use was just before it", async () => {
      const store = createMemoryReplayStore();
      const requestId = `${ISSUED}_edgeId1`;
      const edge = (ISSUED + WINDOW) * 1000;
      assert.equal(await consume(store, requestId, edge - 1), "accepted");
      assert.equal(await consume(store, requestId, edge), REPLAY);
      assert.equal(await consume(store, requestId, edge + 999), REPLAY);
      assert.equal(await consume(store, requestId, edge + 1000), STALE);
    });

    it("blocks a future-issued id through its whole accepted range", async () => {
      const store = createMemoryReplayStore();
      const issued = ISSUED + WINDOW;
      const requestId = `${issued}_futureId`;
      // The earliest accepted instant is `issued - window`; the millisecond before it is stale.
      assert.equal(await consume(store, requestId, (issued - WINDOW) * 1000 - 1), STALE);
      assert.equal(await consume(store, requestId, (issued - WINDOW) * 1000), "accepted");
      for (const nowMs of secondEdges(issued - WINDOW, issued + WINDOW)) {
        assert.equal(await consume(store, requestId, nowMs), REPLAY, `replay at ${nowMs} must be blocked`);
      }
      assert.equal(await consume(store, requestId, (issued + WINDOW + 1) * 1000), STALE);
    });

    it("keeps the claim scoped to the identity", async () => {
      const store = createMemoryReplayStore();
      const requestId = `${ISSUED}_scopeId`;
      const edge = (ISSUED + WINDOW) * 1000;
      assert.equal(await consume(store, requestId, ISSUED * 1000), "accepted");
      assert.equal(await consume(store, requestId, edge), REPLAY);
      assert.equal(await consume(store, requestId, edge, { identityKey: OTHER_IDENTITY }), "accepted");
    });

    it("applies the window it is given, so a shorter window closes its own edge", async () => {
      const store = createMemoryReplayStore();
      const requestId = `${ISSUED}_shortId`;
      const short = 30;
      const edge = (ISSUED + short) * 1000;
      assert.equal(await consume(store, requestId, ISSUED * 1000, { windowSeconds: short }), "accepted");
      assert.equal(await consume(store, requestId, edge, { windowSeconds: short }), REPLAY);
      assert.equal(await consume(store, requestId, edge + 1000, { windowSeconds: short }), STALE);
    });
});
