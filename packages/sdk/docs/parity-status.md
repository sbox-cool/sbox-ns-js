# Parity status: SDK backend against the .NET reference

Generated from the corpus run of the SDK backend against the local .NET reference build (`/private/tmp/wt-script-budget`, commit `cae55ab`, library `1.2.0`).

- SDK commit: `66c9242` (`packages/sdk` backend, Node 22, fresh `git archive` export)
- Command: `sbox-ns-parity run` against the SDK server, then `sbox-ns-parity diff --stable ref-results.json --candidate sdk-results.json --allow tests/parity/intentional-differences.json`.
- Reference results: `/tmp/refrun/ref-results.json`. Candidate results: `/tmp/refrun/sdk-results4.json`. Logs: `/tmp/refrun/diff4.log` (with allow-list) and `/tmp/refrun/diff4-noallow.log` (without).

## Totals

- Steps compared: 163
- Identical: 83
- Intentional only (in the allow-list): 23
- Remaining unlisted differences: 57

## Per trace family

| Family | Steps | Identical | Intentional | Remaining |
| --- | ---: | ---: | ---: | ---: |
| 01-management-push | 46 | 15 | 10 | 21 |
| 02-runtime-config | 9 | 5 | 0 | 4 |
| 03-endpoints | 23 | 15 | 5 | 3 |
| 04-documents | 15 | 15 | 0 | 0 |
| 05-global-records | 10 | 4 | 2 | 4 |
| 06-ledger-and-records | 11 | 4 | 1 | 6 |
| 07-analytics-and-stats | 7 | 2 | 1 | 4 |
| 08-auth-sessions | 7 | 7 | 0 | 0 |
| 09-queries | 6 | 1 | 0 | 5 |
| 10-errors | 29 | 15 | 4 | 10 |

## Remaining differences (reference vs SDK)

Each entry lists the reference (`stable`) and SDK (`candidate`) status, then every differing path. `-` means only in the reference, `+` only in the SDK, `~` both with different values. Lines marked `(allowed ...)` are intentional and kept here for context.

### 07-analytics-and-stats: analytics-and-heartbeat / analytics-missing-type

- request: POST /v3/storage/${projectId}/analytics/events?apiKey=${publicKey}
- reference stable: 400 application/json;charset=utf-8
- SDK candidate: 400 application/json;charset=utf-8
  - body:$.detail: "A valid analytics event type or code is required." (only in stable) [reference only]
  - body:$.error: "INVALID_ANALYTICS_EVENT" → {"code":"INVALID_ANALYTICS_EVENT","message":"A valid analytics event type or code is required."} [value differs]
  - body:$.ok: false (only in candidate) [SDK only]

### 07-analytics-and-stats: analytics-and-heartbeat / heartbeat

- request: POST /v3/storage/${projectId}/stats/heartbeat?apiKey=${publicKey}
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$.totalSeconds: 2 → 120 [value differs]

### 07-analytics-and-stats: analytics-and-heartbeat / heartbeat-api-alias

- request: POST /api/storage/${projectId}/stats/heartbeat?apiKey=${publicKey}
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$.totalSeconds: 2 → 120 [value differs]

### 07-analytics-and-stats: analytics-and-heartbeat / heartbeat-leave

- request: POST /v3/storage/${projectId}/stats/heartbeat?apiKey=${publicKey}
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$.totalSeconds: 2 → 120 [value differs]

### 03-endpoints: endpoints-get-and-routing / missing-slug

- request: POST /v3/endpoints/${projectId}?apiKey=${publicKey}
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$._requestId: "<trace-id>" → "<guid>" [value differs]
  - body:$.error.code: "INVALID_REQUEST" → "ENDPOINT_SLUG_REQUIRED" [value differs]
  - body:$.error.message: "Missing endpoint slug." → "The endpoint name is required." [value differs]
  - body:$.error.requestId: "<trace-id>" → "<guid>" [value differs]
  - body:$.message: "Missing endpoint slug." → "The endpoint name is required." [value differs]

### 03-endpoints: endpoints-player-flow / mine-ore-invalid

- request: POST /v3/endpoints/${projectId}/mine-ore?apiKey=${publicKey}
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$._requestId: "<trace-id>" → "<guid>" [value differs]
  - body:$.conditionRejection: true (only in stable) [reference only]
  - body:$.error.requestId: "<trace-id>" → "<guid>" [value differs]
  - body:$.fireWebhook: false (only in stable) [reference only]
  - body:$.flagged: false (only in stable) [reference only]
  - body:$.severity: null (only in stable) [reference only]

### 03-endpoints: endpoints-player-flow / mine-ore-missing-input

- request: POST /v3/endpoints/${projectId}/mine-ore?apiKey=${publicKey}
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$._requestId: "<trace-id>" → "<guid>" [value differs]
  - body:$.conditionRejection: true (only in stable) [reference only]
  - body:$.error.code: "INVALID_AMOUNT" → "INVALID_INPUT" [value differs]
  - body:$.error.message: "Amount must be positive." → "Missing required field \"amount\"." [value differs]
  - body:$.error.requestId: "<trace-id>" → "<guid>" [value differs]
  - body:$.fireWebhook: false (only in stable) [reference only]
  - body:$.flagged: false (only in stable) [reference only]
  - body:$.message: "Amount must be positive." → "Missing required field \"amount\"." [value differs]
  - body:$.severity: null (only in stable) [reference only]

### 10-errors: errors-credentials / endpoint-bad-key

- request: POST /v3/endpoints/${projectId}/load-profile?apiKey=sbox_ns_00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$._requestId: "<trace-id>" → "<guid>" [value differs]
  - body:$.error.requestId: "<trace-id>" → "<guid>" [value differs]

### 10-errors: errors-credentials / endpoint-no-key

- request: POST /v3/endpoints/${projectId}/load-profile
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$._requestId: "<trace-id>" → "<guid>" [value differs]
  - body:$.error.requestId: "<trace-id>" → "<guid>" [value differs]

### 10-errors: errors-invalid-input / deploy-canary

- request: GET /v3/storage/deploy-canary/ping
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - header:cache-control: no-store (only in stable) [reference only]
  - body:$.owner: ".NET native" → "@sbox-ns/sdk" [value differs]

### 10-errors: errors-invalid-input / document-malformed-json

- request: POST /v3/storage/${projectId}/players/${steamId}?apiKey=${publicKey}
- reference stable: 400 application/json;charset=utf-8
- SDK candidate: 400 application/json;charset=utf-8
  - body:$.error: "INVALID_BODY" → {"code":"INVALID_JSON","message":"The request body is not valid JSON."} [value differs]
  - body:$.ok: false (only in candidate) [SDK only]

### 10-errors: errors-invalid-input / document-null-body

- request: POST /v3/storage/${projectId}/players/${steamId}?apiKey=${publicKey}
- reference stable: 400 application/json;charset=utf-8
- SDK candidate: 400 application/json;charset=utf-8
  - body:$.error: "INVALID_BODY" → {"code":"INVALID_BODY","message":"Body must be a JSON object."} [value differs]
  - body:$.ok: false (only in candidate) [SDK only]

### 10-errors: errors-invalid-input / endpoint-malformed-json

- request: POST /v3/endpoints/${projectId}/save-profile?apiKey=${publicKey}
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 400 application/json;charset=utf-8
  - status: 200 → 400 [value differs]
  - body:$._requestId: "<trace-id>" (only in stable) [reference only]
  - body:$.error.code: "ENDPOINT_ERROR.WRITE" → "INVALID_JSON" [value differs]
  - body:$.error.docsUrl: "https://sboxcool.com/wiki/network-storage-v3/endpoints#error-handling" (only in stable) [reference only]
  - body:$.error.message: "Write \"save\": ops[0]: \"set\" requires a \"value\"." → "The request body is not valid JSON." [value differs]
  - body:$.error.requestId: "<trace-id>" (only in stable) [reference only]
  - body:$.error.step: {"collection":"players","id":"save","key":"{{steamId}}","type":"write"} (only in stable) [reference only]
  - body:$.message: "Write \"save\": ops[0]: \"set\" requires a \"value\"." (only in stable) [reference only]
  - body:$.status: 400 (only in stable) [reference only]

### 10-errors: errors-invalid-input / preflight-malformed-json

- request: POST /v3/manage/${projectId}/sync/preflight
- reference stable: 400 application/json;charset=utf-8
- SDK candidate: 400 application/json;charset=utf-8
  - body:$.error: "INVALID_JSON" → {"code":"INVALID_JSON","message":"The request body is not valid JSON."} [value differs]
  - body:$.message: "Body must be valid JSON." (only in stable) [reference only]
  - body:$.mode: "preflight" (only in stable) [reference only]

### 10-errors: errors-missing-project / endpoint

- request: POST /v3/endpoints/proj_000000000000000000000000/load-profile?apiKey=${publicKey}
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$._requestId: "<trace-id>" → "<guid>" [value differs]
  - body:$.error.requestId: "<trace-id>" → "<guid>" [value differs]

### 10-errors: errors-missing-project / security-config

- request: GET /v3/security-config/proj_000000000000000000000000
- reference stable: 404 application/json;charset=utf-8
- SDK candidate: 404 application/json;charset=utf-8
  - header:cache-control: public, max-age=15, s-maxage=60 (only in stable) [reference only]
  - header:x-security-config-cache: public (only in stable) [reference only]
  - header:x-security-config-source: missing (only in stable) [reference only]

### 10-errors: errors-oversized-payloads / append-oversized

