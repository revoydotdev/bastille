/**
 * Snapshot retention. The corpus is ~65,000 rows and ~29 MB a day (per the
 * comment at `server/src/clearance/repo.ts:640-641` — a comment, not a
 * measurement), so an unbounded `daily_snapshot` grows about 10 GB a year
 * for data nothing reads. Pruning is bounded to that table and its run rows;
 * watched-item history lives in `price_point` and must survive.
 *
 * Since todo 3 turned the table into interval rows, pruning is
 * interval-aware: only CLOSED rows whose `valid_to` is older than the cutoff
 * are deleted. Open rows (`valid_to IS NULL`) are never pruned, regardless
 * of `valid_from`. The tests below set up CLOSED intervals explicitly so the
 * old "old date goes, new date stays" assertions still hold for the closed
 * subset of the table — see `server/test/snapshot-intervals.test.ts` for
 * the open-interval side of the contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { Repo } from '../src/repo.js';
import type { Offer } from '../src/price/model.js';

const TODAY = new Date('2026-09-06T12:00:00Z');

function offer(id: string): Offer {
  return {
    product: {
      storeId: 'foodlion', storeProductId: id, name: `Product ${id}`,
      brand: null, size: null, imageUrl: null, productUrl: null, category: 'Produce',
    },
    price: {
      regularCents: 199, currentCents: 199, effectiveUnitCents: 199,
      promoKind: 'none', promoText: null, promoDetail: null,
      unitPriceText: '$0.19/oz', inStock: true, capturedAt: TODAY.toISOString(),
    },
  };
}

function withRepo(fn: (repo: Repo, db: DB) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bastille-retention-'));
  const db = openDb(join(dir, 'test.db'));
  try {
    fn(new Repo(db), db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Write a CLOSED snapshot row directly. `recordSnapshot` would open the
 * interval (`valid_to = NULL`); pruning by date only acts on closed rows, so
 * the old per-day tests have to materialise a closed row to be prunable.
 * `valid_from`/`valid_to` are explicit so the date the test cares about is
 * the one `pruneSnapshots` will compare against.
 */
function writeClosed(
  db: DB,
  date: string,
  productId: string,
  cents: number,
  validFrom: string,
  validTo: string,
): void {
  db.prepare(
    `INSERT INTO daily_snapshot
       (snapshot_date, captured_at, store_id, location_id, store_product_id,
        name, brand, size, category, image_url, product_url,
        regular_cents, current_cents, effective_unit_cents, discount_pct,
        promo_kind, promo_text, unit_price_text, in_stock, valid_from, valid_to)
     VALUES (?, ?, 'foodlion', NULL, ?, 'Product', NULL, NULL, 'Produce',
             NULL, NULL, ?, ?, ?, 0, 'none', NULL, NULL, 1, ?, ?)`,
  ).run(date, validFrom, productId, cents, cents, cents, validFrom, validTo);
}

test('closed intervals outside the window are pruned; ones inside it stay', () => {
  withRepo((repo, db) => {
    writeClosed(db, '2026-01-01', 'old', 199, '2026-01-01 00:00:00', '2026-01-01 23:59:59');
    writeClosed(db, '2026-09-01', 'recent', 199, '2026-09-01 00:00:00', '2026-09-01 23:59:59');
    writeClosed(db, '2026-09-06', 'today', 199, '2026-09-06 00:00:00', '2026-09-06 23:59:59');

    assert.equal(repo.pruneSnapshots(90, TODAY), 1);
    assert.deepEqual(repo.snapshotDates(), ['2026-09-06', '2026-09-01']);
  });
});

test('the current closed corpus is inside a 90-day window, so nothing is dropped', () => {
  withRepo((repo, db) => {
    for (const d of ['2026-08-20', '2026-08-23', '2026-09-06']) {
      writeClosed(db, d, `p-${d}`, 199, `${d} 00:00:00`, `${d} 23:59:59`);
    }
    assert.equal(repo.pruneSnapshots(90, TODAY), 0);
    assert.equal(repo.snapshotDates().length, 3);
  });
});

test('a retention of zero or less keeps every closed row', () => {
  withRepo((repo, db) => {
    writeClosed(db, '2020-01-01', 'ancient', 199, '2020-01-01 00:00:00', '2020-01-01 23:59:59');
    assert.equal(repo.pruneSnapshots(0, TODAY), 0);
    assert.equal(repo.pruneSnapshots(-1, TODAY), 0);
    assert.equal(repo.snapshotDates().length, 1);
  });
});

test('pruning does not touch watched-item price history', () => {
  withRepo((repo, db) => {
    const stored = repo.upsertProduct(offer('watched'));
    repo.recordPrice(stored.id, null, offer('watched').price);
    writeClosed(db, '2020-01-01', 'ancient', 199, '2020-01-01 00:00:00', '2020-01-01 23:59:59');

    assert.equal(repo.pruneSnapshots(90, TODAY), 1);
    assert.equal(repo.priceHistory(stored.id, null).length, 1);
  });
});
