# Storage: `ns.records` and `ns.values`

The storage slice gives endpoints the same record store the server uses. Five adapters share one engine:

| Adapter | Factory | Backing | Atomicity |
| --- | --- | --- | --- |
| Memory | `createMemoryStorage(options)` | Process memory | In-process only; lost on restart |
| SQLite | `createSqliteStorage({ ...options, db })` | `SqliteDatabase` (`exec`, `prepare`) | One `BEGIN IMMEDIATE` transaction per `apply()` |
| PostgreSQL | `createPostgresStorage({ ...options, pool })` | `PgPool` (`query`, `connect`) | One `SERIALIZABLE` transaction per `apply()`, no automatic retry |
| Cloudflare D1 | `createD1Storage({ ...options, db })` | `D1Database` (`prepare`, `batch`) | One `batch()`, with an `ns_assert` statement |
| Cloudflare KV | `createKvStorage({ ...options, coordinator, blobs, coordinatorName })` | Durable Object coordinator + KV blobs | Atomic metadata commit in the coordinator (see KV) |

Every adapter takes the same `collections`, `values`, and `seed` options (`EndpointStorageOptions`). Drivers are supplied as structural objects. The SDK has zero runtime dependencies and imports no database driver.

## Runtime support

- **Memory, PostgreSQL, D1, and KV** use only standard APIs. Node 20 is not verified for any of them in this slice. Do not assume Node 20 works.
- **SQLite via `node:sqlite`** requires **Node 22.5 or newer**. Node 20 has no `node:sqlite`. On Node 20, use another provider.
- **SQLite via `bun:sqlite`** works through the same generic adapter with no wrapper. `bun:sqlite`'s `Database` already has `exec(sql)` and `prepare(sql)`, and its `Statement` has `all(...params)` and `run(...params)`. Pass the database directly:

  ```ts
  import { Database } from "bun:sqlite";
  import { createSqliteStorage } from "@sbox-ns/sdk/storage";

  const storage = createSqliteStorage({ collections, values, seed, db: new Database("game.db") });
  ```

  Verified under Bun 1.3.14 (see Verification). The `bun:sqlite` import works only under Bun, so load it only in a Bun runtime.

## Collections

`collections` is an array of `CollectionDefinition` values. These are the same YAML definitions the server uses.

- `id` matches `^[a-zA-Z0-9_-]{1,128}$`.
- `collectionType`: `per-steamid` (default) or `global` (case-insensitive). Global records are hard-deleted.
- `maxRecords` (per player, `per-steamid` only): 1–50, default 1.
- `accessMode`: `public | endpoint | private`. Informational in the store (see Differences).
- `allowRecordDelete`: informational in the store (see Differences).
- `schema`: **required and must be an object.** A missing schema would be stored as JSON null on the server and fail every write, so construction throws `INVALID_COLLECTION`.

Record keys match `^[a-zA-Z0-9_:-]{1,256}$`. Payloads are limited to 64 KiB of UTF-8 JSON (`RECORD_TOO_LARGE`). A payload that fails `schema` throws `SCHEMA_VIOLATION`.

Schema checks follow the server's `OwnerRecordValidation`. Supported keywords: `type`, `properties`, `required`, `additionalProperties`, `enum`, `items`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, `description`, `title`, `default`, `$schema`. Supported types: `object`, `array`, `string`, `number`, `integer`, `boolean`, `null`, `player`, `playerSave`, `datetime`, and `""`.

A field node whose value is not an object and that carries any other modifier is rejected (`SCHEMA_VIOLATION` on write, with "collection schema modifier '<name>' is not supported by the record editor"). The server behaves the same way. Underscore flags such as `_ledger`, `_unique`, `_maxPerHour`, and `$ref` are not storage keywords. The DSL must strip them from the schema it passes here and keep them as metadata.

### `datetime`

A `datetime` value must be an ISO 8601 / RFC 3339 string: `YYYY-MM-DD`, optionally followed by `T` or a space and `HH:mm`, optionally `:ss`, optionally `.` and 1–7 fractional digits. An optional zone is `Z` or `±HH:mm` / `±HHmm`. Calendar and clock bounds are enforced: month 1–12, day within the month (leap years included), year at least 1, hour up to 23, minute and second up to 59, zone offset up to ±14:00 (and ±14:00 exactly, not 14:30), zone minutes up to 59.

