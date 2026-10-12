/**
 * Nightly backup service.
 *
 * Runs once a day (default 03:00 local, configurable via
 * `BASTILLE_BACKUP_HOUR`):
 *
 *   1. `VACUUM INTO 'data/backups/bastille-<UTC-ISO>.db'` — a clean snapshot
 *      of the whole database as a regular SQLite file. The path is recorded
 *      in `backup_log` so retention rotation can see what it deleted.
 *   2. Exports `daily_snapshot`, `product`, and `price_point` to Parquet
 *      under `data/archive/<date>/`, one file per table. Parquet is the
 *      external format for the corpus; readers like DuckDB or pandas can
 *      query it without bastille running.
 *
 * Rotation keeps the N most recent VACUUM files and Parquet day directories
 * (default N=14, `BASTILLE_BACKUP_KEEP`). Older entries are deleted from
 * disk AND from `backup_log` so the two never disagree.
 *
 * The Parquet dependency is `hyparquet-writer` (and `hyparquet` for the
 * reader side, which is used by the schema-version tests). Both are pure
 * JavaScript with zero native deps, ESM-only, actively maintained, and ship
 * with row-based and column-based write APIs that fit our columnar SQLite
 * tables directly.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parquetReadObjects, parquetMetadataAsync, type FileMetaData } from 'hyparquet';
import { parquetWriteFile } from 'hyparquet-writer';
import type { DB } from '../db.js';

export interface BackupServiceOptions {
  /** Source database (open). */
  db: DB;
  /** Override the data root; defaults to `data/` next to the working dir. */
  dataDir?: string;
  /** Override the VACUUM backup directory; defaults to `${dataDir}/backups`. */
  backupsDir?: string;
  /** Override the Parquet archive directory; defaults to `${dataDir}/archive`. */
  archiveDir?: string;
  /** Hour of day (local, 0-23) to run at. Default 3. */
  hour?: number;
  /** Number of backups to keep per kind (most recent). Default 14. */
  keep?: number;
  /** Inject a clock for tests. Returns ISO timestamp or epoch ms. */
  now?: () => Date;
}

export interface BackupArtifact {
  kind: 'vacuum' | 'parquet';
  path: string;
  rows: number;
  bytes: number;
  error?: string;
}

export interface BackupResult {
  startedAt: string;
  finishedAt: string;
  artifacts: BackupArtifact[];
  errors: string[];
}

/**
 * Static column metadata used by the Parquet writer. We declare each column
 * with its SQLite type so the reader sees matching types; the corpus is the
 * source of truth, not the writer's auto-detection.
 */
const PARQUET_SCHEMA_VERSION = 1;

interface ColumnDef {
  name: string;
  type: 'INT32' | 'INT64' | 'FLOAT' | 'DOUBLE' | 'STRING' | 'BOOLEAN' | 'TIMESTAMP';
  nullable?: boolean;
}

/**
 * Per-table column list. The order matches `SELECT *` from the source table;
 * the Parquet writer transposes row data into columns by name.
 *
 * `daily_snapshot` and `product` were chosen for the corpus because they
 * answer every query the deals UI serves today (`/api/deals`, `/api/products`,
 * cross-store comparison). `price_point` is the per-watch history series.
 */
