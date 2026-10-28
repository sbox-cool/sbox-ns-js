# Parity status: SDK backend against the .NET reference

Generated from the corpus runs of the SDK backend against the .NET reference build.

- Reference: sbox-network-storage-server `ae367a3` (tree identical to `main` at `8893c36`), built Release, .NET SDK 10.0.401.
- SDK: `packages/sdk` backend at commit `022f876`, Node v26.0.0.
- Allow-list: only `packages/sdk/test/parity/sdk-intentional-differences.json`. The reference list `tests/parity/intentional-differences.json` exists for managed-service-versus-.NET comparisons. It is not applied here, so every difference from the .NET reference is either fixed or listed below with a reason.

## Command

```sh
# SQLite (exit 0)
bash scripts/parity.sh --reference <server checkout> --ref-port 18761 --sdk-port 18762

# PostgreSQL 18.6 (exit 0)
bash scripts/parity.sh --reference <server checkout> --storage postgres \
  --postgres-admin postgres://postgres@127.0.0.1:55432/postgres \
  --pg-driver <dir>/node_modules/pg --ref-port 18763 --sdk-port 18764
```

`--pg-driver` takes the path of the `pg` package itself. The driver is installed in a temp directory, not as an SDK dependency. The reference checkout needs a Release build (`--build` builds it).

## Totals

Both storages produce the same result.

- Scenarios: 29
- Steps compared: 163
- Identical: 161
- Differ only on SDK allow-listed paths: 2
- Remaining unlisted differences: 0
- Exit status: 0 on both storages

## Per trace family

| Family | Steps | Identical | Intentional | Remaining |
| --- | ---: | ---: | ---: | ---: |
| 01-management-push | 46 | 45 | 1 | 0 |
| 02-runtime-config | 9 | 9 | 0 | 0 |
| 03-endpoints | 23 | 23 | 0 | 0 |
| 04-documents | 15 | 15 | 0 | 0 |
| 05-global-records | 10 | 10 | 0 | 0 |
| 06-ledger-and-records | 11 | 11 | 0 | 0 |
| 07-analytics-and-stats | 7 | 7 | 0 | 0 |
| 08-auth-sessions | 7 | 7 | 0 | 0 |
| 09-queries | 6 | 6 | 0 | 0 |
| 10-errors | 29 | 28 | 1 | 0 |

## SDK allow-list entries

Only items that cannot be matched belong here. Without these two entries the diff reports exactly these two steps and nothing else.

| Scenario / step | Path | Reason |
| --- | --- | --- |
| `manage-push-all` / `preflight-invalid` | `body:$.endpoints.results[0].diagnostics[0].message` | For malformed YAML the reference reports the message from the .NET YamlDotNet parser, and the SDK reports its own YAML parser's message. The diagnostic code and the failure status match. Only the parser wording differs, and it comes from the implementation. |
| `errors-invalid-input` / `deploy-canary` | `body:$.owner` | The owner field names the implementation that serves the probe: `.NET native` for the reference, `@sbox-ns/sdk` for the SDK. The probe's `ok` and `probe` fields match. |

## Known differences outside the corpus

The corpus does not measure these. They are listed so they are not mistaken for parity.

