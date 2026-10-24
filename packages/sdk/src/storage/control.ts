import type { PgPool } from "./postgres.js";
import type { SqliteDatabase } from "./sqlite.js";
import type { SqlValue } from "./sql.js";

// The durable control-state document for one project: managed settings, the definitions catalog, and the staged
// revision. The server owns the document format (server/control-state.ts); this layer only stores and versions
// the serialized text, so it stays independent of the catalog shape.
export interface ControlStateRow {
  // Monotonic per project. A save succeeds only when the stored version is the one the caller read.
  readonly version: number;
  readonly document: string;
  // Hex SHA-256 of `document`, verified by the server on every load.
  readonly checksum: string;
}

// The compare-and-set failed: the stored version is not the expected one. Nothing was written.
export class ControlStateConflict extends Error {
  constructor(projectId: string) {
    super(`Control state for project ${projectId} changed underneath this writer; nothing was written.`);
    this.name = "ControlStateConflict";
  }
}

// Persists one control-state document per project. `save` resolves only after the write is durable.
// `expectedVersion` is 0 when no row exists yet.
export interface ControlStateStore {
  load(projectId: string): Promise<ControlStateRow | null>;
  save(projectId: string, expectedVersion: number, row: ControlStateRow): Promise<void>;
}

const TABLE = "ns_control_state";

const INSERT_SQL = `INSERT INTO ${TABLE} (project_id, version, checksum, document) VALUES (?, ?, ?, ?) ON CONFLICT (project_id) DO NOTHING RETURNING version`;
const UPDATE_SQL = `UPDATE ${TABLE} SET version = ?, checksum = ?, document = ? WHERE project_id = ? AND version = ? RETURNING version`;
const SELECT_SQL = `SELECT version, checksum, document FROM ${TABLE} WHERE project_id = ?`;

const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS ${TABLE} (
  project_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  document TEXT NOT NULL
)`;

function rowOf(raw: unknown): ControlStateRow | null {
  if (raw === undefined || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const version = record["version"];
  const checksum = record["checksum"];
  const document = record["document"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new Error("Control state row has an invalid version.");
  }
  if (typeof checksum !== "string" || typeof document !== "string") {
    throw new Error("Control state row is malformed.");
  }
  return { version, checksum, document };
}

// The SQLite store takes a database it owns: the connection must not be shared with a records transaction, because
// the save runs BEGIN IMMEDIATE. The store sets `synchronous = FULL` so an acknowledged commit survives power loss.
export function createSqliteControlStateStore(options: { db: SqliteDatabase }): ControlStateStore {
  const { db } = options;
  db.exec("PRAGMA synchronous = FULL");
  db.exec(SCHEMA_SQL);
  return {
    async load(projectId) {
      return rowOf(db.prepare(SELECT_SQL).all(projectId)[0]);
    },
    async save(projectId, expectedVersion, row) {
      db.exec("BEGIN IMMEDIATE");
      let open = true;
      try {
        const params: SqlValue[] =
          expectedVersion === 0
            ? [projectId, row.version, row.checksum, row.document]
            : [row.version, row.checksum, row.document, projectId, expectedVersion];
        const written = db.prepare(expectedVersion === 0 ? INSERT_SQL : UPDATE_SQL).all(...params);
        if (written.length !== 1) throw new ControlStateConflict(projectId);
        db.exec("COMMIT");
        open = false;
      } finally {
        if (open) db.exec("ROLLBACK");
      }
    },
  };
}

// The PostgreSQL store takes a pool and runs each save on a dedicated client in one transaction with
// `synchronous_commit = on`, so the commit is acknowledged only after it is flushed.
export function createPostgresControlStateStore(options: { pool: PgPool }): ControlStateStore {
  const { pool } = options;
  let schema: Promise<void> | null = null;
  const ensureSchema = (): Promise<void> => {
    schema ??= pool.query(SCHEMA_SQL).then(() => undefined);
    return schema;
  };
  return {
    async load(projectId) {
      await ensureSchema();
      const result = await pool.query(toNumbered(SELECT_SQL), [projectId]);
      return rowOf(result.rows[0]);
    },
    async save(projectId, expectedVersion, row) {
      await ensureSchema();
      const client = await pool.connect();
      let open = false;
      try {
        await client.query("BEGIN");
        open = true;
        await client.query("SET LOCAL synchronous_commit TO on");
        const sql = expectedVersion === 0 ? INSERT_SQL : UPDATE_SQL;
        const params: SqlValue[] =
          expectedVersion === 0
            ? [projectId, row.version, row.checksum, row.document]
            : [row.version, row.checksum, row.document, projectId, expectedVersion];
        const written = await client.query(toNumbered(sql), params);
        if (written.rows.length !== 1) throw new ControlStateConflict(projectId);
        await client.query("COMMIT");
        open = false;
      } catch (error) {
        if (open) await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

// Rewrites each `?` placeholder to `$n`. The statements here contain no literal `?`.
function toNumbered(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}
