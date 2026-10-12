/**
 * The interval-row contract for `daily_snapshot` (todo 3, plan P-6).
 *
 * Before this change the table was a per-day partition: every nightly run
 * wrote one row per (date, store, location, product), so an unchanged product
 * over 30 days cost 30 rows. After this change the table holds interval
 * rows: a row represents the time period during which the price tuple
 * `(regular_cents, current_cents, promo_kind, promo_text, in_stock,
 * discount_pct)` was stable. `recordSnapshot` only writes a new row when the
 * tuple changes; otherwise it leaves the open interval alone.
 *
 * These tests exercise the contract end to end:
 *   1. 30 calls with the same offer produce 1 row, not 30.
 *   2. `queryDeals(d)` returns the same product for any `d` while the open
 *      interval covers it, so `/api/deals?date=<2nd>` matches
 *      `/api/deals?date=<1st>` after migration.
 *   3. A `current_cents` mutation mid-window closes the prior interval
 *      (sets `valid_to = NOW`) and opens a new one (`valid_from = NOW`,
 *      `valid_to = NULL`).
 *   4. `pruneSnapshots(90)` does not delete a row whose `valid_to IS NULL`
 *      even when `valid_from` is well before the cutoff — the open interval
 *      is still current.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { Repo } from '../src/repo.js';
import { registerRoutes } from '../src/routes.js';
import type { Offer, PriceSnapshot } from '../src/price/model.js';

function price(cents: number, at: number): PriceSnapshot {
  return {
    regularCents: cents, currentCents: cents, effectiveUnitCents: cents,
    promoKind: 'none', promoText: null, promoDetail: null, unitPriceText: null,
    inStock: true, capturedAt: new Date(Date.UTC(2026, 0, 1) + at * 60_000).toISOString(),
  };
}

function offer(id: string, cents: number): Offer {
  return {
    product: {
      storeId: 'foodlion', storeProductId: id, name: `Product ${id}`,
      brand: null, size: null, imageUrl: null, productUrl: null, category: 'Produce',
    },
    price: price(cents, 0),
  };
}

function withRepo(fn: (repo: Repo) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bastille-intervals-'));
  const db = openDb(join(dir, 'test.db'));
  try {
    fn(new Repo(db));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function withDb(fn: (repo: Repo, db: DB) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bastille-intervals-'));
  const db = openDb(join(dir, 'test.db'));
  try {
    fn(new Repo(db), db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function dayDate(day: number): string {
  // Day 1 = today, day 30 = today + 29 days. The dates stay relative to
  // the test's run moment so the interval's `valid_from` (also "now")
  // lands on day 1 of the simulation, not three weeks earlier.
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + day - 1);
  return d.toISOString().slice(0, 10);
}

test('an unchanged product over a 30-day run writes 1 row, not 30', () => {
  withRepo((repo) => {
    const product = offer('steady', 199);
    for (let day = 1; day <= 30; day++) {
      repo.recordSnapshot(dayDate(day), [{ offer: product, locationId: null }]);
    }
    const db = (repo as unknown as { db: { prepare: (s: string) => { get: () => unknown } } }).db;
    const row = db.prepare('SELECT COUNT(*) AS c FROM daily_snapshot').get() as { c: number };
    assert.equal(row.c, 1, '30 identical snapshots collapse to 1 open interval');
  });
});

test('queryDeals reconstructs any date inside an open interval', () => {
  withRepo((repo) => {
    repo.recordSnapshot(dayDate(1), [{ offer: offer('steady', 199), locationId: null }]);
    const day1 = repo.queryDeals({ date: dayDate(1) });
    const day15 = repo.queryDeals({ date: dayDate(15) });
    const day30 = repo.queryDeals({ date: dayDate(30) });
    // One row in the corpus; every date the interval covers sees it.
    assert.equal(day1.total, 1);
    assert.equal(day15.total, 1);
    assert.equal(day30.total, 1);
    assert.equal(day1.rows[0]!.storeProductId, 'steady');
    assert.equal(day15.rows[0]!.storeProductId, 'steady');
    assert.equal(day30.rows[0]!.storeProductId, 'steady');
    // The interval is the same row for every queried date, so the visible
    // `currentCents` and `validFrom` are the original ones.
    assert.equal(day1.rows[0]!.currentCents, 199);
    assert.equal(day15.rows[0]!.currentCents, 199);
    assert.equal(day30.rows[0]!.currentCents, 199);
  });
});

test('a current_cents change mid-window splits the interval into 2 rows', () => {
  withDb((repo, db) => {
    const r1 = repo.recordSnapshot(dayDate(1), [{ offer: offer('wobbly', 199), locationId: null }]);
    assert.equal(r1, 1, 'first observation opens an interval');
    const r2 = repo.recordSnapshot(dayDate(15), [{ offer: offer('wobbly', 149), locationId: null }]);
    assert.equal(r2, 1, 'tuple changed — second interval opened');

    // Order by `id` so the chronology is deterministic even when the two
    // writes happen within the same millisecond.
    const rows = db
      .prepare(
        `SELECT id, current_cents, valid_from, valid_to
           FROM daily_snapshot
          WHERE store_product_id = ?
          ORDER BY id ASC`,
      )
      .all('wobbly') as { id: number; current_cents: number; valid_from: string; valid_to: string | null }[];
    assert.equal(rows.length, 2, 'mid-window change produces exactly 2 rows');
    // Old row first (smaller id), new row second.
    assert.equal(rows[0]!.current_cents, 199);
    assert.ok(rows[0]!.valid_to !== null, 'old row is closed on insert of the new one');
    assert.equal(rows[1]!.current_cents, 149);
    assert.equal(rows[1]!.valid_to, null, 'the latest interval is open');
    assert.ok(
      Date.parse(rows[1]!.valid_from) >= Date.parse(rows[0]!.valid_from),
      'new row opens at-or-after the old row',
    );
  });
});

test('pruneSnapshots keeps an open interval even when valid_from is well before the cutoff', () => {
  withDb((repo, db) => {
    // First record an open interval with a back-dated valid_from so it
    // looks older than the 90-day cutoff but is still current. The
    // backdating has to be a direct UPDATE — recordSnapshot always sets
    // valid_from = NOW. This mirrors a row that has been open for a long
    // time: pruning must not delete it.
    repo.recordSnapshot('2026-09-06', [{ offer: offer('long-running', 199), locationId: null }]);
    db.prepare(
      "UPDATE daily_snapshot SET valid_from = '2025-01-01 00:00:00' WHERE store_product_id = 'long-running'",
    ).run();

    const removed = repo.pruneSnapshots(90, new Date('2026-09-06T12:00:00Z'));
    assert.equal(removed, 0, 'an open interval is never date-pruned');

    const surviving = db
      .prepare('SELECT valid_to FROM daily_snapshot WHERE store_product_id = ?')
      .get('long-running') as { valid_to: string | null } | undefined;
    assert.ok(surviving, 'row still exists');
    assert.equal(surviving!.valid_to, null, 'the interval is still open');
  });
});

test('a closed interval older than the cutoff is pruned; an open one is not', () => {
  withDb((repo, db) => {
    repo.recordSnapshot('2024-01-01', [{ offer: offer('ancient', 199), locationId: null }]);
    repo.recordSnapshot('2026-09-06', [{ offer: offer('current', 199), locationId: null }]);
    db.prepare(
      "UPDATE daily_snapshot SET valid_to = '2024-01-01 23:59:59' WHERE store_product_id = 'ancient'",
    ).run();

    const removed = repo.pruneSnapshots(90, new Date('2026-09-06T12:00:00Z'));
    assert.equal(removed, 1, 'only the closed ancient row goes');

    const stillThere = db
      .prepare('SELECT store_product_id, valid_to FROM daily_snapshot')
      .all() as { store_product_id: string; valid_to: string | null }[];
    assert.equal(stillThere.length, 1);
    assert.equal(stillThere[0]!.store_product_id, 'current');
    assert.equal(stillThere[0]!.valid_to, null);
  });
});

test('queryDeals is a true interval join: each covered date returns the interval that was current then', () => {
  withDb((repo, db) => {
    // Build a 3-interval history with explicit, well-spaced valid_from and
    // valid_to timestamps so the interval join picks the right row per
    // queried date. recordSnapshot's NOW-based valid_from would put all
    // three in the same millisecond, which is fine for write-side tests
    // but not for query-side tests that need to discriminate by date.
    db.prepare(
      `INSERT INTO daily_snapshot
         (snapshot_date, captured_at, store_id, location_id, store_product_id,
          name, brand, size, category, image_url, product_url,
          regular_cents, current_cents, effective_unit_cents, discount_pct,
          promo_kind, promo_text, unit_price_text, in_stock, valid_from, valid_to)
       VALUES ('2026-01-01', '2026-01-01 12:00:00', 'foodlion', NULL, 'yo-yo',
               'Product', NULL, NULL, 'Produce', NULL, NULL,
               200, 200, 200, 0, 'none', NULL, NULL, 1,
               '2026-01-01 00:00:00', '2026-01-09 23:59:59')`,
    ).run();
    db.prepare(
      `INSERT INTO daily_snapshot
         (snapshot_date, captured_at, store_id, location_id, store_product_id,
          name, brand, size, category, image_url, product_url,
          regular_cents, current_cents, effective_unit_cents, discount_pct,
          promo_kind, promo_text, unit_price_text, in_stock, valid_from, valid_to)
       VALUES ('2026-01-10', '2026-01-10 12:00:00', 'foodlion', NULL, 'yo-yo',
               'Product', NULL, NULL, 'Produce', NULL, NULL,
               150, 150, 150, 0, 'none', NULL, NULL, 1,
               '2026-01-10 00:00:00', '2026-01-19 23:59:59')`,
    ).run();
    db.prepare(
      `INSERT INTO daily_snapshot
         (snapshot_date, captured_at, store_id, location_id, store_product_id,
          name, brand, size, category, image_url, product_url,
          regular_cents, current_cents, effective_unit_cents, discount_pct,
          promo_kind, promo_text, unit_price_text, in_stock, valid_from, valid_to)
       VALUES ('2026-01-20', '2026-01-20 12:00:00', 'foodlion', NULL, 'yo-yo',
               'Product', NULL, NULL, 'Produce', NULL, NULL,
               200, 200, 200, 0, 'none', NULL, NULL, 1,
               '2026-01-20 00:00:00', NULL)`,
    ).run();

    // Day 5 is inside the first interval (200).
    assert.equal(repo.queryDeals({ date: '2026-01-05' }).rows[0]!.currentCents, 200);
    // Day 15 is inside the second (discounted 150) interval.
    assert.equal(repo.queryDeals({ date: '2026-01-15' }).rows[0]!.currentCents, 150);
    // Day 25 is inside the third (back to 200, open) interval.
    assert.equal(repo.queryDeals({ date: '2026-01-25' }).rows[0]!.currentCents, 200);
    // And the rows exist exactly once per interval — 3 rows total.
    const rowCount = (
      db.prepare('SELECT COUNT(*) AS c FROM daily_snapshot').get() as { c: number }
    ).c;
    assert.equal(rowCount, 3, 'three price changes, three rows, not thirty');
  });
});

test('/api/deals?date=<2nd> returns the same product as /api/deals?date=<1st>', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bastille-intervals-http-'));
  const db = openDb(join(dir, 'test.db'));
  const app: FastifyInstance = Fastify();
  const repo = new Repo(db);
  const stubPoller = { onPoll: (_fn: () => void) => undefined } as unknown as Parameters<typeof registerRoutes>[2];
  registerRoutes(app, repo, stubPoller, undefined, { clearance: undefined });
  const base = await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    // The 30-day run test uses dates relative to "now" so the row's
    // valid_from is on the same day as the queried dates; otherwise the
    // back-dated query would find no row.
    const day1 = dayDate(1);
    const day15 = dayDate(15);
    repo.recordSnapshot(day1, [{ offer: offer('steady', 199), locationId: null }]);
    const r1 = (await (await fetch(`${base}/api/deals?date=${day1}`)).json()) as {
      source: string;
      date: string;
      total: number;
      rows: { storeProductId: string; currentCents: number | null }[];
    };
    const r15 = (await (await fetch(`${base}/api/deals?date=${day15}`)).json()) as {
      source: string;
      date: string;
      total: number;
      rows: { storeProductId: string; currentCents: number | null }[];
    };
    assert.equal(r1.source, 'snapshot');
    assert.equal(r15.source, 'snapshot');
    assert.equal(r1.total, 1, 'day1 sees the one open interval');
    assert.equal(r15.total, 1, 'day15 sees the same open interval');
    assert.equal(r1.rows[0]!.storeProductId, 'steady');
    assert.equal(r15.rows[0]!.storeProductId, 'steady');
    assert.equal(r1.rows[0]!.currentCents, 199);
    assert.equal(r15.rows[0]!.currentCents, 199);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
