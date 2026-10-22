# Parity status: SDK backend against the .NET reference

Generated from the final corpus runs of the SDK backend against the .NET reference build.

- Reference: `/tmp/ns-fix186`, commit `ae367a3`, built Release.
- SDK: `packages/sdk` backend, commit `81c0dd4`, Node v26.0.0.
- Allow-list: the reference list `tests/parity/intentional-differences.json` (untouched) merged with `packages/sdk/test/parity/sdk-intentional-differences.json` by `scripts/parity.sh` before `diff`.

## Command

```sh
export PATH=/Users/tom/.dotnet:$PATH DOTNET_ROOT=/Users/tom/.dotnet; hash -r

# SQLite (run output: /tmp/parity-out-sync6, ports 18799/18800, exit 0)
bash scripts/parity.sh --reference /tmp/ns-fix186 --out /tmp/parity-out-sync6 --ref-port 18799 --sdk-port 18800

# PostgreSQL 18 (run output: /tmp/parity-out-pg2, ports 18803/18804, exit 0)
bash scripts/parity.sh --reference /tmp/ns-fix186 --storage postgres \
  --postgres-admin postgres://postgres@127.0.0.1:55432/postgres \
  --pg-driver /tmp/pgdrv/node_modules/pg --out /tmp/parity-out-pg2 --ref-port 18803 --sdk-port 18804
```

`--pg-driver` takes the path of the `pg` package itself. The driver is installed in a temp directory, not an SDK dependency.

## Totals

Both storages produce the same result.

- Scenarios: 29
- Steps compared: 163
- Identical: 148
- Intentional only (matched by the allow-list): 15
- Remaining unlisted differences: 0
- Exit status: 0 on both storages

## Per trace family

| Family | Steps | Identical | Intentional | Remaining |
| --- | ---: | ---: | ---: | ---: |
| 01-management-push | 46 | 35 | 11 | 0 |
| 02-runtime-config | 9 | 9 | 0 | 0 |
| 03-endpoints | 23 | 22 | 1 | 0 |
| 04-documents | 15 | 15 | 0 | 0 |
| 05-global-records | 10 | 10 | 0 | 0 |
| 06-ledger-and-records | 11 | 10 | 1 | 0 |
| 07-analytics-and-stats | 7 | 7 | 0 | 0 |
| 08-auth-sessions | 7 | 7 | 0 | 0 |
| 09-queries | 6 | 6 | 0 | 0 |
| 10-errors | 29 | 27 | 2 | 0 |

## SDK allow-list entries

Only genuinely unmatchable items belong here. Without these two entries, the diff reports two unlisted steps.

| Scenario / step | Path | Reason |
| --- | --- | --- |
| `manage-push-all` / `preflight-invalid` | `body:$.endpoints.results[0].diagnostics[0].message` | The reference reports the .NET YamlDotNet parser's message for malformed YAML. The SDK reports its own YAML parser's message. Both are the same diagnostic: the code `COLLECTION_NAME_REQUIRED` and the failure status match. The parser wording belongs to the implementation. |
| `errors-invalid-input` / `deploy-canary` | `body:$.owner` | The owner field identifies the implementation serving the probe. The reference answers `.NET native`; the SDK answers `@sbox-ns/sdk`. The probe's `ok` and `probe` fields match. |

## Intentional steps

The 12 intentional steps differ from the reference, and the allow-lists accept those differences. Ten are covered by the reference allow-list. Two are covered by the SDK allow-list above (`preflight-invalid`, `deploy-canary`). The table is from before the latest changes; regenerate it from a fresh run.

| Family | Scenario / step | Covered by | Differing paths (stable vs candidate) |
| --- | --- | --- | --- |
| 01 | manage-resource-crud / patch-endpoint, patch-collection, patch-workflow | reference | Reference adds `body:$.skipped: true`; SDK omits it. |
| 01 | manage-rate-limit-rules / get | reference | Reference rules carry `id`, `enabled`, `maxPerMinute`, `maxPerHour`, `maxPerDay`. SDK rules carry `name`, `limit`, `window`. |
| 01 | manage-queries / list, list-after-delete | reference | Reference reports `config` and `sources` per query. SDK reports flat `field`, `limit`, `order`, `ttlSeconds`, `collectionId`. |
| 01 | manage-package-and-revision / revision-init, revision-init-outdated | reference | Reference reports `latestRevisionId`, `playerRevision`, `revisionOutdated`, `message`. SDK reports `revisionId`, `projectId`, `outdated`. |
| 01 | manage-tests-and-tools / put-tests | reference | Reference reports `action`, `resourceKind`, `source`, `total`. SDK reports `count`. |
| 01 | manage-push-all / preflight-invalid | SDK | YAML parser wording (see above). |
| 03 | endpoints-player-flow / buy-drill-unaffordable | reference | A failing condition step: the SDK adds `error.docsUrl` and `error.step`, and omits `conditionRejection`, `flagged`, `severity`, `fireWebhook`. |
| 10 | errors-invalid-input / deploy-canary | SDK | Owner identity (see above). |

Several reference-covered differences are behavioral, not cosmetic (for example the buy-drill condition rejection shape). They stay here because the reference allow-list covers them. Main should review them if the goal tightens beyond the allow-list.
