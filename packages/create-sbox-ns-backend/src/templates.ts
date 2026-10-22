// Files copied into a new backend project. Generated code uses no template literals with interpolation, so the
// text here is plain. Keys and the signing key are written by scaffold.ts, not here.
export interface TemplateContext {
  configureLine: string;
  port: number;
}

const PACKAGE_JSON = {
  name: "sbox-ns-backend",
  version: "0.1.0",
  private: true,
  type: "module",
  engines: { node: ">=22.13", bun: ">=1.1" },
  scripts: {
    dev: "bun --hot src/server.ts",
    build: "tsc -p tsconfig.json",
    start: "node --experimental-sqlite --env-file=.env dist/server.js",
    test: "tsc -p tsconfig.json && node --test dist/test/app.test.js",
  },
  dependencies: {
    "@sbox-ns/sdk": "^0.1.0",
    "quickjs-emscripten": "^0.32.0",
    sucrase: "^3.35.1",
    yaml: "^2.6.0",
  },
  devDependencies: {
    "@types/node": "^22.10.0",
    typescript: "^5.7.2",
  },
};

const TSCONFIG = {
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    lib: ["ES2022", "DOM"],
    types: ["node"],
    strict: true,
    noUncheckedIndexedAccess: true,
    declaration: false,
    outDir: "dist",
    rootDir: "src",
    skipLibCheck: true,
    forceConsistentCasingInFileNames: true,
  },
  include: ["src/**/*.ts"],
};

const GITIGNORE = ["node_modules/", "dist/", ".env", "keys/", "data/", ""].join("\n");

const DOCKERIGNORE = ["node_modules/", "dist/", ".env", "keys/", "data/", ".git/", ""].join("\n");

const CONFIG_TS = `import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface Config {
  projectId: string;
  publicKey: string;
  secretKey: string;
  sessionSecret: string;
  signingPrivateKeyPem: string;
  dataFile: string;
  definitionsDir: string;
  fetchAllowedHosts: readonly string[];
  host: string;
  port: number;
}

type Env = Readonly<Record<string, string | undefined>>;

// Reads the settings from the environment (Bun loads .env itself; Node loads it with --env-file).
// Missing required values fail here, so the server never starts half-configured.
export function loadConfig(env: Env, root: string): Config {
  const required = (name: string): string => {
    const value = env[name];
    if (value === undefined || value.trim() === "") {
      throw new Error(name + " is not set. Check .env in the project root.");
    }
    return value;
  };
  const port = Number(env["PORT"] ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be 1-65535.");

  const publicKey = required("PUBLIC_KEY");
  const secretKey = required("SECRET_KEY");
  if (publicKey === secretKey) throw new Error("PUBLIC_KEY and SECRET_KEY must differ.");

  return {
    projectId: required("PROJECT_ID"),
    publicKey,
    secretKey,
    sessionSecret: required("SESSION_SECRET"),
    signingPrivateKeyPem: readFileSync(resolve(root, env["SIGNING_KEY_FILE"] ?? "keys/signing-private.pem"), "utf8"),
    dataFile: resolve(root, env["DATA_FILE"] ?? "data/sbox-ns.sqlite"),
    definitionsDir: resolve(root, env["DEFINITIONS_DIR"] ?? "Editor/Network Storage"),
    fetchAllowedHosts: splitList(env["FETCH_ALLOWED_HOSTS"]),
    host: env["HOST"] ?? "0.0.0.0",
    port,
  };
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}
`;

const STORAGE_TS = `import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createSqliteStorage, type SqliteDatabase } from "@sbox-ns/sdk/storage";
import type { ServerOptions } from "@sbox-ns/sdk/server";

// Bun ships bun:sqlite; Node 22.13+ ships node:sqlite (--experimental-sqlite covers Node 22.5 to 22.12).
// Older runtimes have no built-in SQLite and fail below with a clear message. The module name depends on the
// runtime, and a static import of bun:sqlite would fail on Node, so both loads are dynamic. Only one runs.
async function openDatabase(file: string): Promise<SqliteDatabase> {
  await mkdir(dirname(file), { recursive: true });
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    const bunSqlite = "bun:sqlite";
    const { Database } = (await import(bunSqlite)) as { Database: new (path: string) => SqliteDatabase };
    return new Database(file);
  }
  try {
    const nodeSqlite = "node:sqlite";
    const { DatabaseSync } = (await import(nodeSqlite)) as { DatabaseSync: new (path: string) => SqliteDatabase };
    return new DatabaseSync(file);
  } catch {
    throw new Error("SQLite needs Bun or Node 22.13+ (node:sqlite). Upgrade the runtime.");
  }
}

// The server rebuilds storage whenever definitions change, so the factory reuses the same database handle.
export async function openStorage(file: string): Promise<ServerOptions["storage"]> {
  const db = await openDatabase(file);
  return (definition) =>
    createSqliteStorage({
      db,
      collections: definition.collections,
      values: definition.values,
    });
}
`;

