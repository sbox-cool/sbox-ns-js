// Runs the shared conformance suite against real SQLite files via bun:sqlite, through the generic SqliteDatabase adapter.
// bun:sqlite exists only under Bun, so the suite is skipped under Node (node:sqlite covers Node).
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { createSqliteStorage, type SqliteDatabase } from "../src/storage/index.js";
import { runConformance } from "./storage/conformance.js";

interface BunSqlite {
  Database: new (path: string) => SqliteDatabase & { close(): void };
}

const skip = process.versions.bun === undefined ? "bun:sqlite is only available under Bun" : undefined;
const dir = mkdtempSync(join(tmpdir(), "ns-storage-bun-sqlite-"));
const databases: { close(): void }[] = [];

after(() => {
  for (const db of databases) db.close();
  rmSync(dir, { recursive: true, force: true });
});

runConformance({
  name: "bun:sqlite",
  persistent: true,
  skip,
  open: (config, store) => {
    const { Database }: BunSqlite = createRequire(import.meta.url)("bun:sqlite");
    const db = new Database(join(dir, `${store}.db`));
    databases.push(db);
    return createSqliteStorage({ ...config, db });
  },
});
