import { isLibraryCaller, libraryErrorBody } from "../protocol/library.js";
import { jsonResponse } from "../util/http.js";
import { errorResponse } from "./http.js";

// Thrown by any route family whose key check failed. The top-level dispatcher renders it in the envelope of the
// family that owns the route (reference: each *Endpoints.cs answers a failed key check in its own shape).
export class KeyRefusal extends Error {
  constructor() {
    super("The request key check failed.");
    this.name = "KeyRefusal";
  }
}

// A route the family does not serve. The dispatcher renders it in the flat not-recognised envelope.
export class UnknownRoute extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.name = "UnknownRoute";
    this.detail = detail;
  }
}

export type KeyFamily = "manage" | "storage" | "values" | "queries" | "endpoints" | "other";

// True when the request presented any key at all. A request with no key gets the "missing" wording of its family.
export function keyPresented(request: Request, url: URL): boolean {
  const values = [
    request.headers.get("x-public-key"),
    request.headers.get("x-secret-key"),
    request.headers.get("x-api-key"),
    url.searchParams.get("apiKey"),
  ];
  return values.some((value) => value !== null && value.trim() !== "");
}

export async function keyFailureResponse(family: KeyFamily, request: Request, url: URL): Promise<Response> {
  const presented = keyPresented(request, url);
  switch (family) {
    case "manage":
      return errorResponse({ status: 401, code: "UNAUTHORIZED", message: "Invalid or missing management API key." });
    case "values":
      return jsonResponse({ error: { code: "UNAUTHORIZED", message: "Invalid or missing API key." } }, 401);
    case "queries":
      return jsonResponse({ error: { code: "UNAUTHORIZED", message: "Invalid API key." } }, 401);
    case "storage":
      return presented
        ? jsonResponse({ error: "UNAUTHORIZED" }, 401)
        : jsonResponse({ detail: "Missing apiKey", error: "UNAUTHORIZED" }, 401);
    case "endpoints": {
      const message = presented
        ? "The API key is not valid for this project."
        : "Missing API key. Send a public key in x-api-key or x-public-key, or a Network Storage secret key in x-secret-key.";
      const body = request.method === "GET" ? null : await request.clone().json().catch(() => null);
      if (!isLibraryCaller(request.headers, body)) {
        return errorResponse({ status: 401, code: "UNAUTHORIZED", message });
      }
      return jsonResponse(
        libraryErrorBody({ status: 401, code: "UNAUTHORIZED", message, requestId: crypto.randomUUID() }),
        200,
      );
    }
    case "other":
      return errorResponse({ status: 401, code: "UNAUTHORIZED", message: "Invalid or missing API key." });
  }
}
