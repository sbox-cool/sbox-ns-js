import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createMemoryReplayStore } from "../src/protocol/index.js";
import {
  createNetworkStorageServer,
  type NetworkStorageServer,
  type ServerOptions,
  type SessionRevocations,
} from "../src/server/index.js";
import { createMemoryStorage } from "../src/storage/index.js";

// A session family is the payload id shared by a session and every token refreshed or reauthenticated from it. These
// tests drive the public auth-session routes end to end, as a game server's clients would.

const PROJECT_ID = "proj_session_family";
const API_KEY = "session-family-api-key";
const SESSION_SECRET = "session-family-session-secret";
const STEAM_ID = "76561198000000001";
const REVOKED_CODE = "AUTH_SESSION_REVOKED";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

interface SessionBody {
  ok: boolean;
  token?: string;
  sessionId?: string;
  error?: { code: string; message: string };
}

function serverOptions(overrides: Partial<ServerOptions> = {}): ServerOptions {
  return {
    projectId: PROJECT_ID,
    publicKey: API_KEY,
    secretKey: "session-family-secret-key",
    ownerUserId: 1,
    settings: { enableAuthSessions: true, requireAuthSessions: false, encryptedRequestMode: "v1" },
    signingPrivateKeyPem: privateKey,
    sessionSecret: SESSION_SECRET,
    endpoints: {},
    storage: (definition) => createMemoryStorage({ collections: definition.collections, values: definition.values }),
    parseYaml,
    stringifyYaml,
    fetchPolicy: { allowedHosts: [], resolveHost: async () => [] },
    replayStore: createMemoryReplayStore(),
    ...overrides,
  };
}


async function callSessions(
  app: NetworkStorageServer,
  op: string,
  headers: Record<string, string> = {},
): Promise<SessionBody> {
  const response = await app.fetch(
    new Request(`http://ns.test/v3/auth-sessions/${PROJECT_ID}/${op}`, {
      method: "POST",
      headers: {
        "x-api-key": API_KEY,
        "x-steam-id": STEAM_ID,
        "content-type": "application/json",
        ...headers,
      },
      body: "{}",
    }),
  );
  return (await response.json()) as SessionBody;
}

async function create(app: NetworkStorageServer): Promise<{ token: string; sessionId: string }> {
  const body = await callSessions(app, "create");
  assert.equal(body.ok, true, JSON.stringify(body));
  return { token: body.token!, sessionId: body.sessionId! };
}

async function refresh(app: NetworkStorageServer, token: string): Promise<SessionBody> {
  return callSessions(app, "refresh", { "x-auth-session": token });
}

async function revoke(app: NetworkStorageServer, token: string): Promise<SessionBody> {
  return callSessions(app, "revoke", { "x-auth-session": token });
}

function assertRevoked(body: SessionBody): void {
  assert.equal(body.ok, false, JSON.stringify(body));
  assert.equal(body.error?.code, REVOKED_CODE);
  assert.equal(body.token, undefined);
}

describe("auth session families", () => {
  it("revoking the newest token invalidates every earlier and refreshed token of its family", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const first = await create(app);
    const second = await refresh(app, first.token);
    const third = await refresh(app, second.token!);

    const revokedBody = await revoke(app, third.token!);
    assert.equal(revokedBody.ok, true, JSON.stringify(revokedBody));

    for (const stale of [first.token, second.token!, third.token!]) {
      assertRevoked(await refresh(app, stale));
    }
  });

  it("revoking an earlier token invalidates the refreshed successors that share its family", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const first = await create(app);
    const second = await refresh(app, first.token);

    await revoke(app, first.token);

    assertRevoked(await refresh(app, second.token!));
  });

  it("a revoked session cannot reauth or refresh", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const session = await create(app);
    await revoke(app, session.token);

    assertRevoked(await callSessions(app, "reauth", { "x-auth-session": session.token }));
    assertRevoked(await refresh(app, session.token));
  });

  it("revoking a family leaves other families of the same project valid", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const revokedFamily = await create(app);
    const otherFamily = await create(app);
    assert.notEqual(otherFamily.sessionId, revokedFamily.sessionId);

    await revoke(app, revokedFamily.token);

    const refreshed = await refresh(app, otherFamily.token);
    assert.equal(refreshed.ok, true, JSON.stringify(refreshed));
  });

  it("revoke is idempotent", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const session = await create(app);

    assert.equal((await revoke(app, session.token)).ok, true);
    assert.equal((await revoke(app, session.token)).ok, true);
    assertRevoked(await refresh(app, session.token));
  });

  it("keeps a revoked family blocked after the revoked token expires", async () => {
    let now = 1_800_000_000_000;
    const app = createNetworkStorageServer(serverOptions({ now: () => now }));
    const first = await create(app);
    now += 50 * 60 * 1000;
    const successor = await refresh(app, first.token);
    assert.equal(successor.ok, true);
    await revoke(app, first.token);
    now += 11 * 60 * 1000;
    assertRevoked(await refresh(app, successor.token!));
  });

  it("refresh fails closed when the revocation store errors", async () => {
    let failing = false;
    const store: SessionRevocations = {
      async revoke() {},
      async isRevoked() {
        if (failing) throw new Error("revocation store unavailable");
        return false;
      },
    };
    const app = createNetworkStorageServer(serverOptions({ sessionRevocations: store }));
    const session = await create(app);

    failing = true;
    const body = await refresh(app, session.token);

    assert.equal(body.ok, false);
    assert.equal(body.token, undefined);
  });

  it("refresh rechecks revocation after minting, so a revoke that lands mid-refresh wins", async () => {
    let checks = 0;
    const store: SessionRevocations = {
      async revoke() {},
      // The first check (before minting) passes; the revoke that lands during minting shows up on the second.
      async isRevoked() {
        checks += 1;
        return checks > 1;
      },
    };
    const app = createNetworkStorageServer(serverOptions({ sessionRevocations: store }));
    const session = await create(app);

    const body = await refresh(app, session.token);

    assertRevoked(body);
  });
});
