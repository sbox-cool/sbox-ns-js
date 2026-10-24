import { createServer } from "node:http";
import { nodeHandler } from "../../src/adapters/node.js";
import { createNetworkStorageServer } from "../../src/server/index.js";
import { referenceOptions } from "../parity/reference-backend.js";

// The shared endpoint run starts this backend with one project secret. The reference server gets the same name and
// value through its dashboard (scripts/shared-endpoints.sh), so `ns.secrets.get` must return the same answer on both.
export function sharedSecretStore(name: string, value: string): { get(key: string): string | null } {
  return { get: (key) => (key === name ? value : null) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env["SHARED_PORT"] ?? 18812);
  const name = process.env["SHARED_SECRET_NAME"] ?? "shared_token";
  const value = process.env["SHARED_SECRET_VALUE"] ?? "";
  if (value === "") throw new Error("SHARED_SECRET_VALUE must be set");
  const options = { ...referenceOptions(), secrets: sharedSecretStore(name, value) };
  createServer(nodeHandler(createNetworkStorageServer(options))).listen(port, "127.0.0.1", () => {
    console.log(`shared endpoint backend listening on http://127.0.0.1:${port}`);
  });
}
