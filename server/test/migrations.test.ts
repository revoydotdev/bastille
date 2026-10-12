/**
 * Migration runner tests.
 *
 * Three things the runner has to do, and we want each pinned by an explicit
 * test:
 *
 *   1. A fresh DB gets both migrations applied, and both rows are recorded
 *      with the SQL checksum.
 *   2. A second `applyMigrations` call is a clean no-op: nothing new is
 *      applied, the recorded row count is unchanged.
 *   3. If a previously recorded migration's SQL has been edited out from
 *      under us, the runner refuses to boot — a checksum mismatch throws
 *      `MigrationChecksumError`.
 *
 * Plus: the in-source MIGRATIONS array should apply cleanly against a fresh
 * in-memory database with the SCHEMA + EXTRA_SCHEMA blocks from db.ts. That
 * is the whole end-to-end path the server takes on first boot.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { BackupService } from '../src/backup/index.js';
import { applyMigrations, MigrationChecksumError } from '../src/db/runner.js';
import { MIGRATIONS, migrationChecksum, type Migration } from '../src/db/migrations.js';

function freshDB(): DatabaseSync {
  return new DatabaseSync(':memory:');
}

function minimalSchema(db: DatabaseSync): void {
  // The smallest pre-migration schema the runner can adopt. `walmart_store`
  // is the probe table for the adopt-existing-schema path.
  db.exec(`
    CREATE TABLE walmart_store (location_id TEXT PRIMARY KEY, name TEXT NOT NULL);
  `);
}

test('a fresh DB has both migrations applied and both rows recorded', () => {
  const db = freshDB();
  minimalSchema(db);
  try {
    const list: Migration[] = [
      { version: 1, name: 'one', sql: `ALTER TABLE walmart_store ADD COLUMN one TEXT` },
      { version: 2, name: 'two', sql: `ALTER TABLE walmart_store ADD COLUMN two TEXT` },
    ];
    const result = applyMigrations(db, list);
    assert.deepEqual(result.applied.map((a) => a.version), [1, 2]);
    const rows = db
      .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
      .all() as { version: number; name: string; checksum: string }[];
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.version), [1, 2]);
    assert.equal(rows[0]!.checksum, migrationChecksum(list[0]!.sql));
    assert.equal(rows[1]!.checksum, migrationChecksum(list[1]!.sql));
    const cols = db.prepare("SELECT name FROM pragma_table_info('walmart_store') ORDER BY name").all() as { name: string }[];
    assert.deepEqual(cols.map((c) => c.name).sort(), ['location_id', 'name', 'one', 'two']);
  } finally {
    db.close();
  }
});

test('a second applyMigrations call is a clean no-op', () => {
  const db = freshDB();
  minimalSchema(db);
  try {
    const list: Migration[] = [
      { version: 1, name: 'one', sql: `ALTER TABLE walmart_store ADD COLUMN one TEXT` },
      { version: 2, name: 'two', sql: `ALTER TABLE walmart_store ADD COLUMN two TEXT` },
    ];
    const first = applyMigrations(db, list);
    assert.equal(first.applied.length, 2);
    const second = applyMigrations(db, list);
    assert.deepEqual(second.applied, [], 'no migrations applied on second run');
    const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[];
    assert.equal(rows.length, 2, 'still only two recorded rows');
    assert.equal(second.headVersion, 2);
  } finally {
    db.close();
  }
});

test('a checksum mismatch between recorded SQL and current SQL aborts boot', () => {
  const db = freshDB();
  minimalSchema(db);
  try {
    const list: Migration[] = [
      { version: 1, name: 'one', sql: `ALTER TABLE walmart_store ADD COLUMN one TEXT` },
      { version: 2, name: 'two', sql: `ALTER TABLE walmart_store ADD COLUMN two TEXT` },
    ];
    applyMigrations(db, list);
    // Simulate a developer editing the SQL out from under us: the recorded
    // checksum stays the same, but the list's checksum is now different.
    const mutated: Migration[] = [
      { version: 1, name: 'one', sql: `ALTER TABLE walmart_store ADD COLUMN one TEXT` },
      { version: 2, name: 'two', sql: `ALTER TABLE walmart_store ADD COLUMN two_with_a_change TEXT` },
    ];
    assert.throws(
      () => applyMigrations(db, mutated),
      (err: unknown) => err instanceof MigrationChecksumError && err.version === 2 && err.migrationName === 'two',
    );
  } finally {
    db.close();
  }
});

test('on an empty schema_migrations, a pre-existing column is adopted without re-running', () => {
  const db = freshDB();
  try {
    // Simulate the pre-existing-DB state: schema is already at v2's effect
    // (the egress_node_id column was added by the old ADDED_COLUMNS path).
    db.exec(`
      CREATE TABLE walmart_store (
        location_id TEXT PRIMARY KEY,
        egress_node_id TEXT
      );
    `);
    const list: Migration[] = [
      { version: 1, name: 'one', sql: `ALTER TABLE walmart_store ADD COLUMN one TEXT` },
      { version: 2, name: 'two', sql: `ALTER TABLE walmart_store ADD COLUMN egress_node_id TEXT` },
      { version: 3, name: 'three', sql: `ALTER TABLE walmart_store ADD COLUMN three TEXT` },
    ];
    const result = applyMigrations(db, list);
    // v2's effect was already present (egress_node_id existed), so it was
    // adopted; v1 and v3 ran normally.
    assert.deepEqual(result.applied.map((a) => a.version), [1, 2, 3]);
    assert.equal(result.adoptedExistingSchema, true);
    const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[];
    assert.equal(rows.length, 3);
  } finally {
    db.close();
  }
});

test('the in-source MIGRATIONS array applies cleanly against a fresh schema', () => {
  // This is the full path openDB runs: SCHEMA + EXTRA_SCHEMA + applyMigrations.
  // We use openDb so a real schema file is laid down and the migrations
  // exercise every ALTER + CREATE they touch.
  const dir = mkdtempSync(join(tmpdir(), 'bastille-mig-'));
  const dbPath = join(dir, 't.db');
  try {
    const db = openDb(dbPath);
    try {
      const rows = db
        .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
        .all() as { version: number; name: string; checksum: string }[];
      assert.deepEqual(
        rows.map((r) => r.version),
        MIGRATIONS.map((m) => m.version),
        'every migration in MIGRATIONS is recorded on a fresh DB',
      );
      for (const row of rows) {
        const def = MIGRATIONS.find((m) => m.version === row.version)!;
        assert.equal(row.checksum, migrationChecksum(def.sql), `checksum matches for v${row.version}`);
        assert.equal(row.name, def.name);
      }
      const count = (db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number }).c;
      assert.ok(count >= 5, 'at least five migrations recorded (v1 bootstrap + W-9 + O-2 cols + backup_log)');

      // Re-running applyMigrations is a no-op.
      const second = applyMigrations(db);
      assert.equal(second.applied.length, 0);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('VACUUM INTO produces a valid SQLite file readable by a fresh handle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bastille-vac-'));
  const dbPath = join(dir, 't.db');
  let db: DatabaseSync | null = null;
  try {
    db = openDb(dbPath);
    db.prepare('INSERT INTO bastille_meta (key, value) VALUES (?, ?)').run('K', 'V');
    const bs = new BackupService({ db, dataDir: join(dir, 'data'), keep: 3 });
    const result = await bs.runOnce();
    const vacuum = result.artifacts.find((a) => a.kind === 'vacuum')!;
    assert.ok(vacuum, 'a vacuum artifact was produced');
    assert.ok(vacuum.bytes > 0, 'vacuum file is non-empty');
    assert.ok(!result.errors.find((e) => e.startsWith('vacuum')), 'no vacuum error');

    // Open the backup file with a fresh handle and assert the meta row is there.
    const backupDb = new DatabaseSync(vacuum.path);
    try {
      const r = backupDb.prepare('SELECT value FROM bastille_meta WHERE key = ?').get('K') as { value: string } | undefined;
      assert.equal(r?.value, 'V', 'backup file answers a store query');
    } finally {
      backupDb.close();
    }
  } finally {
    if (db) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the Parquet export produces non-empty files readable by hyparquet', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { parquetMetadataAsync, parquetReadObjects } = await import('hyparquet');
  const dir = mkdtempSync(join(tmpdir(), 'bastille-pq-'));
  const dbPath = join(dir, 't.db');
  let db: DatabaseSync | null = null;
  try {
    db = openDb(dbPath);
    db.prepare(
      `INSERT INTO daily_snapshot (snapshot_date, captured_at, store_id, location_id,
         store_product_id, name, brand, size, category, image_url, product_url,
         regular_cents, current_cents, effective_unit_cents, discount_pct, promo_kind,
         promo_text, unit_price_text, in_stock)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      '2026-10-12', '2026-10-12T03:00:00.000Z', 'wegmans', '100',
      'sku-001', 'milk', 'trader joe', '1 gal', 'dairy', null, null,
      500, 350, 350 / 128, 30, 'discount', null, '$0.27/oz', 1,
    );
    const bs = new BackupService({ db, dataDir: join(dir, 'data'), keep: 3 });
    const result = await bs.runOnce();
    const parquetArtifacts = result.artifacts.filter((a) => a.kind === 'parquet');
    assert.ok(parquetArtifacts.length >= 3, 'one parquet file per source table');
    for (const art of parquetArtifacts) {
      assert.ok(existsSync(art.path), `${art.path} exists`);
      assert.ok(art.bytes > 0, `${art.path} is non-empty (${art.bytes} bytes)`);
      // hyparquet is the read side of the same library we wrote with; if
      // the file parses here, every other Parquet reader will too.
      const buf = readFileSync(art.path);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      const meta = await parquetMetadataAsync(ab);
      assert.ok(meta, `metadata is parseable for ${art.path}`);
      const rows = await parquetReadObjects({ file: ab });
      assert.ok(Array.isArray(rows), `parquetReadObjects returns an array for ${art.path}`);
      if (art.path.endsWith('daily_snapshot.parquet')) {
        assert.equal(rows.length, 1, 'daily_snapshot.parquet has one row');
        const first = rows[0] as Record<string, unknown>;
        assert.equal(first['store_id'], 'wegmans');
        // hyparquet-writer stores INT64 as BigInt; coerce for the strict
        // assertion so the comparison is by value, not type.
        assert.equal(Number(first['current_cents']), 350);
      }
    }
    const manifestPath = join(dir, 'data', 'archive', '2026-10-12', 'manifest.json');
    assert.ok(existsSync(manifestPath), 'manifest.json side-car exists');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.schemaVersion, 1);
    assert.deepEqual(manifest.tables.sort(), ['daily_snapshot', 'price_point', 'product']);
  } finally {
    if (db) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});