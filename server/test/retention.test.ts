/**
 * Snapshot retention. The corpus is ~65,000 rows and ~29 MB a day, so an
 * unbounded `daily_snapshot` grows about 10 GB a year for days nothing reads.
 * Pruning is bounded to that table and its run rows: watched-item history
 * lives in `price_point` and must survive.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
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

function withRepo(fn: (repo: Repo) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bastille-retention-'));
  const db = openDb(join(dir, 'test.db'));
  try {
    fn(new Repo(db));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('days outside the window go, days inside it stay', () => {
  withRepo((repo) => {
    repo.recordSnapshot('2026-01-01', [{ offer: offer('old'), locationId: null }]);
    repo.recordSnapshot('2026-09-01', [{ offer: offer('recent'), locationId: null }]);
    repo.recordSnapshot('2026-09-06', [{ offer: offer('today'), locationId: null }]);

    assert.equal(repo.pruneSnapshots(90, TODAY), 1);
    assert.deepEqual(repo.snapshotDates(), ['2026-09-06', '2026-09-01']);
  });
});

test('the current corpus is inside a 90-day window, so nothing is dropped', () => {
  withRepo((repo) => {
    for (const d of ['2026-08-20', '2026-08-23', '2026-09-06']) {
      repo.recordSnapshot(d, [{ offer: offer(`p-${d}`), locationId: null }]);
    }
    assert.equal(repo.pruneSnapshots(90, TODAY), 0);
    assert.equal(repo.snapshotDates().length, 3);
  });
});

test('a retention of zero or less keeps every day', () => {
  withRepo((repo) => {
    repo.recordSnapshot('2020-01-01', [{ offer: offer('ancient'), locationId: null }]);
    assert.equal(repo.pruneSnapshots(0, TODAY), 0);
    assert.equal(repo.pruneSnapshots(-1, TODAY), 0);
    assert.equal(repo.snapshotDates().length, 1);
  });
});

test('pruning does not touch watched-item price history', () => {
  withRepo((repo) => {
    const stored = repo.upsertProduct(offer('watched'));
    repo.recordPrice(stored.id, null, offer('watched').price);
    repo.recordSnapshot('2020-01-01', [{ offer: offer('ancient'), locationId: null }]);

    assert.equal(repo.pruneSnapshots(90, TODAY), 1);
    assert.equal(repo.priceHistory(stored.id, null).length, 1);
  });
});
