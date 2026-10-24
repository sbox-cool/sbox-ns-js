// Runs the shared conformance suite against real SQLite files via node:sqlite (Node 22.5+).
// node:sqlite is loaded with createRequire and a typed shape: the installed @types/node does not declare it.
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { createSqliteStorage, type SqliteDatabase } from "../src/storage/index.js";
import { runConformance } from "./storage/conformance.js";

interface NodeSqlite {
  DatabaseSync: new (path: string) => SqliteDatabase & { close(): void };
}

const { DatabaseSync }: NodeSqlite = createRequire(import.meta.url)("node:sqlite");
const dir = mkdtempSync(join(tmpdir(), "ns-storage-sqlite-"));
const databases: { close(): void }[] = [];

after(() => {
  for (const db of databases) db.close();
  rmSync(dir, { recursive: true, force: true });
});

runConformance({
  name: "sqlite",
  persistent: true,
  open: (config, store) => {
    const db = new DatabaseSync(join(dir, `${store}.db`));
    databases.push(db);
    return createSqliteStorage({ ...config, db });
  },
});
