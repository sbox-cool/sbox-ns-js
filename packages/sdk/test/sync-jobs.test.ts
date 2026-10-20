import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createMemoryReplayStore } from "../src/protocol/index.js";
import { createNetworkStorageServer, type ServerOptions } from "../src/server/index.js";
import { createSyncJobs, SYNC_JOB_TTL_MS, type SyncJobLookup } from "../src/server/sync-jobs.js";
import { createMemoryStorage } from "../src/storage/index.js";

const PROJECT = "proj_sync";
const SECRET = "sbox_ns_sk_sync";
const PUBLIC = "sbox_ns_pk_sync";
const T0 = Date.parse("2026-01-01T00:00:00Z");

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function serverOptions(): ServerOptions {
  return {
    projectId: PROJECT,
    publicKey: PUBLIC,
    secretKey: SECRET,
    ownerUserId: 1,
    settings: { enableAuthSessions: false, requireAuthSessions: false, encryptedRequestMode: "off" },
    signingPrivateKeyPem: privateKey,
    sessionSecret: "sync-jobs-test-session-secret",
    endpoints: {},
    storage: (definition) => createMemoryStorage({ collections: definition.collections, values: definition.values }),
    parseYaml,
    stringifyYaml,
    fetchPolicy: { allowedHosts: [], resolveHost: async () => [] },
    replayStore: createMemoryReplayStore(),
  };
}

type Server = { fetch(request: Request): Promise<Response> };

