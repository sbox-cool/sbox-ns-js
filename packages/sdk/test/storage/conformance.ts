// Behavior every storage provider must share. Each provider's test file calls runConformance() with a
// factory that opens storage over its real backend. Nothing here mocks a provider.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EndpointStorageOptions } from "../../src/storage/engine.js";
import {
  StorageError,
  type CollectionDefinition,
  type EndpointStorage,
  type RecordData,
  type StorageErrorCode,
} from "../../src/storage/index.js";

export type StorageConfig = Pick<EndpointStorageOptions, "collections" | "values" | "seed">;

export interface ConformanceFixture {
  name: string;
  // True when reopening the same store name sees previously committed data (SQL, D1, KV). Memory is not.
  persistent: boolean;
  // Set when this backend cannot run here (missing driver, server, or wrangler). The suite is then reported
  // as skipped with this reason instead of silently passing.
  skip?: string;
  // Opens storage over the backend store `store`. Opening the same name again reaches the same data.
  open(config: StorageConfig, store: string): Promise<EndpointStorage> | EndpointStorage;
}

const PLAYER_A = "76561198000000001";
const PLAYER_B = "76561198000000002";

const collections: CollectionDefinition[] = [
  {
    id: "profile",
    maxRecords: 1,
    schema: { properties: { score: { type: "integer" } }, required: ["score"] },
  },
  { id: "saves", maxRecords: 3, schema: { properties: { slot: { type: "string" } } } },
  { id: "global_config", collectionType: "global", schema: { properties: { text: { type: "string" } } } },
];

let storeCounter = 0;

