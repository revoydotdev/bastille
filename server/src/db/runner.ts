/**
 * Migration runner.
 *
 * `applyMigrations(db, MIGRATIONS)` is called once at boot, after the SCHEMA
 * and EXTRA_SCHEMA blocks in db.ts have created every table (or no-op'd on a
 * pre-existing DB). The runner:
 *
 *   1. Ensures `schema_migrations(version, name, applied_at, checksum)` exists.
 *   2. Verifies the checksum of every previously recorded row matches the
 *      SQL of its MIGRATIONS entry. A mismatch is a hard failure — silent
 *      schema drift is worse than a refused boot.
 *   3. Applies every migration whose version is not yet recorded, each
 *      inside its own `BEGIN IMMEDIATE` transaction. On error, ROLLBACK and
 *      abort boot.
 *   4. If a migration fails because the column it tries to add already
 *      exists ("duplicate column name: ..."), the runner treats it as
 *      "already applied" and records the row without re-running the SQL.
 *      This is the natural signal that the schema is older than the
 *      migration framework: the old `ADDED_COLUMNS` path produced the same
 *      effect before this framework existed. SQLite's error wording is
 *      stable across versions and the check is narrow.
 *
 * The runner is intentionally explicit. There is no down-path: a
 * forward-only migration is the right default for a single-operator local
 * app, and a "down" feature is debt with nothing to recommend it.
 */

import type { DB } from '../db.js';
import { MIGRATIONS, migrationChecksum, type Migration } from './migrations.js';

const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  checksum   TEXT NOT NULL
)
`;

export interface ApplyResult {
  /** Migrations applied during this call (newly recorded rows). */
  applied: { version: number; name: string; checksum: string }[];
  /** true when a previously-applied column was detected (adopt-existing). */
  adoptedExistingSchema: boolean;
  /** The largest version recorded after the runner returned. */
  headVersion: number;
}

interface RecordedRow {
  version: number;
  name: string;
  applied_at: string;
  checksum: string;
}

/**
 * SQLite raises "duplicate column name: <name>" when an `ALTER TABLE ADD
 * COLUMN` targets a column that already exists. We use that signal to mark
 * a migration as adopted without re-running its DDL, so pre-existing
 * databases that pre-date the framework boot cleanly on the second run.
 *
 * The wording is stable across every SQLite release shipped in Node 22 LTS;
 * "duplicate column name" appears in the official error table and does not
 * appear in any other normal `ALTER TABLE` failure.
 */
function isDuplicateColumnError(err: unknown): boolean {
  return err instanceof Error && /duplicate column name/i.test(err.message);
}

export class MigrationChecksumError extends Error {
  override readonly name = 'MigrationChecksumError';
  readonly version: number;
  readonly migrationName: string;
  readonly expected: string;
  readonly actual: string;
  constructor(version: number, name: string, expected: string, actual: string) {
    super(
      `Migration ${version} (${name}) checksum mismatch: recorded=${expected} actual=${actual}. ` +
        `The migration SQL has changed since this database was last booted. ` +
        `Refusing to start to avoid silent schema drift.`,
    );
    this.version = version;
    this.migrationName = name;
    this.expected = expected;
    this.actual = actual;
  }
}

export class MigrationOrderingError extends Error {
  override readonly name = 'MigrationOrderingError';
  readonly expected: number;
  readonly actual: number;
  constructor(expected: number, actual: number) {
    super(
      `Migrations are out of order: the next pending version should be ${expected} ` +
        `but the MIGRATIONS array has version ${actual}. Append new migrations at the ` +
        `end of MIGRATIONS; never renumber or remove existing entries.`,
    );
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Apply pending migrations. Safe to call repeatedly; each call is idempotent.
 *
 * @param db   an open DatabaseSync.
 * @param list the migration list (defaults to MIGRATIONS, exported for tests).
 */
export function applyMigrations(db: DB, list: readonly Migration[] = MIGRATIONS): ApplyResult {
  db.exec(SCHEMA_MIGRATIONS_DDL);

  const recorded = db
    .prepare('SELECT version, name, applied_at, checksum FROM schema_migrations ORDER BY version ASC')
    .all() as unknown as RecordedRow[];
  const recordedByVersion = new Map<number, RecordedRow>(recorded.map((r) => [r.version, r]));

  // Step 1: verify the checksum of every recorded row. A mismatch is a hard
  // failure; the operator must intervene before boot can proceed.
  for (const row of recorded) {
    const def = list.find((m) => m.version === row.version);
    if (!def) {
      // A row in the table whose version no longer exists in MIGRATIONS is
      // the same kind of drift: someone edited the list. Fail.
      throw new MigrationOrderingError(row.version, -1);
    }
    const expected = migrationChecksum(def.sql);
    if (row.checksum !== expected) {
      throw new MigrationChecksumError(row.version, row.name, row.checksum, expected);
    }
  }

  const applied: ApplyResult['applied'] = [];
  let adoptedExistingSchema = false;
  const insertRow = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)',
  );

  // Step 2: apply any pending migration, in version order. Each in its own
  // BEGIN IMMEDIATE so a failure mid-way leaves a consistent state behind.
  for (const def of list) {
    if (recordedByVersion.has(def.version)) continue;

    const head = recorded.length + applied.length;
    if (def.version !== head + 1) {
      throw new MigrationOrderingError(head + 1, def.version);
    }

    const checksum = migrationChecksum(def.sql);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(def.sql);
      insertRow.run(def.version, def.name, new Date().toISOString(), checksum);
      db.exec('COMMIT');
      applied.push({ version: def.version, name: def.name, checksum });
    } catch (err) {
      db.exec('ROLLBACK');
      if (isDuplicateColumnError(err)) {
        // The schema pre-dates this migration: ADDED_COLUMNS (or some other
        // pre-framework path) already produced the column. Record the row
        // so subsequent boots skip cleanly.
        adoptedExistingSchema = true;
        db.exec('BEGIN IMMEDIATE');
        try {
          insertRow.run(def.version, def.name, new Date().toISOString(), checksum);
          db.exec('COMMIT');
          applied.push({ version: def.version, name: def.name, checksum });
        } catch (err2) {
          db.exec('ROLLBACK');
          throw err2;
        }
      } else {
        throw err;
      }
    }
  }

  const headVersion = applied.length > 0
    ? applied[applied.length - 1]!.version
    : (recorded.length > 0 ? recorded[recorded.length - 1]!.version : 0);

  return { applied, adoptedExistingSchema, headVersion };
}