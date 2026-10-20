import assert from "node:assert/strict";
import { test } from "node:test";
import { createSboxNsClient, isSboxNsError } from "../src/client/index.js";

const base = { baseUrl: "https://ns.test/", projectId: "proj_1", secretKey: "sbox_ns_sk_1" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("sends the secret key once, against the trimmed base URL", async () => {
  let url = "";
  let secret = "";
  const client = createSboxNsClient({
    ...base,
    fetch: async (input, init) => {
      url = input;
      secret = (init.headers as Record<string, string>)["x-secret-key"] ?? "";
      return jsonResponse({ ok: true, success: true });
    },
  });
  const body = await client.get<{ success: boolean }>("ping");
  assert.equal(body.success, true);
  assert.equal(url, "https://ns.test/v1/endpoints/proj_1/ping");
  assert.equal(secret, "sbox_ns_sk_1");
});

test("a network failure is a typed NETWORK_ERROR and is never retried", async () => {
  let attempts = 0;
  const client = createSboxNsClient({
    ...base,
    fetch: async () => {
      attempts += 1;
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(client.get("ping"), (error: unknown) => {
    return isSboxNsError(error) && error.status === 0 && error.code === "NETWORK_ERROR";
  });
  assert.equal(attempts, 1);
});

test("a library envelope on HTTP 200 surfaces its real status and code", async () => {
  const client = createSboxNsClient({
    ...base,
    fetch: async () => jsonResponse({ ok: false, status: 403, error: { code: "FORBIDDEN", message: "no" } }),
  });
  await assert.rejects(client.call("submit", {}), (error: unknown) => {
    return isSboxNsError(error) && error.status === 403 && error.code === "FORBIDDEN" && error.message === "no";
  });
});

test("a plain failure keeps its HTTP status and carries the body", async () => {
  const body = { ok: false, error: { code: "INVALID_SCORE", message: "score must be a number." } };
  const client = createSboxNsClient({ ...base, fetch: async () => jsonResponse(body, 400) });
  await assert.rejects(client.call("clamp-score", {}), (error: unknown) => {
    return isSboxNsError(error) && error.status === 400 && error.code === "INVALID_SCORE" && error.body !== undefined;
  });
});

test("a body that is not JSON is INVALID_RESPONSE with the HTTP status", async () => {
  const client = createSboxNsClient({ ...base, fetch: async () => new Response("<html>", { status: 502 }) });
  await assert.rejects(client.get("ping"), (error: unknown) => {
    return isSboxNsError(error) && error.status === 502 && error.code === "INVALID_RESPONSE";
  });
});

test("records.get returns null for a missing key (storage NOT_FOUND shape)", async () => {
  const client = createSboxNsClient({
    ...base,
    fetch: async () => jsonResponse({ error: "NOT_FOUND", detail: "Key not found." }, 404),
  });
  assert.equal(await client.records.get("scores", "missing"), null);
});

test("records.get still throws for other failures", async () => {
  const client = createSboxNsClient({
    ...base,
    fetch: async () => jsonResponse({ error: "FORBIDDEN", detail: "no" }, 403),
  });
  await assert.rejects(client.records.get("scores", "x"), (error: unknown) => {
    return isSboxNsError(error) && error.status === 403 && error.code === "FORBIDDEN";
  });
});
