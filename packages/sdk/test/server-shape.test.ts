import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { compileCollection, compileEndpoint, DefinitionError } from "../src/dsl/compile.js";
import { commitCompiled, createCatalog, deleteResource, publicValuesOf, valuesOf, type CollectionEntry } from "../src/server/catalog.js";
import { createMemoryReplayStore } from "../src/protocol/index.js";
import { createNetworkStorageServer, type ServerOptions } from "../src/server/index.js";
import { createMemoryStorage } from "../src/storage/index.js";

// Document shapes as the server accepts them (the create-sbox-ns-backend fixture uses the same layout).

function endpointDoc(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { sourceVersion: 1, kind: "endpoint", id, method: "GET", steps: [], response: { status: 200, body: { pong: id } }, ...extra };
}

// The fixture's gamecfg: a flat body beside the envelope, with a scope key the server ignores and a list of constant groups.
const GAMECFG = {
  sourceVersion: 1,
  kind: "collection",
  id: "gamecfg",
  name: "gamecfg",
  scope: "global",
  visibility: "public",
  constants: [{ id: "rules", name: "Rules", entries: { xp_per_level: 100 } }],
};

function collectionEntry(doc: Record<string, unknown>): CollectionEntry {
  return { document: doc, record: doc, compiled: compileCollection(doc) };
}

describe("endpoint exposure, as the server reads it", () => {
  it("defaults an endpoint without exposure to public", () => {
    assert.equal(compileEndpoint(endpointDoc("open")).exposure, "public");
  });

  it("accepts exposure internal and the legacy internal flags as internal", () => {
    assert.equal(compileEndpoint(endpointDoc("a", { exposure: "internal" })).exposure, "internal");
    assert.equal(compileEndpoint(endpointDoc("b", { internalOnly: true })).exposure, "internal");
    assert.equal(compileEndpoint(endpointDoc("c", { exposure: "public", internal: true })).exposure, "internal");
  });

  it("rejects exposure values the server does not accept", () => {
    assert.throws(() => compileEndpoint(endpointDoc("d", { exposure: "endpoint" })), (error: unknown) => {
      assert.ok(error instanceof DefinitionError);
      assert.equal(error.path, "endpoint.exposure");
      return true;
    });
  });
});

describe("collections, as the server reads them", () => {
  it("compiles the fixture layout and ignores the scope key", () => {
    const compiled = compileCollection(GAMECFG);
    assert.equal(compiled.definition.id, "gamecfg");
    assert.deepEqual(compiled.constants, [{ id: "rules", visibility: "public", entries: { xp_per_level: 100 } }]);
  });

  it("takes constants in map form too, and defaults visibility from accessMode", () => {
    const compiled = compileCollection({
      sourceVersion: 1,
      kind: "collection",
      id: "scores",
      accessMode: "endpoint",
      constants: { tuning: { speed: 3 } },
    });
    assert.deepEqual(compiled.constants, [{ id: "tuning", visibility: "private", entries: { speed: 3 } }]);
  });

  it("still accepts the wrapped definition form", () => {
    const compiled = compileCollection({
      sourceVersion: 1,
      kind: "collection",
      id: "wrapped",
      definition: { accessMode: "public", constants: [{ id: "g", entries: { k: 1 } }] },
    });
    assert.equal(compiled.definition.accessMode, "public");
    assert.deepEqual(compiled.constants, [{ id: "g", visibility: "public", entries: { k: 1 } }]);
  });

  it("fails explicitly on keys the server accepts but this SDK does not implement", () => {
    assert.throws(() => compileCollection({ sourceVersion: 1, kind: "collection", id: "t", tables: [] }), (error: unknown) => {
      assert.ok(error instanceof DefinitionError);
      assert.equal(error.path, "collection.tables");
      return true;
    });
  });
});

