import { compileBatch, documentOf, removeEndpoints, writeCompiled, type Catalog, type Compiled, type RecordResult } from "./catalog.js";
import type { ServerContext } from "./context.js";
import type { PublishDecision } from "./publish-target.js";

// Async sync jobs behind PUT endpoints?async=true and GET sync-jobs/:jobId. Jobs live in this process. A job that is
// not processing expires five minutes after it was created; an expired job reads as expired once, then is forgotten.

export const SYNC_JOB_TTL_MS = 5 * 60 * 1000;

export const SYNC_JOB_MESSAGE_ACCEPTED = "Sync job accepted. Poll GET /manage/:projectId/sync-jobs/:jobId for status.";

interface SyncJobStage {
  readonly name: string;
  readonly status: string;
  readonly detail: string;
  readonly at: number;
}

interface SyncJob {
  readonly id: string;
  readonly resourceType: string;
  status: "accepted" | "processing" | "complete" | "failed";
  readonly stages: SyncJobStage[];
  results: unknown;
  error: Readonly<Record<string, unknown>> | null;
  readonly createdAt: number;
  completedAt: number | null;
}

export type SyncJobLookup =
  | { readonly state: "found"; readonly job: Record<string, unknown> }
  | { readonly state: "expired" }
  | { readonly state: "notFound" };

