// Where a management write or an endpoint run goes. "next" addresses the staged revision. The header and the query
// parameter name the same target, and either one is enough (reference NetworkStoragePublishTarget.IsNext).

export const PUBLISH_TARGET_HEADER = "x-ns-publish-target";
export const PUBLISH_TARGET_QUERY = "revisionTarget";

const STAGED_FALLBACK_REASON = "no synced game package";

// What a next-targeted write actually did. "stagedFallback" wrote live because no game package has been synced yet.
export type PublishDecision = "live" | "staged" | "stagedFallback";

function isNext(value: string | null): boolean {
  return value !== null && value.trim().toLowerCase() === "next";
}

export function targetsNext(request: Request, url: URL): boolean {
  return isNext(request.headers.get(PUBLISH_TARGET_HEADER)) || isNext(url.searchParams.get(PUBLISH_TARGET_QUERY));
}

export function decidePublish(next: boolean, gamePackage: Readonly<Record<string, unknown>> | null): PublishDecision {
  if (!next) return "live";
  return typeof gamePackage?.["currentRevisionId"] === "number" ? "staged" : "stagedFallback";
}

// Reports the publish target on a response. Live writes keep their exact shape.
export function withPublishTarget(body: Record<string, unknown>, decision: PublishDecision): Record<string, unknown> {
  if (decision === "live") return body;
  return {
    ...body,
    publishTarget: decision === "staged" ? "next" : "live",
    ...(decision === "stagedFallback" ? { stagedFallback: STAGED_FALLBACK_REASON } : {}),
  };
}
