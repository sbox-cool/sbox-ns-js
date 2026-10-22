# Engine leg: a fresh create-sbox-ns-backend project served to a source-built s&box dedicated server.
# Runs on windows-latest. The server repo (sbox-network-storage-server, main) supplies tools/sbox-cli-e2e/run.cs.
# This script packs the SDK and the generator from this checkout, scaffolds a new backend, starts it on
# 127.0.0.1:8080, and runs the harness in --server-url mode once per library target.
param(
  [Parameter(Mandatory = $true)][string]$Engine,        # <sbox-public>/game (contains sbox-server.exe)
  [Parameter(Mandatory = $true)][string]$ServerDir,     # sbox-network-storage-server checkout (working tree)
  [Parameter(Mandatory = $true)][string]$Out,           # artifact directory
  [string[]]$Libraries = @("main", "latest"),           # "main", "latest" (highest published r<N>), or "r<N>"
  [int]$Port = 8080
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$out = New-Item -ItemType Directory -Force -Path $Out
$work = Join-Path $env:RUNNER_TEMP "engine-leg"
New-Item -ItemType Directory -Force -Path $work | Out-Null
$libraryRepo = "https://github.com/sbox-cool/sbox-network-storage.git"
$baseUrl = "http://127.0.0.1:$Port"

function Invoke-Native([string]$File, [string[]]$CmdArgs) {
  & $File @CmdArgs
  if ($LASTEXITCODE -ne 0) { throw "$File $($CmdArgs -join ' ') exited $LASTEXITCODE" }
}

# 1. Resolve library refs the same way compat-engine.ps1 does: "latest" is the highest r<N> tag.
$resolved = @()
foreach ($lib in $Libraries) {
  if ($lib -eq "latest") {
    $tags = & git ls-remote --tags $libraryRepo "refs/tags/r*"
    $best = $tags | ForEach-Object { if ($_ -match "refs/tags/r(\d+)$") { [int]$Matches[1] } } | Sort-Object -Descending | Select-Object -First 1
    if ($null -eq $best) { throw "no r<N> tags found on $libraryRepo" }
    $resolved += "r$best"
  } else {
    $resolved += $lib
  }
}
Write-Host "library targets: $($resolved -join ', ')"

# 2. Build and pack the SDK and the generator from this checkout.
Push-Location $root
Invoke-Native "npm" @("ci")
Invoke-Native "npm" @("run", "build", "--workspaces", "--if-present")
$pack = Join-Path $work "pack"
New-Item -ItemType Directory -Force -Path $pack | Out-Null
$sdkTgz = (& npm pack --workspace packages/sdk --pack-destination $pack --silent | Select-Object -Last 1).Trim()
$genTgz = (& npm pack --workspace packages/create-sbox-ns-backend --pack-destination $pack --silent | Select-Object -Last 1).Trim()
Pop-Location
$sdkTgz = Join-Path $pack $sdkTgz
$genTgz = Join-Path $pack $genTgz
Write-Host "sdk tarball: $sdkTgz"
Write-Host "generator tarball: $genTgz"

# 3. Install the packed generator into a scratch prefix and scaffold a fresh project from it.
$genPrefix = Join-Path $work "generator"
New-Item -ItemType Directory -Force -Path $genPrefix | Out-Null
Push-Location $genPrefix
Invoke-Native "npm" @("install", "--no-audit", "--no-fund", $genTgz)
Pop-Location
$backend = Join-Path $work "backend"
$cli = Join-Path $genPrefix "node_modules/create-sbox-ns-backend/dist/cli.js"
Invoke-Native "node" @($cli, $backend, "--port", "$Port", "--base-url", $baseUrl)

# 4. Point the scaffolded project at the packed SDK and build it.
Push-Location $backend
Invoke-Native "npm" @("install", "--no-audit", "--no-fund", $sdkTgz)
Invoke-Native "npm" @("run", "build")
Pop-Location

# Read the generated keys from .env. The secret is masked so it never appears in the log.
$envMap = @{}
Get-Content (Join-Path $backend ".env") | ForEach-Object {
  if ($_ -match "^([A-Z_]+)=(.*)$") { $envMap[$Matches[1]] = $Matches[2] }
}
$projectId = $envMap["PROJECT_ID"]
$publicKey = $envMap["PUBLIC_KEY"]
$secretKey = $envMap["SECRET_KEY"]
if ([string]::IsNullOrWhiteSpace($projectId) -or [string]::IsNullOrWhiteSpace($publicKey) -or [string]::IsNullOrWhiteSpace($secretKey)) {
  throw "generated .env is missing PROJECT_ID, PUBLIC_KEY, or SECRET_KEY"
}
Write-Host "::add-mask::$secretKey"
Write-Host "project: $projectId"

# 5. Start the backend. node:sqlite needs Node 22.13+ (provided by setup-node in the workflow).
$backendLog = Join-Path $out "backend.log"
$backendErr = Join-Path $out "backend.err.log"
$backendProc = Start-Process -FilePath "node" -ArgumentList @("--experimental-sqlite", "--env-file=.env", "dist/server.js") `
  -WorkingDirectory $backend -RedirectStandardOutput $backendLog -RedirectStandardError $backendErr -PassThru -NoNewWindow

try {
  $deadline = (Get-Date).AddSeconds(90)
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    if ($backendProc.HasExited) { throw "backend exited early with code $($backendProc.ExitCode); see backend.err.log" }
    try {
      $info = Invoke-RestMethod -Uri "$baseUrl/v3/server-info" -TimeoutSec 5
      if ($null -ne $info.capabilities) { $ready = $true; break }
    } catch { }
    Start-Sleep -Seconds 2
  }
  if (-not $ready) { throw "backend did not answer /v3/server-info within 90s" }
  Write-Host "backend ready at $baseUrl"
  $info | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $out "server-info.json")

  # 6. Run the server's harness against this backend, once per library target.
  $sdkSha = (& git -C $root rev-parse HEAD).Trim()
  $failed = @()
  Push-Location $ServerDir
  $serverSha = (& git rev-parse HEAD).Trim()
  foreach ($lib in $resolved) {
    $libOut = Join-Path $out ("library-" + $lib)
    New-Item -ItemType Directory -Force -Path $libOut | Out-Null
    Write-Host "== library $lib =="
    & dotnet run tools/sbox-cli-e2e/run.cs -- --engine $Engine --targets dedicated --library $lib `
      --server-url $baseUrl --project $projectId --public-key $publicKey --secret-key $secretKey `
      --no-build --startup-timeout 600 --out $libOut
    $code = $LASTEXITCODE
    Write-Host "library $lib exit $code"
    if ($code -ne 0) { $failed += $lib }
  }
  Pop-Location

  @{
    engine_dir = $Engine
    engine_commit = $env:ENGINE_SHA
    sbox_ns_js_commit = $sdkSha
    server_commit = $serverSha
    libraries = $resolved
    failed = $failed
  } | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $out "run-meta.json")

  if ($failed.Count -gt 0) { throw "engine leg failed for: $($failed -join ', ')" }
} finally {
  if (-not $backendProc.HasExited) { Stop-Process -Id $backendProc.Id -Force }
}
