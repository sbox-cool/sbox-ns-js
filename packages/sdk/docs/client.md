# Secret-key client

`@sbox-ns/sdk/client` is a typed client for trusted server code: Discord bots, CI jobs, cron workers, and your own backend. It authenticates with the project **secret key**. Never ship that key in game code; a game uses the public key and player sessions.

```ts
import { createSboxNsClient, isSboxNsError } from "@sbox-ns/sdk/client";

const ns = createSboxNsClient({
  baseUrl: "https://ns.example.com",
  projectId: process.env.SBOX_NS_PROJECT_ID!,
  secretKey: process.env.SBOX_NS_SECRET_KEY!,
});
```

`fetch` can be injected (`fetch: (url, init) => ...`) for tests or custom transports. Otherwise the global `fetch` is used.

## Calls

| Method | Use |
| --- | --- |
| `ns.call<T>(slug, input?)` | POST an endpoint with JSON input. |
| `ns.get<T>(slug)` | GET an endpoint that takes no input. On a custom backend, module queries are mounted as endpoints, so `get(queryId)` reads them. |
| `ns.records.get/put/patch/delete/append(collection, key, ...)` | Read and write collection records. `get` returns `null` for a missing key. |
| `ns.queries.run/list/upsert/remove` | Query definitions, and `run(name)` through the hosted query route `/v1/storage/{project}/queries/{name}`. |
| `ns.manage.validate/config/sync/preflight/list/upsert/remove` | Project management (definitions, sync, preflight). |
| `ns.gameValues.list/put` | Game values. `put` upserts by id and keeps the others. The API has no game-value delete. |

Every call makes exactly one attempt. The client never retries on its own; a retry policy belongs to the caller, and only for operations that are safe to repeat.

## Errors

Every failure throws `SboxNsError` with the real status and code. Two wire shapes are normalised:

- Library callers get HTTP 200 with `{ "ok": false, "status": 403, "error": { "code", "message" } }`. The client reports status `403`.
- Plain callers get the real HTTP status with the same error body.

Storage routes answer a missing key with `{ "error": "NOT_FOUND", "detail": ... }` and HTTP 404. `records.get` maps that to `null`.

| `error.code` | When |
| --- | --- |
| `NETWORK_ERROR` (status `0`) | The request never produced a response. |
| `INVALID_RESPONSE` | The body is not JSON. The status is the HTTP status that came back. |
| `HTTP_ERROR` | A non-OK response whose body carries no error code. The status is the HTTP status; `body` keeps what the server sent. |
| any server code | The server's error code, for example `INVALID_SCORE` or `NOT_FOUND`. |

Use `isSboxNsError(error)` to narrow the type. `error.body` keeps the parsed response and `error.requestId` is set when the server provides one.

## Automation example

```ts
import { createSboxNsClient, isSboxNsError } from "@sbox-ns/sdk/client";

const ns = createSboxNsClient({ baseUrl, projectId, secretKey });

try {
  const top = await ns.get<{ entries: { name: string; score: number }[] }>("leaderboards_top");
  await discord.postLeaderboard(top.entries);
} catch (error) {
  if (isSboxNsError(error) && error.status === 0) return; // offline; try again next tick
  throw error;
}
```

The secret key stays in the bot's environment. It is not written to logs, error messages, or the generated project's game code.
