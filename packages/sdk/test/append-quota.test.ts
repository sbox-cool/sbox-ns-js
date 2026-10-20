import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProtocolError } from "../src/protocol/errors.js";
import { takeAppendQuota } from "../src/server/storage-routes.js";

const NOON = Date.parse("2025-03-01T12:00:00Z");
const NEXT_MIDNIGHT = Date.parse("2025-03-02T00:00:00Z");
const DAILY_LIMIT = 8640;
const WRITER_A = "76561198000000001";
const WRITER_B = "76561198000000002";

describe("global append daily quota", () => {
  it("allows 8640 appends per writer per collection per UTC day and rejects the next with RATE_LIMIT_DAILY", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < DAILY_LIMIT; i++) takeAppendQuota(counts, NOON, "scores", WRITER_A);
    assert.throws(
      () => takeAppendQuota(counts, NOON, "scores", WRITER_A),
      (error: unknown) => {
        assert.ok(error instanceof ProtocolError);
        assert.equal(error.status, 429);
        assert.equal(error.code, "RATE_LIMIT_DAILY");
        assert.equal(
          error.message,
          "Rate limit exceeded for this player: max 8640 saves per day (~360/hr, ~6.0/min). Resets at midnight UTC.",
        );
        return true;
      },
    );
  });

  it("counts each writer and each collection separately", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < DAILY_LIMIT; i++) takeAppendQuota(counts, NOON, "scores", WRITER_A);
    assert.doesNotThrow(() => takeAppendQuota(counts, NOON, "scores", WRITER_B));
    assert.doesNotThrow(() => takeAppendQuota(counts, NOON, "events", WRITER_A));
  });

  it("starts a fresh count after UTC midnight and drops earlier days' counters", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < DAILY_LIMIT; i++) takeAppendQuota(counts, NOON, "scores", WRITER_A);
    takeAppendQuota(counts, NEXT_MIDNIGHT, "scores", WRITER_A);
    assert.deepEqual([...counts.keys()], [`scores:${WRITER_A}:2025-03-02`]);
    assert.equal(counts.get(`scores:${WRITER_A}:2025-03-02`), 1);
  });
});