const GLOBALS_TS = `import type { EndpointGlobal, EndpointRequest } from "@sbox-ns/sdk/endpoint";

export const MAX_SCORE = 1_000_000;

// Shared helpers that code endpoints reach through scope.globals. Keep them synchronous.
export const globals: Readonly<Record<string, Readonly<Record<string, EndpointGlobal>>>> = {
  scoring: {
    clampScore: (req: EndpointRequest) => {
      const score = Number(req.input["score"]);
      return Math.min(MAX_SCORE, Math.max(0, score));
    },
  },
};
`;

const ENDPOINTS_TS = `import { defineEndpoint, type EndpointHandler } from "@sbox-ns/sdk/endpoint";

// Code endpoints. The YAML endpoints in Editor/Network Storage are synced separately.
export const endpoints: Readonly<Record<string, EndpointHandler>> = {
  "clamp-score": defineEndpoint((req, ns, scope) => {
    if (typeof req.input["score"] !== "number") {
      ns.fail("INVALID_SCORE", "score must be a number.", 400);
    }
    const clampScore = scope.globals["scoring"]?.["clampScore"];
    if (clampScore === undefined) throw new Error("scoring.clampScore is not registered.");
    return { score: clampScore(req, ns) };
  }),
};
`;

const MODULES_TS = `import { economy, inventory, leaderboards, progression, type SboxModule } from "@sbox-ns/sdk/modules";

// Catalog modules installed into this backend. Remove an entry to stop serving that module.
export const modules: readonly SboxModule[] = [economy, inventory, progression, leaderboards];
`;

const SYNC_TS = `import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ManageSections, SboxNsClient } from "@sbox-ns/sdk/client";

// Layout matches the Sync Tool: Editor/Network Storage/{collections,endpoints,workflows}/*.{yml,yaml,json}.
const FOLDERS = [
  { folder: "collections", section: "collections", suffix: ".collection" },
  { folder: "endpoints", section: "endpoints", suffix: ".endpoint" },
  { folder: "workflows", section: "workflows", suffix: ".workflow" },
] as const;

const EXTENSIONS = [".yml", ".yaml", ".json"] as const;

interface SourceRecord {
  sourceText: string;
}

export interface DefinitionSections {
  collections: SourceRecord[];
  endpoints: SourceRecord[];
  workflows: SourceRecord[];
}

export async function readDefinitions(dir: string): Promise<DefinitionSections> {
  const sections: DefinitionSections = { collections: [], endpoints: [], workflows: [] };
  for (const { folder, section, suffix } of FOLDERS) {
    for (const name of await listFiles(join(dir, folder))) {
      if (!EXTENSIONS.some((extension) => name.endsWith(suffix + extension))) continue;
      const sourceText = await readFile(join(dir, folder, name), "utf8");
      sections[section].push({ sourceText });
    }
  }
  return sections;
}

// Replaces the server's definitions with the files on disk, the same way the Sync Tool does.
export async function syncDefinitions(client: SboxNsClient, dir: string): Promise<void> {
  const sections: DefinitionSections = await readDefinitions(dir);
  await client.manage.sync(sections as ManageSections);
}

async function listFiles(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
`;

