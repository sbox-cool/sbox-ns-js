#!/usr/bin/env bash
set -euo pipefail
# Differential parity run: the .NET reference server and the SDK backend (packages/sdk/test/parity/reference-backend.ts)
# replay the same corpus, and `sbox-ns-parity diff` compares them with the reference allow-list. Exits 0 only when every
# step matches or differs only in allow-listed ways. Results: <out>/ref-results.json, <out>/sdk-results.json, <out>/diff.log.
#
# Usage: bash scripts/parity.sh --reference DIR [--storage sqlite|postgres] [--postgres-admin URL] [--pg-driver DIR]
#                               [--out DIR] [--build] [--ref-port N] [--sdk-port N]
#   --reference DIR          .NET reference checkout (provides tests/parity/corpus, the allow-list and the Release build)
#   --storage PROVIDER       sqlite (default) or postgres. Applies to both sides; the reference is never run in memory.
#   --postgres-admin URL     postgres://user@host:port/postgres with CREATE/DROP DATABASE rights. Required for postgres.
#                            The script creates two fresh databases (reference and SDK), and drops only those on exit.
#   --pg-driver DIR          directory of an installed node-postgres (`pg`) package for the SDK side. Defaults to $PARITY_PG_DRIVER.
#   --out DIR                output directory (default: a new temporary directory, kept after the run)
#   --build                  build the reference server and parity tool first (dotnet build -c Release)
#   --ref-port N, --sdk-port N   listening ports (defaults 18421 and 18422)
# Requires: dotnet on PATH (set DOTNET_ROOT if needed), node 22.5+ (node:sqlite), curl, and psql for postgres.

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
reference=''; storage=sqlite; pg_admin=''; pg_driver="${PARITY_PG_DRIVER:-}"; out=''; build=false
ref_port=18421; sdk_port=18422
while (($#)); do
  case "$1" in
    --reference) reference="$2"; shift 2 ;;
    --storage) storage="$2"; shift 2 ;;
    --postgres-admin) pg_admin="$2"; shift 2 ;;
    --pg-driver) pg_driver="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --build) build=true; shift ;;
    --ref-port) ref_port="$2"; shift 2 ;;
    --sdk-port) sdk_port="$2"; shift 2 ;;
    *) echo "Usage: bash scripts/parity.sh --reference DIR [--storage sqlite|postgres] [--postgres-admin URL] [--pg-driver DIR] [--out DIR] [--build] [--ref-port N] [--sdk-port N]" >&2; exit 2 ;;
  esac
done
[[ -n "$reference" && -d "$reference/tests/parity/corpus" ]] || { echo "--reference must point at a .NET checkout with tests/parity/corpus" >&2; exit 2; }
reference="$(cd "$reference" && pwd)"
case "$storage" in
  sqlite|postgres) ;;
  *) echo "--storage must be sqlite or postgres" >&2; exit 2 ;;
esac
if [[ "$storage" == postgres ]]; then
  [[ -n "$pg_admin" && -n "$pg_driver" ]] || { echo "--storage postgres needs --postgres-admin and --pg-driver (or PARITY_PG_DRIVER)" >&2; exit 2; }
fi
[[ -n "$out" ]] || out="$(mktemp -d "${TMPDIR:-/tmp}/sbox-ns-parity.XXXXXX")"
mkdir -p "$out"
out="$(cd "$out" && pwd)"

# The SDK's parity backend uses these fixed credentials (packages/sdk/test/parity/reference-backend.ts PARITY_PROJECT).
sdk_project='parity-project'; sdk_public='pk_parity_public_0123456789'; sdk_secret='sk_parity_secret_0123456789'

dotnet_root="$reference"
parity_dll="$reference/tools/SboxNetworkStorage.Parity/bin/Release/net10.0/sbox-ns-parity.dll"
server_dll="$reference/src/SboxNetworkStorage.Server/bin/Release/net10.0/sbox-ns.dll"
if $build; then
  (cd "$reference" && dotnet build SboxNetworkStorage.sln -c Release)
fi
[[ -f "$parity_dll" && -f "$server_dll" ]] || { echo "Reference binaries missing; build with --build or dotnet build -c Release" >&2; exit 2; }
command -v dotnet >/dev/null || { echo "dotnet is not on PATH" >&2; exit 2; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 2; }

