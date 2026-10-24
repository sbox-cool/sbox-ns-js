import { generateKeyPairSync } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ControlStateOptions } from "../../src/server/control-state.js";
import type { ServerOptions } from "../../src/server/options.js";
import { createMemoryReplayStore } from "../../src/protocol/index.js";
import { createMemoryStorage } from "../../src/storage/index.js";
import { isRecord } from "../../src/util/guards.js";

export const PROJECT = "proj-durable";
export const OTHER_PROJECT = "proj-other";
export const PUBLIC = "public-durable";
export const SECRET = "secret-durable";

const SIGNING_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

export const DEFAULT_SETTINGS: ServerOptions["settings"] = {
  enableAuthSessions: false,
  requireAuthSessions: false,
  encryptedRequestMode: "off",
};

export interface FixtureInput {
  readonly controlState?: ControlStateOptions | undefined;
  readonly settings?: ServerOptions["settings"] | undefined;
  readonly projectId?: string | undefined;
  readonly log?: ((value: unknown) => void) | undefined;
}

// Options for one backend over the given control state. Storage stays in memory; the control state is what these tests
// exercise.
export function serverOptions(input: FixtureInput = {}): ServerOptions {
  return {
    projectId: input.projectId ?? PROJECT,
    publicKey: PUBLIC,
    secretKey: SECRET,
    ownerUserId: 1,
    settings: input.settings ?? DEFAULT_SETTINGS,
    signingPrivateKeyPem: SIGNING_PEM,
    sessionSecret: "durable-test-session-secret",
    endpoints: {},
    storage: (definition) => createMemoryStorage({ collections: definition.collections, values: definition.values }),
    parseYaml,
    stringifyYaml,
    fetchPolicy: { allowedHosts: [], resolveHost: async () => [] },
    replayStore: createMemoryReplayStore(),
    ...(input.controlState === undefined ? {} : { controlState: input.controlState }),
    ...(input.log === undefined ? {} : { log: input.log }),
  };
}

export function endpointDoc(id: string): Record<string, unknown> {
  return { sourceVersion: 1, kind: "endpoint", id, method: "GET", steps: [], response: { status: 200, body: { pong: id } } };
}

// A manage-API request against one project, authenticated with the secret key.
export function manageRequest(route: string, method: string, body?: unknown, projectId = PROJECT): Request {
  return new Request(`http://ns.test/v3/manage/${projectId}/${route}`, {
    method,
    headers: { "x-api-key": SECRET, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function settingsOf(body: unknown): Record<string, unknown> {
  if (!isRecord(body) || !isRecord(body["settings"])) throw new Error("settings response has no settings object");
  return body["settings"];
}

export function idsOf(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body["data"])) throw new Error("list response has no data array");
  return body["data"].map((item) => {
    if (!isRecord(item)) throw new Error("list item is not an object");
    return String(item["id"]);
  });
}