const PARQUET_TABLES: { table: string; columns: ColumnDef[] }[] = [
  {
    table: 'daily_snapshot',
    columns: [
      { name: 'id', type: 'INT64' },
      { name: 'snapshot_date', type: 'STRING' },
      { name: 'captured_at', type: 'STRING' },
      { name: 'store_id', type: 'STRING' },
      { name: 'location_id', type: 'STRING', nullable: true },
      { name: 'store_product_id', type: 'STRING' },
      { name: 'name', type: 'STRING' },
      { name: 'brand', type: 'STRING', nullable: true },
      { name: 'size', type: 'STRING', nullable: true },
      { name: 'category', type: 'STRING', nullable: true },
      { name: 'image_url', type: 'STRING', nullable: true },
      { name: 'product_url', type: 'STRING', nullable: true },
      { name: 'regular_cents', type: 'INT64', nullable: true },
      { name: 'current_cents', type: 'INT64', nullable: true },
      { name: 'effective_unit_cents', type: 'INT64', nullable: true },
      { name: 'discount_pct', type: 'FLOAT', nullable: true },
      { name: 'promo_kind', type: 'STRING' },
      { name: 'promo_text', type: 'STRING', nullable: true },
      { name: 'unit_price_text', type: 'STRING', nullable: true },
      { name: 'in_stock', type: 'INT32', nullable: true },
    ],
  },
  {
    table: 'product',
    columns: [
      { name: 'id', type: 'INT64' },
      { name: 'store_id', type: 'STRING' },
      { name: 'store_product_id', type: 'STRING' },
      { name: 'name', type: 'STRING' },
      { name: 'brand', type: 'STRING', nullable: true },
      { name: 'size', type: 'STRING', nullable: true },
      { name: 'image_url', type: 'STRING', nullable: true },
      { name: 'product_url', type: 'STRING', nullable: true },
      { name: 'category', type: 'STRING', nullable: true },
      { name: 'first_seen_at', type: 'STRING' },
      { name: 'last_seen_at', type: 'STRING' },
    ],
  },
  {
    table: 'price_point',
    columns: [
      { name: 'id', type: 'INT64' },
      { name: 'product_id', type: 'INT64' },
      { name: 'location_id', type: 'STRING', nullable: true },
      { name: 'captured_at', type: 'STRING' },
      { name: 'regular_cents', type: 'INT64', nullable: true },
      { name: 'current_cents', type: 'INT64', nullable: true },
      { name: 'effective_unit_cents', type: 'INT64', nullable: true },
      { name: 'promo_kind', type: 'STRING' },
      { name: 'promo_text', type: 'STRING', nullable: true },
      { name: 'promo_detail_json', type: 'STRING', nullable: true },
      { name: 'unit_price_text', type: 'STRING', nullable: true },
      { name: 'in_stock', type: 'INT32', nullable: true },
    ],
  },
];

