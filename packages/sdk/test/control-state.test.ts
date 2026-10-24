// Durable control state over real SQLite files, plus the memory default that must stay unchanged when no control state
// is configured.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createNetworkStorageServer } from "../src/server/index.js";
import { manageRequest, serverOptions, settingsOf } from "./control/fixture.js";
import type { ControlEnv } from "./control/stores.js";
import { type ControlBackend, runControlSuite } from "./control/suite.js";

const dir = mkdtempSync(join(tmpdir(), "ns-control-sqlite-"));
let locations = 0;

const sqlite: ControlBackend = {
  label: "sqlite",
  skip: false,
  newLocation: async (): Promise<ControlEnv> => {
    locations += 1;
    return { NS_CONTROL_BACKEND: "sqlite", NS_CONTROL_SQLITE_FILE: join(dir, `control-${locations}.sqlite`) };
  },
  cleanup: async () => rmSync(dir, { recursive: true, force: true }),
};

runControlSuite(sqlite);

describe("memory default", () => {
  it("keeps settings in memory and refuses an export when no control state is configured", async () => {
    const server = createNetworkStorageServer(serverOptions());
    await server.ready;

    const put = await server.fetch(manageRequest("settings", "PUT", { enableAuthSessions: true, requireSboxAuth: true }));
    assert.equal(put.status, 200);
    const view = settingsOf(await (await server.fetch(manageRequest("settings", "GET"))).json());
    assert.equal(view["enableAuthSessions"], true);

    await assert.rejects(server.exportControlState(), /exportControlState requires ServerOptions\.controlState/);
  });
});
