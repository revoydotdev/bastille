import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type DB = DatabaseSync;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

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

export function openDb(path = process.env.GROCER_DB ?? resolve('data/grocer.db')): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