export function runConformance(fixture: ConformanceFixture): void {
  const config: StorageConfig = {
    collections,
    values: { game: { maxPlayers: 16, mode: "casual" } },
  };
  const open = (store: string, extra: Partial<StorageConfig> = {}): Promise<EndpointStorage> | EndpointStorage =>
    fixture.open({ ...config, ...extra }, store);
  const freshStore = (): string => `conformance-${fixture.name}-${Date.now()}-${++storeCounter}`;

  describe(`storage conformance: ${fixture.name}`, { skip: fixture.skip }, () => {
    it("rejects an unknown collection on reads and writes", async () => {
      const storage = await open(freshStore());
      await assertRejects(storage.records.get("nope", PLAYER_A), "UNKNOWN_COLLECTION");
      await assertRejects(storage.records.list("nope"), "UNKNOWN_COLLECTION");
      await assertRejects(
        storage.apply([{ collection: "nope", key: PLAYER_A, op: "delete" }]),
        "UNKNOWN_COLLECTION",
      );
    });

    it("reads missing records as null at version 0", async () => {
      const storage = await open(freshStore());
      assert.equal(await storage.records.get("profile", PLAYER_A), null);
      assert.deepEqual(await storage.records.getVersioned("profile", PLAYER_A), { data: null, version: 0 });
    });

    it("creates at version 1 and increments on each update", async () => {
      const storage = await open(freshStore());
      await putRecord(storage, "profile", PLAYER_A, { score: 1 });
      assert.deepEqual(await storage.records.getVersioned("profile", PLAYER_A), { data: { score: 1 }, version: 1 });
      await putRecord(storage, "profile", PLAYER_A, { score: 2 });
      assert.deepEqual(await storage.records.getVersioned("profile", PLAYER_A), { data: { score: 2 }, version: 2 });
    });

    it("lists live records sorted by key and excludes tombstones", async () => {
      const storage = await open(freshStore());
      await putRecord(storage, "saves", `${PLAYER_A}_b`, { slot: "b" });
      await putRecord(storage, "saves", `${PLAYER_A}_a`, { slot: "a" });
      await putRecord(storage, "saves", `${PLAYER_B}_x`, { slot: "x" });
      await storage.apply([{ collection: "saves", key: `${PLAYER_B}_x`, op: "delete" }]);
      const keys = (await storage.records.list("saves")).map((record) => record.key);
      assert.deepEqual(keys, [`${PLAYER_A}_a`, `${PLAYER_A}_b`]);
    });

    it("tombstones per-steamid deletes and keeps the version sequence", async () => {
      const storage = await open(freshStore());
      await putRecord(storage, "profile", PLAYER_A, { score: 1 });
      await storage.apply([{ collection: "profile", key: PLAYER_A, op: "delete" }]);
      assert.deepEqual(await storage.records.getVersioned("profile", PLAYER_A), { data: null, version: 2 });
      await putRecord(storage, "profile", PLAYER_A, { score: 3 });
      assert.deepEqual(await storage.records.getVersioned("profile", PLAYER_A), { data: { score: 3 }, version: 3 });
    });

    it("hard-deletes global records", async () => {
      const storage = await open(freshStore());
      await putRecord(storage, "global_config", "motd", { text: "hi" });
      await storage.apply([{ collection: "global_config", key: "motd", op: "delete" }]);
      assert.deepEqual(await storage.records.getVersioned("global_config", "motd"), { data: null, version: 0 });
      assert.deepEqual(await storage.records.list("global_config"), []);
    });

    it("enforces maxRecords per player, not globally", async () => {
      const storage = await open(freshStore());
      await putRecord(storage, "profile", PLAYER_A, { score: 1 });
      await putRecord(storage, "profile", PLAYER_B, { score: 1 });
      await assertRejects(putCreate(storage, "profile", `${PLAYER_A}_extra`, { score: 2 }), "RECORD_LIMIT_REACHED");
    });

    it("does not count tombstones toward maxRecords", async () => {
      const storage = await open(freshStore());
      await putRecord(storage, "profile", PLAYER_A, { score: 1 });
      await storage.apply([{ collection: "profile", key: PLAYER_A, op: "delete" }]);
      await putRecord(storage, "profile", PLAYER_A, { score: 2 });
      assert.deepEqual(await storage.records.get("profile", PLAYER_A), { score: 2 });
    });

    it("allows up to maxRecords per player and frees a slot after delete", async () => {
      const storage = await open(freshStore());
      for (const slot of ["1", "2", "3"]) await putRecord(storage, "saves", `${PLAYER_A}_${slot}`, { slot });
      await assertRejects(putCreate(storage, "saves", `${PLAYER_A}_4`, { slot: "4" }), "RECORD_LIMIT_REACHED");
      await storage.apply([{ collection: "saves", key: `${PLAYER_A}_2`, op: "delete" }]);
      await putRecord(storage, "saves", `${PLAYER_A}_4`, { slot: "4" });
      assert.equal((await storage.records.list("saves")).length, 3);
    });

    it("judges maxRecords on the whole batch: a delete and a create in one batch fit", async () => {
      const storage = await open(freshStore());
      for (const slot of ["1", "2", "3"]) await putRecord(storage, "saves", `${PLAYER_A}_${slot}`, { slot });
      const observed = (await storage.records.getVersioned("saves", `${PLAYER_A}_2`)).version;
      await storage.apply(
        [
          { collection: "saves", key: `${PLAYER_A}_2`, op: "delete" },
          { collection: "saves", key: `${PLAYER_A}_4`, op: "put", data: { slot: "4" } },
        ],
        {
          expectedVersions: [
            { collection: "saves", key: `${PLAYER_A}_2`, version: observed },
            { collection: "saves", key: `${PLAYER_A}_4`, version: 0 },
          ],
        },
      );
      assert.equal((await storage.records.list("saves")).length, 3);
      await assertRejects(putCreate(storage, "saves", `${PLAYER_A}_5`, { slot: "5" }), "RECORD_LIMIT_REACHED");
    });

    it("rejects a payload that violates the collection schema", async () => {
      const storage = await open(freshStore());
      await assertRejects(putCreate(storage, "profile", PLAYER_A, { score: "high" }), "SCHEMA_VIOLATION");
      await assertRejects(putCreate(storage, "profile", PLAYER_A, {}), "SCHEMA_VIOLATION");
    });

    it("rejects invalid record keys", async () => {
      const storage = await open(freshStore());
      await assertRejects(putCreate(storage, "saves", "bad key!", { slot: "1" }), "INVALID_KEY");
    });

    it("rejects payloads over 64 KiB", async () => {
      const storage = await open(freshStore());
      await assertRejects(putCreate(storage, "saves", `${PLAYER_A}_1`, { blob: "x".repeat(70_000) }), "RECORD_TOO_LARGE");
    });

    it("conflicts when an expected version is stale", async () => {
      const storage = await open(freshStore());
      await putRecord(storage, "profile", PLAYER_A, { score: 1 });
      await assertRejects(
        storage.apply(
          [{ collection: "profile", key: PLAYER_A, op: "put", data: { score: 9 } }],
          { expectedVersions: [{ collection: "profile", key: PLAYER_A, version: 0 }] },
        ),
        "CONFLICT",
      );
      assert.deepEqual(await storage.records.get("profile", PLAYER_A), { score: 1 });
    });

    it("rejects a put that was never observed", async () => {
      const storage = await open(freshStore());
      await assertRejects(
        storage.apply([{ collection: "profile", key: PLAYER_A, op: "put", data: { score: 1 } }]),
        "UNOBSERVED_WRITE",
      );
    });

    it("applies a batch atomically: one failing check leaves every write unapplied", async () => {
      const storage = await open(freshStore());
      await putRecord(storage, "profile", PLAYER_B, { score: 1 });
      await assertRejects(
        storage.apply(
          [
            { collection: "saves", key: `${PLAYER_A}_1`, op: "put", data: { slot: "1" } },
            { collection: "profile", key: PLAYER_B, op: "put", data: { score: 2 } },
          ],
          {
            expectedVersions: [
              { collection: "saves", key: `${PLAYER_A}_1`, version: 0 },
              { collection: "profile", key: PLAYER_B, version: 7 },
            ],
          },
        ),
        "CONFLICT",
      );
      assert.equal(await storage.records.get("saves", `${PLAYER_A}_1`), null);
      assert.deepEqual(await storage.records.get("profile", PLAYER_B), { score: 1 });
    });

    it("lets exactly one of several concurrent creates win a per-player slot", async () => {
      const storage = await open(freshStore());
      const attempts = [1, 2, 3, 4, 5].map((n) => putCreate(storage, "profile", `${PLAYER_A}_${n}`, { score: n }));
      const results = await Promise.allSettled(attempts);
      const won = results.filter((result) => result.status === "fulfilled");
      assert.equal(won.length, 1);
      for (const result of results) {
        if (result.status === "rejected") assertStorageCode(result.reason, ["RECORD_LIMIT_REACHED", "CONFLICT"]);
      }
      assert.equal((await storage.records.list("profile")).length, 1);
    });

    it("lets exactly one of several concurrent updates at one version win", async () => {
      const storage = await open(freshStore());
      await putRecord(storage, "profile", PLAYER_A, { score: 0 });
      const attempts = [1, 2, 3, 4, 5].map((n) =>
        storage.apply(
          [{ collection: "profile", key: PLAYER_A, op: "put", data: { score: n } }],
          { expectedVersions: [{ collection: "profile", key: PLAYER_A, version: 1 }] },
        ),
      );
      const results = await Promise.allSettled(attempts);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      for (const result of results) {
        if (result.status === "rejected") assertStorageCode(result.reason, ["CONFLICT"]);
      }
      const after = await storage.records.getVersioned("profile", PLAYER_A);
      assert.equal(after.version, 2);
    });

    it("reads values as dotted paths and returns null for missing ones", async () => {
      const storage = await open(freshStore());
      assert.equal(await storage.values.get("game.maxPlayers"), 16);
      assert.deepEqual(await storage.values.get("game"), { maxPlayers: 16, mode: "casual" });
      assert.equal(await storage.values.get("game.missing"), null);
      assert.equal(await storage.values.get("missing"), null);
    });

    it("rejects invalid collection configuration at construction", async () => {
      await assertRejects(
        Promise.resolve().then(() => open(freshStore(), { collections: [{ id: "bad", maxRecords: 0 }] })),
        "INVALID_COLLECTION",
      );
    });

    it("seeds absent records at version 1 on construction", async () => {
      const storage = await open(freshStore(), { seed: { profile: { [PLAYER_A]: { score: 5 } } } });
      assert.deepEqual(await storage.records.getVersioned("profile", PLAYER_A), { data: { score: 5 }, version: 1 });
    });

    it("rejects a seed record that violates its schema at construction", async () => {
      await assertRejects(
        Promise.resolve().then(() => open(freshStore(), { seed: { profile: { [PLAYER_A]: { score: "x" } } } })),
        "SCHEMA_VIOLATION",
      );
    });

    if (fixture.persistent) {
      it("does not overwrite existing or tombstoned records when the seed is applied again", async () => {
        const store = freshStore();
        const seed = { profile: { [PLAYER_A]: { score: 5 } } };
        const first = await open(store, { seed });
        await putRecord(first, "profile", PLAYER_A, { score: 6 });
        const reopened = await open(store, { seed });
        assert.deepEqual(await reopened.records.get("profile", PLAYER_A), { score: 6 });
        await reopened.apply([{ collection: "profile", key: PLAYER_A, op: "delete" }]);
        const again = await open(store, { seed });
        assert.deepEqual(await again.records.getVersioned("profile", PLAYER_A), { data: null, version: 3 });
      });

      it("keeps committed data across reopening the same store", async () => {
        const store = freshStore();
        await putRecord(await open(store), "saves", `${PLAYER_A}_1`, { slot: "1" });
        const reopened = await open(store);
        assert.deepEqual(await reopened.records.get("saves", `${PLAYER_A}_1`), { slot: "1" });
      });
    }
  });
}

// Creates a record that must not already exist (expects version 0).
export function putCreate(storage: EndpointStorage, collection: string, key: string, data: RecordData): Promise<void> {
  return storage.apply([{ collection, key, op: "put", data }], { expectedVersions: [{ collection, key, version: 0 }] });
}

// Writes data over whatever version is current, reading the version in the same run.
export async function putRecord(storage: EndpointStorage, collection: string, key: string, data: RecordData): Promise<void> {
  const current = await storage.records.getVersioned(collection, key);
  await storage.apply([{ collection, key, op: "put", data }], { expectedVersions: [{ collection, key, version: current.version }] });
}

export async function assertRejects(promise: Promise<unknown>, code: StorageErrorCode): Promise<void> {
  await assert.rejects(promise, (error: unknown) => assertStorageCode(error, [code]));
}


// Returns true when error is a StorageError with one of the given codes; throws otherwise so the
// failure names the actual error.
function assertStorageCode(error: unknown, codes: StorageErrorCode[]): boolean {
  if (error instanceof StorageError && codes.includes(error.code)) return true;
  throw new Error(`expected StorageError ${codes.join(" or ")}, got ${error instanceof Error ? error.message : String(error)}`);
}