- request: POST /v3/storage/${projectId}/leaderboard_global/append?apiKey=${publicKey}
- reference stable: 413 application/json;charset=utf-8
- SDK candidate: 413 application/json;charset=utf-8
  - body:$.detail: "Request body exceeds the 262144-byte limit for this route." (only in stable) [reference only]
  - body:$.error: "PAYLOAD_TOO_LARGE" → {"code":"BODY_TOO_LARGE","message":"The request body is too large."} [value differs]
  - body:$.message: "Request body exceeds the 262144-byte limit for this route." (only in stable) [reference only]
  - body:$.ok: false (only in candidate) [SDK only]

### 05-global-records: global-append-list / append-empty-body

- request: POST /v3/storage/${projectId}/leaderboard_global/append?apiKey=${publicKey}
- reference stable: 400 application/json;charset=utf-8
- SDK candidate: 400 application/json;charset=utf-8
  - body:$.detail: "Body must be a non-empty JSON object." (only in stable) [reference only]
  - body:$.error: "INVALID_BODY" → {"code":"INVALID_BODY","message":"Body must be a non-empty JSON object."} [value differs]
  - body:$.ok: false (only in candidate) [SDK only]

### 05-global-records: global-append-list / append-per-player-collection

- request: POST /v3/storage/${projectId}/players/append?apiKey=${publicKey}
- reference stable: 400 application/json;charset=utf-8
- SDK candidate: 400 application/json;charset=utf-8
  - body:$.detail: "This is a per-steamid collection. Use an endpoint instead." (only in stable) [reference only]
  - body:$.error: "COLLECTION_TYPE_MISMATCH" → {"code":"COLLECTION_TYPE_MISMATCH","message":"Only global collections accept appends."} [value differs]
  - body:$.ok: false (only in candidate) [SDK only]

### 05-global-records: global-append-list / append-public-key

- request: POST /v3/storage/${projectId}/leaderboard_global/append?apiKey=${publicKey}
- reference stable: 403 application/json;charset=utf-8
- SDK candidate: 403 application/json;charset=utf-8
  - body:$.detail: "This secret key does not have execute access to collections." (only in stable) [reference only]
  - body:$.error: "FORBIDDEN" → {"code":"FORBIDDEN","message":"Appending to this collection requires the secret key."} [value differs]
  - body:$.ok: false (only in candidate) [SDK only]

### 05-global-records: global-append-list / append-replay

- request: POST /v3/storage/${projectId}/leaderboard_global/append?apiKey=${publicKey}
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$.record._id: "<hex32>" → "<capture:firstRecord>" [value differs]

### 01-management-push: manage-package-and-revision / game-package

- request: GET /v3/manage/${projectId}/game-package
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$.gamePackage.lastSyncedAt: "<masked:lastSyncedAt>" (only in stable) [reference only]
  - body:$.gamePackage.lastSyncedAtUnix: "<masked:lastSyncedAtUnix>" (only in stable) [reference only]
  - body:$.gamePackage.projectId: "${projectId}" (only in candidate) [SDK only]
  - body:$.gamePackage.rawBundle: {} (only in stable) [reference only]
  - body:$.gamePackage.rawPackage: {} (only in stable) [reference only]
  - body:$.gamePackage.rawRevision: {} (only in stable) [reference only]
  - body:$.gamePackage.revisionFirstSyncedAtUnix: "<masked:revisionFirstSyncedAtUnix>" (only in stable) [reference only]
  - body:$.gamePackage.revisionPublishedAt: "<masked:revisionPublishedAt>" (only in stable) [reference only]

### 01-management-push: manage-push-all / list-collections