const APP_TS = `import { createMemoryReplayStore } from "@sbox-ns/sdk/protocol";
import { withModules } from "@sbox-ns/sdk/modules";
import { createNetworkStorageServer, type NetworkStorageServer, type ServerOptions } from "@sbox-ns/sdk/server";
import { parse } from "yaml";
import type { Config } from "./config.js";
import { endpoints } from "./endpoints.js";
import { nodeFetchPolicy } from "@sbox-ns/sdk/node";
import { globals } from "./globals.js";
import { modules } from "./modules.js";
import { openStorage } from "./storage.js";

export interface App {
  server: NetworkStorageServer;
  options: ServerOptions;
}

// Server options for this project without catalog modules. Tests use this to exercise installModules.
export async function buildOptions(config: Config): Promise<ServerOptions> {
  return {
    projectId: config.projectId,
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    ownerUserId: 1,
    settings: { enableAuthSessions: false, requireAuthSessions: false, encryptedRequestMode: "off" },
    signingPrivateKeyPem: config.signingPrivateKeyPem,
    sessionSecret: config.sessionSecret,
    endpoints,
    globals,
    storage: await openStorage(config.dataFile),
    parseYaml: parse,
    fetchPolicy: nodeFetchPolicy(config.fetchAllowedHosts),
    replayStore: createMemoryReplayStore(),
  };
}

// The running app: code endpoints, shared globals, and the catalog modules wired in-process.
export async function createApp(config: Config): Promise<App> {
  const options = withModules(await buildOptions(config), modules);
  return { server: createNetworkStorageServer(options), options };
}
`;

const SERVER_TS = `import { watch, type FSWatcher } from "node:fs";
import { createServer, type Server } from "node:http";
import { nodeHandler } from "@sbox-ns/sdk/node";
import { createSboxNsClient } from "@sbox-ns/sdk/client";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { syncDefinitions } from "./sync.js";

interface DevState {
  http?: Server;
  watcher?: FSWatcher;
}

// bun --hot re-evaluates this module in the same process. Close the previous listener and watcher first, or the
// port stays bound and the watcher keeps firing.
const dev = globalThis as typeof globalThis & { __sboxNsDev?: DevState };
if (dev.__sboxNsDev !== undefined) {
  dev.__sboxNsDev.watcher?.close();
  await closeServer(dev.__sboxNsDev.http);
}
const state: DevState = {};
dev.__sboxNsDev = state;

const config = loadConfig(process.env, process.cwd());
const app = await createApp(config);
const http = createServer(nodeHandler(app.server));
state.http = http;
await new Promise<void>((resolve, reject) => {
  http.once("error", reject);
  http.listen(config.port, config.host, () => resolve());
});

const syncHost = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
const client = createSboxNsClient({
  baseUrl: "http://" + syncHost + ":" + String(config.port),
  projectId: config.projectId,
  secretKey: config.secretKey,
});
await syncDefinitions(client, config.definitionsDir);
console.log("sbox-ns backend listening on " + config.host + ":" + String(config.port));

// Re-sync when a definition file changes. Debounced so an editor save writes once.
let timer: NodeJS.Timeout | undefined;
state.watcher = watch(config.definitionsDir, { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    syncDefinitions(client, config.definitionsDir).then(
      () => console.log("definitions synced"),
      (error: unknown) => console.error("definition sync failed:", error),
    );
  }, 250);
});

async function closeServer(server: Server | undefined): Promise<void> {
  if (server === undefined) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    state.watcher?.close();
    http.close(() => process.exit(0));
  });
}
`;