describe("constant groups in the catalog", () => {
  it("serves public groups, hides private ones from the client view, and replaces them on re-sync and delete", () => {
    const catalog = createCatalog();
    const secret = { sourceVersion: 1, kind: "collection", id: "secretcfg", accessMode: "private", constants: [{ id: "secret", entries: { key: 1 } }] };
    commitCompiled(catalog, [
      { kind: "collections", id: "gamecfg", entry: collectionEntry(GAMECFG) },
      { kind: "collections", id: "secretcfg", entry: collectionEntry(secret) },
    ]);

    const full = valuesOf(catalog, undefined);
    assert.deepEqual(full.groups["rules"], { name: "rules", values: { xp_per_level: 100 } });
    assert.ok(full.groups["secret"]);

    const client = publicValuesOf(catalog, undefined);
    assert.ok(client.groups["rules"]);
    assert.equal(client.groups["secret"], undefined);

    commitCompiled(catalog, [{ kind: "collections", id: "gamecfg", entry: collectionEntry({ ...GAMECFG, constants: [] }) }]);
    assert.equal(valuesOf(catalog, undefined).groups["rules"], undefined);

    assert.equal(deleteResource(catalog, "collections", "secretcfg"), true);
    assert.equal(valuesOf(catalog, undefined).groups["secret"], undefined);
  });
});

describe("runtime, through the server", () => {
  const PROJECT = "proj_server_shape";
  const SECRET = "sbox_ns_sk_shape";
  const PUBLIC = "sbox_ns_pk_shape";

  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  function serverOptions(): ServerOptions {
    return {
      projectId: PROJECT,
      publicKey: PUBLIC,
      secretKey: SECRET,
      ownerUserId: 1,
      settings: { enableAuthSessions: false, requireAuthSessions: false, encryptedRequestMode: "off" },
      signingPrivateKeyPem: privateKey,
      sessionSecret: "server-shape-test-session-secret",
      endpoints: {},
      storage: (definition) => createMemoryStorage({ collections: definition.collections, values: definition.values }),
      parseYaml,
      stringifyYaml,
      fetchPolicy: { allowedHosts: [], resolveHost: async () => [] },
      replayStore: createMemoryReplayStore(),
    };
  }

  it("answers an internal endpoint as not found and serves the public one", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const put = await app.fetch(
      new Request(`http://ns.test/v3/manage/${PROJECT}/endpoints`, {
        method: "PUT",
        headers: { "x-api-key": SECRET, "content-type": "application/json" },
        body: JSON.stringify([endpointDoc("open"), endpointDoc("hidden", { exposure: "internal" })]),
      }),
    );
    assert.equal(put.status, 200);

    const open = await app.fetch(
      new Request(`http://ns.test/v3/endpoints/${PROJECT}/open`, {
        method: "POST",
        headers: { "x-public-key": PUBLIC, "content-type": "application/json" },
        body: "{}",
      }),
    );
    assert.equal(open.status, 200);

    const hidden = await app.fetch(
      new Request(`http://ns.test/v3/endpoints/${PROJECT}/hidden`, {
        method: "POST",
        headers: { "x-public-key": PUBLIC, "content-type": "application/json" },
        body: "{}",
      }),
    );
    assert.equal(hidden.status, 404);
    assert.match(await hidden.text(), /ENDPOINT_NOT_FOUND/);
  });

  it("serves public constant groups over the values route and omits private ones", async () => {
    const app = createNetworkStorageServer(serverOptions());
    const secret = { sourceVersion: 1, kind: "collection", id: "secretcfg", accessMode: "private", constants: [{ id: "secret", entries: { key: 1 } }] };
    const put = await app.fetch(
      new Request(`http://ns.test/v3/manage/${PROJECT}/collections`, {
        method: "PUT",
        headers: { "x-api-key": SECRET, "content-type": "application/json" },
        body: JSON.stringify([GAMECFG, secret]),
      }),
    );
    assert.equal(put.status, 200);

    const values = await app.fetch(
      new Request(`http://ns.test/v3/values/${PROJECT}`, { headers: { "x-public-key": PUBLIC } }),
    );
    assert.equal(values.status, 200);
    const body = (await values.json()) as { groups: Record<string, unknown> };
    assert.ok(body.groups["rules"]);
    assert.equal(body.groups["secret"], undefined);
  });
});
