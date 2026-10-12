/**
 * Ordered, individually-named schema migrations.
 *
 * Each entry runs once, in version order, inside a single `BEGIN IMMEDIATE`
 * transaction. The runner (./runner.ts) records `(version, name, applied_at,
 * checksum)` after a successful apply, and refuses to boot if a previously
 * recorded migration's checksum no longer matches its SQL — that is the one
 * invariant an operator can rely on, since the alternative is silent schema
 * drift.
 *
 * The first entry, `bootstrap`, is special: it represents the schema as it
 * existed before this framework shipped. A fresh database applies it
 * normally (it just records the row, since `CREATE TABLE IF NOT EXISTS` in
 * db.ts has already created the tables). A pre-existing database — one
 * whose `schema_migrations` is empty but whose user tables already hold
 * data — records only the bootstrap row and does NOT re-run any later
 * migration, because the prior code path already produced the same effect.
 *
 * New migrations go at the end. Never renumber or delete an existing entry:
 * the checksums of older migrations are stored in production databases and
 * must keep matching forever.
 */

import { createHash } from 'node:crypto';

export interface Migration {
  /** Monotonically increasing integer; no gaps required, but never reused. */
  version: number;
  /** Short snake_case identifier; appears in `schema_migrations.name`. */
  name: string;
  /** SQL to run. May contain multiple statements; one transaction wraps them. */
  sql: string;
}

const bootstrap: Migration = {
  version: 1,
  name: 'bootstrap',
  // No DDL: the SCHEMA / EXTRA_SCHEMA blocks in db.ts already CREATE TABLE IF
  // NOT EXISTS for everything the bootstrap represents. This entry exists only
  // to anchor the migration table at version 1.
  sql: 'SELECT 1',
};

const add_egress_node_id_to_walmart_store: Migration = {
  version: 2,
  name: 'add_egress_node_id_to_walmart_store',
  // W-9: each store binds to a row in egress_node (proxy URL + region). The
  // sweep dials the proxy and reads that store's local rack. Stores with no
  // node fall back to the process's own egress, the pre-federation behaviour.
  //
  // The ALTER is guarded so re-running this entry against a database that
  // already has the column is a no-op (SQLite raises on a duplicate column).
  sql: `ALTER TABLE walmart_store ADD COLUMN egress_node_id TEXT`,
};

const add_poll_run_request_columns: Migration = {
  version: 3,
  name: 'add_poll_run_request_columns',
  // O-2: per-run request count + byte total so the metrics endpoint can
  // report both without scanning request_log. request_log is pruned at 14
  // days (metrics.ts:54), so it cannot answer a 30-day question on its own.
  sql: [
    `ALTER TABLE poll_run ADD COLUMN requests INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE poll_run ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0`,
  ].join(';\n'),
};

const add_snapshot_run_request_columns: Migration = {
  version: 4,
  name: 'add_snapshot_run_request_columns',
  // O-2: same shape for the nightly snapshot job. snapshot_run.bytes is
  // aggregated from request_log.bytes by repo.finishSnapshotRun.
  sql: [
    `ALTER TABLE snapshot_run ADD COLUMN requests INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE snapshot_run ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0`,
  ].join(';\n'),
};

const add_backup_log_table: Migration = {
  version: 5,
  name: 'add_backup_log_table',
  // Nightly backup bookkeeping. One row per artifact produced (VACUUM INTO
  // file, each Parquet file). The retention rotation consults this table
  // rather than reading the filesystem, so a deleted file is visible.
  sql: [
    `CREATE TABLE IF NOT EXISTS backup_log (
       id          INTEGER PRIMARY KEY,
       started_at  TEXT NOT NULL,
       finished_at TEXT,
       kind        TEXT NOT NULL,
       path        TEXT NOT NULL,
       bytes       INTEGER NOT NULL DEFAULT 0,
       rows        INTEGER,
       error       TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS backup_log_started ON backup_log (started_at DESC)`,
  ].join(';\n'),
};

/**
 * The full, ordered list. Append new migrations at the end; never reorder.
 *
 * The runner walks this array sequentially, applying anything whose version
 * is greater than the largest version already in `schema_migrations`. Each
 * entry's checksum is recorded alongside; the runner aborts boot if any
 * previously recorded checksum no longer matches its SQL.
 */
export const MIGRATIONS: readonly Migration[] = [
  bootstrap,
  add_egress_node_id_to_walmart_store,
  add_poll_run_request_columns,
  add_snapshot_run_request_columns,
  add_backup_log_table,
];

/**
 * Stable hex SHA-256 of a migration's SQL string. The runner records this
 * alongside each applied row and re-checks every entry on every boot, so a
 * hand-edited SQL string in this file trips the checksum guard rather than
 * silently changing the schema for new boots.
 */
export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}