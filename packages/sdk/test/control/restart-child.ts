import { createNetworkStorageServer } from "../../src/server/index.js";
import { endpointDoc, idsOf, manageRequest, serverOptions, settingsOf } from "./fixture.js";
import { openStore } from "./stores.js";

// Child process for the real-restart test. "write" commits settings and an endpoint, acknowledges them, then exits
// without closing the store, so only durability can carry them to the next process. "read" starts a fresh backend over
// the same location and prints what it serves, as JSON, on stdout.
const action = process.env["NS_CONTROL_ACTION"];
const opened = await openStore(process.env);
const server = createNetworkStorageServer(serverOptions({ controlState: { store: opened.store } }));

if (action === "write") {
  const settings = await server.fetch(
    manageRequest("settings", "PUT", { enableAuthSessions: true, requireSboxAuth: true }),
  );
  const endpoint = await server.fetch(manageRequest("endpoints", "PUT", [endpointDoc("durable-ping")]));
  if (settings.status !== 200 || endpoint.status !== 200) {
    process.stderr.write(`write refused: settings ${settings.status}, endpoints ${endpoint.status}\n`);
    process.exit(2);
  }
  process.stdout.write("acknowledged\n");
  process.exit(0);
}

if (action === "read") {
  const settings = await server.fetch(manageRequest("settings", "GET"));
  const endpoints = await server.fetch(manageRequest("endpoints", "GET"));
  const result = { settings: settingsOf(await settings.json()), endpoints: idsOf(await endpoints.json()) };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  await opened.close();
  process.exit(0);
}

throw new Error(`NS_CONTROL_ACTION must be "write" or "read", got ${String(action)}`);
