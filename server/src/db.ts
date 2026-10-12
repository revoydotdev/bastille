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

-- One row per product per *interval* of unchanged price. The price tuple is
-- stable for as long as the row's valid_to is NULL; a nightly run that
-- observes the same tuple as the open row closes nothing and writes nothing.
-- /api/deals reconstructs any date by interval join, not by snapshot_date
-- equality — snapshot_date is the day the interval was first observed and
-- is preserved only for partition-style reports. A single product can have
-- many rows for the same snapshot_date across its history.
--
-- The two indexes that depend on the new columns (daily_snapshot_open,
-- daily_snapshot_interval) are created by applyDailySnapshotIndexes() AFTER
-- applyAddedColumns() has added the columns, not here in SCHEMA. SCHEMA runs
-- before applyAddedColumns(); a pre-migration database has no valid_from /
-- valid_to columns yet, so the CREATE INDEX statements that reference them
-- would error out and the operator's existing data would be unbootable. The
-- deals + product indexes that follow are safe (they only reference columns
-- that exist in the pre-migration table).
CREATE TABLE IF NOT EXISTS daily_snapshot (
  id                   INTEGER PRIMARY KEY,
  snapshot_date        TEXT NOT NULL,          -- YYYY-MM-DD (local); partition key, not uniqueness
  captured_at          TEXT NOT NULL,          -- ISO-8601; row uniqueness + deals ordering
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
  valid_from           TEXT NOT NULL,          -- ISO-8601; interval opens here
  valid_to             TEXT,                   -- ISO-8601; NULL while the price tuple is still current
  UNIQUE (captured_at, store_id, location_id, store_product_id)
);
-- Deals queries use the latest capture per product; captured_at leads for ordering.
CREATE INDEX IF NOT EXISTS daily_snapshot_deals
  ON daily_snapshot (captured_at DESC, store_id, discount_pct DESC);
CREATE INDEX IF NOT EXISTS daily_snapshot_product
  ON daily_snapshot (store_id, store_product_id, captured_at DESC);

-- ---- Egress nodes (W-9) -------------------------------------------------
-- One row per residential-proxy exit point. The sweep dials the proxy_url and
-- appends the geo suffix to the proxy password to get an IP in <region>.
-- The host budget is keyed by (host, egress_node_id) so each exit point burns
-- its own 18-read window.  This is what implements the W-9 federation path:
-- one process, multiple egress nodes, one store per node.
--
-- proxy_url is a full URL with embedded credentials (e.g. a per-region password
-- suffix that IPRoyal understands). Keeping it in the DB means rotating
-- credentials doesn't require a code change; the rotation just edits rows.
-- Rotation cadence is left to the operator.  Treat the column as sensitive.
CREATE TABLE IF NOT EXISTS egress_node (
  id          TEXT PRIMARY KEY,        -- short operator-chosen id, e.g. "us-va-fairfax"
  label       TEXT NOT NULL,            -- human label, e.g. "Fairfax VA residential"
  proxy_url   TEXT NOT NULL,            -- full URL with embedded creds; sensitive
  region      TEXT,                     -- freeform city/state, e.g. "fairfax,va,us"
  enabled     INTEGER NOT NULL DEFAULT 1,
  added_at    TEXT NOT NULL,            -- ISO-8601
  last_used_at TEXT                     -- ISO-8601; null until the first sweep uses it
);

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
  // ---- begin: W-9 — egress node assignment
  // Each store points to a row in egress_node (proxy URL + region selector).
  // The sweep uses that to dial a residential IP and read this store's local
  // rack. Stores without a node are read from the process's own egress (the
  // old behaviour, kept for single-store setups that don't need federation).
  { table: 'walmart_store', column: 'egress_node_id', definition: 'TEXT' },
  // ---- end: W-9
  // ---- begin: observability columns (O-2)
  { table: 'poll_run', column: 'requests', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'poll_run', column: 'bytes', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'snapshot_run', column: 'requests', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'snapshot_run', column: 'bytes', definition: 'INTEGER NOT NULL DEFAULT 0' },
  // ---- end: observability columns
  // ---- begin: daily_snapshot interval columns (todo 3)
  // Convert `daily_snapshot` from a per-day partition to per-interval rows so
  // an unchanged product over 30 days writes 1 row, not 30. The sentinel
  // default for `valid_from` lets the backfill UPDATE identify pre-migration
  // rows; `valid_to` defaults to NULL ("current interval"). Both columns are
  // NOT NULL or NULL respectively — the partial unique index on
  // `(store, location, product) WHERE valid_to IS NULL` is what stops a
  // product from holding two open intervals at once.
  { table: 'daily_snapshot', column: 'valid_from', definition: `TEXT NOT NULL DEFAULT '1970-01-01 00:00:00'` },
  { table: 'daily_snapshot', column: 'valid_to', definition: 'TEXT' },
  // ---- end: daily_snapshot interval columns
];

