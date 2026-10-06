import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type DB = DatabaseSync;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
-- Perf: NORMAL is safe under WAL, waits out writer locks instead of erroring,
-- keeps temp b-trees and a generous page cache in memory, and memory-maps the
-- db so reads avoid syscalls. All cheap on a single-writer local app.
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -16000;   -- ~16 MB page cache
PRAGMA mmap_size = 268435456; -- 256 MB

CREATE TABLE IF NOT EXISTS store_location (
  store_id      TEXT NOT NULL,          -- see StoreId in price/model.ts
  location_id   TEXT NOT NULL,          -- store's own site/store number
  name          TEXT NOT NULL,
  address       TEXT,
  postal_code   TEXT,
  is_default    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (store_id, location_id)
);

CREATE TABLE IF NOT EXISTS product (
  id               INTEGER PRIMARY KEY,
  store_id         TEXT NOT NULL,
  store_product_id TEXT NOT NULL,
  name             TEXT NOT NULL,
  brand            TEXT,
  size             TEXT,
  image_url        TEXT,
  product_url      TEXT,
  category         TEXT,
  first_seen_at    TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL,
  UNIQUE (store_id, store_product_id)
);

-- A watchlist entry groups one or more store products the user considers
-- equivalent, so Food Lion and Wegmans rows compare side by side.
CREATE TABLE IF NOT EXISTS watch_group (
  id          INTEGER PRIMARY KEY,
  label       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  target_cents INTEGER,                 -- optional: alert when at or below
  notify_promos INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS watch_item (
  id          INTEGER PRIMARY KEY,
  group_id    INTEGER NOT NULL REFERENCES watch_group(id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  location_id TEXT,
  added_at    TEXT NOT NULL,
  UNIQUE (group_id, product_id)
);

CREATE TABLE IF NOT EXISTS price_point (
  id                   INTEGER PRIMARY KEY,
  product_id           INTEGER NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  location_id          TEXT,
  captured_at          TEXT NOT NULL,
  regular_cents        INTEGER,
  current_cents        INTEGER,
  effective_unit_cents INTEGER,
  promo_kind           TEXT NOT NULL,
  promo_text           TEXT,
  promo_detail_json    TEXT,
  unit_price_text      TEXT,
  in_stock             INTEGER
);
CREATE INDEX IF NOT EXISTS price_point_product_time
  ON price_point (product_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS alert (
  id             INTEGER PRIMARY KEY,
  product_id     INTEGER NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  group_id       INTEGER REFERENCES watch_group(id) ON DELETE CASCADE,
  created_at     TEXT NOT NULL,
  kind           TEXT NOT NULL,
  numeric_change INTEGER NOT NULL,
  severity       TEXT NOT NULL,
  from_cents     INTEGER,
  to_cents       INTEGER,
  delta_cents    INTEGER,
  delta_percent  REAL,
  message        TEXT NOT NULL,
  acknowledged   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS alert_created ON alert (created_at DESC);

-- One row per product per store per day: a durable cross-source price record
-- for analysis, and the corpus the deals filter reads. Append-only.
CREATE TABLE IF NOT EXISTS daily_snapshot (
  id                   INTEGER PRIMARY KEY,
  snapshot_date        TEXT NOT NULL,          -- YYYY-MM-DD (local)
  captured_at          TEXT NOT NULL,          -- ISO-8601
  store_id             TEXT NOT NULL,
  location_id          TEXT,
  store_product_id     TEXT NOT NULL,
  name                 TEXT NOT NULL,
  brand                TEXT,
  size                 TEXT,
  category             TEXT,
  image_url            TEXT,
  product_url          TEXT,
  regular_cents        INTEGER,
  current_cents        INTEGER,
  effective_unit_cents INTEGER,
  discount_pct         REAL,                   -- percent off regular, or NULL
  promo_kind           TEXT NOT NULL,
  promo_text           TEXT,
  unit_price_text      TEXT,
  in_stock             INTEGER,
  UNIQUE (snapshot_date, store_id, location_id, store_product_id)
);
-- Deals queries filter one date by discount / promo / store, so lead with date.
CREATE INDEX IF NOT EXISTS daily_snapshot_deals
  ON daily_snapshot (snapshot_date, store_id, discount_pct DESC);
CREATE INDEX IF NOT EXISTS daily_snapshot_product
  ON daily_snapshot (store_id, store_product_id, snapshot_date DESC);

CREATE TABLE IF NOT EXISTS snapshot_run (
  id            INTEGER PRIMARY KEY,
  snapshot_date TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  rows_written  INTEGER NOT NULL DEFAULT 0,
  stores        TEXT,
  error         TEXT
);

-- ---- Walmart in-store clearance ------------------------------------------
-- Walmart is not a price-comparison source like the grocers: its clearance is
-- per store and does not exist online, so it gets its own tables rather than
-- being forced into the shared product/price_point model.

-- The stores the sweep visits. Populated from Walmart's store finder for a
-- ZIP; 'enabled' is the user's choice of which of those to actually sweep.
CREATE TABLE IF NOT EXISTS walmart_store (
  location_id    TEXT PRIMARY KEY,      -- Walmart store number, e.g. "4682"
  name           TEXT NOT NULL,
  address        TEXT,
  city           TEXT,
  state          TEXT,
  postal_code    TEXT,
  lat            REAL,
  lng            REAL,
  distance_miles REAL,                   -- from the ZIP it was discovered with
  discovered_zip TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  added_at       TEXT NOT NULL,
  last_swept_at  TEXT                    -- ISO-8601; null until a sweep reads it
);

-- One row per item per store per sweep day. Append-only and idempotent, so a
-- retried or resumed sweep overwrites the day rather than duplicating it.
CREATE TABLE IF NOT EXISTS clearance_find (
  id             INTEGER PRIMARY KEY,
  sweep_date     TEXT NOT NULL,          -- YYYY-MM-DD (local)
  captured_at    TEXT NOT NULL,          -- ISO-8601
  location_id    TEXT NOT NULL REFERENCES walmart_store(location_id) ON DELETE CASCADE,
  item_id        TEXT NOT NULL,          -- Walmart usItemId
  category_slug  TEXT NOT NULL,          -- the shelf this came off
  item_group     TEXT NOT NULL,          -- 'pc-parts' | 'electronics'
  category_path  TEXT,                   -- Walmart's own chain, e.g. 0:3944:1089430
  department     TEXT,
  name           TEXT NOT NULL,
  brand          TEXT,
  image_url      TEXT,
  product_url    TEXT,
  now_cents      INTEGER,
  was_cents      INTEGER,
  savings_cents  INTEGER,
  discount_pct   REAL,
  aisle          TEXT,                   -- in-store shelf location, e.g. "K14"
  in_stock       INTEGER,
  UNIQUE (sweep_date, location_id, item_id)
);
-- The clearance feed reads one day, filtered by store and ranked by discount.
CREATE INDEX IF NOT EXISTS clearance_find_feed
  ON clearance_find (sweep_date, item_group, discount_pct DESC);
-- "when did this item first show up, and where" — the alerting path.
CREATE INDEX IF NOT EXISTS clearance_find_item
  ON clearance_find (item_id, sweep_date DESC);

-- A saved term the user is hunting for ("rtx", "ssd", "nvme"). Matched against
-- item names as each sweep lands, so a new find alerts the same day.
CREATE TABLE IF NOT EXISTS clearance_watch (
  id            INTEGER PRIMARY KEY,
  term          TEXT NOT NULL UNIQUE,    -- case-insensitive substring
  max_cents     INTEGER,                 -- optional ceiling on the clearance price
  min_discount  REAL,                    -- optional floor on percent off
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clearance_alert (
  id           INTEGER PRIMARY KEY,
  watch_id     INTEGER REFERENCES clearance_watch(id) ON DELETE CASCADE,
  find_id      INTEGER NOT NULL REFERENCES clearance_find(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  message      TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  UNIQUE (watch_id, find_id)
);
CREATE INDEX IF NOT EXISTS clearance_alert_created ON clearance_alert (created_at DESC);
-- A monitor alert has no watch, and SQLite treats NULLs in a UNIQUE tuple as
-- distinct — so the composite key above would not stop it firing twice for the
-- same find. This partial index is what actually makes them idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS clearance_alert_monitor
  ON clearance_alert (find_id) WHERE watch_id IS NULL;

-- The standing rule for what counts as a deal worth surfacing. One row: the
-- question "which finds do I want to be told about" has one answer, and a list
-- of competing rules would only make it ambiguous which one fired.
CREATE TABLE IF NOT EXISTS deal_monitor (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  min_discount REAL NOT NULL,              -- percent off, e.g. 25
  groups       TEXT NOT NULL,              -- comma-separated category groups
  enabled      INTEGER NOT NULL DEFAULT 1,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sweep_run (
  id             INTEGER PRIMARY KEY,
  sweep_date     TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  stores_swept   INTEGER NOT NULL DEFAULT 0,
  finds_written  INTEGER NOT NULL DEFAULT 0,
  error          TEXT
);

-- Durable read ledger for hosts that rate-limit by count. The pacer, the nightly
-- sweep and a manual sweep all consult the same row, so a restart does not hand
-- a refused connection a fresh allowance.
CREATE TABLE IF NOT EXISTS host_budget (
  host              TEXT PRIMARY KEY,
  not_before        INTEGER NOT NULL DEFAULT 0,   -- epoch ms; no read before this
  window_started_at INTEGER NOT NULL DEFAULT 0,   -- epoch ms
  reads_in_window   INTEGER NOT NULL DEFAULT 0,
  last_status       INTEGER,                      -- HTTP status of the last refusal
  updated_at        TEXT NOT NULL
);

-- When a store last got a full read of every shelf. Delta sweeps (newest-first,
-- stop at the familiar) cannot see items that left the rack, so a full pass is
-- forced when this is old.
CREATE TABLE IF NOT EXISTS walmart_sweep_state (
  location_id    TEXT PRIMARY KEY,
  last_full_date TEXT NOT NULL              -- YYYY-MM-DD (local)
);

CREATE TABLE IF NOT EXISTS poll_run (
  id           INTEGER PRIMARY KEY,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  store_id     TEXT,
  items_polled INTEGER NOT NULL DEFAULT 0,
  changes      INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);
`;

/**
 * Columns added after a table shipped. `CREATE TABLE IF NOT EXISTS` leaves an
 * existing table alone, so a new column has to be added explicitly — and
 * idempotently, since this runs on every open.
 */
const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: 'walmart_store', column: 'last_swept_at', definition: 'TEXT' },
];

function applyAddedColumns(db: DB): void {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
    if (columns.length === 0) continue; // table not created yet on this open
    if (columns.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/** The monitor a fresh install starts with: a quarter off, everything swept. */
const DEFAULT_MONITOR = {
  minDiscount: Number(process.env.BASTILLE_DEAL_MIN_DISCOUNT ?? 25),
  groups: 'pc-parts,video-games,electronics',
};

export function openDb(path: string = process.env.BASTILLE_DB ?? resolve('data/bastille.db')): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  applyAddedColumns(db);
  db.prepare(
    `INSERT INTO deal_monitor (id, min_discount, groups, enabled, updated_at)
     VALUES (1, ?, ?, 1, ?) ON CONFLICT (id) DO NOTHING`,
  ).run(DEFAULT_MONITOR.minDiscount, DEFAULT_MONITOR.groups, new Date().toISOString());
  return db;
}