- The player marker behind ledger reads (`_profiles`) is written only after a successful endpoint run. The reference also records it on handled failures and from analytics, and skips global-execution calls.
- Reference sync stores definitions that have validator findings and fails them at run time. For step-level findings (ids, types, routes, goto targets, condition checks) the SDK does the same and answers `ENDPOINT_ERROR.CONDITION` when the step runs. Other definition-level findings are still rejected at sync.
- Queries: `config.fields`/`columns` output shaping, count `condition`/`conditionValue`, cached reads (`?cache=1`), and the source `name` taken from the collection display name are not implemented.
- Generic step failures sent to non-library callers include `ok:false`, which the reference omits.
- Auto-test (`POST /v3/manage/{project}/auto-test`) runs each endpoint as a preview and discards its writes. When one auto-test covers several endpoints, a later endpoint therefore does not see an earlier endpoint's preview writes, as it would with the reference's in-memory run cache.
- `GET /v3/server-info` advertises only the capabilities the SDK routes: records, global-records, endpoints, queries, game-values, rate-limits, auth-sessions, library-error-envelope, management-sync-jobs. Not advertised because not routed: workflows, analytics, analytics-batch, package-sync, https-tunnel, api-root, media, endpoint-js. The reference's server-info `kind`, `version`, `database` and `compat` fields are not returned.
- `PUT /v3/manage/{project}/settings` changes the security settings the protocol reads from the next request on, and the signed config follows at its next build. By default the SDK keeps control state in memory, so a restart returns to startup settings; the reference persists them. Opting into `ServerOptions.controlState` with a SQLite or PostgreSQL control store persists managed settings, definitions and supported staged state across restarts (see [storage.md](storage.md#durable-control-state)). Stored keys follow the reference's `ManagementSettings.Apply`; `enabled`, `playerKeyMode` and the revision keys are view-only and refuse a different value with `SETTING_NOT_STORED`. Key rotation is not in the management API, as in the reference.
- Auth session revocation is per family. Refresh and reauth with a presented session stay in its family, and revoking any token ends the whole family, as the reference does. Refresh does not revoke earlier tokens, so they stay valid until revoke or expiry. The default revocation store is in-process, so it covers one instance only. A custom `ServerOptions.sessionRevocations` store must implement family semantics and keep each marker until `now + 24h + 1h`, and a store error fails closed.
  Tokens refreshed by earlier draft SDK builds have different family ids; this fix cannot reconstruct their old family from a later token. Revoke each previously issued token separately or rotate the session secret to invalidate them all. The in-process store also loses revocations on restart; use a durable shared store where restart-safe revocation is required.
  Session creation and reauthentication also have a separate identity-verification gap tracked in [sbox-ns-js#4](https://github.com/sbox-cool/sbox-ns-js/issues/4); do not treat these sessions as verified identity on projects with `requireSboxAuth: false` until it is fixed.

## Engine leg coverage (ci-only)

Run 39764111378 on windows-latest (sbox-ns-js `a0a2516`, sbox-network-storage-server `976cff7`, sbox-public `468c55e8`, dedicated server built from source) passed for `main` and `r427072`: library load, HTTP allowed, endpoint call, endpoint call with input, game values, secret-key endpoint, encrypted calls, and plain/encrypted switching through `PUT /v3/manage/{project}/settings`. Both refs resolved to library commit `ddf9b617`, the r427072 tag, so this is one library revision run twice. The result is `ci-only`. No native editor pass is claimed.

Run 39767697019 on windows-latest (sbox-ns-js `0a585ff`, sbox-network-storage-server `d2c321c` with the harness at main, sbox-public `468c55e8`, dedicated server built from source) passed for `main` and `r427072`. The backend is a fresh `create-sbox-ns-backend` project, which creates `data/request_encryption_keys.json` on first start, so the SDK accepts v2 modes. Both libraries pass every v2 check: v2-required saved and the signed config requiring v2, the v2 echo and no-input calls, a changed signing-key pin refused with `ENCRYPTION_KEY_PIN_MISMATCH` and then recovered, and v2 to v1 and v1 to v2 switching through the library's `SECURITY_*` retry. The r427072 v1 on/off rows are marked informational in its summary; `main` marks them as checks. The result is `ci-only`. No native editor pass is claimed.

Not covered by that run:

- Sessions (session login and session-bound calls). The dedicated driver has no session step.
- Host-proxy with a second account.
- Rate limit. A `--server-url` server cannot be restarted with a low limit.
- Encryption 409 rows. An attached server's request log is not reachable from the harness.
- Key rotation in attached mode.
- Tables. The collection DSL does not implement them.
- Definition-level findings other than step-level ones, which are rejected at sync.
- Native editor pass.