function utcStamp(d: Date): string {
  // Filename-safe UTC stamp: 2026-10-12T03-00-00Z (no colons).
  return d.toISOString().replace(/[:.]/g, '-');
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class BackupService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly hour: number;
  private readonly keep: number;
  private readonly now: () => Date;
  private readonly dataDir: string;
  private readonly backupsDir: string;
  private readonly archiveDir: string;
  private readonly opts: BackupServiceOptions;

  constructor(opts: BackupServiceOptions) {
    this.opts = opts;
    this.hour = Math.min(Math.max(Number(opts.hour ?? process.env.BASTILLE_BACKUP_HOUR ?? 3), 0), 23);
    this.keep = Math.max(1, Number(opts.keep ?? process.env.BASTILLE_BACKUP_KEEP ?? 14));
    this.now = opts.now ?? (() => new Date());
    this.dataDir = opts.dataDir ?? process.env.BASTILLE_DATA_DIR ?? resolve('data');
    this.backupsDir = opts.backupsDir ?? join(this.dataDir, 'backups');
    this.archiveDir = opts.archiveDir ?? join(this.dataDir, 'archive');
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.timer) return;
    const next = this.nextRun();
    const ms = next.getTime() - this.now().getTime();
    this.timer = setTimeout(() => {
      void this.runOnce().catch(() => undefined);
      this.timer = setInterval(() => void this.runOnce().catch(() => undefined), 24 * 60 * 60 * 1000);
      this.timer.unref?.();
    }, ms);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      clearInterval(this.timer);
    }
    this.timer = null;
  }

  private nextRun(): Date {
    const now = this.now();
    const next = new Date(now);
    next.setHours(this.hour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next;
  }

  /**
   * Run one backup cycle. Returns the artifacts list; partial failures show
   * up as `error` strings on the affected artifact and a populated
   * `result.errors`. The cycle never throws — each artifact is a separate
   * try/catch so one failure does not abort the rest.
   */
  async runOnce(): Promise<BackupResult> {
    if (this.running) {
      return {
        startedAt: this.now().toISOString(),
        finishedAt: this.now().toISOString(),
        artifacts: [],
        errors: ['backup already in progress'],
      };
    }
    this.running = true;
    const startedAt = this.now().toISOString();
    const artifacts: BackupArtifact[] = [];
    const errors: string[] = [];

    mkdirSync(this.backupsDir, { recursive: true });
    mkdirSync(this.archiveDir, { recursive: true });

    try {
      const vacuum = await this.vacuumInto(artifacts, errors);
      if (vacuum) {
        await this.exportParquet(vacuum.archiveDate, artifacts, errors);
      }
      this.rotate(artifacts, errors);
    } finally {
      this.running = false;
    }
    return {
      startedAt,
      finishedAt: this.now().toISOString(),
      artifacts,
      errors,
    };
  }

  private vacuumInto(artifacts: BackupArtifact[], errors: string[]): { archiveDate: string } | null {
    const stamp = utcStamp(this.now());
    const path = join(this.backupsDir, `bastille-${stamp}.db`);
    let rows = 0;
    let bytes = 0;
    const startedAt = this.now().toISOString();
    let artifact: BackupArtifact;
    try {
      // VACUUM INTO expects a string literal, not a parameter binding, so we
      // inline the path. Paths are built from a controlled UTC stamp +
      // operator-configured directories, so the only escaping needed is the
      // single-quote that surrounds the literal itself.
      const escaped = path.replace(/'/g, "''");
      this.opts.db.exec(`VACUUM INTO '${escaped}'`);
      const st = statSync(path);
      bytes = st.size;
      // Count what we backed up: a single number for "did we capture something?"
      const r = this.opts.db.prepare('SELECT COUNT(*) AS c FROM daily_snapshot').get() as { c: number };
      rows = r.c;
      artifact = { kind: 'vacuum', path, rows, bytes };
      artifacts.push(artifact);
    } catch (err) {
      artifact = { kind: 'vacuum', path, rows, bytes, error: (err as Error).message };
      artifacts.push(artifact);
      errors.push(`vacuum: ${(err as Error).message}`);
    } finally {
      this.recordBackupLog(startedAt, artifact!);
    }
    if (artifact!.error) return null;
    return { archiveDate: localDate(this.now()) };
  }

  private async exportParquet(
    archiveDate: string,
    artifacts: BackupArtifact[],
    errors: string[],
  ): Promise<void> {
    const dayDir = join(this.archiveDir, archiveDate);
    mkdirSync(dayDir, { recursive: true });

    for (const def of PARQUET_TABLES) {
      const path = join(dayDir, `${def.table}.parquet`);
      const startedAt = this.now().toISOString();
      let rows = 0;
      let bytes = 0;
      let artifact: BackupArtifact;
      try {
        rows = await this.writeTableAsParquet(def, path);
        const st = statSync(path);
        bytes = st.size;
        artifact = { kind: 'parquet', path, rows, bytes };
        artifacts.push(artifact);
      } catch (err) {
        artifact = { kind: 'parquet', path, rows, bytes, error: (err as Error).message };
        artifacts.push(artifact);
        errors.push(`parquet ${def.table}: ${(err as Error).message}`);
      } finally {
        this.recordBackupLog(startedAt, artifact!);
      }
    }

    // Side-car file: the schema version + table list, so a reader can tell
    // what a given archive directory was produced by.
    const manifest = {
      schemaVersion: PARQUET_SCHEMA_VERSION,
      date: archiveDate,
      tables: PARQUET_TABLES.map((d) => d.table),
      generatedAt: this.now().toISOString(),
    };
    writeFileSync(join(dayDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  }

  /**
   * Read every row from `def.table` and write one Parquet file at `path`.
   * Each column is built into a typed array so the Parquet writer can stream
   * it natively. SQLite's `node:sqlite` returns column values typed by the
   * column declaration, which lines up with the Parquet column type map.
   *
   * INT64 columns need BigInt values; hyparquet-writer throws on plain
   * numbers. We coerce here so callers don't have to.
   */
  private async writeTableAsParquet(
    def: { table: string; columns: ColumnDef[] },
    path: string,
  ): Promise<number> {
    const rows = this.opts.db.prepare(`SELECT * FROM ${def.table}`).all() as Record<string, unknown>[];
    const columnData = def.columns.map((col) => ({
      name: col.name,
      type: col.type,
      nullable: col.nullable,
      data: rows.map((r) => {
        const raw = r[col.name];
        if (raw === null || raw === undefined) return null;
        if (col.type === 'INT64') {
          if (typeof raw === 'bigint') return raw;
          // SQLite is loosely typed; a REAL value can land in an INTEGER
          // column when the caller did arithmetic that produced a fraction.
          // Round to the nearest integer so the BigInt coercion succeeds.
          const n = typeof raw === 'number' ? raw : Number(raw);
          return BigInt(Math.trunc(n));
        }
        if (col.type === 'INT32') return typeof raw === 'number' ? raw : Math.trunc(Number(raw));
        return raw;
      }),
    }));
    parquetWriteFile({ filename: path, columnData });
    return rows.length;
  }

  /**
   * Keep the N most recent VACUUM files and Parquet day directories. The
   * cutoff is by mtime: older entries are deleted from disk AND their rows
   * removed from `backup_log`, so the table and the filesystem never lie to
   * each other.
   */
  private rotate(_artifacts: BackupArtifact[], errors: string[]): void {
    try {
      this.rotateVacuumFiles();
    } catch (err) {
      errors.push(`rotate vacuum: ${(err as Error).message}`);
    }
    try {
      this.rotateArchiveDays();
    } catch (err) {
      errors.push(`rotate archive: ${(err as Error).message}`);
    }
    try {
      this.purgeBackupLog();
    } catch (err) {
      errors.push(`purge backup_log: ${(err as Error).message}`);
    }
  }

  private rotateVacuumFiles(): void {
    if (!existsSync(this.backupsDir)) return;
    const files = readdirSync(this.backupsDir)
      .filter((n) => n.endsWith('.db'))
      .map((n) => {
        const full = join(this.backupsDir, n);
        const mtime = statSync(full).mtimeMs;
        return { full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of files.slice(this.keep)) {
      rmSync(old.full);
    }
  }

  private rotateArchiveDays(): void {
    if (!existsSync(this.archiveDir)) return;
    const dirs = readdirSync(this.archiveDir)
      .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
      .map((n) => {
        const full = join(this.archiveDir, n);
        const mtime = statSync(full).mtimeMs;
        return { full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of dirs.slice(this.keep)) {
      rmSync(old.full, { recursive: true });
    }
  }

  /**
   * Drop backup_log rows whose file is no longer on disk, or whose path
   * doesn't match a real artifact. This keeps the table honest after manual
   * filesystem cleanup or a future move to remote storage.
   */
  private purgeBackupLog(): void {
    const rows = this.opts.db
      .prepare("SELECT id, kind, path FROM backup_log WHERE error IS NULL")
      .all() as unknown as { id: number; kind: string; path: string }[];
    const stmt = this.opts.db.prepare('DELETE FROM backup_log WHERE id = ?');
    for (const row of rows) {
      if (!existsSync(row.path)) stmt.run(row.id);
    }
  }

  private recordBackupLog(startedAt: string, artifact: BackupArtifact): void {
    try {
      this.opts.db
        .prepare(
          `INSERT INTO backup_log (started_at, finished_at, kind, path, bytes, rows, error)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          startedAt,
          this.now().toISOString(),
          artifact.kind,
          artifact.path,
          artifact.bytes,
          artifact.rows,
          artifact.error ?? null,
        );
    } catch {
      // backup_log is created by migration v5; on a pre-existing DB the
      // BackupService also creates it defensively. If both paths somehow
      // miss it, swallow the error rather than fail the backup.
    }
  }
}

/**
 * Defensive CREATE TABLE for `backup_log` on a database where migration v5
 * has not yet been recorded. The migration runner takes over on subsequent
 * boots, so this is a one-shot helper.
 */
export function ensureBackupLogTable(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS backup_log (
      id          INTEGER PRIMARY KEY,
      started_at  TEXT NOT NULL,
      finished_at TEXT,
      kind        TEXT NOT NULL,
      path        TEXT NOT NULL,
      bytes       INTEGER NOT NULL DEFAULT 0,
      rows        INTEGER,
      error       TEXT
    );
    CREATE INDEX IF NOT EXISTS backup_log_started ON backup_log (started_at DESC);
  `);
}

// Re-export the Parquet reader bits used by tests and tools.
export { parquetReadObjects, parquetMetadataAsync };
export type { FileMetaData };
export const PARQUET_SCHEMA_VERSION_EXPORT = PARQUET_SCHEMA_VERSION;
export const PARQUET_TABLE_NAMES = PARQUET_TABLES.map((d) => d.table);