function applyAddedColumns(db: DB): void {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
    if (columns.length === 0) continue; // table not created yet on this open
    if (columns.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/**
 * Create the two `daily_snapshot` indexes that depend on the interval columns
 * and backfill the interval columns on pre-migration rows.
 *
 * SCHEMA runs BEFORE applyAddedColumns, so index DDL that references the new
 * columns cannot live there: a pre-migration database has no `valid_from` /
 * `valid_to` and the CREATE INDEX would error out, leaving the operator's
 * existing data unbootable. This function is called once at the bottom of
 * `openDb` after `applyAddedColumns` has added both columns.
 *
 * The backfill uses the half-open convention so the deals feed is queryable
 * by `?date=`: a row for `snapshot_date = 'D'` covers the half-open interval
 * `[D 00:00:00, D+1 00:00:00)`. `date(snapshot_date, '+1 day') || ' 00:00:00'`
 * is the half-open right endpoint; a query for `D` matches (`D+1 > D`),
 * a query for `D+1` does not. The pre-migration sentinel default for
 * `valid_from` is `'1970-01-01 00:00:00'` (set by the `ADDED_COLUMNS` entry
 * in `applyAddedColumns`), so this UPDATE rewrites only the rows that
 * inherited the sentinel. Rows written after migration have `valid_to =
 * NULL` and the sentinel never reappears, so subsequent boots are no-ops.
 */
function applyDailySnapshotIndexes(db: DB): void {
  const cols = db.prepare(`PRAGMA table_info(daily_snapshot)`).all() as unknown as { name: string }[];
  if (!cols.some((c) => c.name === 'valid_from') || !cols.some((c) => c.name === 'valid_to')) {
    return; // columns not added yet; nothing to do
  }
  // At most one OPEN interval per (store, location, product) at a time.
  // SQLite treats NULLs in UNIQUE tuples as distinct, so a partial index is
  // the only way to enforce this; a closed row (valid_to IS NOT NULL) and a
  // new open row can share a (captured_at, store, location, product) tuple
  // because they live in different table rows, not in the same UNIQUE slot.
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS daily_snapshot_open
       ON daily_snapshot (store_id, location_id, store_product_id) WHERE valid_to IS NULL`,
  );
  // Interval-bounded reads: the deals feed asks "what was the price on day D",
  // which is an interval-overlap query, not a partition lookup. Leading on
  // valid_from lets the planner walk a date range cheaply.
  db.exec(
    `CREATE INDEX IF NOT EXISTS daily_snapshot_interval
       ON daily_snapshot (valid_from, valid_to)`,
  );

  const sentinel = db
    .prepare(
      `SELECT 1 FROM daily_snapshot
        WHERE valid_from = '1970-01-01 00:00:00'
        LIMIT 1`,
    )
    .get();
  if (!sentinel) return; // already backfilled (or no rows)
  db.exec(
    `UPDATE daily_snapshot
        SET valid_from = snapshot_date || ' 00:00:00',
            valid_to   = date(snapshot_date, '+1 day') || ' 00:00:00'
      WHERE valid_from = '1970-01-01 00:00:00'`,
  );
}

// ---- begin: observability and perf additions --------------------------------
// Kept apart from SCHEMA above so it merges cleanly with changes to that block.
const EXTRA_SCHEMA = `
-- One row per upstream read (O-1), written by adapters/http.ts. Pruned by age
-- and row count in metrics.ts. No query strings, headers or cookies.
CREATE TABLE IF NOT EXISTS request_log (
  id      INTEGER PRIMARY KEY,
  ts      TEXT NOT NULL,             -- ISO-8601
  host    TEXT NOT NULL,
  op      TEXT NOT NULL,             -- URL path only
  status  INTEGER NOT NULL,          -- 0 = no response
  ms      INTEGER NOT NULL,
  bytes   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS request_log_ts ON request_log (ts);

-- previousSweepDate / seenBefore filter on the store first (P-8).
CREATE INDEX IF NOT EXISTS clearance_find_location
  ON clearance_find (location_id, sweep_date DESC);

-- Small key/value store for facts that must survive a restart (P-9).
CREATE TABLE IF NOT EXISTS bastille_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
// ---- end: observability and perf additions ----------------------------------

/** The monitor a fresh install starts with: a quarter off, everything swept. */
const DEFAULT_MONITOR = {
  minDiscount: Number(process.env.BASTILLE_DEAL_MIN_DISCOUNT ?? 25),
  groups: 'pc-parts,video-games,electronics',
};

export function openDb(path: string = process.env.BASTILLE_DB ?? resolve('data/bastille.db')): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  db.exec(EXTRA_SCHEMA);
  applyAddedColumns(db);
  applyDailySnapshotIndexes(db);
  db.prepare(
    `INSERT INTO deal_monitor (id, min_discount, groups, enabled, updated_at)
     VALUES (1, ?, ?, 1, ?) ON CONFLICT (id) DO NOTHING`,
  ).run(DEFAULT_MONITOR.minDiscount, DEFAULT_MONITOR.groups, new Date().toISOString());
  return db;
}
