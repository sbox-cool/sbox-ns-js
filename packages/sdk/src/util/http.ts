export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

const TRACE_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// The reference's request id is ASP.NET Core's TraceIdentifier: "0H" plus 11 base-32 characters, a colon, and an
// 8-digit uppercase hex connection counter. Error envelopes on endpoint, manage, and storage routes carry it.
export function traceIdentifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(11));
  let id = "0H";
  for (const byte of bytes) id += TRACE_ALPHABET[byte % 32];
  const counter = (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0).toString(16).toUpperCase().padStart(8, "0");
  return `${id}:${counter}`;
}
