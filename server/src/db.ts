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
  store_id      TEXT NOT NULL,          -- 'foodlion' | 'wegmans'
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

export function openDb(path: string = process.env.GROCER_DB ?? resolve('data/grocer.db')): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