stamp="$(date +%Y%m%d%H%M%S)$$"
ref_db="ns_parity_ref_$stamp"; sdk_db="ns_parity_sdk_$stamp"
work="$(mktemp -d)"
ref_pid=''; sdk_pid=''
cleanup() {
  status=$?
  trap - EXIT
  for pid in "$ref_pid" "$sdk_pid"; do
    if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  done
  if [[ "$storage" == postgres ]]; then
    for db in "$ref_db" "$sdk_db"; do psql "$pg_admin" -q -c "DROP DATABASE IF EXISTS $db" >/dev/null 2>&1 || true; done
  fi
  if ((status != 0)); then
    echo "Parity run exited $status; logs and results in $out" >&2
  fi
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

wait_for() {
  local url="$1" pid="$2" i
  for ((i = 0; i < 120; i++)); do
    if curl -s -o /dev/null "$url"; then return 0; fi
    kill -0 "$pid" 2>/dev/null || return 1
    sleep 0.5
  done
  return 1
}
port_free() {
  if (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; then exec 3<&-; exec 3>&-; return 1; fi
  return 0
}
parse_key() {
  local line key=''
  while IFS= read -r line; do
    line="${line%$'\r'}"
    if [[ "$line" =~ ^[[:space:]]+(sbox_[^[:space:]]+)[[:space:]]*$ ]]; then key="${BASH_REMATCH[1]}"; fi
  done
  [[ -n "$key" ]] || { echo 'Cannot parse CLI key output' >&2; return 1; }
  printf '%s' "$key"
}

if [[ "$storage" == postgres ]]; then
  psql "$pg_admin" -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $ref_db" -c "CREATE DATABASE $sdk_db" >/dev/null
  host_port="${pg_admin#*@}"; host_port="${host_port%%/*}"; host="${host_port%%:*}"; port="${host_port##*:}"
  user="${pg_admin#*://}"; user="${user%%@*}"
  ref_pg="Host=$host;Port=$port;Username=$user;Database=$ref_db"
  sdk_pg="postgres://$user@$host:$port/$sdk_db"
fi

# Reference server: fresh state, one project, one public and one secret key (smoke.sh pattern).
ref_cfg=(--config-dir "$work/ref/config" --data-dir "$work/ref/data")
ref_setup=(setup --non-interactive --listen "127.0.0.1:$ref_port" "${ref_cfg[@]}")
if [[ "$storage" == postgres ]]; then ref_setup+=(--database postgres --pg-connection-string "$ref_pg"); fi
port_free "$ref_port" || { echo "Port $ref_port is in use" >&2; exit 1; }
dotnet "$server_dll" "${ref_setup[@]}" > "$out/reference-setup.log" 2>&1
project_output="$(dotnet "$server_dll" project create 'Parity Corpus' --key-mode public --require-sbox-auth false "${ref_cfg[@]}")"
ref_project=''
while IFS= read -r line; do line="${line%$'\r'}"; [[ "$line" != 'Project ID: '* ]] || ref_project="${line#Project ID: }"; done <<< "$project_output"
[[ -n "$ref_project" ]] || { echo "Cannot parse reference project id: $project_output" >&2; exit 1; }
ref_public="$(dotnet "$server_dll" key create "$ref_project" --type public "${ref_cfg[@]}" | parse_key)"
ref_secret="$(dotnet "$server_dll" key create "$ref_project" --type secret "${ref_cfg[@]}" | parse_key)"
(exec dotnet "$server_dll" start "${ref_cfg[@]}" > "$out/reference-server.log" 2>&1) &
ref_pid=$!
wait_for "http://127.0.0.1:$ref_port/health" "$ref_pid" || { echo "Reference server did not become healthy; see $out/reference-server.log" >&2; exit 1; }

dotnet "$parity_dll" run --target "http://127.0.0.1:$ref_port" --project-id "$ref_project" --public-key "$ref_public" \
  --secret-key "$ref_secret" --corpus "$reference/tests/parity/corpus" --out "$out/ref-results.json" > "$out/reference-run.log" 2>&1 || true
kill "$ref_pid" 2>/dev/null || true; wait "$ref_pid" 2>/dev/null || true; ref_pid=''

# SDK backend: the test build of packages/sdk, one process, the same corpus.
sdk_dir="$root/packages/sdk"
(cd "$sdk_dir" && npx tsc -p tsconfig.test.json)
port_free "$sdk_port" || { echo "Port $sdk_port is in use" >&2; exit 1; }
(
  cd "$sdk_dir"
  export PARITY_PORT="$sdk_port" PARITY_STORAGE="$storage"
  if [[ "$storage" == postgres ]]; then export PARITY_POSTGRES_URL="$sdk_pg" PARITY_PG_DRIVER="$pg_driver"; fi
  exec node dist-test/test/parity/reference-backend.js
) > "$out/sdk-server.log" 2>&1 &
sdk_pid=$!
wait_for "http://127.0.0.1:$sdk_port/v3/storage/deploy-canary/ping" "$sdk_pid" || { echo "SDK backend did not start; see $out/sdk-server.log" >&2; exit 1; }

dotnet "$parity_dll" run --target "http://127.0.0.1:$sdk_port" --project-id "$sdk_project" --public-key "$sdk_public" \
  --secret-key "$sdk_secret" --corpus "$reference/tests/parity/corpus" --out "$out/sdk-results.json" > "$out/sdk-run.log" 2>&1 || true
kill "$sdk_pid" 2>/dev/null || true; wait "$sdk_pid" 2>/dev/null || true; sdk_pid=''

diff_status=0
dotnet "$parity_dll" diff --stable "$out/ref-results.json" --candidate "$out/sdk-results.json" \
  --allow "$reference/tests/parity/intentional-differences.json" > "$out/diff.log" 2>&1 || diff_status=$?
{
  echo "reference: $(git -C "$reference" rev-parse --short HEAD 2>/dev/null || echo unknown) ($reference)"
  echo "sdk: $(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo unknown) ($root)"
  echo "storage: $storage"
  echo "node: $(node -v)"
} > "$out/meta.txt"
tail -n 1 "$out/diff.log"
echo "results: $out"
exit "$diff_status"
