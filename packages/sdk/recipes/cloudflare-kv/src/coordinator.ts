// Coordinator for createKvStorage (packages/sdk/src/storage/kv.ts). One instance per storage namespace.
// It holds record metadata in its SQLite storage and applies each apply() as one synchronous transaction:
// verify every version check and player limit, then write every op. Payloads stay in KV as blobs.
import { DurableObject } from "cloudflare:workers";
import type {
  CoordinatorCommit,
  CoordinatorCommitResult,
  CoordinatorLiveRecord,
  CoordinatorRecord,
} from "../../../src/storage/kv.js";

// blob_key NULL = tombstone (the version sequence survives deletion). Live means blob_key IS NOT NULL.
const SCHEMA = `CREATE TABLE IF NOT EXISTS ns_records (
  collection TEXT NOT NULL,
  record_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  blob_key TEXT,
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (collection, record_key)
)`;

const UPSERT = `INSERT INTO ns_records (collection, record_key, version, blob_key, updated_at_unix_ms)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (collection, record_key) DO UPDATE SET
    version = excluded.version,
    blob_key = excluded.blob_key,
    updated_at_unix_ms = excluded.updated_at_unix_ms`;

interface MetaRow {
  version: number;
  blob_key: string | null;
}

export class StorageCoordinator extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(SCHEMA);
    });
  }

  read(collection: string, key: string): CoordinatorRecord | null {
    const row = this.ctx.storage.sql
      .exec<MetaRow>("SELECT version, blob_key FROM ns_records WHERE collection = ? AND record_key = ?", collection, key)
      .toArray()[0];
    return row === undefined ? null : { version: row.version, blobKey: row.blob_key };
  }

  countLive(collection: string, playerKey: string): number {
    return this.ctx.storage.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM ns_records WHERE collection = ? AND blob_key IS NOT NULL AND (record_key = ? OR substr(record_key, 1, ?) = ?)",
        collection,
        playerKey,
        playerKey.length + 1,
        `${playerKey}_`,
      )
      .one().n;
  }

  list(collection: string): CoordinatorLiveRecord[] {
    return this.ctx.storage.sql
      .exec<{ record_key: string; version: number; blob_key: string }>(
        "SELECT record_key, version, blob_key FROM ns_records WHERE collection = ? AND blob_key IS NOT NULL",
        collection,
      )
      .toArray()
      .map((row) => ({ key: row.record_key, version: row.version, blobKey: row.blob_key }));
  }

  // Checks and ops run inside transactionSync: all checks run before any write, and a failed check
  // returns without writing, so nothing from this call is applied.
  commit(request: CoordinatorCommit): CoordinatorCommitResult {
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync((): CoordinatorCommitResult => {
      for (const check of request.checks) {
        const current = this.read(check.collection, check.key)?.version ?? 0;
        if (current !== check.version) {
          return { ok: false, reason: `Record ${check.collection}/${check.key} changed (expected version ${check.version}, found ${current}).` };
        }
      }
      for (const limit of request.limits) {
        const count = this.countLive(limit.collection, limit.playerKey);
        if (count !== limit.count) {
          return { ok: false, reason: `Player ${limit.playerKey} record count changed in "${limit.collection}" (expected ${limit.count}, found ${count}).` };
        }
      }

      const superseded: string[] = [];
      const now = Date.now();
      for (const op of request.ops) {
        const previous = this.read(op.collection, op.key);
        if (previous?.blobKey) superseded.push(previous.blobKey);
        if (op.kind === "remove") {
          sql.exec("DELETE FROM ns_records WHERE collection = ? AND record_key = ?", op.collection, op.key);
        } else {
          sql.exec(UPSERT, op.collection, op.key, op.version, op.blobKey, now);
        }
      }
      return { ok: true, superseded };
    });
  }
}
