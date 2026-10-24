import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";
import { sha256Hex } from "../../src/protocol/crypto.js";
import { type ControlStartup, ControlStateError, type ControlStateOptions } from "../../src/server/control-state.js";
import { createNetworkStorageServer, type NetworkStorageServer, type ServerOptions } from "../../src/server/index.js";
import type { ControlStateStore } from "../../src/storage/control.js";
import { endpointDoc, idsOf, manageRequest, OTHER_PROJECT, PROJECT, serverOptions, settingsOf } from "./fixture.js";
import { type ControlEnv, type OpenedStore, openStore } from "./stores.js";

const CHILD = fileURLToPath(new URL("./restart-child.js", import.meta.url));
const SETTING_ON = { enableAuthSessions: true, requireSboxAuth: true };
const ZERO_CHECKSUM = "0".repeat(64);

export interface ControlBackend {
  readonly label: string;
  // A non-false reason skips the suite, for example when no database is configured.
  readonly skip: string | false;
  // A fresh, empty control-state location. Every call returns a different one.
  newLocation(): Promise<ControlEnv>;
  cleanup(): Promise<void>;
}

// Failure injection around a real store. Test-only: production code never wraps its store.
interface FaultPlan {
  // The next save fails. "reject" writes nothing; "land-then-throw" writes, then reports failure.
  saveFault: "reject" | "land-then-throw" | null;
  // While set, every load fails.
  loadFails: boolean;
}

interface BootInput {
  readonly projectId?: string;
  readonly settings?: ServerOptions["settings"];
  readonly startup?: ControlStartup;
  readonly snapshot?: string;
  readonly plan?: FaultPlan;
  readonly log?: (value: unknown) => void;
}

interface Built {
  readonly server: NetworkStorageServer;
  readonly plan: FaultPlan;
}

function faulty(inner: ControlStateStore, plan: FaultPlan): ControlStateStore {
  return {
    load: async (projectId) => {
      if (plan.loadFails) throw new Error("injected load failure");
      return inner.load(projectId);
    },
    save: async (projectId, expectedVersion, row) => {
      const fault = plan.saveFault;
      plan.saveFault = null;
      if (fault === "reject") throw new Error("injected save rejection");
      await inner.save(projectId, expectedVersion, row);
      if (fault === "land-then-throw") throw new Error("injected acknowledgement loss");
    },
  };
}

// Runs the restart child against the location. The child is a separate process, so nothing it wrote is cached here.
const execFileAsync = promisify(execFile);
async function runChild(env: ControlEnv, action: "write" | "read"): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [CHILD], {
    env: { ...process.env, ...env, NS_CONTROL_ACTION: action },
    timeout: 60_000,
  });
  return stdout;
}

