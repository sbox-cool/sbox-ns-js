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
