import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createMemoryReplayStore } from "../src/protocol/index.js";
import { computeProxySignature } from "../src/protocol/identity.js";
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
const OTHER_STEAM_ID = "76561198000000002";
const HOST_STEAM_ID = "76561198000000003";
const PLAYER_TOKEN = "player-token";
const OTHER_PLAYER_TOKEN = "other-player-token";
const HOST_TOKEN = "host-token";
const FACEPUNCH_URL = "https://public.facepunch.com/sbox/auth/token";
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

interface SessionBody {
  ok: boolean;
  token?: string;
  sessionId?: string;
  steamId?: string;
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
  body: Record<string, unknown> = {},
): Promise<SessionBody> {
  const response = await app.fetch(
    new Request(`http://ns.test/v3/auth-sessions/${PROJECT_ID}/${op}`, {
      method: "POST",
      headers: {
        "x-api-key": API_KEY,
        "x-steam-id": STEAM_ID,
        "x-sbox-token": PLAYER_TOKEN,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
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

function assertRefused(body: SessionBody, code: string): void {
  assert.equal(body.ok, false, JSON.stringify(body));
  assert.equal(body.error?.code, code);
  assert.equal(body.token, undefined);
}

// Controlled Facepunch: a token verifies only for the steam id it was issued to. Any other token is rejected.
const ISSUED_TOKENS: Record<string, string> = {
  [PLAYER_TOKEN]: STEAM_ID,
  [OTHER_PLAYER_TOKEN]: OTHER_STEAM_ID,
  [HOST_TOKEN]: HOST_STEAM_ID,
};

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const sent = JSON.parse(String(init?.body)) as { steamid: string; token: string };
    const owner = ISSUED_TOKENS[sent.token];
    const body = owner === undefined ? `{"Status":"invalid"}` : `{"Status":"ok","SteamId":${owner}}`;
    return new Response(body, { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// Headers for a proxied request: the host token proves the host, and the client token proves the player on whose behalf it acts.
async function delegatedHeaders(
  clientSteamId: string,
  clientToken: string,
  endpointSlug: string,
): Promise<Record<string, string>> {
  return {
    "x-steam-id": "",
    "x-sbox-token": HOST_TOKEN,
    "x-sbox-steam-id": HOST_STEAM_ID,
    "x-on-behalf-of": clientSteamId,
    "x-on-behalf-of-token": clientToken,
    "x-proxy-signature": await computeProxySignature(API_KEY, PROJECT_ID, endpointSlug, clientSteamId, clientToken),
  };
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

describe("auth session identity", () => {
  it("create refuses an anonymous caller even when requireSboxAuth is off", async () => {
    const app = createNetworkStorageServer(serverOptions());
    assertRefused(await callSessions(app, "create", { "x-sbox-token": "" }), "SBOX_AUTH_FAILED");
  });

  it("create refuses a forged s&box token", async () => {
    const app = createNetworkStorageServer(serverOptions());
    assertRefused(await callSessions(app, "create", { "x-sbox-token": "forged-token" }), "SBOX_AUTH_FAILED");
  });

  it("create does not accept a presented session in place of an s&box proof", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const session = await create(app);
    const body = await callSessions(app, "create", { "x-sbox-token": "", "x-auth-session": session.token });
    assertRefused(body, "SBOX_AUTH_FAILED");
  });

  it("create rejects an implausible claimed Steam ID", async () => {
    const app = createNetworkStorageServer(serverOptions());
    assertRefused(await callSessions(app, "create", { "x-steam-id": "12345" }), "INVALID_STEAMID");
  });

  it("create rejects a body Steam ID that differs from the verified player", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const body = await callSessions(app, "create", {}, { steamId: OTHER_STEAM_ID });
    assertRefused(body, "AUTH_SESSION_STEAMID_MISMATCH");
  });

  it("create issues a session for the verified player", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const body = await callSessions(app, "create");
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.steamId, STEAM_ID);
  });

  it("create for a delegated verified player issues a session for the player, not the host", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const headers = await delegatedHeaders(STEAM_ID, PLAYER_TOKEN, "__auth_session_create");
    const body = await callSessions(app, "create", headers, { steamId: STEAM_ID });
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.steamId, STEAM_ID);
  });

  it("create refuses a delegated client token not issued to the claimed player", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const headers = await delegatedHeaders(STEAM_ID, OTHER_PLAYER_TOKEN, "__auth_session_create");
    assertRefused(await callSessions(app, "create", headers, { steamId: STEAM_ID }), "SBOX_AUTH_FAILED");
  });

  it("create refuses a delegated request whose body names a different player", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const headers = await delegatedHeaders(OTHER_STEAM_ID, OTHER_PLAYER_TOKEN, "__auth_session_create");
    const body = await callSessions(app, "create", headers, { steamId: STEAM_ID });
    assertRefused(body, "AUTH_SESSION_STEAMID_MISMATCH");
  });

  it("reauth without a presented session mints nothing", async () => {
    const app = createNetworkStorageServer(serverOptions());
    assertRefused(await callSessions(app, "reauth"), "AUTH_SESSION_REQUIRED");
  });

  it("reauth refuses an unverified caller", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const session = await create(app);
    const body = await callSessions(app, "reauth", { "x-auth-session": session.token, "x-sbox-token": "" });
    assertRefused(body, "SBOX_AUTH_FAILED");
  });

  it("reauth refuses a session owned by a different player", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const session = await create(app);
    const body = await callSessions(app, "reauth", {
      "x-auth-session": session.token,
      "x-steam-id": OTHER_STEAM_ID,
      "x-sbox-token": OTHER_PLAYER_TOKEN,
    });
    assertRefused(body, "AUTH_SESSION_STEAMID_MISMATCH");
  });

  it("reauth refuses a body Steam ID that differs from the verified player", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const session = await create(app);
    const body = await callSessions(app, "reauth", { "x-auth-session": session.token }, { steamId: OTHER_STEAM_ID });
    assertRefused(body, "AUTH_SESSION_STEAMID_MISMATCH");
  });

  it("reauth refuses an expired session", async () => {
    let now = 1_800_000_000_000;
    const app = createNetworkStorageServer(serverOptions({ now: () => now }));
    const session = await create(app);
    now += ONE_YEAR_MS;
    assertRefused(await callSessions(app, "reauth", { "x-auth-session": session.token }), "AUTH_SESSION_EXPIRED");
  });

  it("reauth renews the session within its family", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const session = await create(app);
    const renewed = await callSessions(app, "reauth", { "x-auth-session": session.token });
    assert.equal(renewed.ok, true, JSON.stringify(renewed));
    assert.equal(renewed.steamId, STEAM_ID);

    // The renewed token shares the original family, so revoking it ends the original too.
    await revoke(app, renewed.token!);
    assertRevoked(await refresh(app, session.token));
  });

  it("reauth renews a delegated player session", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const session = await create(app);
    const headers = await delegatedHeaders(STEAM_ID, PLAYER_TOKEN, "__auth_session_reauth");
    const body = await callSessions(app, "reauth", { ...headers, "x-auth-session": session.token }, { steamId: STEAM_ID });
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.steamId, STEAM_ID);
  });

  it("reauth refuses a delegated client token not issued to the session's player", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const session = await create(app);
    const headers = await delegatedHeaders(STEAM_ID, OTHER_PLAYER_TOKEN, "__auth_session_reauth");
    const body = await callSessions(app, "reauth", { ...headers, "x-auth-session": session.token }, { steamId: STEAM_ID });
    assertRefused(body, "SBOX_AUTH_FAILED");
  });
});