- request: GET /v3/manage/${projectId}/collections?includeStaged=true&_syncToolTs=1767225600000
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$.data[0].accessMode: "public" (only in stable) [reference only]
  - body:$.data[0].allowRecordDelete: false (only in stable) [reference only]
  - body:$.data[0].authoringMode: "source" (only in stable) [reference only]
  - body:$.data[0].collectionType: "global" (only in stable) [reference only]
  - body:$.data[0].definition: {"accessMode":"public","allowRecordDelete":false,"collectionType":"global","schema":{"playerName":{"type":"string"},"score":{"type":"number"}}} (only in candidate) [SDK only]
  - body:$.data[0].kind: "collection" (only in candidate) [SDK only]
  - body:$.data[0].schema: {"playerName":{"type":"string"},"score":{"type":"number"}} (only in stable) [reference only]
  - body:$.data[0].sourceFormat: "yaml" (only in stable) [reference only]
  - body:$.data[0].sourcePath: "leaderboard_global.collection.yml" (only in stable) [reference only]
  - body:$.data[0].sourceText: "sourceVersion: 1\nkind: collection\nid: leaderboard_global\nname: leaderboard_global\ndescription: Shared append-only run log.\ndefinition:\n  collectionType: … (only in stable) [reference only]
  - body:$.data[0].visibility: "private" (only in stable) [reference only]
  - body:$.data[1].accessMode: "public" (only in stable) [reference only]
  - body:$.data[1].allowRecordDelete: true (only in stable) [reference only]
  - body:$.data[1].authoringMode: "source" (only in stable) [reference only]
  - body:$.data[1].collectionType: "per-steamid" (only in stable) [reference only]
  - body:$.data[1].definition: {"accessMode":"public","allowRecordDelete":true,"collectionType":"per-steamid","maxRecords":1,"rateLimitAction":"reject","rateLimits":{"mode":"none"},"requireSa… (only in candidate) [SDK only]
  - body:$.data[1].kind: "collection" (only in candidate) [SDK only]
  - body:$.data[1].maxRecords: 1 (only in stable) [reference only]
  - body:$.data[1].rateLimitAction: "reject" (only in stable) [reference only]
  - body:$.data[1].rateLimits: {"mode":"none"} (only in stable) [reference only]
  - body:$.data[1].requireSaveVersion: false (only in stable) [reference only]
  - body:$.data[1].schema: {"gold":{"_ledger":true,"default":100,"type":"number"},"level":{"default":0,"type":"number"},"ores":{"default":{"stone":0},"properties":{"stone":{"type":"number… (only in stable) [reference only]
  - body:$.data[1].sourceFormat: "yaml" (only in stable) [reference only]
  - body:$.data[1].sourcePath: "players.collection.yml" (only in stable) [reference only]
  - body:$.data[1].sourceText: "sourceVersion: 1\nkind: collection\nid: players\nname: players\ndescription: Per-player profile and economy state.\ndefinition:\n  collectionType: per-steamid\… (only in stable) [reference only]
  - body:$.data[1].visibility: "private" (only in stable) [reference only]
  - body:$.data[2].accessMode: "public" (only in stable) [reference only]
  - body:$.data[2].allowRecordDelete: true (only in stable) [reference only]
  - body:$.data[2].authoringMode: "source" (only in stable) [reference only]
  - body:$.data[2].collectionType: "per-steamid" (only in stable) [reference only]
  - body:$.data[2].definition: {"accessMode":"public","allowRecordDelete":true,"collectionType":"per-steamid","maxRecords":3,"schema":{"playtimeSeconds":{"default":0,"type":"number"},"slotNam… (only in candidate) [SDK only]
  - body:$.data[2].kind: "collection" (only in candidate) [SDK only]
  - body:$.data[2].maxRecords: 3 (only in stable) [reference only]
  - body:$.data[2].schema: {"playtimeSeconds":{"default":0,"type":"number"},"slotName":{"default":"","type":"string"}} (only in stable) [reference only]
  - body:$.data[2].sourceFormat: "yaml" (only in stable) [reference only]
  - body:$.data[2].sourcePath: "save_slots.collection.yml" (only in stable) [reference only]
  - body:$.data[2].sourceText: "sourceVersion: 1\nkind: collection\nid: save_slots\nname: save_slots\ndescription: Up to three save files per player.\ndefinition:\n  collectionType: per-steam… (only in stable) [reference only]
  - body:$.data[2].visibility: "private" (only in stable) [reference only]

### 01-management-push: manage-push-all / list-endpoints

- request: GET /v3/manage/${projectId}/endpoints?includeStaged=true&_syncToolTs=1767225600000
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$.data[0].authoringMode: "source" (only in stable) [reference only]
  - body:$.data[0].enabled: true (only in candidate) [SDK only]
  - body:$.data[0].kind: "endpoint" (only in candidate) [SDK only]
  - body:$.data[0].slug: "mine-ore" (only in stable) [reference only]
  - body:$.data[0].sourceFormat: "yaml" (only in stable) [reference only]
  - body:$.data[0].sourcePath: "mine-ore.endpoint.yml" (only in stable) [reference only]
  - body:$.data[0].sourceText: "sourceVersion: 1\nkind: endpoint\nid: mine-ore\nname: Mine Ore\ndescription: Adds ore after validating the amount.\nexposure: public\nmethod: POST\ninput:\n  t… (only in stable) [reference only]
  - body:$.data[1].authoringMode: "source" (only in stable) [reference only]
  - body:$.data[1].enabled: true (only in candidate) [SDK only]
  - body:$.data[1].kind: "endpoint" (only in candidate) [SDK only]
  - body:$.data[1].slug: "grant-gold" (only in stable) [reference only]
  - body:$.data[1].sourceFormat: "yaml" (only in stable) [reference only]
  - body:$.data[1].sourcePath: "grant-gold.endpoint.yml" (only in stable) [reference only]
  - body:$.data[1].sourceText: "sourceVersion: 1\nkind: endpoint\nid: grant-gold\nname: Grant Gold\ndescription: Dedicated-server-only reward grant.\nexposure: public\nrequiresSecretKey: true… (only in stable) [reference only]
  - body:$.data[2].authoringMode: "source" (only in stable) [reference only]
  - body:$.data[2].enabled: true (only in candidate) [SDK only]
  - body:$.data[2].kind: "endpoint" (only in candidate) [SDK only]
  - body:$.data[2].slug: "load-profile" (only in stable) [reference only]
  - body:$.data[2].sourceFormat: "yaml" (only in stable) [reference only]
  - body:$.data[2].sourcePath: "load-profile.endpoint.yml" (only in stable) [reference only]
  - body:$.data[2].sourceText: "sourceVersion: 1\nkind: endpoint\nid: load-profile\nname: Load Profile\ndescription: Return the caller's players record.\nexposure: public\nmethod: POST\ninput… (only in stable) [reference only]
  - body:$.data[3].authoringMode: "source" (only in stable) [reference only]
  - body:$.data[3].enabled: true (only in candidate) [SDK only]
  - body:$.data[3].kind: "endpoint" (only in candidate) [SDK only]
  - body:$.data[3].slug: "save-profile" (only in stable) [reference only]
  - body:$.data[3].sourceFormat: "yaml" (only in stable) [reference only]
  - body:$.data[3].sourcePath: "save-profile.endpoint.yml" (only in stable) [reference only]
  - body:$.data[3].sourceText: "sourceVersion: 1\nkind: endpoint\nid: save-profile\nname: Save Profile\ndescription: Save non-economic profile state.\nexposure: public\nmethod: POST\ninput:\n… (only in stable) [reference only]
  - body:$.data[4].authoringMode: "source" (only in stable) [reference only]
  - body:$.data[4].enabled: true (only in candidate) [SDK only]
  - body:$.data[4].kind: "endpoint" (only in candidate) [SDK only]
  - body:$.data[4].slug: "market-listings" (only in stable) [reference only]
  - body:$.data[4].sourceFormat: "yaml" (only in stable) [reference only]
  - body:$.data[4].sourcePath: "market-listings.endpoint.yml" (only in stable) [reference only]
  - body:$.data[4].sourceText: "sourceVersion: 1\nkind: endpoint\nid: market-listings\nname: Market Listings\ndescription: Static read-only listing endpoint (callable by GET).\nexposure: publ… (only in stable) [reference only]
  - body:$.data[5].authoringMode: "source" (only in stable) [reference only]
  - body:$.data[5].enabled: true (only in candidate) [SDK only]
  - body:$.data[5].kind: "endpoint" (only in candidate) [SDK only]
  - body:$.data[5].slug: "buy-upgrade" (only in stable) [reference only]
  - body:$.data[5].sourceFormat: "yaml" (only in stable) [reference only]
  - body:$.data[5].sourcePath: "buy-upgrade.endpoint.yml" (only in stable) [reference only]
  - body:$.data[5].sourceText: "sourceVersion: 1\nkind: endpoint\nid: buy-upgrade\nname: Buy Upgrade\ndescription: Workflow-backed purchase priced from the upgrades game-values table.\nexposu… (only in stable) [reference only]

### 01-management-push: manage-push-all / list-endpoints-live

- request: GET /v3/manage/${projectId}/endpoints?revisionTarget=live
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$.data[0].authoringMode: "source" (only in stable) [reference only]
  - body:$.data[0].enabled: true (only in candidate) [SDK only]
  - body:$.data[0].kind: "endpoint" (only in candidate) [SDK only]
  - body:$.data[0].slug: "mine-ore" (only in stable) [reference only]
  - body:$.data[0].sourceFormat: "yaml" (only in stable) [reference only]
  - body:$.data[0].sourcePath: "mine-ore.endpoint.yml" (only in stable) [reference only]
  - body:$.data[0].sourceText: "sourceVersion: 1\nkind: endpoint\nid: mine-ore\nname: Mine Ore\ndescription: Adds ore after validating the amount.\nexposure: public\nmethod: POST\ninput:\n  t… (only in stable) [reference only]
  - body:$.data[1].authoringMode: "source" (only in stable) [reference only]
  - body:$.data[1].enabled: true (only in candidate) [SDK only]
  - body:$.data[1].kind: "endpoint" (only in candidate) [SDK only]
  - body:$.data[1].slug: "grant-gold" (only in stable) [reference only]
  - body:$.data[1].sourceFormat: "yaml" (only in stable) [reference only]
  - body:$.data[1].sourcePath: "grant-gold.endpoint.yml" (only in stable) [reference only]
  - body:$.data[1].sourceText: "sourceVersion: 1\nkind: endpoint\nid: grant-gold\nname: Grant Gold\ndescription: Dedicated-server-only reward grant.\nexposure: public\nrequiresSecretKey: true… (only in stable) [reference only]
  - body:$.data[2].authoringMode: "source" (only in stable) [reference only]
  - body:$.data[2].enabled: true (only in candidate) [SDK only]
  - body:$.data[2].kind: "endpoint" (only in candidate) [SDK only]
  - body:$.data[2].slug: "load-profile" (only in stable) [reference only]
  - body:$.data[2].sourceFormat: "yaml" (only in stable) [reference only]
  - body:$.data[2].sourcePath: "load-profile.endpoint.yml" (only in stable) [reference only]
  - body:$.data[2].sourceText: "sourceVersion: 1\nkind: endpoint\nid: load-profile\nname: Load Profile\ndescription: Return the caller's players record.\nexposure: public\nmethod: POST\ninput… (only in stable) [reference only]
  - body:$.data[3].authoringMode: "source" (only in stable) [reference only]
  - body:$.data[3].enabled: true (only in candidate) [SDK only]
  - body:$.data[3].kind: "endpoint" (only in candidate) [SDK only]
  - body:$.data[3].slug: "save-profile" (only in stable) [reference only]
  - body:$.data[3].sourceFormat: "yaml" (only in stable) [reference only]
  - body:$.data[3].sourcePath: "save-profile.endpoint.yml" (only in stable) [reference only]
  - body:$.data[3].sourceText: "sourceVersion: 1\nkind: endpoint\nid: save-profile\nname: Save Profile\ndescription: Save non-economic profile state.\nexposure: public\nmethod: POST\ninput:\n… (only in stable) [reference only]
  - body:$.data[4].authoringMode: "source" (only in stable) [reference only]
  - body:$.data[4].enabled: true (only in candidate) [SDK only]
  - body:$.data[4].kind: "endpoint" (only in candidate) [SDK only]
  - body:$.data[4].slug: "market-listings" (only in stable) [reference only]
  - body:$.data[4].sourceFormat: "yaml" (only in stable) [reference only]
  - body:$.data[4].sourcePath: "market-listings.endpoint.yml" (only in stable) [reference only]
  - body:$.data[4].sourceText: "sourceVersion: 1\nkind: endpoint\nid: market-listings\nname: Market Listings\ndescription: Static read-only listing endpoint (callable by GET).\nexposure: publ… (only in stable) [reference only]
  - body:$.data[5].authoringMode: "source" (only in stable) [reference only]
  - body:$.data[5].enabled: true (only in candidate) [SDK only]
  - body:$.data[5].kind: "endpoint" (only in candidate) [SDK only]
  - body:$.data[5].slug: "buy-upgrade" (only in stable) [reference only]
  - body:$.data[5].sourceFormat: "yaml" (only in stable) [reference only]
  - body:$.data[5].sourcePath: "buy-upgrade.endpoint.yml" (only in stable) [reference only]
  - body:$.data[5].sourceText: "sourceVersion: 1\nkind: endpoint\nid: buy-upgrade\nname: Buy Upgrade\ndescription: Workflow-backed purchase priced from the upgrades game-values table.\nexposu… (only in stable) [reference only]

### 01-management-push: manage-push-all / list-workflows

- request: GET /v3/manage/${projectId}/workflows?_syncToolTs=1767225600000
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$.data[0].authoringMode: "source" (only in stable) [reference only]
  - body:$.data[0].definition: {"params":{"balance":{"type":"number"},"cost":{"type":"number"}},"returns":{"ok":true},"steps":[{"check":{"field":"{{balance}}","op":">=","value":"{{cost}}"},"i… (only in candidate) [SDK only]
  - body:$.data[0].description: "Compute an exponential purchase cost for the next level." → "Validate that a player has enough currency for a cost." [value differs]
  - body:$.data[0].id: "scaled-cost" → "check-currency" [value differs]
  - body:$.data[0].kind: "workflow" (only in candidate) [SDK only]
  - body:$.data[0].name: "Scaled Cost" → "Check Currency" [value differs]
  - body:$.data[0].params: {"baseCost":{"type":"number"},"costGrowth":{"type":"number"},"currentValue":{"type":"number"}} (only in stable) [reference only]
  - body:$.data[0].returns: {"cost":"{{cost}}","negCost":"{{neg_cost}}","nextValue":"{{next_value}}"} (only in stable) [reference only]
  - body:$.data[0].sourceFormat: "yaml" (only in stable) [reference only]
  - body:$.data[0].sourcePath: "scaled-cost.workflow.yml" (only in stable) [reference only]
  - body:$.data[0].sourceText: "sourceVersion: 1\nkind: workflow\nid: scaled-cost\nname: Scaled Cost\ndescription: Compute an exponential purchase cost for the next level.\ndefinition:\n  par… (only in stable) [reference only]
  - body:$.data[0].steps: [{"expression":"max(0, {{currentValue}})","id":"current_value","type":"transform"},{"expression":"ceil({{baseCost}} * pow({{costGrowth}}, {{current_value}}))","… (only in stable) [reference only]
  - body:$.data[1].authoringMode: "source" (only in stable) [reference only]
  - body:$.data[1].definition: {"params":{"baseCost":{"type":"number"},"costGrowth":{"type":"number"},"currentValue":{"type":"number"}},"returns":{"cost":"{{cost}}","negCost":"{{neg_cost}}","… (only in candidate) [SDK only]
  - body:$.data[1].description: "Validate that a player has enough currency for a cost." → "Compute an exponential purchase cost for the next level." [value differs]
  - body:$.data[1].id: "check-currency" → "scaled-cost" [value differs]
  - body:$.data[1].kind: "workflow" (only in candidate) [SDK only]
  - body:$.data[1].name: "Check Currency" → "Scaled Cost" [value differs]
  - body:$.data[1].params: {"balance":{"type":"number"},"cost":{"type":"number"}} (only in stable) [reference only]
  - body:$.data[1].returns: {"ok":true} (only in stable) [reference only]
  - body:$.data[1].sourceFormat: "yaml" (only in stable) [reference only]
  - body:$.data[1].sourcePath: "check-currency.workflow.yml" (only in stable) [reference only]
  - body:$.data[1].sourceText: "sourceVersion: 1\nkind: workflow\nid: check-currency\nname: Check Currency\ndescription: Validate that a player has enough currency for a cost.\ndefinition:\n … (only in stable) [reference only]
  - body:$.data[1].steps: [{"check":{"field":"{{balance}}","op":">=","value":"{{cost}}"},"id":"has_currency","onFail":{"error":"INSUFFICIENT_CURRENCY","message":"Not enough currency.","s… (only in stable) [reference only]

### 01-management-push: manage-push-all / preflight-invalid

- request: POST /v3/manage/${projectId}/sync/preflight
- reference stable: 400 application/json;charset=utf-8
- SDK candidate: 400 application/json;charset=utf-8
  - body:$.collections.error: "VALIDATION_FAILED" (only in candidate) [SDK only]
  - body:$.collections.message: "Each collection must have an 'id' or 'name'." (only in candidate) [SDK only]
  - body:$.collections.results[0].diagnostics[0].code: "COLLECTION_NAME_REQUIRED" → "VALIDATION_FAILED" [value differs]
  - body:$.collections.results[0].diagnostics[0].message: "Collection name is required." → "Each collection must have an 'id' or 'name'." [value differs]
  - body:$.collections.results[0].diagnostics[0].resourceId: "collection[0]" → "" [value differs]
  - body:$.collections.results[0].diagnostics[0].sourcePath: "name" (only in stable) [reference only]
  - body:$.collections.results[0].diagnostics[0].suggestedFix: "Use a collection name like player_data." (only in stable) [reference only]
  - body:$.collections.results[0].resourceId: "collection[0]" → "" [value differs]
  - body:$.endpoints.error: "VALIDATION_FAILED" (only in candidate) [SDK only]
  - body:$.endpoints.message: "sourceText could not be parsed." (only in candidate) [SDK only]
  - body:$.endpoints.results[0].diagnostics[0].code: "SOURCE_COMPILE_FAILED" → "VALIDATION_FAILED" [value differs]
  - body:$.endpoints.results[0].diagnostics[0].message: "Invalid YAML source: While parsing a node, did not find expected node content." → "sourceText could not be parsed." [value differs]
  - body:$.endpoints.results[0].diagnostics[0].sourcePath: "sourceText" (only in stable) [reference only]
  - body:$.endpoints.results[0].diagnostics[0].suggestedFix: "Fix the source syntax and retry." (only in stable) [reference only]

### 01-management-push: manage-push-all / push-invalid-section

- request: PUT /v3/manage/${projectId}/sync
- reference stable: 400 application/json;charset=utf-8
- SDK candidate: 400 application/json;charset=utf-8
  - body:$.endpoints.message: "endpoints must be an array" → "Body must be an array of endpoint objects." [value differs]

### 01-management-push: manage-queries / create-leaderboard

- request: POST /v3/manage/${projectId}/queries
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$.action: "upsert" (only in stable) [reference only]
  - body:$.count: 1 (only in candidate) [SDK only]
  - body:$.resourceKind: "query" (only in stable) [reference only]
  - body:$.source: "candidate" (only in stable) [reference only]

### 01-management-push: manage-queries / create-scratch

- request: POST /v3/manage/${projectId}/queries
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$.action: "upsert" (only in stable) [reference only]
  - body:$.count: 1 (only in candidate) [SDK only]
  - body:$.resourceKind: "query" (only in stable) [reference only]
  - body:$.source: "candidate" (only in stable) [reference only]

### 01-management-push: manage-queries / create-secret-count

- request: POST /v3/manage/${projectId}/queries
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$.action: "upsert" (only in stable) [reference only]
  - body:$.count: 1 (only in candidate) [SDK only]
  - body:$.resourceKind: "query" (only in stable) [reference only]
  - body:$.source: "candidate" (only in stable) [reference only]

### 01-management-push: manage-queries / delete-scratch

- request: DELETE /v3/manage/${projectId}/queries/scratch_query
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$.action: "delete" (only in stable) [reference only]
  - body:$.id: "scratch_query" (only in candidate) [SDK only]
  - body:$.resourceId: "scratch_query" (only in stable) [reference only]
  - body:$.resourceKind: "query" (only in stable) [reference only]
  - body:$.source: "candidate" (only in stable) [reference only]

### 01-management-push: manage-rate-limit-rules / get

- request: GET /v3/manage/${projectId}/rate-limit-rules
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$.endpointRateLimits: null (only in stable) [reference only]
  - body:$.projectId: "${projectId}" (only in stable) [reference only]
  - body:$.rules[0].enabled: true (only in stable) [reference only]
  - body:$.rules[0].id: "" (only in stable) [reference only]
  - body:$.rules[0].limit: 1000 (only in candidate) [SDK only]
  - body:$.rules[0].maxPerDay: null (only in stable) [reference only]
  - body:$.rules[0].maxPerHour: null (only in stable) [reference only]
  - body:$.rules[0].maxPerMinute: null (only in stable) [reference only]
  - body:$.rules[0].name: "ore_minute_cap" (only in candidate) [SDK only]
  - body:$.rules[0].window: "perMinute" (only in candidate) [SDK only]
  - body:$.rules[1].enabled: true (only in stable) [reference only]
  - body:$.rules[1].id: "" (only in stable) [reference only]
  - body:$.rules[1].limit: 1000000 (only in candidate) [SDK only]
  - body:$.rules[1].maxPerDay: null (only in stable) [reference only]
  - body:$.rules[1].maxPerHour: null (only in stable) [reference only]
  - body:$.rules[1].maxPerMinute: null (only in stable) [reference only]
  - body:$.rules[1].name: "gold_daily_flag" (only in candidate) [SDK only]
  - body:$.rules[1].window: "perDay" (only in candidate) [SDK only]
  - body:$.source: "configuration" (only in stable) [reference only]

### 01-management-push: manage-rate-limit-rules / put

- request: PUT /v3/manage/${projectId}/rate-limit-rules
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$.action: "upsert" (only in stable) [reference only]
  - body:$.count: 2 (only in candidate) [SDK only]
  - body:$.resourceKind: "rate-limit-rules" (only in stable) [reference only]
  - body:$.source: "candidate" (only in stable) [reference only]

### 01-management-push: manage-resource-crud / list-after-delete

- request: GET /v3/manage/${projectId}/collections
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$.data[0].accessMode: "public" (only in stable) [reference only]
  - body:$.data[0].allowRecordDelete: false (only in stable) [reference only]
  - body:$.data[0].authoringMode: "source" (only in stable) [reference only]
  - body:$.data[0].collectionType: "global" (only in stable) [reference only]
  - body:$.data[0].definition: {"accessMode":"public","allowRecordDelete":false,"collectionType":"global","schema":{"playerName":{"type":"string"},"score":{"type":"number"}}} (only in candidate) [SDK only]
  - body:$.data[0].kind: "collection" (only in candidate) [SDK only]
  - body:$.data[0].schema: {"playerName":{"type":"string"},"score":{"type":"number"}} (only in stable) [reference only]
  - body:$.data[0].sourceFormat: "yaml" (only in stable) [reference only]
  - body:$.data[0].sourcePath: "leaderboard_global.collection.yml" (only in stable) [reference only]
  - body:$.data[0].sourceText: "sourceVersion: 1\nkind: collection\nid: leaderboard_global\nname: leaderboard_global\ndescription: Shared append-only run log.\ndefinition:\n  collectionType: … (only in stable) [reference only]
  - body:$.data[0].visibility: "private" (only in stable) [reference only]
  - body:$.data[1].accessMode: "public" (only in stable) [reference only]
  - body:$.data[1].allowRecordDelete: true (only in stable) [reference only]
  - body:$.data[1].authoringMode: "source" (only in stable) [reference only]
  - body:$.data[1].collectionType: "per-steamid" (only in stable) [reference only]
  - body:$.data[1].definition: {"accessMode":"public","allowRecordDelete":true,"collectionType":"per-steamid","maxRecords":1,"rateLimitAction":"reject","rateLimits":{"mode":"none"},"requireSa… (only in candidate) [SDK only]
  - body:$.data[1].kind: "collection" (only in candidate) [SDK only]
  - body:$.data[1].maxRecords: 1 (only in stable) [reference only]
  - body:$.data[1].rateLimitAction: "reject" (only in stable) [reference only]
  - body:$.data[1].rateLimits: {"mode":"none"} (only in stable) [reference only]
  - body:$.data[1].requireSaveVersion: false (only in stable) [reference only]
  - body:$.data[1].schema: {"gold":{"_ledger":true,"default":100,"type":"number"},"level":{"default":0,"type":"number"},"ores":{"default":{"stone":0},"properties":{"stone":{"type":"number… (only in stable) [reference only]
  - body:$.data[1].sourceFormat: "yaml" (only in stable) [reference only]
  - body:$.data[1].sourcePath: "players.collection.yml" (only in stable) [reference only]
  - body:$.data[1].sourceText: "sourceVersion: 1\nkind: collection\nid: players\nname: players\ndescription: Per-player profile and economy state.\ndefinition:\n  collectionType: per-steamid\… (only in stable) [reference only]
  - body:$.data[1].visibility: "private" (only in stable) [reference only]
  - body:$.data[2].accessMode: "public" (only in stable) [reference only]
  - body:$.data[2].allowRecordDelete: true (only in stable) [reference only]
  - body:$.data[2].authoringMode: "source" (only in stable) [reference only]
  - body:$.data[2].collectionType: "per-steamid" (only in stable) [reference only]
  - body:$.data[2].definition: {"accessMode":"public","allowRecordDelete":true,"collectionType":"per-steamid","maxRecords":3,"schema":{"playtimeSeconds":{"default":0,"type":"number"},"slotNam… (only in candidate) [SDK only]
  - body:$.data[2].kind: "collection" (only in candidate) [SDK only]
  - body:$.data[2].maxRecords: 3 (only in stable) [reference only]
  - body:$.data[2].schema: {"playtimeSeconds":{"default":0,"type":"number"},"slotName":{"default":"","type":"string"}} (only in stable) [reference only]
  - body:$.data[2].sourceFormat: "yaml" (only in stable) [reference only]
  - body:$.data[2].sourcePath: "save_slots.collection.yml" (only in stable) [reference only]
  - body:$.data[2].sourceText: "sourceVersion: 1\nkind: collection\nid: save_slots\nname: save_slots\ndescription: Up to three save files per player.\ndefinition:\n  collectionType: per-steam… (only in stable) [reference only]
  - body:$.data[2].visibility: "private" (only in stable) [reference only]

### 01-management-push: manage-resource-crud / list-after-put

- request: GET /v3/manage/${projectId}/endpoints
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$.data[0].authoringMode: "source" (only in stable) [reference only]
  - body:$.data[0].enabled: true (only in candidate) [SDK only]
  - body:$.data[0].kind: "endpoint" (only in candidate) [SDK only]
  - body:$.data[0].slug: "mine-ore" (only in stable) [reference only]
  - body:$.data[0].sourceFormat: "yaml" (only in stable) [reference only]
  - body:$.data[0].sourcePath: "mine-ore.endpoint.yml" (only in stable) [reference only]
  - body:$.data[0].sourceText: "sourceVersion: 1\nkind: endpoint\nid: mine-ore\nname: Mine Ore\ndescription: Adds ore after validating the amount.\nexposure: public\nmethod: POST\ninput:\n  t… (only in stable) [reference only]
  - body:$.data[1].authoringMode: "source" (only in stable) [reference only]
  - body:$.data[1].enabled: true (only in candidate) [SDK only]
  - body:$.data[1].kind: "endpoint" (only in candidate) [SDK only]
  - body:$.data[1].slug: "grant-gold" (only in stable) [reference only]
  - body:$.data[1].sourceFormat: "yaml" (only in stable) [reference only]
  - body:$.data[1].sourcePath: "grant-gold.endpoint.yml" (only in stable) [reference only]
  - body:$.data[1].sourceText: "sourceVersion: 1\nkind: endpoint\nid: grant-gold\nname: Grant Gold\ndescription: Dedicated-server-only reward grant.\nexposure: public\nrequiresSecretKey: true… (only in stable) [reference only]
  - body:$.data[2].authoringMode: "source" (only in stable) [reference only]
  - body:$.data[2].description: "Return the caller's players record." → "Health ping endpoint." [value differs]
  - body:$.data[2].enabled: true (only in candidate) [SDK only]
  - body:$.data[2].id: "load-profile" → "ping" [value differs]
  - body:$.data[2].kind: "endpoint" (only in candidate) [SDK only]
  - body:$.data[2].name: "Load Profile" → "ping" [value differs]
  - body:$.data[2].response.body.pong: true (only in candidate) [SDK only]
  - body:$.data[2].response.body.profile: "{{profile}}" (only in stable) [reference only]
  - body:$.data[2].slug: "load-profile" (only in stable) [reference only]
  - body:$.data[2].sourceFormat: "yaml" (only in stable) [reference only]
  - body:$.data[2].sourcePath: "load-profile.endpoint.yml" (only in stable) [reference only]
  - body:$.data[2].sourceText: "sourceVersion: 1\nkind: endpoint\nid: load-profile\nname: Load Profile\ndescription: Return the caller's players record.\nexposure: public\nmethod: POST\ninput… (only in stable) [reference only]
  - body:$.data[2].steps[0]: {"collection":"players","id":"profile","key":"{{steamId}}","type":"read"} (only in stable) [reference only]
  - body:$.data[3].authoringMode: "source" (only in stable) [reference only]
  - body:$.data[3].description: "Save non-economic profile state." → "Return the caller's players record." [value differs]
  - body:$.data[3].enabled: true (only in candidate) [SDK only]
  - body:$.data[3].id: "save-profile" → "load-profile" [value differs]
  - body:$.data[3].input.properties.playerName: {"type":"string"} (only in stable) [reference only]
  - body:$.data[3].input.required: ["playerName"] (only in stable) [reference only]
  - body:$.data[3].kind: "endpoint" (only in candidate) [SDK only]
  - body:$.data[3].name: "Save Profile" → "Load Profile" [value differs]
  - body:$.data[3].response.body.profile: "{{profile}}" (only in candidate) [SDK only]
  - body:$.data[3].slug: "save-profile" (only in stable) [reference only]
  - body:$.data[3].sourceFormat: "yaml" (only in stable) [reference only]
  - body:$.data[3].sourcePath: "save-profile.endpoint.yml" (only in stable) [reference only]
  - body:$.data[3].sourceText: "sourceVersion: 1\nkind: endpoint\nid: save-profile\nname: Save Profile\ndescription: Save non-economic profile state.\nexposure: public\nmethod: POST\ninput:\n… (only in stable) [reference only]
  - body:$.data[3].steps[0].id: "save" → "profile" [value differs]
  - body:$.data[3].steps[0].ops: [{"op":"set","path":"playerName","value":"{{input.playerName}}"}] (only in stable) [reference only]
  - body:$.data[3].steps[0].type: "write" → "read" [value differs]
  - body:$.data[4].authoringMode: "source" (only in stable) [reference only]
  - body:$.data[4].description: "Static read-only listing endpoint (callable by GET)." → "Save non-economic profile state." [value differs]
  - body:$.data[4].enabled: true (only in candidate) [SDK only]
  - body:$.data[4].id: "market-listings" → "save-profile" [value differs]
  - body:$.data[4].input: {"properties":{"playerName":{"type":"string"}},"required":["playerName"],"type":"object"} (only in candidate) [SDK only]
  - body:$.data[4].kind: "endpoint" (only in candidate) [SDK only]
  - body:$.data[4].method: "GET" → "POST" [value differs]
  - body:$.data[4].name: "Market Listings" → "Save Profile" [value differs]
  - body:$.data[4].response.body.listings: [] (only in stable) [reference only]
  - body:$.data[4].slug: "market-listings" (only in stable) [reference only]
  - body:$.data[4].sourceFormat: "yaml" (only in stable) [reference only]
  - body:$.data[4].sourcePath: "market-listings.endpoint.yml" (only in stable) [reference only]
  - body:$.data[4].sourceText: "sourceVersion: 1\nkind: endpoint\nid: market-listings\nname: Market Listings\ndescription: Static read-only listing endpoint (callable by GET).\nexposure: publ… (only in stable) [reference only]
  - body:$.data[4].steps[0]: {"collection":"players","id":"save","key":"{{steamId}}","ops":[{"op":"set","path":"playerName","value":"{{input.playerName}}"}],"type":"write"} (only in candidate) [SDK only]
  - body:$.data[5].authoringMode: "source" (only in stable) [reference only]
  - body:$.data[5].description: "Workflow-backed purchase priced from the upgrades game-values table." → "Static read-only listing endpoint (callable by GET)." [value differs]
  - body:$.data[5].enabled: true (only in candidate) [SDK only]
  - body:$.data[5].id: "buy-upgrade" → "market-listings" [value differs]
  - body:$.data[5].input: {"properties":{"upgradeId":{"type":"string"}},"required":["upgradeId"],"type":"object"} (only in stable) [reference only]
  - body:$.data[5].kind: "endpoint" (only in candidate) [SDK only]
  - body:$.data[5].method: "POST" → "GET" [value differs]
  - body:$.data[5].name: "Buy Upgrade" → "Market Listings" [value differs]
  - body:$.data[5].response.body.cost: "{{pricing.cost}}" (only in stable) [reference only]
  - body:$.data[5].response.body.level: "{{pricing.nextValue}}" (only in stable) [reference only]
  - body:$.data[5].response.body.listings: [] (only in candidate) [SDK only]
  - body:$.data[5].slug: "buy-upgrade" (only in stable) [reference only]
  - body:$.data[5].sourceFormat: "yaml" (only in stable) [reference only]
  - body:$.data[5].sourcePath: "buy-upgrade.endpoint.yml" (only in stable) [reference only]
  - body:$.data[5].sourceText: "sourceVersion: 1\nkind: endpoint\nid: buy-upgrade\nname: Buy Upgrade\ndescription: Workflow-backed purchase priced from the upgrades game-values table.\nexposu… (only in stable) [reference only]
  - body:$.data[5].steps[0]: {"collection":"players","id":"player","key":"{{steamId}}","type":"read"} (only in stable) [reference only]
  - body:$.data[5].steps[1]: {"id":"upgrade","onMissing":{"errorCode":"UNKNOWN_UPGRADE","message":"Unknown upgrade.","status":400},"required":true,"source":"values","table":"upgrades","type… (only in stable) [reference only]
  - body:$.data[5].steps[2]: {"id":"pricing","params":{"baseCost":"{{upgrade.baseCost}}","costGrowth":"{{upgrade.costGrowth}}","currentValue":"{{player.level}}"},"type":"workflow","workflow… (only in stable) [reference only]
  - body:$.data[5].steps[3]: {"id":"afford","params":{"balance":"{{player.gold}}","cost":"{{pricing.cost}}"},"type":"workflow","workflow":"check-currency"} (only in stable) [reference only]
  - body:$.data[5].steps[4]: {"collection":"players","id":"charge","key":"{{steamId}}","ops":[{"op":"inc","path":"gold","value":"{{pricing.negCost}}"},{"op":"set","path":"level","value":"{{… (only in stable) [reference only]
  - body:$.data[6].description: "Health ping endpoint." → "Workflow-backed purchase priced from the upgrades game-values table." [value differs]
  - body:$.data[6].exposure: "public" (only in candidate) [SDK only]
  - body:$.data[6].id: "ping" → "buy-upgrade" [value differs]
  - body:$.data[6].input.properties.upgradeId: {"type":"string"} (only in candidate) [SDK only]
  - body:$.data[6].input.required: ["upgradeId"] (only in candidate) [SDK only]
  - body:$.data[6].kind: "endpoint" (only in candidate) [SDK only]
  - body:$.data[6].name: "ping" → "Buy Upgrade" [value differs]
  - body:$.data[6].response.body.cost: "{{pricing.cost}}" (only in candidate) [SDK only]
  - body:$.data[6].response.body.level: "{{pricing.nextValue}}" (only in candidate) [SDK only]
  - body:$.data[6].response.body.pong: true (only in stable) [reference only]
  - body:$.data[6].slug: "ping" (only in stable) [reference only]
  - body:$.data[6].sourceVersion: 1 (only in candidate) [SDK only]
  - body:$.data[6].steps[0]: {"collection":"players","id":"player","key":"{{steamId}}","type":"read"} (only in candidate) [SDK only]
  - body:$.data[6].steps[1]: {"id":"upgrade","onMissing":{"errorCode":"UNKNOWN_UPGRADE","message":"Unknown upgrade.","status":400},"required":true,"source":"values","table":"upgrades","type… (only in candidate) [SDK only]
  - body:$.data[6].steps[2]: {"id":"pricing","params":{"baseCost":"{{upgrade.baseCost}}","costGrowth":"{{upgrade.costGrowth}}","currentValue":"{{player.level}}"},"type":"workflow","workflow… (only in candidate) [SDK only]
  - body:$.data[6].steps[3]: {"id":"afford","params":{"balance":"{{player.gold}}","cost":"{{pricing.cost}}"},"type":"workflow","workflow":"check-currency"} (only in candidate) [SDK only]
  - body:$.data[6].steps[4]: {"collection":"players","id":"charge","key":"{{steamId}}","ops":[{"op":"inc","path":"gold","value":"{{pricing.negCost}}"},{"op":"set","path":"level","value":"{{… (only in candidate) [SDK only]

### 01-management-push: manage-tests-and-tools / auto-test-all

- request: POST /v3/manage/${projectId}/auto-test
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$.failed: 0 (only in candidate) [SDK only]
  - body:$.passed: 0 (only in candidate) [SDK only]
  - body:$.results[0]: {"deprecated":false,"endpoint":"buy-upgrade","errors":["Endpoint returned HTTP 400."],"method":"POST","name":"Auto-test buy-upgrade","passed":false,"result":{"b… (only in stable) [reference only]
  - body:$.results[1]: {"deprecated":false,"endpoint":"grant-gold","errors":[],"method":"POST","name":"Auto-test grant-gold","passed":true,"result":{"body":{"granted":1,"ok":true},"st… (only in stable) [reference only]
  - body:$.results[2]: {"deprecated":false,"endpoint":"load-profile","errors":[],"method":"POST","name":"Auto-test load-profile","passed":true,"result":{"body":{"ok":true,"profile":nu… (only in stable) [reference only]
  - body:$.results[3]: {"deprecated":false,"endpoint":"market-listings","errors":[],"method":"GET","name":"Auto-test market-listings","passed":true,"result":{"body":{"listings":[],"ok… (only in stable) [reference only]
  - body:$.results[4]: {"deprecated":false,"endpoint":"mine-ore","errors":[],"method":"POST","name":"Auto-test mine-ore","passed":true,"result":{"body":{"mined":1,"ok":true},"status":… (only in stable) [reference only]
  - body:$.results[5]: {"deprecated":false,"endpoint":"save-profile","errors":[],"method":"POST","name":"Auto-test save-profile","passed":true,"result":{"body":{"ok":true},"status":20… (only in stable) [reference only]
  - body:$.summary: {"failed":1,"passed":5,"total":6} (only in stable) [reference only]

### 01-management-push: manage-tests-and-tools / auto-test-one

- request: POST /v3/manage/${projectId}/auto-test
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$.deprecated: false (only in stable) [reference only]
  - body:$.endpoint: "mine-ore" (only in stable) [reference only]
  - body:$.errors: [] (only in stable) [reference only]
  - body:$.failed: 0 (only in candidate) [SDK only]
  - body:$.method: "POST" (only in stable) [reference only]
  - body:$.name: "Auto-test mine-ore" (only in stable) [reference only]
  - body:$.passed: true → 0 [value differs]
  - body:$.result: {"body":{"mined":1,"ok":true},"status":200} (only in stable) [reference only]
  - body:$.results: [] (only in candidate) [SDK only]
  - body:$.warnings: [] (only in stable) [reference only]

### 01-management-push: manage-tests-and-tools / config

- request: GET /v3/manage/${projectId}/config
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$.config: {"authSessionTtlSeconds":3600,"enableAuthSessions":false,"enableEncryptedRequests":false,"enabled":true,"encryptedRequestWindowSeconds":300,"playerKeyMode":"pub… (only in stable) [reference only]
  - body:$.counts: {"collections":3,"endpoints":6,"gameValues":2,"queries":2,"workflows":2} (only in candidate) [SDK only]
  - body:$.enableAuthSessions: false (only in stable) [reference only]
  - body:$.enableEncryptedRequests: false (only in stable) [reference only]
  - body:$.revision: 10 (only in candidate) [SDK only]
  - body:$.settings: {"authSessionTtlSeconds":3600,"enableAuthSessions":false,"enableEncryptedRequests":false,"enabled":true,"encryptedRequestWindowSeconds":300,"playerKeyMode":"pub… (only in stable) [reference only]

### 01-management-push: manage-validate / settings

- request: GET /v3/manage/${projectId}/settings
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$.config: {"authSessionTtlSeconds":3600,"enableAuthSessions":false,"enableEncryptedRequests":false,"enabled":true,"encryptedRequestWindowSeconds":300,"playerKeyMode":"pub… (only in stable) [reference only]
  - body:$.enableAuthSessions: false (only in stable) [reference only]
  - body:$.enableEncryptedRequests: false (only in stable) [reference only]
  - body:$.settings.authSessionTtlSeconds: 3600 (only in stable) [reference only]
  - body:$.settings.enableEncryptedRequests: false (only in stable) [reference only]
  - body:$.settings.enabled: true (only in stable) [reference only]
  - body:$.settings.encryptedRequestMode: "off" (only in candidate) [SDK only]
  - body:$.settings.encryptedRequestWindowSeconds: 300 (only in stable) [reference only]
  - body:$.settings.playerKeyMode: "public" (only in stable) [reference only]
  - body:$.settings.requireSboxAuth: false (only in stable) [reference only]
  - body:$.settings.revisionEnforcementEnabled: false (only in stable) [reference only]
  - body:$.settings.revisionEnforcementMode: "allow_continue" (only in stable) [reference only]
  - body:$.settings.revisionEscalateAfterMinutes: null (only in stable) [reference only]
  - body:$.settings.revisionForceEndpointUpgrade: false (only in stable) [reference only]
  - body:$.settings.revisionGracePeriodMinutes: null (only in stable) [reference only]
  - body:$.settings.revisionNotifyMessage: "" (only in stable) [reference only]
  - body:$.settings.revisionPostGraceAction: "block_writes" (only in stable) [reference only]
  - body:$.settings.revisionShowDefaultMessage: false (only in stable) [reference only]
  - body:$.settings.revisionShowNewVersionBanner: true (only in stable) [reference only]
  - body:$.settings.revisionShowPopupOnce: true (only in stable) [reference only]
  - body:$.settings.revisionShowUpdateOptions: true (only in stable) [reference only]
  - body:$.settings.revisionTestOutdatedEditor: false (only in stable) [reference only]
  - body:$.settings.revisionTestOutdatedLive: false (only in stable) [reference only]

### 01-management-push: manage-validate / validate-both-keys

- request: GET /v3/manage/${projectId}/validate
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$.checks: {"projectId":{"message":"Found","ok":true},"publicKey":{"message":"Valid","ok":true},"secretKey":{"message":"Valid","ok":true}} (only in stable) [reference only]
  - body:$.project: {"id":"${projectId}","settings":{"enabled":true},"title":"${projectId}"} (only in stable) [reference only]
  - body:$.projectId: "${projectId}" (only in candidate) [SDK only]
  - body:$.revision: 0 (only in candidate) [SDK only]

### 01-management-push: manage-validate / validate-secret-only

- request: GET /v3/manage/${projectId}/validate
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$.checks: {"projectId":{"message":"Found","ok":true},"publicKey":{"message":"Not provided","ok":false},"secretKey":{"message":"Valid","ok":true}} (only in stable) [reference only]
  - body:$.project: {"id":"${projectId}","settings":{"enabled":true},"title":"${projectId}"} (only in stable) [reference only]
  - body:$.projectId: "${projectId}" (only in candidate) [SDK only]
  - body:$.revision: 0 (only in candidate) [SDK only]

### 09-queries: queries-run / api-storage-alias

- request: GET /api/storage/${projectId}/queries/top_miners?apiKey=${publicKey}
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - header:cache-control: no-store, max-age=0 (only in stable) [reference only]
  - body:$.columns[0]: "rank" (only in candidate) [SDK only]
  - body:$.columns[1]: "key" (only in candidate) [SDK only]
  - body:$.columns[2]: "value" (only in candidate) [SDK only]
  - body:$.outputFields: [] (only in stable) [reference only]
  - body:$.performance: {"at":"<timestamp>","computedErrors":null,"computedFields":null,"durationMs":"<masked:durationMs>","keysScanned":1,"sources":[{"alias":"players","collectionId":… (only in stable) [reference only]
  - body:$.query: "top_miners" (only in stable) [reference only]
  - body:$.queryName: "top_miners" (only in stable) [reference only]
  - body:$.ttl: 300 (only in stable) [reference only]
  - body:$.updatedAt: "<masked:updatedAt>" (only in stable) [reference only]

### 09-queries: queries-run / leaderboard

- request: GET /v3/queries/${projectId}/top_miners?apiKey=${publicKey}
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - header:cache-control: no-store, max-age=0 (only in stable) [reference only]
  - body:$.columns[0]: "rank" (only in candidate) [SDK only]
  - body:$.columns[1]: "key" (only in candidate) [SDK only]
  - body:$.columns[2]: "value" (only in candidate) [SDK only]
  - body:$.outputFields: [] (only in stable) [reference only]
  - body:$.performance: {"at":"<timestamp>","computedErrors":null,"computedFields":null,"durationMs":"<masked:durationMs>","keysScanned":1,"sources":[{"alias":"players","collectionId":… (only in stable) [reference only]
  - body:$.query: "top_miners" (only in stable) [reference only]
  - body:$.queryName: "top_miners" (only in stable) [reference only]
  - body:$.ttl: 300 (only in stable) [reference only]
  - body:$.updatedAt: "<masked:updatedAt>" (only in stable) [reference only]

### 09-queries: queries-run / leaderboard-v1

- request: GET /v1/queries/${projectId}/top_miners?apiKey=${publicKey}
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - header:cache-control: no-store, max-age=0 (only in stable) [reference only]
  - body:$.columns[0]: "rank" (only in candidate) [SDK only]
  - body:$.columns[1]: "key" (only in candidate) [SDK only]
  - body:$.columns[2]: "value" (only in candidate) [SDK only]
  - body:$.outputFields: [] (only in stable) [reference only]
  - body:$.performance: {"at":"<timestamp>","computedErrors":null,"computedFields":null,"durationMs":"<masked:durationMs>","keysScanned":1,"sources":[{"alias":"players","collectionId":… (only in stable) [reference only]
  - body:$.query: "top_miners" (only in stable) [reference only]
  - body:$.queryName: "top_miners" (only in stable) [reference only]
  - body:$.ttl: 300 (only in stable) [reference only]
  - body:$.updatedAt: "<masked:updatedAt>" (only in stable) [reference only]

### 09-queries: queries-run / secret-query-dedicated

- request: GET /v3/queries/${projectId}/player_count?apiKey=${publicKey}&secret-key=1
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - header:cache-control: no-store, max-age=0 (only in stable) [reference only]
  - body:$.columns: ["count"] (only in candidate) [SDK only]
  - body:$.entries: [{"count":1}] (only in candidate) [SDK only]
  - body:$.performance: {"at":"<timestamp>","computedErrors":null,"computedFields":null,"durationMs":"<masked:durationMs>","keysScanned":1,"sources":[{"alias":"players","collectionId":… (only in stable) [reference only]
  - body:$.query: "player_count" (only in stable) [reference only]
  - body:$.queryName: "player_count" (only in stable) [reference only]
  - body:$.ttl: 300 (only in stable) [reference only]
  - body:$.updatedAt: "<masked:updatedAt>" (only in stable) [reference only]

### 09-queries: queries-run / secret-query-public-key

- request: GET /v3/queries/${projectId}/player_count?apiKey=${publicKey}
- reference stable: 401 application/json;charset=utf-8
- SDK candidate: 401 application/json;charset=utf-8
  - body:$.ok: false (only in candidate) [SDK only]

### 06-ledger-and-records: records-save-slots / create-unnamed

- request: POST /v3/storage/${projectId}/save_slots/${steamId}/records?apiKey=${publicKey}
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$.recordName: "Save" → "Untitled save" [value differs]

### 06-ledger-and-records: records-save-slots / delete-missing

- request: DELETE /v3/storage/${projectId}/save_slots/${steamId}/records/missing-record?apiKey=${publicKey}
- reference stable: 404 application/json;charset=utf-8
- SDK candidate: 404 application/json;charset=utf-8
  - body:$.ok: false (only in candidate) [SDK only]

### 06-ledger-and-records: records-save-slots / list

- request: GET /v3/storage/${projectId}/save_slots/${steamId}/records?apiKey=${publicKey}
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$.ok: true (only in candidate) [SDK only]
  - body:$.records[0].CreatedAt: "<masked:CreatedAt>" (only in stable) [reference only]
  - body:$.records[0].IsLegacy: false (only in stable) [reference only]
  - body:$.records[0].RecordId: "<capture:slotA>" (only in stable) [reference only]
  - body:$.records[0].UpdatedAt: "<masked:UpdatedAt>" (only in stable) [reference only]
  - body:$.records[0].data: {} (only in candidate) [SDK only]
  - body:$.records[0].id: "<capture:slotA>" (only in candidate) [SDK only]
  - body:$.records[1].CreatedAt: "<masked:CreatedAt>" (only in stable) [reference only]
  - body:$.records[1].IsLegacy: false (only in stable) [reference only]
  - body:$.records[1].RecordId: "<capture:slotB>" (only in stable) [reference only]
  - body:$.records[1].RecordName: "Save" → "Untitled save" [value differs]
  - body:$.records[1].UpdatedAt: "<masked:UpdatedAt>" (only in stable) [reference only]
  - body:$.records[1].data: {} (only in candidate) [SDK only]
  - body:$.records[1].id: "<capture:slotB>" (only in candidate) [SDK only]
  - body:$.records[1].recordName: "Save" → "Untitled save" [value differs]

### 06-ledger-and-records: records-save-slots / list-after

- request: GET /v3/storage/${projectId}/save_slots/${steamId}/records?apiKey=${publicKey}
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$.ok: true (only in candidate) [SDK only]
  - body:$.records[0].CreatedAt: "<masked:CreatedAt>" (only in stable) [reference only]
  - body:$.records[0].IsLegacy: false (only in stable) [reference only]
  - body:$.records[0].RecordId: "<capture:slotA>" (only in stable) [reference only]
  - body:$.records[0].UpdatedAt: "<masked:UpdatedAt>" (only in stable) [reference only]
  - body:$.records[0].data: {} (only in candidate) [SDK only]
  - body:$.records[0].id: "<capture:slotA>" (only in candidate) [SDK only]

### 06-ledger-and-records: records-save-slots / list-empty

- request: GET /v3/storage/${projectId}/save_slots/${steamId}/records?apiKey=${publicKey}
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$.ok: true (only in candidate) [SDK only]

### 06-ledger-and-records: records-save-slots / rename-missing

- request: PATCH /v3/storage/${projectId}/save_slots/${steamId}/records/missing-record?apiKey=${publicKey}
- reference stable: 404 application/json;charset=utf-8
- SDK candidate: 404 application/json;charset=utf-8
  - body:$.ok: false (only in candidate) [SDK only]

### 02-runtime-config: runtime-rate-limits / rate-limits

- request: GET /v3/storage/${projectId}/rate-limits?apiKey=${publicKey}
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$.endpointRateLimits: {} (only in stable) [reference only]
  - body:$.source: "store" (only in stable) [reference only]

### 02-runtime-config: runtime-rate-limits / rate-limits-v1

- request: GET /v1/storage/${projectId}/rate-limits?apiKey=${publicKey}
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - body:$.endpointRateLimits: {} (only in stable) [reference only]
  - body:$.source: "store" (only in stable) [reference only]

### 02-runtime-config: runtime-security-config / security-config

- request: GET /v3/security-config/${projectId}
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - header:cache-control: public, max-age=15, s-maxage=60 (only in stable) [reference only]
  - header:x-security-config-cache: public (only in stable) [reference only]
  - header:x-security-config-source: store (only in stable) [reference only]
  - header:x-security-config-version: <present> (only in stable) [reference only]
  - body:$.config: {"configVersion":"<masked:configVersion>","generatedAt":"<masked:generatedAt>","modes":{"analytics":"enabled","authSessions":"disabled","encryptedRequests":"dis… (only in stable) [reference only]
  - body:$.configVersion: "<masked:configVersion>" (only in candidate) [SDK only]
  - body:$.generatedAt: "<masked:generatedAt>" (only in candidate) [SDK only]
  - body:$.modes: {"analytics":"disabled","authSessions":"disabled","encryptedRequests":"disabled"} (only in candidate) [SDK only]
  - body:$.ok: true (only in stable) [reference only]
  - body:$.projectId: "${projectId}" (only in candidate) [SDK only]
  - body:$.schemaVersion: 1 (only in candidate) [SDK only]
  - body:$.settings: {"analytics":{"allowedEventTypes":["death","respawn","cast_line","caught_fish","sold_fish"],"enabled":false},"authSessionTtlSeconds":3600,"enableAuthSessions":f… (only in candidate) [SDK only]
  - body:$.signature: "<masked:signature>" (only in candidate) [SDK only]
  - body:$.signing: {"algorithm":"rsa-sha256","keyId":"<masked:keyId>","publicKeyJwk":"<masked:publicKeyJwk:object>","publicKeyPem":"<masked:publicKeyPem>"} (only in candidate) [SDK only]
  - body:$.source: "store" (only in stable) [reference only]
  - body:$.ttlSeconds: 60 (only in candidate) [SDK only]

### 02-runtime-config: runtime-security-config / security-config-refresh

- request: GET /v3/security-config/${projectId}?refresh=1
- reference stable: 200 application/json;charset=utf-8
- SDK candidate: 200 application/json;charset=utf-8
  - header:cache-control: no-store, max-age=0 (only in stable) [reference only]
  - header:x-security-config-cache: bypass (only in stable) [reference only]
  - header:x-security-config-source: store (only in stable) [reference only]
  - header:x-security-config-version: <present> (only in stable) [reference only]
  - body:$.config: {"configVersion":"<masked:configVersion>","generatedAt":"<masked:generatedAt>","modes":{"analytics":"enabled","authSessions":"disabled","encryptedRequests":"dis… (only in stable) [reference only]
  - body:$.configVersion: "<masked:configVersion>" (only in candidate) [SDK only]
  - body:$.generatedAt: "<masked:generatedAt>" (only in candidate) [SDK only]
  - body:$.modes: {"analytics":"disabled","authSessions":"disabled","encryptedRequests":"disabled"} (only in candidate) [SDK only]
  - body:$.ok: true (only in stable) [reference only]
  - body:$.projectId: "${projectId}" (only in candidate) [SDK only]
  - body:$.schemaVersion: 1 (only in candidate) [SDK only]
  - body:$.settings: {"analytics":{"allowedEventTypes":["death","respawn","cast_line","caught_fish","sold_fish"],"enabled":false},"authSessionTtlSeconds":3600,"enableAuthSessions":f… (only in candidate) [SDK only]
  - body:$.signature: "<masked:signature>" (only in candidate) [SDK only]
  - body:$.signing: {"algorithm":"rsa-sha256","keyId":"<masked:keyId>","publicKeyJwk":"<masked:publicKeyJwk:object>","publicKeyPem":"<masked:publicKeyPem>"} (only in candidate) [SDK only]
  - body:$.source: "store" (only in stable) [reference only]
  - body:$.ttlSeconds: 60 (only in candidate) [SDK only]

## Intentional differences (allow-list)

These steps differ only on paths the allow-list names. Reasons are copied from `tests/parity/intentional-differences.json`.

- 07-analytics-and-stats: analytics-and-heartbeat / stats-read
  - Live bug: managed service answers 404 for player stats immediately after accepted heartbeats, failing the corpus contract.
- 03-endpoints: endpoints-get-and-routing / get-unknown-slug
  - Live bug: managed service treats an unknown slug as an unsupported definition (501 ENDPOINT_NOT_SUPPORTED) and fails the corpus contract (404 ENDPOINT_NOT_FOUND).
- 03-endpoints: endpoints-get-and-routing / unknown-slug
  - Live bug: managed service treats an unknown slug as an unsupported definition (501 ENDPOINT_NOT_SUPPORTED) and fails the corpus contract (404 ENDPOINT_NOT_FOUND).
- 03-endpoints: endpoints-player-flow / buy-drill-unaffordable
  - Live bug: managed endpoint executor cannot resolve game-value table scan sources (400 ENDPOINT_ERROR.LOOKUP) and fails the corpus contract (409 INSUFFICIENT_CURRENCY).
- 03-endpoints: endpoints-player-flow / buy-unknown-upgrade
  - Library envelope (#152): HTTP 200 with the real status in the body for library callers (reference epError).
  - Live bug: status matches (400) only because the managed executor fails the table lookup (ENDPOINT_ERROR.LOOKUP) before evaluating the upgrade; this server returns UNKNOWN_UPGRADE.
- 03-endpoints: endpoints-secret-key / player-grant-rejected
  - Library envelope (#152): HTTP 200 with the real status in the body for library callers (reference epError).
- 10-errors: errors-invalid-input / document-invalid-collection-id
  - Live bug: managed service answers 500 STORAGE_ERROR for an invalid collection id; corpus contract is 404.
- 10-errors: errors-invalid-input / endpoint-invalid-slug
  - Live bug: managed service answers 501 ENDPOINT_NOT_SUPPORTED for an invalid slug and fails the corpus contract (404).
- 10-errors: errors-oversized-payloads / document-oversized
  - Live bug: managed service answers 500 STORAGE_ERROR for an oversized document; corpus contract is 413 PAYLOAD_TOO_LARGE.
- 10-errors: errors-oversized-payloads / endpoint-oversized
  - Live bug: managed service answers 500 STORAGE_WRITE_FAILED for an oversized endpoint payload; corpus contract is 413 PAYLOAD_TOO_LARGE.
- 05-global-records: global-append-list / list
  - Live bug: appended global records are not readable on the managed service (list empty after successful appends; see the record step). Candidate lists the appends. New-project projection behavior: a project created after 0.5.2 has legacyPlayerProjections off, so no leaderboard_global/default projection record is written; projects that existed at migration keep that projection.
- 05-global-records: global-append-list / record
  - Live bug: managed service answers 404 reading a record it just appended, failing the corpus contract.
- 06-ledger-and-records: ledger-read / ledger
  - Live bug: managed service answers 404 for an empty ledger and fails the corpus contract (200 with an empty page).
- 01-management-push: manage-package-and-revision / package-sync
  - Live-unimplemented: managed service answers 200 with an empty body and fails the corpus contract; this server returns the synced gamePackage.
- 01-management-push: manage-package-and-revision / revision-init
  - Live-unimplemented: managed service answers 501 STORAGE_API_DECOMMISSIONED and fails the corpus contract; this server implements revision-init.
- 01-management-push: manage-package-and-revision / revision-init-outdated
  - Live-unimplemented: managed service answers 501 STORAGE_API_DECOMMISSIONED and fails the corpus contract; this server implements revision-init.
- 01-management-push: manage-queries / list
  - Live-unimplemented: managed service answers 501 MANAGEMENT_MUTATION_NOT_IMPLEMENTED and fails the corpus contract; this server implements the route.
- 01-management-push: manage-queries / list-after-delete
  - Live-unimplemented: managed service answers 501 MANAGEMENT_MUTATION_NOT_IMPLEMENTED and fails the corpus contract; this server implements the route.
- 01-management-push: manage-resource-crud / patch-collection
  - Reference captured with writes suppressed (write_suppressed_dry_run envelope); this server answers the actual PATCH result.
- 01-management-push: manage-resource-crud / patch-endpoint
  - Reference captured with writes suppressed (write_suppressed_dry_run envelope); this server answers the actual PATCH result.
- 01-management-push: manage-resource-crud / patch-workflow
  - Reference captured with writes suppressed (write_suppressed_dry_run envelope); this server answers the actual PATCH result.
- 01-management-push: manage-tests-and-tools / put-tests
  - Live-unimplemented: managed service answers 404 route-not-recognized and fails the corpus contract; this server implements PUT tests.
- 01-management-push: manage-tests-and-tools / source-upgrade
  - Live-unimplemented: managed service answers 501 STORAGE_API_DECOMMISSIONED and fails the corpus contract; this server implements source-upgrade.

## Known differences outside the corpus

These are not measured by the corpus. They are recorded here so they are not mistaken for parity.

- Pages: `GET /pages/{project}/{slug}` answers the reference's 404 `Project not found.` for any page request of the matching project, because the SDK has no page content.
- Staged records are keyed by id, not slug.
- Job scope is project-only.
- Promotion is all-or-nothing across sections.
- Staged DELETE is live-only.
- Async sync identifier is `id ?? slug ?? name`.
- The provider requires versions on every write and reads datetime in ISO form only. The .NET reference accepts optional versions and invariant datetime forms. These live in the providers, owned by the provider slice.
- Endpoint writes always run the version check, which is stricter than the reference's gate.
- Schema-walk diagnostics (`INVALID_SCHEMA`, `EMPTY_COLLECTION_DEFINITION`, `/schema/type`, `/schema/properties`) are not implemented.
- Rate rules are stored and validated, not enforced at request time, matching the reference.
- Revocation keeps a store and throws `AUTH_SESSION_REVOKED`, which has no reference table entry.
- Undeclared collections answer as a miss on read and probe. The reference still serves stored documents for a removed collection.
- The `deploy-canary` probe reports owner `@sbox-ns/sdk`; the reference reports `.NET native`. It is on the allow-list.
- Document-level findings still fail the whole sync batch (the reference stores them and fails at run time, or warns). The SDK rejects these at compile time: the envelope (`sourceVersion`, `kind`, unknown top-level keys), endpoint `id`, `method`, `exposure` (only `public` or `internal`), and `response`; workflow `id` and `definition`; collection `accessMode`, `visibility`, constant groups, and the unsupported keys `fields`, `tables`, `webhookOnRateLimit`; and `input` schema shape. A step that is not an object is also rejected, because it cannot carry a finding.
- Step-level findings are stored and fail when the step runs with `ENDPOINT_ERROR.<TYPE>` 400 (`STEP` when the type is not a string): a missing, malformed, or duplicate id; an unsupported step type; a condition with no check; a `routes` table that is not an object or has keys other than `true`/`false`, a route that does not parse, or a `goto` target not in scope; a block whose `steps` is not a list. The `ENDPOINT_ERROR.CONDITION` code for an id-less condition is checked against the reference. The codes for other step types, and the message text, are not verified against the reference.
- The reference's remaining findings (about 150 codes across `NetworkStorageStepValidator` and `NetworkStorageDefinitionValidator`, including warnings) are not mirrored beyond the step-level set above.
