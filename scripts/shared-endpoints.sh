#!/usr/bin/env bash
set -euo pipefail
# Shared endpoint run (issue #150): the same YAML endpoint fixtures (packages/sdk/test/shared-endpoints/endpoints) and the
# same requests (corpus.json) run against the .NET reference server and the SDK backend. Every case must return the same
# status and body on both. The runner is packages/sdk/test/shared-endpoints/run.mjs.
#
# Usage: bash scripts/shared-endpoints.sh --reference DIR [--out DIR] [--build] [--ref-port N] [--sdk-port N]
#   --reference DIR   .NET reference checkout (src/SboxNetworkStorage.Server Release build)
#   --out DIR         output directory (default: a new temporary directory, kept after the run)
#   --build           build the reference server first (dotnet build -c Release)
#   --ref-port N, --sdk-port N   listening ports (defaults 18811 and 18812)
# Requires: dotnet on PATH (set DOTNET_ROOT if needed), node 22+, npm dependencies installed in packages/sdk, curl.

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
reference=''; out=''; build=false
ref_port=18811; sdk_port=18812
while (($#)); do
  case "$1" in
    --reference) reference="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --build) build=true; shift ;;
    --ref-port) ref_port="$2"; shift 2 ;;
    --sdk-port) sdk_port="$2"; shift 2 ;;
    *) echo "Usage: bash scripts/shared-endpoints.sh --reference DIR [--out DIR] [--build] [--ref-port N] [--sdk-port N]" >&2; exit 2 ;;
  esac
done
[[ -n "$reference" && -f "$reference/src/SboxNetworkStorage.Server/bin/Release/net10.0/sbox-ns.dll" ]] \
  || { echo "--reference must point at a .NET checkout with a Release server build (or pass --build)" >&2; exit 2; }
reference="$(cd "$reference" && pwd)"
[[ -n "$out" ]] || out="$(mktemp -d "${TMPDIR:-/tmp}/sbox-ns-shared.XXXXXX")"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
command -v dotnet >/dev/null || { echo "dotnet is not on PATH" >&2; exit 2; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 2; }

server_dll="$reference/src/SboxNetworkStorage.Server/bin/Release/net10.0/sbox-ns.dll"
if $build; then
  (cd "$reference" && dotnet build SboxNetworkStorage.sln -c Release)
fi

# The SDK backend uses these fixed credentials (packages/sdk/test/parity/reference-backend.ts referenceOptions).
sdk_project='parity-project'; sdk_public='pk_parity_public_0123456789'; sdk_secret='sk_parity_secret_0123456789'
# One project secret, set on both sides with the same name and value.
secret_name='shared_token'; secret_value="shared-$(openssl rand -hex 12)"
admin_password="admin-$(openssl rand -hex 12)"

