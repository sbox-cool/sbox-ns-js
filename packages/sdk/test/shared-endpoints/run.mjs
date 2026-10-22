#!/usr/bin/env node
// Shared endpoint run. Syncs identical endpoint fixtures to the .NET reference and to the SDK backend, sends the same
// requests to both in the same order, and fails unless every case returns the same status and body on both.
// Driven by scripts/shared-endpoints.sh; see its header for the environment it sets up.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const endpointsDir = join(here, "endpoints");
const corpus = JSON.parse(await readFile(join(here, "corpus.json"), "utf8"));

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`--${name} is required`);
  return process.argv[index + 1];
}

function optionalOption(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? null : process.argv[index + 1];
}

const targets = [
  {
    name: "reference",
    url: option("reference"),
    project: option("reference-project"),
    publicKey: option("reference-public"),
    secretKey: option("reference-secret"),
  },
  {
    name: "sdk",
    url: option("sdk"),
    project: option("sdk-project"),
    publicKey: option("sdk-public"),
    secretKey: option("sdk-secret"),
  },
];

const ENDPOINT_SUFFIX = ".endpoint.yml";

async function loadEndpoints() {
  const files = (await readdir(endpointsDir)).filter((file) => file.endsWith(ENDPOINT_SUFFIX)).sort();
  return Promise.all(
    files.map(async (file) => {
      const sourceText = await readFile(join(endpointsDir, file), "utf8");
      const id = file.slice(0, -ENDPOINT_SUFFIX.length);
      const declared = sourceText.match(/^id: (.+)$/m)?.[1]?.trim();
      if (declared !== id) throw new Error(`${file}: YAML id "${declared}" must match the file name "${id}"`);
      return { kind: "endpoint", id, authoringMode: "source", sourceFormat: "yaml", sourcePath: file, sourceText };
    }),
  );
}

function manageHeaders(target) {
  return { "content-type": "application/json", "x-api-key": target.secretKey };
}

async function sync(target, endpoints) {
  const response = await fetch(`${target.url}/v3/manage/${target.project}/sync`, {
    method: "PUT",
    headers: manageHeaders(target),
    body: JSON.stringify({ endpoints, collections: corpus.collections }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${target.name} sync failed: HTTP ${response.status} ${text}`);
  console.log(`${target.name}: synced ${endpoints.length} endpoints and ${corpus.collections.length} collection(s)`);
}

function parseBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function call(target, testCase) {
  const headers = {
    "content-type": "application/json",
    "x-public-key": target.publicKey,
    "x-sbox-token": "parity-placeholder-token",
    "x-ns-client-type": "game",
  };
  if (testCase.steamId) headers["x-steam-id"] = testCase.steamId;
  if (testCase.secret) headers["x-secret-key"] = target.secretKey;
  const url = `${target.url}/v3/endpoints/${target.project}/${testCase.endpoint}?apiKey=${encodeURIComponent(target.publicKey)}`;
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(testCase.body) });
  return { status: response.status, body: parseBody(await response.text()) };
}

// Request ids are per-request values (ASP.NET trace ids on the reference), so only their presence is compared. Numeric
// `...At` fields come from ns.now() on two servers called milliseconds apart, so only their presence is compared too.
const VOLATILE_KEYS = new Set(["_requestId", "requestId"]);

function volatile(key, value) {
  if (VOLATILE_KEYS.has(key) && typeof value === "string") return '"<request-id>"';
  if (key.endsWith("At") && typeof value === "number") return '"<time>"';
  return null;
}

// Stable JSON with sorted object keys, so key order never causes a false mismatch.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const members = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${volatile(key, value[key]) ?? canonical(value[key])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value);
}

const endpoints = await loadEndpoints();
for (const target of targets) await sync(target, endpoints);

const results = [];
for (const testCase of corpus.cases) {
  const reference = await call(targets[0], testCase);
  const sdk = await call(targets[1], testCase);
  const match = canonical(reference) === canonical(sdk);
  results.push({ name: testCase.name, match, reference, sdk });
  const detail = match ? `${reference.status}` : `reference ${reference.status} vs sdk ${sdk.status}`;
  console.log(`${match ? "PASS" : "FAIL"} ${testCase.name} ${detail}`);
  if (!match) {
    console.log(`  reference: ${canonical(reference)}`);
    console.log(`  sdk:       ${canonical(sdk)}`);
  }
}

const out = optionalOption("out");
if (out) {
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(results, null, 2)}\n`);
}

const failed = results.filter((result) => !result.match);
console.log(`${results.length - failed.length}/${results.length} cases match`);
if (failed.length > 0) process.exitCode = 1;