async function send(app: Server, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return app.fetch(
    new Request(`http://ns.test/v3/manage/${PROJECT}${path}`, {
      method,
      headers: { "x-api-key": SECRET, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

async function json(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

// A minimal valid endpoint definition, as the DSL compiler accepts it.
function endpoint(id: string): Record<string, unknown> {
  return {
    sourceVersion: 1,
    kind: "endpoint",
    id,
    method: "GET",
    exposure: "public",
    steps: [],
    response: { status: 200, body: { pong: id } },
  };
}

// Polls a job until it leaves the accepted and processing states. The write runs on a microtask, so a few polls suffice.
async function settle(app: Server, jobId: string): Promise<Record<string, any>> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const body = await json(await send(app, "GET", `/sync-jobs/${jobId}`));
    if (body["job"]["status"] === "complete" || body["job"]["status"] === "failed") return body["job"];
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`sync job ${jobId} did not settle`);
}

function foundJob(lookup: SyncJobLookup): Record<string, unknown> {
  if (lookup.state !== "found") assert.fail(`expected a found job, got ${lookup.state}`);
  return lookup.job;
}

describe("sync job store", () => {
  it("moves accepted, processing and complete, recording each stage and the results", () => {
    let at = T0;
    const jobs = createSyncJobs(() => at, PROJECT);
    const id = jobs.create("endpoints");
    assert.equal(foundJob(jobs.lookup(id))["status"], "accepted");
    at += 10;
    jobs.stage(id, "saving", "processing", "Saving");
    assert.equal(foundJob(jobs.lookup(id))["status"], "processing");
    at += 10;
    jobs.complete(id, { ok: true, createdCount: 1 });
    const job = foundJob(jobs.lookup(id));
    assert.equal(job["status"], "complete");
    assert.deepEqual(job["results"], { ok: true, createdCount: 1 });
    assert.equal(job["projectId"], PROJECT);
    assert.equal(job["resourceType"], "endpoints");
    assert.equal(job["completedAt"], new Date(T0 + 20).toISOString());
    assert.deepEqual(
      (job["stages"] as { name: string }[]).map((stage) => stage.name),
      ["accepted", "saving", "complete"],
    );
  });

  it("records a failure with its error and marks the job failed", () => {
    const jobs = createSyncJobs(() => T0, PROJECT);
    const id = jobs.create("endpoints");
    jobs.fail(id, { code: "SYNC_FAILED", message: "Endpoint save failed.", stage: "compiling" });
    const job = foundJob(jobs.lookup(id));
    assert.equal(job["status"], "failed");
    assert.deepEqual(job["error"], { code: "SYNC_FAILED", message: "Endpoint save failed.", stage: "compiling" });
  });

  it("expires a job that is not processing after the TTL, reports it expired once, then forgets it", () => {
    let at = T0;
    const jobs = createSyncJobs(() => at, PROJECT);
    const id = jobs.create("endpoints");
    at = T0 + SYNC_JOB_TTL_MS;
    assert.equal(jobs.lookup(id).state, "found");
    at = T0 + SYNC_JOB_TTL_MS + 1;
    assert.equal(jobs.lookup(id).state, "expired");
    assert.equal(jobs.lookup(id).state, "notFound");
  });

  it("never expires a job that is still processing", () => {
    let at = T0;
    const jobs = createSyncJobs(() => at, PROJECT);
    const id = jobs.create("endpoints");
    jobs.stage(id, "saving", "processing", "Saving");
    at = T0 + SYNC_JOB_TTL_MS * 10;
    assert.equal(foundJob(jobs.lookup(id))["status"], "processing");
  });

  it("answers notFound for an id that was never issued", () => {
    const jobs = createSyncJobs(() => T0, PROJECT);
    assert.equal(jobs.lookup("sync_missing").state, "notFound");
  });
});

describe("async endpoint sync over HTTP", () => {
  it("answers 202 with the job id and no publish target, then the job completes and the endpoint is live", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const accepted = await send(app, "PUT", "/endpoints?async=true", [endpoint("ping")]);
    assert.equal(accepted.status, 202);
    const body = await json(accepted);
    assert.equal(body["ok"], true);
    assert.equal(body["status"], "accepted");
    assert.equal(typeof body["jobId"], "string");
    assert.equal("publishTarget" in body, false);

    const job = await settle(app, body["jobId"]);
    assert.equal(job["status"], "complete");
    assert.deepEqual(job["results"]["results"], [{ ok: true, action: "upsert", resourceKind: "endpoint", resourceId: "ping" }]);
    assert.equal(job["results"]["createdCount"], 1);
    assert.equal(job["results"]["updatedCount"], 0);

    const listed = await json(await send(app, "GET", "/endpoints"));
    assert.ok(listed["data"].some((document: { id: string }) => document.id === "ping"));
  });

  it("fails the job, not the request, when the body is not an array", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const accepted = await json(await send(app, "PUT", "/endpoints?async=true", "{}"));
    const job = await settle(app, accepted["jobId"]);
    assert.equal(job["status"], "failed");
    assert.equal(job["error"]["code"], "VALIDATION_FAILED");
    assert.equal(job["error"]["message"], "Body must be an array of endpoints.");
  });

  it("answers 404 JOB_NOT_FOUND for an unknown job", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const response = await send(app, "GET", "/sync-jobs/sync_unknown");
    assert.equal(response.status, 404);
    assert.deepEqual(await json(response), { ok: false, error: "JOB_NOT_FOUND" });
  });
});

describe("staged revision over HTTP", () => {
  it("falls back to a live write when no game package has been synced", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const response = await send(app, "PUT", "/endpoints", [endpoint("fallback")], { "x-ns-publish-target": "next" });
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(body["publishTarget"], "live");
    assert.equal(body["stagedFallback"], "no synced game package");
    const listed = await json(await send(app, "GET", "/endpoints"));
    assert.ok(listed["data"].some((document: { id: string }) => document.id === "fallback"));
  });

  it("keeps a next-targeted write out of the live list, shows it with includeStaged, and promotes it on a new revision", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const first = await send(app, "POST", "/package-sync", { packageIdent: "sbox.pkg", currentRevisionId: 1 });
    const firstBody = await json(first);
    assert.equal(firstBody["revisionChanged"], false);
    assert.deepEqual(firstBody["promotedRevisionOverrides"], { endpointCount: 0, collectionCount: 0, promoted: false });

    const staged = await send(app, "PUT", "/endpoints", [endpoint("next_ping")], { "x-ns-publish-target": "next" });
    const stagedBody = await json(staged);
    assert.equal(stagedBody["publishTarget"], "next");
    assert.equal("stagedFallback" in stagedBody, false);

    const live = await json(await send(app, "GET", "/endpoints"));
    assert.equal(live["data"].some((document: { id: string }) => document.id === "next_ping"), false);

    const withStaged = await json(await send(app, "GET", "/endpoints?includeStaged=true"));
    const copy = withStaged["data"].find((document: { id: string }) => document.id === "next_ping");
    assert.ok(copy, "the staged endpoint is listed with includeStaged");
    assert.equal(copy["revisionTarget"], "next");

    // Syncing the same revision again changes nothing and keeps the staged copy.
    const same = await json(await send(app, "POST", "/package-sync", { packageIdent: "sbox.pkg", currentRevisionId: 1 }));
    assert.equal(same["revisionChanged"], false);
    assert.equal(same["promotedRevisionOverrides"]["promoted"], false);

    const next = await json(await send(app, "POST", "/package-sync", { packageIdent: "sbox.pkg", currentRevisionId: 2 }));
    assert.equal(next["revisionChanged"], true);
    assert.equal(next["promotedRevisionOverrides"]["promoted"], true);
    assert.equal(next["promotedRevisionOverrides"]["endpointCount"], 1);

    const promoted = await json(await send(app, "GET", "/endpoints?includeStaged=true"));
    const live2 = promoted["data"].find((document: { id: string }) => document.id === "next_ping");
    assert.ok(live2, "the promoted endpoint is live");
    assert.equal("revisionTarget" in live2, false);
    assert.equal(promoted["data"].filter((document: { id: string }) => document.id === "next_ping").length, 1);
  });

  it("answers revisionTarget=live on a list even when includeStaged is asked for", async () => {
    const app = createNetworkStorageServer(serverOptions());
    await send(app, "POST", "/package-sync", { packageIdent: "sbox.pkg", currentRevisionId: 1 });
    await send(app, "PUT", "/endpoints", [endpoint("hidden")], { "x-ns-publish-target": "next" });
    const listed = await json(await send(app, "GET", "/endpoints?includeStaged=true&revisionTarget=live"));
    assert.equal(listed["data"].some((document: { id: string }) => document.id === "hidden"), false);
  });
});