work="$(mktemp -d)"
ref_pid=''; sdk_pid=''
cleanup() {
  status=$?
  trap - EXIT
  for pid in "$ref_pid" "$sdk_pid"; do
    if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  done
  if ((status != 0)); then echo "Shared endpoint run exited $status; logs in $out" >&2; fi
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
# Extracts an antiforgery token from an ASP.NET page. Every command reads its whole input: an early `head` would make
# the writer fail with SIGPIPE, which pipefail turns into a script exit.
antiforgery_token() {
  sed -n 's/.*name="__RequestVerificationToken"[^>]*value="\([^"]*\)".*/\1/p' | sed -n '1p'
}

# Reference server: fresh state, an owner account, one project, one public and one secret key.
ref_cfg=(--config-dir "$work/ref/config" --data-dir "$work/ref/data")
ref_url="http://127.0.0.1:$ref_port"
port_free "$ref_port" || { echo "Port $ref_port is in use" >&2; exit 1; }
NS_ADMIN_PASSWORD="$admin_password" dotnet "$server_dll" setup --non-interactive --listen "127.0.0.1:$ref_port" \
  --allow-http --admin-username owner "${ref_cfg[@]}" > "$out/reference-setup.log" 2>&1
project_output="$(dotnet "$server_dll" project create 'Shared Endpoints' --key-mode public --require-sbox-auth false "${ref_cfg[@]}")"
ref_project=''
while IFS= read -r line; do line="${line%$'\r'}"; [[ "$line" != 'Project ID: '* ]] || ref_project="${line#Project ID: }"; done <<< "$project_output"
[[ -n "$ref_project" ]] || { echo "Cannot parse reference project id: $project_output" >&2; exit 1; }
ref_public="$(dotnet "$server_dll" key create "$ref_project" --type public "${ref_cfg[@]}" | parse_key)"
ref_secret="$(dotnet "$server_dll" key create "$ref_project" --type secret "${ref_cfg[@]}" | parse_key)"
(exec dotnet "$server_dll" start "${ref_cfg[@]}" > "$out/reference-server.log" 2>&1) &
ref_pid=$!
wait_for "$ref_url/health" "$ref_pid" || { echo "Reference server did not become healthy; see $out/reference-server.log" >&2; exit 1; }

# The secret lives in the owner dashboard (the CLI has no secret command): sign in, then submit the secret form.
jar="$work/cookies.txt"
login_token="$(curl -s -c "$jar" -b "$jar" "$ref_url/login" | antiforgery_token)"
login_status="$(curl -s -c "$jar" -b "$jar" -o /dev/null -w '%{http_code}' \
  --data-urlencode "username=owner" --data-urlencode "password=$admin_password" \
  --data-urlencode "__RequestVerificationToken=$login_token" "$ref_url/login")"
[[ "$login_status" == 302 ]] || { echo "Owner sign-in failed: HTTP $login_status" >&2; exit 1; }
form_token="$(curl -s -c "$jar" -b "$jar" "$ref_url/dashboard/projects/$ref_project" | antiforgery_token)"
secret_status="$(curl -s -c "$jar" -b "$jar" -o /dev/null -w '%{http_code}' \
  --data-urlencode "name=$secret_name" --data-urlencode "value=$secret_value" \
  --data-urlencode "__RequestVerificationToken=$form_token" "$ref_url/dashboard/projects/$ref_project/secrets")"
[[ "$secret_status" == 302 ]] || { echo "Setting the reference secret failed: HTTP $secret_status" >&2; exit 1; }

# SDK backend: the test build of packages/sdk with the same secret.
sdk_dir="$root/packages/sdk"
(cd "$sdk_dir" && npx tsc -p tsconfig.test.json)
port_free "$sdk_port" || { echo "Port $sdk_port is in use" >&2; exit 1; }
(
  cd "$sdk_dir"
  export SHARED_PORT="$sdk_port" SHARED_SECRET_NAME="$secret_name" SHARED_SECRET_VALUE="$secret_value"
  exec node dist-test/test/shared-endpoints/backend.js
) > "$out/sdk-server.log" 2>&1 &
sdk_pid=$!
wait_for "http://127.0.0.1:$sdk_port/v3/storage/deploy-canary/ping" "$sdk_pid" \
  || { echo "SDK backend did not start; see $out/sdk-server.log" >&2; exit 1; }

# Both sides get the same fixtures, the same requests and the same secret name and value.
export SHARED_SECRET_NAME="$secret_name" SHARED_SECRET_VALUE="$secret_value"
node "$sdk_dir/test/shared-endpoints/run.mjs" \
  --reference "$ref_url" --reference-project "$ref_project" --reference-public "$ref_public" --reference-secret "$ref_secret" \
  --sdk "http://127.0.0.1:$sdk_port" --sdk-project "$sdk_project" --sdk-public "$sdk_public" --sdk-secret "$sdk_secret" \
  --out "$out/results.json"
run_status=$?
{
  echo "reference: $(git -C "$reference" rev-parse --short HEAD 2>/dev/null || echo unknown) ($reference)"
  echo "sdk: $(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo unknown) ($root)"
  echo "node: $(node -v)"
} > "$out/meta.txt"
echo "results: $out"
exit "$run_status"