export function runControlSuite(backend: ControlBackend): void {
  describe(`durable control state on ${backend.label}`, { skip: backend.skip }, () => {
    const opened: OpenedStore[] = [];

    after(async () => {
      for (const entry of opened) await entry.close();
      await backend.cleanup();
    });

    const open = async (env: ControlEnv): Promise<OpenedStore> => {
      const entry = await openStore(env);
      opened.push(entry);
      return entry;
    };

    const build = async (env: ControlEnv, input: BootInput = {}): Promise<Built> => {
      const plan = input.plan ?? { saveFault: null, loadFails: false };
      const { store } = await open(env);
      const controlState: ControlStateOptions = {
        store: faulty(store, plan),
        ...(input.startup === undefined ? {} : { startup: input.startup }),
        ...(input.snapshot === undefined ? {} : { snapshot: input.snapshot }),
      };
      const server = createNetworkStorageServer(
        serverOptions({
          controlState,
          projectId: input.projectId,
          settings: input.settings,
          log: input.log,
        }),
      );
      return { server, plan };
    };

    const boot = async (env: ControlEnv, input: BootInput = {}): Promise<Built> => {
      const built = await build(env, input);
      await built.server.ready;
      return built;
    };

    const refused = async (env: ControlEnv, input: BootInput): Promise<void> => {
      const { server } = await build(env, input);
      await assert.rejects(server.ready, ControlStateError);
      const response = await server.fetch(manageRequest("settings", "GET", undefined, input.projectId));
      assert.equal(response.status, 500);
      const body = await response.json() as { error: { code: string } };
      assert.equal(body.error.code, "INTERNAL_ERROR");
    };

    const put = (server: NetworkStorageServer, route: string, body: unknown, projectId?: string): Promise<Response> =>
      server.fetch(manageRequest(route, "PUT", body, projectId));

    const readJson = async (server: NetworkStorageServer, route: string, projectId?: string): Promise<unknown> =>
      (await server.fetch(manageRequest(route, "GET", undefined, projectId))).json();

    const settingsNow = async (server: NetworkStorageServer, projectId?: string) =>
      settingsOf(await readJson(server, "settings", projectId));

    const endpointIds = async (server: NetworkStorageServer, projectId?: string) =>
      idsOf(await readJson(server, "endpoints", projectId));

    // Writes a row for PROJECT, then replaces it with a damaged copy that carries a valid version bump.
    const damage = async (
      env: ControlEnv,
      rewrite: (stored: string) => Promise<{ document: string; checksum: string }>,
    ): Promise<void> => {
      await boot(env);
      const writer = await open(env);
      const row = await writer.store.load(PROJECT);
      if (row === null) throw new Error("expected a control state row to damage");
      await writer.store.save(PROJECT, row.version, { version: row.version + 1, ...(await rewrite(row.document)) });
    };

    it("restores settings and definitions after a reopen", async () => {
      const env = await backend.newLocation();
      const first = await boot(env);
      assert.equal((await put(first.server, "settings", SETTING_ON)).status, 200);
      assert.equal((await put(first.server, "endpoints", [endpointDoc("alpha")])).status, 200);

      const second = await boot(env);
      assert.equal((await settingsNow(second.server))["enableAuthSessions"], true);
      assert.deepEqual(await endpointIds(second.server), ["alpha"]);
    });

    it("gives persisted settings precedence over a different seed and logs the difference", async () => {
      const env = await backend.newLocation();
      const first = await boot(env);
      assert.equal((await put(first.server, "settings", SETTING_ON)).status, 200);

      const logged: unknown[] = [];
      const second = await boot(env, {
        settings: { enableAuthSessions: false, requireAuthSessions: true, encryptedRequestMode: "off" },
        log: (value) => logged.push(value),
      });
      assert.equal((await settingsNow(second.server))["enableAuthSessions"], true);
      assert.match(JSON.stringify(logged), /control-state\.settings-ignored/);
    });

    it("reset replaces persisted state with the seed, and the seed survives the next restart", async () => {
      const env = await backend.newLocation();
      const first = await boot(env);
      assert.equal((await put(first.server, "settings", SETTING_ON)).status, 200);
      assert.equal((await put(first.server, "endpoints", [endpointDoc("gone")])).status, 200);

      const reset = await boot(env, { startup: "reset" });
      assert.equal((await settingsNow(reset.server))["enableAuthSessions"], false);
      assert.deepEqual(await endpointIds(reset.server), []);

      const later = await boot(env);
      assert.equal((await settingsNow(later.server))["enableAuthSessions"], false);
      assert.deepEqual(await endpointIds(later.server), []);
    });

    it("imports an exported snapshot into a fresh location", async () => {
      const env = await backend.newLocation();
      const first = await boot(env);
      assert.equal((await put(first.server, "settings", SETTING_ON)).status, 200);
      assert.equal((await put(first.server, "endpoints", [endpointDoc("exported")])).status, 200);
      const snapshot = await first.server.exportControlState();

      const freshEnv = await backend.newLocation();
      const imported = await boot(freshEnv, { startup: "import", snapshot });
      assert.equal((await settingsNow(imported.server))["enableAuthSessions"], true);
      assert.deepEqual(await endpointIds(imported.server), ["exported"]);

      const restored = await boot(freshEnv);
      assert.deepEqual(await endpointIds(restored.server), ["exported"]);
    });

    it("restores staged definitions and publishes one committed generation", async () => {
      const env = await backend.newLocation();
      const first = await boot(env);
      const publish = (server: NetworkStorageServer, revision: number) =>
        server.fetch(manageRequest("package-sync", "POST", { currentRevisionId: revision }));
      assert.equal((await publish(first.server, 1)).status, 200);
      const staged = manageRequest("endpoints", "PUT", [endpointDoc("pending")]);
      staged.headers.set("x-ns-publish-target", "next");
      assert.equal((await first.server.fetch(staged)).status, 200);

      const plan: FaultPlan = { saveFault: null, loadFails: false };
      const reopened = await boot(env, { plan });
      assert.deepEqual(await endpointIds(reopened.server), []);
      assert.deepEqual(idsOf(await readJson(reopened.server, "endpoints?includeStaged=true")), ["pending"]);
      plan.saveFault = "reject";
      assert.equal((await publish(reopened.server, 2)).status, 500);
      assert.deepEqual(await endpointIds(reopened.server), []);
      const failedPackage = await readJson(reopened.server, "game-package") as { gamePackage: { currentRevisionId: number } };
      assert.equal(failedPackage.gamePackage.currentRevisionId, 1);
      assert.deepEqual(idsOf(await readJson(reopened.server, "endpoints?includeStaged=true")), ["pending"]);

      assert.equal((await publish(reopened.server, 2)).status, 200);
      const restored = await boot(env);
      assert.deepEqual(await endpointIds(restored.server), ["pending"]);
      const promoted = await readJson(restored.server, "endpoints?includeStaged=true") as { data: { revisionTarget?: string }[] };
      assert.equal(promoted.data[0]?.revisionTarget, undefined);
    });

    it("refuses an import without a snapshot", async () => {
      const env = await backend.newLocation();
      await refused(env, { startup: "import" });
    });

    it("refuses an import of a snapshot that belongs to another project", async () => {
      const env = await backend.newLocation();
      const first = await boot(env);
      const snapshot = await first.server.exportControlState();

      const freshEnv = await backend.newLocation();
      await refused(freshEnv, { projectId: OTHER_PROJECT, startup: "import", snapshot });
    });

    it("shows no success for a rejected save and promotes nothing", async () => {
      const env = await backend.newLocation();
      const plan: FaultPlan = { saveFault: null, loadFails: false };
      const first = await boot(env, { plan });

      plan.saveFault = "reject";
      assert.equal((await put(first.server, "settings", SETTING_ON)).status, 500);
      assert.equal((await settingsNow(first.server))["enableAuthSessions"], false);

      plan.saveFault = "reject";
      assert.equal((await put(first.server, "endpoints", [endpointDoc("unsaved")])).status, 500);
      assert.deepEqual(await endpointIds(first.server), []);

      assert.equal((await put(first.server, "settings", SETTING_ON)).status, 200);
      assert.equal((await settingsNow(first.server))["enableAuthSessions"], true);

      const reopened = await boot(env);
      assert.equal((await settingsNow(reopened.server))["enableAuthSessions"], true);
    });

    it("adopts a write that landed before its acknowledgement was lost", async () => {
      const env = await backend.newLocation();
      const plan: FaultPlan = { saveFault: null, loadFails: false };
      const first = await boot(env, { plan });

      plan.saveFault = "land-then-throw";
      assert.equal((await put(first.server, "settings", SETTING_ON)).status, 200);
      assert.equal((await settingsNow(first.server))["enableAuthSessions"], true);

      const reopened = await boot(env);
      assert.equal((await settingsNow(reopened.server))["enableAuthSessions"], true);
    });

    it("fails closed when a lost save cannot be reloaded, and restores the last committed state on restart", async () => {
      const env = await backend.newLocation();
      const plan: FaultPlan = { saveFault: null, loadFails: false };
      const first = await boot(env, { plan });

      plan.saveFault = "reject";
      plan.loadFails = true;
      assert.equal((await put(first.server, "settings", SETTING_ON)).status, 500);
      assert.equal((await first.server.fetch(manageRequest("settings", "GET"))).status, 500);

      const restarted = await boot(env);
      assert.equal((await settingsNow(restarted.server))["enableAuthSessions"], false);
    });

    it("fences out a stale writer through the version check", async () => {
      const env = await backend.newLocation();
      const stale = await boot(env);
      const winner = await boot(env);
      assert.equal((await put(winner.server, "settings", SETTING_ON)).status, 200);

      assert.equal((await put(stale.server, "endpoints", [endpointDoc("stale")])).status, 500);
      assert.equal((await stale.server.fetch(manageRequest("endpoints", "GET"))).status, 500);

      const restarted = await boot(env);
      assert.equal((await settingsNow(restarted.server))["enableAuthSessions"], true);
      assert.deepEqual(await endpointIds(restarted.server), []);
    });

    it("refuses a stored document whose checksum does not match", async () => {
      const env = await backend.newLocation();
      await damage(env, async (stored) => ({ document: stored, checksum: ZERO_CHECKSUM }));
      await refused(env, {});
    });

    it("refuses a stored document that is not JSON", async () => {
      const env = await backend.newLocation();
      await damage(env, async () => {
        const document = "{not json";
        return { document, checksum: await sha256Hex(document) };
      });
      await refused(env, {});
    });

    it("refuses a stored document from an unsupported schema version", async () => {
      const env = await backend.newLocation();
      await damage(env, async (stored) => {
        const parsed: Record<string, unknown> = JSON.parse(stored);
        const document = JSON.stringify({ ...parsed, schemaVersion: 2 });
        return { document, checksum: await sha256Hex(document) };
      });
      await refused(env, {});
    });

    it("refuses malformed security flags instead of loading weaker fallback settings", async () => {
      const env = await backend.newLocation();
      await damage(env, async (stored) => {
        const parsed = JSON.parse(stored) as { settings: { security: Record<string, unknown> } };
        parsed.settings.security["requireAuthSessions"] = "false";
        const document = JSON.stringify(parsed);
        return { document, checksum: await sha256Hex(document) };
      });
      await refused(env, {});
    });

    it("refuses a stored document that belongs to another project", async () => {
      const env = await backend.newLocation();
      await damage(env, async (stored) => {
        const parsed: Record<string, unknown> = JSON.parse(stored);
        const document = JSON.stringify({ ...parsed, projectId: OTHER_PROJECT });
        return { document, checksum: await sha256Hex(document) };
      });
      await refused(env, {});
    });

    it("isolates projects that share one location", async () => {
      const env = await backend.newLocation();
      const alpha = await boot(env);
      assert.equal((await put(alpha.server, "settings", SETTING_ON)).status, 200);
      assert.equal((await put(alpha.server, "endpoints", [endpointDoc("alpha")])).status, 200);

      const other = await boot(env, { projectId: OTHER_PROJECT });
      assert.equal((await settingsNow(other.server, OTHER_PROJECT))["enableAuthSessions"], false);
      assert.deepEqual(await endpointIds(other.server, OTHER_PROJECT), []);
      assert.equal((await put(other.server, "endpoints", [endpointDoc("beta")], OTHER_PROJECT)).status, 200);

      assert.deepEqual(await endpointIds(alpha.server), ["alpha"]);
      assert.deepEqual(await endpointIds(other.server, OTHER_PROJECT), ["beta"]);
    });

    it("keeps acknowledged writes across a real backend process restart", async () => {
      const env = await backend.newLocation();
      assert.equal((await runChild(env, "write")).trim(), "acknowledged");

      const restored: { settings: Record<string, unknown>; endpoints: string[] } = JSON.parse(
        await runChild(env, "read"),
      );
      assert.equal(restored.settings["enableAuthSessions"], true);
      assert.deepEqual(restored.endpoints, ["durable-ping"]);
    });
  });
}