Accepted examples: `2024-02-29`, `2000-02-29T10:00:00Z`, `2024-12-31T23:59:59.1234567+14:00`, `2024-01-05T10:00`, `2024-01-05 10:00:00-05:30`.
Rejected examples: `2023-02-29`, `1900-02-29`, `2024-04-31`, `2024-12-31T23:59:60Z`, `2024-12-31T24:00:00Z`, `2024-01-05T10:00:00+14:30`, `not a date`.

This replaces an earlier `Date.parse` check, which normalized invalid dates such as `2023-02-29`. The server uses `DateTimeOffset.TryParse` with invariant culture. The SDK does not accept every form that call accepts (see Differences).

## Reads and writes

- `records.get(collection, key)` returns the data, or `null`.
- `records.getVersioned(collection, key)` returns `{ data, version }`. A missing record is `{ data: null, version: 0 }`. A deleted record keeps its version as a tombstone.
- `records.list(collection)` returns live records sorted by key. Tombstones are excluded.
- `values.get(path)` reads construction-time values with a dot path. It returns `null` for a missing path.
- `apply(writes, { expectedVersions })` applies a batch atomically. It validates every write before any change is committed. The whole batch fails on the first violation.

Each write is `{ op: "put", collection, key, data }` or `{ op: "delete", collection, key }`. A put must follow a read of the same record in the same run (`getVersioned`, or an earlier write's expected version). Otherwise it throws `UNOBSERVED_WRITE`. Versions are checked against `expectedVersions`, and a mismatch throws `CONFLICT`. Two concurrent writers cannot both win the same version.

A `put` on a record that was deleted advances the version. Tombstones keep the version sequence, so a re-created record never reuses an old version.

### Error codes

| Code | HTTP status | Meaning |
| --- | --- | --- |
| `UNKNOWN_COLLECTION` | 500 | Read or write on an undeclared collection |
| `INVALID_COLLECTION` | 500 | Bad collection definition (at construction) |
| `INVALID_KEY` | 400 | Key does not match the pattern |
| `INVALID_RECORD` | 400 | Malformed record payload |
| `RECORD_TOO_LARGE` | 413 | Payload over 64 KiB |
| `SCHEMA_VIOLATION` | 400 | Payload fails the collection schema |
| `INVALID_BATCH` | 400 | Malformed batch or expected version |
| `UNOBSERVED_WRITE` | 409 | Put without an observed version |
| `CONFLICT` | 409 | Expected version is stale, or a concurrent transaction conflicted |
| `RECORD_LIMIT_REACHED` | 409 | Per-player `maxRecords` would be exceeded |
| `STORAGE_UNAVAILABLE` | 503 | Backend could not serve the request (KV: metadata and blob out of step) |
| `INVALID_STORAGE_CONFIG` | 500 | Bad adapter configuration |

Errors are `StorageError` instances with `code`, `status`, and `message`.

## Seed

`seed` is `collection -> key -> payload`. Every seed record is validated when the storage is constructed, and an invalid one throws. A record is inserted at version 1 only if it has never existed. Existing and tombstoned records are left alone. Seeding is therefore safe to repeat on durable providers across restarts.

## Access rules belong to the HTTP layer

`accessMode` and `allowRecordDelete` are not enforced by `ns.records`, `ns.values`, or the raw store. Endpoint code is privileged and can read and write any declared collection, including `endpoint` and `private` ones, so the store cannot tell a privileged call from a direct one.

The HTTP route layer enforces these rules for player-facing (public-key) document requests:

- Undeclared collection: writes and deletes return 404 `NOT_FOUND`.
- `accessMode` other than `public` (missing defaults to `endpoint`, case-insensitive): 403 `ENDPOINT_ONLY`.
- DELETE without `allowRecordDelete: true`: 403 `RECORD_DELETE_DISABLED`.
- Per-player collections (not `global`): a write or delete must use the verified player's Steam ID, or a key starting with `{steamId}_`. Otherwise 403 `FORBIDDEN`.

Secret keys bypass these rules, as on the server.

## Differences from the server

These are deliberate. Each one is conservative or makes a gap explicit.

1. **Unknown collections throw.** The server passes reads of unknown collections through. The SDK throws `UNKNOWN_COLLECTION` for both reads and writes.
2. **Versions are always enforced.** The server's `requireSaveVersion` is optional. The SDK requires an observed version for every put.
3. **Per-player limit is counted before the batch.** A delete and a create for the same player in one batch is rejected, even when the server would allow it.
4. **Access rules are not in the store.** See "Access rules belong to the HTTP layer".
5. **Endpoint deletes are not gated on `allowRecordDelete`.** The server's legacy save-slot delete route is gated; the direct document API and endpoint runtime are not. The SDK store matches the endpoint behavior.
6. **`datetime` accepts ISO 8601 / RFC 3339 only.** The server's `DateTimeOffset.TryParse` also accepts other invariant-culture forms, for example `March 5, 2024`. The SDK rejects those with `SCHEMA_VIOLATION`.

## Cloudflare KV

KV alone cannot provide `apply()`. KV is eventually consistent, has no multi-key transactions, and has no conditional writes. So the KV adapter splits the store:

- **Coordinator** (a Durable Object, `recipes/cloudflare-kv/src/coordinator.ts`) owns metadata: version, tombstone state, and blob pointer per record. It checks versions and limits, then applies one `apply()` as one synchronous `transactionSync`. That transaction is the atomicity guarantee.
- **Blobs** (KV) hold payloads as immutable values under unique keys (`ns/<collection>/<key>/v<version>/<uuid>`). A blob is never overwritten, so eventual consistency cannot show a mixed or stale value for one record version.

### Write path

1. Validate the batch in the adapter. Upload blobs for the put records.
2. Call `coordinator.commit(...)`. The coordinator checks versions and limits and applies the metadata in one transaction.
3. If the coordinator rejects the commit, delete the uploaded blobs and throw `CONFLICT` (or the rejection's code).
4. If the commit RPC fails with an error (ambiguous outcome), keep the uploaded blobs and throw. They may be orphans.
5. On success, delete superseded blobs best-effort.

### Read path

Reads take metadata from the coordinator, then fetch the blob. If the blob is missing (KV propagation lag), the adapter retries 6 times with `50·2^attempt` ms backoff, then throws `STORAGE_UNAVAILABLE`.

### KV semantics and limits

- **Atomicity** holds for the records of one coordinator, which is one Durable Object per `coordinatorName`. Records in different coordinators are not atomic with each other.
- **Writes serialize** through that coordinator. Throughput is bounded by one Durable Object.
- **Orphan blobs** can remain after a crash or an ambiguous commit. There is no sweeper in this slice. Orphans are unreachable through the metadata, so they do not affect reads, but they consume KV storage.
- **Eventual consistency** applies to blob visibility after upload. The retry above covers it, but a read that outlasts the retries throws `STORAGE_UNAVAILABLE`.
- **Payload size** is limited to 64 KiB by the engine, which is well below KV's per-value limit.
- **Verified** under `wrangler dev --local` with real D1, KV, and Durable Object bindings (see Verification). Placeholder ids are accepted in local mode. Production needs real ids.

### Deployment

See `recipes/cloudflare-kv/README.md`. It requires a `COORDINATOR` Durable Object binding, a `BLOBS` KV namespace, and (for the D1 harness) a `DB` D1 binding.

## Verification

Run from `packages/sdk`:

```sh
/path/to/node_modules/.bin/tsc -p tsconfig.test.json
node --test dist-test/test/storage-*.test.js
```

| Suite | Runner | Environment | Result |
| --- | --- | --- | --- |
| memory | `node --test` | none | 21 pass, 0 fail |
| SQLite (`node:sqlite`) | `node --test` | Node v26.0.0 (`node:sqlite`, Node 22.5+) | 23 pass, 0 fail |
| PostgreSQL | `node --test` | `NS_TEST_POSTGRES_URL` (local PostgreSQL 5433) and `NS_TEST_PG_DRIVER` (installed `pg`) | 23 pass, 0 fail |
| D1 | `node --test` | `NS_TEST_HARNESS_URL` (harness under `wrangler dev --local`, real D1 binding) | 23 pass, 0 fail |
| KV | `node --test` | `NS_TEST_HARNESS_URL` (harness under `wrangler dev --local`, real DO + KV bindings) | 23 pass, 0 fail |
| bun:sqlite | `bun test` | Bun 1.3.14, `bun:sqlite` | 23 pass, 0 fail |
| Schema (datetime and keywords) | `node --test` | none | 14 pass, 0 fail |

`storage-bun-sqlite.test.js` is skipped under Node (reason printed), and `storage-d1`/`storage-kv` are skipped unless `NS_TEST_HARNESS_URL` is set. A skipped suite is not a pass.

Full Node run (all files, PG and harness set): 127 pass, 0 fail.

The harness is started from `recipes/cloudflare-kv` with an absolute config path (see that README). It is a test harness, not a production endpoint.

The shared suite (`test/storage/conformance.ts`) covers collections, keys, limits, schema, versions, tombstones, batches, concurrency, values, seeding, and (for persistent providers) reopen behavior.
