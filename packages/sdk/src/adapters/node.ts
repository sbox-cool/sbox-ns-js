import type { IncomingMessage, ServerResponse } from "node:http";
import type { NetworkStorageServer } from "../server/index.js";

// Raw request body cap in bytes. The server also caps parsed JSON, so this only bounds what is buffered.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// Wraps the Fetch-style server for Node's http module. The request is aborted when the client disconnects, so
// long endpoint runs stop with the connection.
export function nodeHandler(server: NetworkStorageServer): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    const body = await readBody(req);
    if (body === "too-large") {
      res.writeHead(413, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: { code: "BODY_TOO_LARGE", message: "The request body is too large." } }));
      return;
    }
    const response = await server.fetch(toRequest(req, body, controller.signal));
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name] = value;
    });
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}

async function readBody(req: IncomingMessage): Promise<Uint8Array<ArrayBuffer> | null | "too-large"> {
  if (req.method === "GET" || req.method === "HEAD") return null;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_BODY_BYTES) return "too-large";
    chunks.push(bytes);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function toRequest(req: IncomingMessage, body: Uint8Array<ArrayBuffer> | null, signal: AbortSignal): Request {
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return new Request(url, {
    method: req.method ?? "GET",
    headers,
    body,
    signal,
  });
}