export interface SyncJobs {
  create(resourceType: string): string;
  stage(jobId: string, name: string, status: string, detail: string): void;
  complete(jobId: string, results: unknown): void;
  fail(jobId: string, error: Readonly<Record<string, unknown>>): void;
  lookup(jobId: string): SyncJobLookup;
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

function snapshotOf(projectId: string, job: SyncJob): Record<string, unknown> {
  return {
    id: job.id,
    projectId,
    resourceType: job.resourceType,
    status: job.status,
    stages: job.stages.map((stage) => ({
      name: stage.name,
      status: stage.status,
      detail: stage.detail,
      at: isoOf(stage.at),
    })),
    results: job.results ?? null,
    error: job.error,
    createdAt: isoOf(job.createdAt),
    completedAt: job.completedAt === null ? null : isoOf(job.completedAt),
  };
}

function jobIdOf(at: number): string {
  const random = new Uint8Array(4);
  crypto.getRandomValues(random);
  const suffix = [...random].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sync_${at.toString(16)}_${suffix}`;
}

export function createSyncJobs(now: () => number, projectId: string): SyncJobs {
  const jobs = new Map<string, SyncJob>();

  const isExpired = (job: SyncJob, at: number): boolean =>
    job.status !== "processing" && at - job.createdAt > SYNC_JOB_TTL_MS;

  const requireJob = (jobId: string): SyncJob => {
    const job = jobs.get(jobId);
    if (job === undefined) throw new Error(`Unknown sync job ${jobId}.`);
    return job;
  };

  return {
    create(resourceType) {
      const at = now();
      for (const [id, job] of jobs) {
        if (isExpired(job, at)) jobs.delete(id);
      }
      const id = jobIdOf(at);
      jobs.set(id, {
        id,
        resourceType,
        status: "accepted",
        stages: [{ name: "accepted", status: "complete", detail: "Sync request accepted", at }],
        results: null,
        error: null,
        createdAt: at,
        completedAt: null,
      });
      return id;
    },
    stage(jobId, name, status, detail) {
      const job = requireJob(jobId);
      if (status === "processing") job.status = "processing";
      job.stages.push({ name, status, detail, at: now() });
    },
    complete(jobId, results) {
      const job = requireJob(jobId);
      const at = now();
      job.status = "complete";
      job.results = results;
      job.completedAt = at;
      job.stages.push({ name: "complete", status: "complete", detail: "Sync completed", at });
    },
    fail(jobId, error) {
      const job = requireJob(jobId);
      const at = now();
      job.status = "failed";
      job.error = error;
      job.completedAt = at;
      job.stages.push({ name: "failed", status: "failed", detail: String(error["message"]), at });
    },
    lookup(jobId) {
      const job = jobs.get(jobId);
      if (job === undefined) return { state: "notFound" };
      if (isExpired(job, now())) {
        jobs.delete(jobId);
        return { state: "expired" };
      }
      return { state: "found", job: snapshotOf(projectId, job) };
    },
  };
}

// Writes an endpoint batch to the live catalog or the staged revision. A full replacement also removes the live
// endpoints the batch did not name. It applies only to a live write whose items name distinct endpoints.
export function writeEndpointBatch(catalog: Catalog, items: readonly Compiled[], staged: boolean, replaceAll: boolean): void {
  writeCompiled(catalog, items, staged);
  if (!replaceAll || staged) return;
  const written = new Set(items.map((item) => item.id));
  if (written.size === items.length) removeEndpoints(catalog, written);
}

// Starts a background endpoint write. The caller answers 202 with the job id; the write runs detached and is observed
// only through the job. The body arrives as text so that parsing failures are reported by the job, as the reference does.
export function startEndpointSync(
  ctx: ServerContext,
  text: string,
  decision: PublishDecision,
  replaceAll: boolean,
): string {
  const jobId = ctx.syncJobs.create("endpoints");
  ctx.syncJobs.stage(jobId, "validating", "complete", "Payload validated, starting background processing");
  queueMicrotask(() => {
    void runEndpointSync(ctx, jobId, text, decision, replaceAll);
  });
  return jobId;
}

// The identifier a batch item is written under: the first of id, slug, or name that is present.
function endpointIdentifierOf(item: unknown): string | null {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
  const record = item as Record<string, unknown>;
  const raw = record["id"] ?? record["slug"] ?? record["name"];
  return typeof raw === "string" ? raw : null;
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function failedRow(resourceId: string, message: string): Record<string, unknown> {
  return {
    ok: false,
    resourceKind: "endpoint",
    resourceId,
    error: "VALIDATION_FAILED",
    message,
  };
}

function failJob(
  ctx: ServerContext,
  jobId: string,
  stage: string,
  code: string,
  message: string,
  results?: readonly Record<string, unknown>[],
): void {
  ctx.syncJobs.stage(jobId, stage, "failed", message);
  ctx.syncJobs.fail(jobId, {
    code,
    message,
    stage,
    ...(results === undefined ? {} : { results }),
  });
}

async function runEndpointSync(
  ctx: ServerContext,
  jobId: string,
  text: string,
  decision: PublishDecision,
  replaceAll: boolean,
): Promise<void> {
  let stage = "compiling";
  try {
    ctx.syncJobs.stage(jobId, "compiling", "processing", "Compiling and validating endpoints...");
    const body = parseBody(text);
    if (!Array.isArray(body)) {
      failJob(ctx, jobId, stage, "VALIDATION_FAILED", "Body must be an array of endpoints.");
      return;
    }

    // Reject the whole batch before any write when an identifier is unusable, so an async request never half-applies.
    const invalid: Record<string, unknown>[] = [];
    for (const item of body) {
      const id = endpointIdentifierOf(item);
      if (id === null || id.trim() === "" || id.startsWith("endpoint-")) {
        invalid.push(failedRow(id ?? "", "endpoint is missing a required identifier field."));
      }
    }
    if (invalid.length > 0) {
      failJob(ctx, jobId, stage, "VALIDATION_FAILED", "One or more endpoints failed validation.", invalid);
      return;
    }

    const batch = compileBatch("endpoints", body, ctx.options.parseYaml);
    if (!batch.ok) {
      const failed = batch.results
        .filter((result: RecordResult) => !result.ok)
        .map((result: RecordResult) => failedRow(result.id, result.message ?? "The definition is invalid."));
      failJob(ctx, jobId, stage, "SYNC_FAILED", "Endpoint save failed.", failed);
      return;
    }
    stage = "saving";
    ctx.syncJobs.stage(jobId, "compiling", "complete", "All endpoints validated");
    ctx.syncJobs.stage(jobId, "saving", "processing", "Saving endpoints to storage...");

    // Counts come from the catalog before the save: an item that already existed is an update.
    const existed = new Set(batch.compiled.filter((item) => documentOf(ctx.catalog, "endpoints", item.id) !== undefined).map((item) => item.id));
    writeEndpointBatch(ctx.catalog, batch.compiled, decision === "staged", replaceAll);

    let createdCount = 0;
    let updatedCount = 0;
    const results = batch.compiled.map((item) => {
      if (existed.has(item.id)) updatedCount++;
      else createdCount++;
      return { ok: true, action: "upsert", resourceKind: "endpoint", resourceId: item.id };
    });

    ctx.syncJobs.stage(jobId, "saving", "complete", "Endpoints saved");
    ctx.syncJobs.complete(jobId, { ok: true, updatedCount, createdCount, results });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Endpoint save failed.";
    failJob(ctx, jobId, stage, "SYNC_FAILED", message);
  }
}
