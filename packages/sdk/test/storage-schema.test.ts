// datetime schema checks through the public memory provider. Matches the server's DateTimeOffset rules:
// impossible calendar dates and out-of-range clock or offset values are rejected, not normalized.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryStorage, StorageError } from "../src/storage/index.js";

const ACCEPTED = [
  "2024-02-29",
  "2000-02-29T10:00:00Z",
  "2024-12-31T23:59:59.1234567+14:00",
  "2024-01-05T10:00",
  "2024-01-05 10:00:00-05:30",
];
const REJECTED = [
  "2023-02-29",
  "1900-02-29",
  "2024-02-30",
  "2024-04-31",
  "2024-12-31T23:59:60Z",
  "2024-12-31T24:00:00Z",
  "2024-01-05T10:00:00+14:30",
  "March 5, 2024",
  "not a date",
];

describe("storage schema: datetime", () => {
  for (const value of ACCEPTED) {
    it(`accepts ${JSON.stringify(value)}`, async () => {
      await putAt(value);
    });
  }
  for (const value of REJECTED) {
    it(`rejects ${JSON.stringify(value)}`, async () => {
      await assert.rejects(putAt(value), (error: unknown) => error instanceof StorageError && error.code === "SCHEMA_VIOLATION");
    });
  }
});

async function putAt(at: string): Promise<void> {
  const store = createMemoryStorage({
    collections: [{ id: "events", collectionType: "global", accessMode: "endpoint", schema: { type: "object", properties: { at: { type: "datetime" } } } }],
  });
  await store.apply([{ op: "put", collection: "events", key: "e1", data: { at } }], {
    expectedVersions: [{ collection: "events", key: "e1", version: 0 }],
  });
}
