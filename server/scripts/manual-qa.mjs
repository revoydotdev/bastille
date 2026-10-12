// Manual QA: exercise the migration runner on a fresh in-memory DB and run a
// real backup cycle (VACUUM INTO + Parquet export) against a populated DB.
// Output is captured into the task-4 evidence file; the Parquet files are
// kept under .omo/evidence/wave-A/parquet-export/.
//
// This is NOT a test file. It is the manual QA harness required by the todo:
// "A captured terminal run of the migration runner against a fresh in-memory
// database, AND a real run of VACUUM INTO + Parquet export against a
// populated database."

import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.ts';
import { applyMigrations } from '../src/db/runner.ts';
import { MIGRATIONS, migrationChecksum } from '../src/db/migrations.ts';
import { BackupService } from '../src/backup/index.ts';
import { parquetReadObjects, parquetMetadataAsync } from 'hyparquet';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// /home/revelri/src/revoydotdev/public/bastille-wt/wave-A/migrations/server/scripts → /home/revelri/hex/.omo/...
const evidenceRoot = resolve(__dirname, '../../../../../../../../', 'hex/.omo/evidence/wave-A/parquet-export');
mkdirSync(evidenceRoot, { recursive: true });

function hr(label) {
  console.log('\n========== ' + label + ' ==========');
}

hr('PART 1 — Migration runner on a fresh in-memory database');
// Use openDb(':memory:') so the SCHEMA + EXTRA_SCHEMA blocks lay down the
// pre-migration tables the migrations expect to alter.
const fresh = openDb(':memory:');
const result1 = applyMigrations(fresh);
console.log('Applied versions:', result1.applied.map((a) => a.version));
console.log('Adopted existing schema:', result1.adoptedExistingSchema);
console.log('Head version:', result1.headVersion);
const recorded = fresh.prepare('SELECT version, name, applied_at, checksum FROM schema_migrations ORDER BY version').all();
console.log('Recorded rows:');
for (const row of recorded) console.log('  v' + row.version + ' (' + row.name + ') checksum=' + row.checksum.slice(0, 12) + '...');
console.log('In-source migrations:');
for (const m of MIGRATIONS) console.log('  v' + m.version + ' (' + m.name + ') sql-checksum=' + migrationChecksum(m.sql).slice(0, 12) + '...');
const allMatch = recorded.every((row) => row.checksum === migrationChecksum(MIGRATIONS.find((m) => m.version === row.version).sql));
console.log('All checksums match:', allMatch);
fresh.close();

hr('PART 2 — Re-running the runner is a no-op');
const fresh2 = openDb(':memory:');
applyMigrations(fresh2);
const before = fresh2.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get().c;
const result2 = applyMigrations(fresh2);
const after = fresh2.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get().c;
console.log('Applied on second run:', result2.applied.length, '(expected: 0)');
console.log('Rows before:', before, 'Rows after:', after, '(expected equal)');
fresh2.close();

hr('PART 3 — Real VACUUM INTO + Parquet export on a populated DB');
const dir = mkdtempSync(join(tmpdir(), 'bastille-manual-'));
const dbPath = join(dir, 't.db');
const db = openDb(dbPath);
db.prepare('INSERT INTO bastille_meta (key, value) VALUES (?, ?)').run('pre_backup_marker', 'yes');

db.prepare(
  `INSERT INTO daily_snapshot (snapshot_date, captured_at, store_id, location_id,
     store_product_id, name, brand, size, category, image_url, product_url,
     regular_cents, current_cents, effective_unit_cents, discount_pct, promo_kind,
     promo_text, unit_price_text, in_stock)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  '2026-10-12', '2026-10-12T03:00:00.000Z', 'wegmans', '100',
  'sku-001', 'milk', 'trader joe', '1 gal', 'dairy', null, null,
  500, 350, 27, 30, 'discount', null, '$0.27/oz', 1,
);
db.prepare('INSERT INTO product (store_id, store_product_id, name, brand, size, image_url, product_url, category, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
  'wegmans', 'sku-001', 'milk', 'trader joe', '1 gal', null, null, 'dairy',
  '2026-10-12T03:00:00.000Z', '2026-10-12T03:00:00.000Z',
);
db.prepare('INSERT INTO price_point (product_id, location_id, captured_at, regular_cents, current_cents, effective_unit_cents, promo_kind, promo_text, promo_detail_json, unit_price_text, in_stock) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
  1, '100', '2026-10-12T03:00:00.000Z', 500, 350, 27, 'discount', null, null, '$0.27/oz', 1,
);

const bs = new BackupService({ db, dataDir: join(dir, 'data'), keep: 3 });
const result = await bs.runOnce();

console.log('Backup result:');
console.log('  startedAt:', result.startedAt);
console.log('  finishedAt:', result.finishedAt);
console.log('  errors:', result.errors);
console.log('  artifacts:');
for (const a of result.artifacts) {
  console.log('    -', a.kind, a.path, '(' + a.bytes + ' bytes, ' + a.rows + ' rows)' + (a.error ? ' ERROR=' + a.error : ''));
}

hr('PART 4 — Verify VACUUM INTO backup round-trip');
const vacuum = result.artifacts.find((a) => a.kind === 'vacuum');
const backupDb = new DatabaseSync(vacuum.path);
const marker = backupDb.prepare('SELECT value FROM bastille_meta WHERE key = ?').get('pre_backup_marker');
console.log('Backup file answers query:', marker.value === 'yes' ? 'PASS' : 'FAIL', '(' + JSON.stringify(marker) + ')');
backupDb.close();

hr('PART 5 — Verify Parquet export readable by hyparquet');
for (const a of result.artifacts.filter((x) => x.kind === 'parquet')) {
  const buf = readFileSync(a.path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const meta = await parquetMetadataAsync(ab);
  const rows = await parquetReadObjects({ file: ab });
  console.log(a.path.split('/').pop(), '- schema fields:', Object.keys(meta.schema || {}).length, '- data rows:', rows.length);
  if (rows.length > 0) {
    const first = rows[0];
    console.log('  first row sample:', JSON.stringify(first, (_, v) => typeof v === 'bigint' ? Number(v) : v));
  }
}

hr('PART 6 — Copy artifacts to .omo/evidence/wave-A/parquet-export/');
for (const a of result.artifacts) {
  const fname = a.path.split('/').pop();
  copyFileSync(a.path, join(evidenceRoot, fname));
  console.log('copied', fname, '(' + statSync(join(evidenceRoot, fname)).size + ' bytes)');
}
const dayDir = join(dir, 'data', 'archive', '2026-10-12');
if (existsSync(join(dayDir, 'manifest.json'))) {
  copyFileSync(join(dayDir, 'manifest.json'), join(evidenceRoot, 'manifest.json'));
  console.log('copied manifest.json');
}

db.close();
rmSync(dir, { recursive: true, force: true });

console.log('\nALL DONE');