const APP_TEST_TS = `import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSboxNsClient, isSboxNsError, type SboxNsClient } from "@sbox-ns/sdk/client";
import { economy, installModules } from "@sbox-ns/sdk/modules";
import { createNetworkStorageServer } from "@sbox-ns/sdk/server";
import { buildOptions, createApp } from "../app.js";
import type { Config } from "../config.js";
import { syncDefinitions } from "../sync.js";

// dist/test/app.test.js lives two levels below the project root.
const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function testConfig(dir: string): Config {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    projectId: "proj_test",
    publicKey: "sbox_ns_pk_test",
    secretKey: "sbox_ns_sk_test",
    sessionSecret: "test-session-secret",
    signingPrivateKeyPem: privateKey,
    dataFile: join(dir, "sbox-ns.sqlite"),
    definitionsDir: join(PROJECT_ROOT, "Editor", "Network Storage"),
    fetchAllowedHosts: [],
    host: "127.0.0.1",
    port: 0,
  };
}

// Runs against the real server in-process (no network) with a temporary SQLite file.
async function withBackend(run: (client: SboxNsClient, config: Config) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "sbox-ns-test-"));
  try {
    const config = testConfig(dir);
    const app = await createApp(config);
    const client = createSboxNsClient({
      baseUrl: "http://sbox-ns.test",
      projectId: config.projectId,
      secretKey: config.secretKey,
      fetch: (url, init) => app.server.fetch(new Request(url, init)),
    });
    await syncDefinitions(client, config.definitionsDir);
    await run(client, config);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("serves synced YAML endpoints and code endpoints", async () => {
  await withBackend(async (client) => {
    const ping = await client.get<{ success: boolean; service: string }>("ping");
    assert.equal(ping.success, true);
    assert.equal(ping.service, "sbox-ns-backend");

    const clamped = await client.call<{ score: number }>("clamp-score", { score: 2_000_000 });
    assert.equal(clamped.score, 1_000_000);
    const floored = await client.call<{ score: number }>("clamp-score", { score: -5 });
    assert.equal(floored.score, 0);
  });
});

test("trusted add-score calls accumulate in the scores collection", async () => {
  await withBackend(async (client) => {
    await client.call("add-score", { player_id: "player-1", points: 5 });
    await client.call("add-score", { player_id: "player-1", points: 7 });
    const score = await client.call<{ points: number }>("get-score", { player_id: "player-1" });
    assert.equal(score.points, 12);
  });
});

test("invalid input comes back as a typed SboxNsError with the real status", async () => {
  await withBackend(async (client) => {
    await assert.rejects(client.call("clamp-score", { score: "high" }), (error: unknown) => {
      return isSboxNsError(error) && error.status === 400 && error.code === "INVALID_SCORE";
    });
  });
});

test("catalog module queries are served by the custom backend", async () => {
  await withBackend(async (client) => {
    const top = await client.get<{ type: string; entries: unknown[] }>("leaderboards_top");
    assert.equal(top.type, "leaderboard");
    assert.deepEqual(top.entries, []);
  });
});

test("installModules is idempotent on a hosted project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sbox-ns-install-"));
  try {
    const config = testConfig(dir);
    const server = createNetworkStorageServer(await buildOptions(config));
    const client = createSboxNsClient({
      baseUrl: "http://sbox-ns.test",
      projectId: config.projectId,
      secretKey: config.secretKey,
      fetch: (url, init) => server.fetch(new Request(url, init)),
    });
    const first = await installModules(client, [economy]);
    const second = await installModules(client, [economy]);
    assert.equal(first.modules[0]?.status, "installed");
    assert.equal(second.modules[0]?.status, "unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
`;

function dockerfile(port: number): string {
  return `FROM oven/bun:1
WORKDIR /app
COPY package.json ./
RUN bun install --production
COPY . .
ENV HOST=0.0.0.0 PORT=${port} DATA_FILE=/app/data/sbox-ns.sqlite SIGNING_KEY_FILE=/app/keys/signing-private.pem
EXPOSE ${port}
VOLUME ["/app/data"]
CMD ["bun", "run", "src/server.ts"]
`;
}

const SYSTEMD_UNIT = `[Unit]
Description=sbox-ns backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=sboxns
WorkingDirectory=/opt/sbox-ns-backend
ExecStart=/usr/bin/node --experimental-sqlite --env-file=.env dist/server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
`;

const SCORES_COLLECTION = `sourceVersion: 1
kind: collection
id: scores
name: scores
description: Points per player. Written by trusted server calls.
definition:
  collectionType: global
  accessMode: endpoint
  allowRecordDelete: false
  schema:
    type: object
    properties:
      points:
        type: number
        default: 0
        min: 0
`;

const PING_ENDPOINT = `sourceVersion: 1
kind: endpoint
id: ping
name: Ping
description: Health check. Confirms which backend answered.
exposure: public
method: GET
steps: []
response:
  status: 200
  body:
    success: true
    service: sbox-ns-backend
`;

const ADD_SCORE_ENDPOINT = `sourceVersion: 1
kind: endpoint
id: add-score
name: Add score
description: Adds points to a player's score. Trusted server calls only.
exposure: public
method: POST
requiresSecretKey: true
input:
  type: object
  properties:
    player_id:
      type: string
    points:
      type: number
  required:
    - player_id
    - points
steps:
  - id: score
    type: write
    collection: scores
    key: "{{input.player_id}}"
    ops:
      - op: inc
        path: points
        value: "{{input.points}}"
response:
  status: 200
  body:
    success: true
`;

const GET_SCORE_ENDPOINT = `sourceVersion: 1
kind: endpoint
id: get-score
name: Get score
description: Reads a player's points. Trusted server calls only.
exposure: public
method: POST
requiresSecretKey: true
input:
  type: object
  properties:
    player_id:
      type: string
  required:
    - player_id
steps:
  - id: score
    type: read
    collection: scores
    key: "{{input.player_id}}"
response:
  status: 200
  body:
    success: true
    points: "{{score.points || 0}}"
`;

