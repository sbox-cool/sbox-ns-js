import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { after, afterEach, before, describe, it, mock } from "node:test";
import {
  MAX_SLEEP_MS,
  fitEmbed,
  isDiscordWebhookUrl,
  postDiscordWebhook,
  sleepFor,
  type DiscordEmbed,
  type DiscordPayload,
} from "../src/dsl/effects.js";
import { betaSample, randomFloat, randomInt, weightedSelect } from "../src/dsl/random.js";
import { RunCancelled } from "../src/endpoint/runtime.js";

describe("sleepFor", () => {
  afterEach(() => mock.timers.reset());

  it("resolves only once the full duration has elapsed", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    let done = false;
    const pending = sleepFor(1000, undefined).then(() => {
      done = true;
    });
    mock.timers.tick(999);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(done, false);
    mock.timers.tick(1);
    await pending;
    assert.equal(done, true);
  });

  it("rejects with RunCancelled when the run aborts during the sleep", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const controller = new AbortController();
    const pending = sleepFor(60_000, controller.signal);
    controller.abort();
    await assert.rejects(pending, RunCancelled);
  });

  it("rejects immediately when the run signal is already aborted", async () => {
    await assert.rejects(sleepFor(1, AbortSignal.abort()), RunCancelled);
  });

  it("caps sleeps at five minutes", () => {
    assert.equal(MAX_SLEEP_MS, 300000);
  });
});

describe("postDiscordWebhook", () => {
  let server: Server;
  let base = "";
  const received: { path: string; body: string; contentType: string | undefined }[] = [];

  function answer(request: IncomingMessage, response: ServerResponse): void {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      received.push({ path: request.url ?? "", body, contentType: request.headers["content-type"] });
      if (request.url === "/fail") {
        response.writeHead(500);
        response.end("x".repeat(600));
        return;
      }
      response.writeHead(204);
      response.end();
    });
  }

  before(async () => {
    server = createServer(answer);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address === "object", "server has no port");
    base = `http://127.0.0.1:${address.port}`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const payload: DiscordPayload = {
    embeds: [{ title: "t", description: "d", color: 1, fields: [], timestamp: "2024-01-01T00:00:00.000Z" }],
  };

  it("reports a 2xx response as ok and posts the payload as JSON", async () => {
    const result = await postDiscordWebhook(`${base}/ok`, payload, undefined);
    assert.deepEqual(result, { ok: true, status: 204 });
    const sent = received.at(-1);
    assert.ok(sent !== undefined);
    assert.equal(sent.path, "/ok");
    assert.equal(sent.contentType, "application/json");
    assert.deepEqual(JSON.parse(sent.body), payload);
  });

  it("reports a non-2xx response with its status and the body cut to 500 characters", async () => {
    const result = await postDiscordWebhook(`${base}/fail`, payload, undefined);
    assert.deepEqual(result, { ok: false, status: 500, error: "x".repeat(500) });
  });

  it("reports a transport failure as status 0 with the error message", async () => {
    const result = await postDiscordWebhook("http://127.0.0.1:1/ok", payload, undefined);
    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
    assert.ok(result.ok === false && result.error.length > 0);
  });

  it("throws RunCancelled when the run has already been aborted", async () => {
    await assert.rejects(postDiscordWebhook(`${base}/ok`, payload, AbortSignal.abort()), RunCancelled);
  });
});

describe("isDiscordWebhookUrl", () => {
  it("accepts https Discord webhook URLs only", () => {
    assert.equal(isDiscordWebhookUrl("https://discord.com/api/webhooks/1/token"), true);
    assert.equal(isDiscordWebhookUrl("https://discordapp.com/api/webhooks/1/token"), true);
    assert.equal(isDiscordWebhookUrl("http://discord.com/api/webhooks/1/token"), false);
    assert.equal(isDiscordWebhookUrl("https://discord.com.evil.example/api/webhooks/1/token"), false);
    assert.equal(isDiscordWebhookUrl("https://example.com/api/webhooks/1/token"), false);
    assert.equal(isDiscordWebhookUrl(undefined), false);
    assert.equal(isDiscordWebhookUrl(42), false);
  });
});

describe("fitEmbed", () => {
  const empty: DiscordEmbed = { title: "", description: "", color: 0, fields: [], timestamp: "2024-01-01T00:00:00.000Z" };

  it("cuts title, description and field text to Discord's limits within the 6000 total", () => {
    const fitted = fitEmbed({
      ...empty,
      title: "t".repeat(300),
      description: "d".repeat(5000),
      fields: [{ name: "n".repeat(300), value: "v".repeat(2000), inline: true }],
    });
    assert.equal(fitted.title.length, 256);
    assert.equal(fitted.description.length, 4096);
    assert.equal(fitted.fields.length, 1);
    const [field] = fitted.fields;
    assert.ok(field !== undefined);
    assert.equal(field.name.length, 256);
    assert.equal(field.value.length, 1024);
    assert.equal(field.inline, true);
    const total = fitted.title.length + fitted.description.length + field.name.length + field.value.length;
    assert.ok(total <= 6000, `total ${total} exceeds 6000`);
  });

  it("keeps at most the fields that fit under the 6000 total and clears the description budget", () => {
    const fields = Array.from({ length: 30 }, () => ({ name: "n".repeat(256), value: "v".repeat(1024), inline: false }));
    const fitted = fitEmbed({ ...empty, fields });
    // Each field is 1280 characters, so four fit under 6000 and the fifth does not.
    assert.equal(fitted.fields.length, 4);
    assert.equal(fitted.description, "");
  });
});

describe("random helpers", () => {
  it("randomInt keeps results in [min, max) and returns min for an empty range", () => {
    for (let i = 0; i < 500; i++) {
      const value = randomInt(3, 7);
      assert.ok(value >= 3 && value < 7, `value ${value} outside [3, 7)`);
    }
    assert.equal(randomInt(5, 5), 5);
    assert.equal(randomInt(9, 2), 9);
  });

  it("randomFloat stays within [min, max]", () => {
    for (let i = 0; i < 500; i++) {
      const value = randomFloat(1.5, 2.5);
      assert.ok(value >= 1.5 && value <= 2.5, `value ${value} outside [1.5, 2.5]`);
    }
  });

  it("weightedSelect never picks a zero-weight item when a positive weight exists", () => {
    const items = [
      { id: "a", weight: 0 },
      { id: "b", weight: 3 },
    ];
    for (let i = 0; i < 300; i++) {
      assert.equal(weightedSelect(items, "weight"), items[1]);
    }
  });

  it("betaSample stays within the requested bounds", () => {
    for (let i = 0; i < 300; i++) {
      const value = betaSample(2, 5, 10, 20);
      assert.ok(value >= 10 && value <= 20, `value ${value} outside [10, 20]`);
    }
  });
});
