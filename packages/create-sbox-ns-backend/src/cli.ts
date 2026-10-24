#!/usr/bin/env node
import { parseArgs } from "node:util";
import { scaffoldBackend } from "./scaffold.js";

const USAGE = `Usage: create-sbox-ns-backend <dir> [options]

Creates a runnable sbox-ns backend in <dir>.

Options:
  --project-id <id>     Project id (default: generated)
  --public-key <key>    Public key for the game's Configure line (default: generated)
  --secret-key <key>    Secret key, written to .env only (default: generated)
  --base-url <url>      Public URL of the backend (default: http://localhost:<port>)
  --port <port>         Local port (default: 8080)
  -h, --help            Show this help
`;

function main(argv: readonly string[]): number {
  const parsed = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      "project-id": { type: "string" },
      "public-key": { type: "string" },
      "secret-key": { type: "string" },
      "base-url": { type: "string" },
      port: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (parsed.values.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }
  const [dir, ...extra] = parsed.positionals;
  if (dir === undefined || extra.length > 0) {
    process.stderr.write(USAGE);
    return 2;
  }

  const port = parsed.values.port === undefined ? undefined : Number(parsed.values.port);
  if (port !== undefined && !Number.isInteger(port)) {
    process.stderr.write("--port must be an integer.\n");
    return 2;
  }

  const result = scaffoldBackend({
    dir,
    projectId: parsed.values["project-id"],
    publicKey: parsed.values["public-key"],
    secretKey: parsed.values["secret-key"],
    baseUrl: parsed.values["base-url"],
    port,
  });

  process.stdout.write(
    [
      "Created sbox-ns backend in " + result.dir,
      "",
      "Add this line to your game once (also saved in configure.txt):",
      "  " + result.configureLine,
      "",
      "The secret key is in .env (mode 0600). It is not printed and must not go in game code.",
      "",
      "Next:",
      "  cd " + dir,
      "  bun install && bun run dev      (or: npm install && npm run build && npm start)",
      "  npm test",
      "",
    ].join("\n"),
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