function readme(configureLine: string, port: number): string {
  return `# sbox-ns backend

Generated by create-sbox-ns-backend. It serves your game's endpoints, storage, and catalog modules.

## Connect the game

Add this line once to the game (also saved in configure.txt):

\`\`\`
${configureLine}
\`\`\`

Only the public key is in that line. The secret key stays in .env and never goes into game code.

## Run locally

Requirements: Bun 1.1+ or Node 22.13+ (for node:sqlite).

\`\`\`
bun install
bun run dev       # hot reload; definitions re-sync when files change
\`\`\`

Or with Node:

\`\`\`
npm install
npm run build
npm start
\`\`\`

Check it answers: \`curl http://localhost:${port}/v1/endpoints/<PROJECT_ID>/ping\`

## Layout

- \`Editor/Network Storage/\`: YAML definitions (collections, endpoints, workflows), synced on start and on save.
- \`src/endpoints.ts\`, \`src/globals.ts\`: code endpoints and shared helpers.
- \`src/modules.ts\`: catalog modules (economy, inventory, progression, leaderboards) wired in-process by \`withModules\`.
- \`src/app.ts\`: builds the server. \`src/server.ts\`: HTTP listener, dev sync.
- \`.env\`: secrets and settings. \`keys/\`: signing key. \`data/\`: SQLite database.

## Test

\`\`\`
npm test
\`\`\`

The tests run the real server in-process against a temporary SQLite file.

## Deploy

### VPS (systemd)

\`\`\`
npm ci && npm run build
sudo cp -r . /opt/sbox-ns-backend
sudo cp deploy/sbox-ns.service /etc/systemd/system/
sudo systemctl enable --now sbox-ns
\`\`\`

Create the \`sboxns\` user first, and keep \`.env\` and \`keys/\` readable only by that user.

### Docker

\`\`\`
docker build -t sbox-ns-backend .
docker run -d -p ${port}:${port} --env-file .env \\
  -v "$PWD/keys:/app/keys:ro" -v "$PWD/data:/app/data" sbox-ns-backend
\`\`\`

The image runs \`bun run src/server.ts\`. Mount \`keys/\` and \`data/\`; do not bake them into the image.

### Cloudflare Workers

This project does not generate a Workers build. To run the same definitions on Workers, use an SDK storage adapter in a Worker \`fetch\` handler: \`storage: (definition) => createD1Storage({ ...definition, db: env.DB })\` from \`@sbox-ns/sdk/storage\` (Cloudflare D1), or \`createKvStorage\` (Durable Object coordinator plus KV). The definitions stay in \`Editor/Network Storage\`. The SDK repository's \`recipes/cloudflare-kv\` is a working Worker: it needs a \`COORDINATOR\` Durable Object binding, a \`BLOBS\` KV namespace, and a \`DB\` D1 binding for the D1 harness. The SDK storage guide lists every adapter's options.
`;
}

export function projectFiles(context: TemplateContext): Record<string, string> {
  return {
    "package.json": JSON.stringify(PACKAGE_JSON, null, 2) + "\n",
    "tsconfig.json": JSON.stringify(TSCONFIG, null, 2) + "\n",
    ".gitignore": GITIGNORE,
    ".dockerignore": DOCKERIGNORE,
    "README.md": readme(context.configureLine, context.port),
    "Dockerfile": dockerfile(context.port),
    "deploy/sbox-ns.service": SYSTEMD_UNIT,
    "src/config.ts": CONFIG_TS,
    "src/storage.ts": STORAGE_TS,
    "src/globals.ts": GLOBALS_TS,
    "src/endpoints.ts": ENDPOINTS_TS,
    "src/modules.ts": MODULES_TS,
    "src/sync.ts": SYNC_TS,
    "src/app.ts": APP_TS,
    "src/server.ts": SERVER_TS,
    "src/test/app.test.ts": APP_TEST_TS,
    "Editor/Network Storage/collections/scores.collection.yml": SCORES_COLLECTION,
    "Editor/Network Storage/endpoints/ping.endpoint.yml": PING_ENDPOINT,
    "Editor/Network Storage/endpoints/add-score.endpoint.yml": ADD_SCORE_ENDPOINT,
    "Editor/Network Storage/endpoints/get-score.endpoint.yml": GET_SCORE_ENDPOINT,
  };
}
