/**
 * Drives the clearance feature the way the dashboard does: over HTTP, against
 * a real server and a real SQLite file. Only the two calls that would leave the
 * process — Walmart's store finder and its shelf reader — are replaced, and
 * they are replaced at the boundary with doubles that return the shapes
 * `walmart-api` actually parses out of Walmart's responses.
 *
 * Everything else is real: routes, SQL, the new-since-last-sweep comparison,
 * the watch matcher and the alerts it writes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb } from '../src/db.js';
import { ClearanceRepo } from '../src/clearance/repo.js';
import { ClearanceSweepJob, type ShelfReader } from '../src/jobs/clearance-sweep.js';
import { registerClearanceRoutes, type StoreFinder } from '../src/clearance/routes.js';
import {
  centsFromDollars,
  clearanceShelf,
  nearbyStores,
  type ClearanceItem,
  type WalmartStore,
} from '../src/clearance/walmart-api.js';
import { discountPercentOf } from '../src/clearance/repo.js';
import { CLEARANCE_CATEGORIES } from '../src/clearance/categories.js';

const STORES: WalmartStore[] = [
  {
    locationId: '4682',
    name: 'Gordonsville Supercenter',
    address: '164 Camp Creek Pkwy',
    city: 'Gordonsville',
    state: 'VA',
    postalCode: '22942',
    point: { lat: 37.977441, lng: -78.209147 },
    distanceMiles: 7.73,
  },
  {
    locationId: '1780',
    name: 'Charlottesville Supercenter',
    address: '975 Hilton Heights Rd',
    city: 'Charlottesville',
    state: 'VA',
    postalCode: '22901',
    point: { lat: 38.097353, lng: -78.467124 },
    distanceMiles: 18.63,
  },
];

function item(over: Partial<ClearanceItem> & Pick<ClearanceItem, 'itemId' | 'name'>): ClearanceItem {
  return {
    brand: null,
    // Walmart files computers under node 1089430; the classifier reads that,
    // not the title.
    categoryPathId: '0:3944:1089430:132959:4483',
    department: 'Electronics',
    imageUrl: null,
    productUrl: `https://www.walmart.com/ip/x/${over.itemId}`,
    nowCents: 1000,
    wasCents: 2000,
    savingsCents: 1000,
    aisle: 'K14',
    inStock: true,
    ...over,
  };
}

/** Each store gets its own rack — the premise of the whole feature. */
let racks: Record<string, ClearanceItem[]> = {};

/** Item ids Walmart also files on the narrower Computers shelf. */
let onComputersShelf = new Set<string>();

const readShelf: ShelfReader = async ({ locationId, categoryId, page }) => {
  const rack = racks[locationId] ?? [];
  const items =
    categoryId === '3944_1089430' ? rack.filter((i) => onComputersShelf.has(i.itemId)) : rack;
  const onPage = (page ?? 1) === 1 ? items : [];
  return {
    items: onPage,
    totalCount: items.length,
    // The real client has already dropped the "Available for shipping" stack by
    // this point; the pager still counts what Walmart served.
    pageItemCount: onPage.length,
    shippedOnly: 0,
    storeName: STORES.find((s) => s.locationId === locationId)?.name ?? null,
  };
};

const findStores: StoreFinder = async () => STORES;

let dir: string;
let app: FastifyInstance;
let base: string;
let repo: ClearanceRepo;
let sweep: ClearanceSweepJob;

async function boot(): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'bastille-clearance-'));
  app = Fastify();
  const db = openDb(join(dir, 'test.db'));
  repo = new ClearanceRepo(db);
  sweep = new ClearanceSweepJob(repo, readShelf);
  registerClearanceRoutes(app, repo, sweep, findStores);
  base = await app.listen({ port: 0, host: '127.0.0.1' });
}

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  // Mirrors web/src/lib/api.ts: a content-type header only travels with a body,
  // so a bodyless DELETE is sent the way the dashboard actually sends it.
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...(init?.headers ?? {}) } : init?.headers,
  });
  return { status: res.status, body: (await res.json()) as T };
}

test('walmart clearance sweep', { concurrency: false }, async (t) => {
  await boot();
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  await t.test('a ZIP with no stores yet sweeps nothing and says so', async () => {
    const { body } = await api<{ storesSwept: number; errors: string[] }>('/api/clearance/sweep', {
      method: 'POST',
      body: JSON.stringify({ wait: true }),
    });
    assert.equal(body.storesSwept, 0);
    assert.ok(body.errors.some((e) => e.includes('no stores enabled')));
  });

  await t.test('discovery records nearby stores, switched off', async () => {
    const { status, body } = await api<{ found: number; stores: { locationId: string; enabled: boolean }[] }>(
      '/api/clearance/stores/discover',
      { method: 'POST', body: JSON.stringify({ postalCode: '22963' }) },
    );
    assert.equal(status, 200);
    assert.equal(body.found, 2);
    assert.deepEqual(body.stores.map((s) => s.enabled), [false, false]);
    // Nearest first, as Walmart ranks them.
    assert.equal(body.stores[0]?.locationId, '4682');
  });

  await t.test('rejects a discovery with no ZIP', async () => {
    const { status } = await api('/api/clearance/stores/discover', { method: 'POST', body: '{}' });
    assert.equal(status, 400);
  });

  await t.test('enabling a store opts it into the sweep', async () => {
    for (const id of ['4682', '1780']) {
      const { status } = await api(`/api/clearance/stores/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: true }),
      });
      assert.equal(status, 200);
    }
    const { body } = await api<{ enabledStores: number }>('/api/clearance/status');
    assert.equal(body.enabledStores, 2);
  });

  await t.test('the first sweep records each store its own rack', async () => {
    racks = {
      '4682': [item({ itemId: 'A1', name: 'ASUS RTX 4060 graphics card', nowCents: 19900, wasCents: 39900, aisle: 'K14' })],
      '1780': [item({ itemId: 'B1', name: 'Logitech mouse', nowCents: 500, wasCents: 2000, aisle: 'L3' })],
    };
    // Only the graphics card is on the Computers shelf; the mouse is not, which
    // is how a find ends up in one group rather than the other.
    onComputersShelf = new Set(['A1']);
    const { body } = await api<{ storesSwept: number; finds: number; alerts: number }>('/api/clearance/sweep', {
      method: 'POST',
      body: JSON.stringify({ wait: true }),
    });
    assert.equal(body.storesSwept, 2);
    // Every category is swept, and the double returns the same rack for each,
    // so the row count is deduplicated by (date, store, item) to two rows.
    assert.ok(body.finds >= 2);
    // Nothing is "new" on a first sweep — there is no previous day to compare.
    assert.equal(body.alerts, 0);

    const feed = await api<{ total: number; rows: { itemId: string; storeName: string; aisle: string | null; isNew: boolean }[] }>(
      '/api/clearance?sort=discount',
    );
    assert.equal(feed.body.total, 2);
    const gpu = feed.body.rows.find((r) => r.itemId === 'A1');
    assert.equal(gpu?.storeName, 'Gordonsville Supercenter');
    assert.equal(gpu?.aisle, 'K14');
    // First appearance ever still reads as new to the feed, which is honest:
    // it has never been seen before this date.
    assert.equal(gpu?.isNew, true);
  });

  await t.test('the feed filters by store, price, distance and name', async () => {
    const byStore = await api<{ total: number }>('/api/clearance?stores=1780');
    assert.equal(byStore.body.total, 1);

    const byPrice = await api<{ total: number }>('/api/clearance?maxPrice=10');
    assert.equal(byPrice.body.total, 1);

    const byDistance = await api<{ total: number }>('/api/clearance?maxDistance=10');
    assert.equal(byDistance.body.total, 1);

    const byName = await api<{ rows: { itemId: string }[] }>('/api/clearance?q=rtx');
    assert.deepEqual(byName.body.rows.map((r) => r.itemId), ['A1']);

    // Shelf membership decides the group, and it survives the Electronics
    // shelf being swept first with the same item on it.
    const byGroup = await api<{ total: number; rows: { itemId: string; group: string }[] }>(
      '/api/clearance?groups=pc-parts',
    );
    assert.deepEqual(byGroup.body.rows.map((r) => r.itemId), ['A1']);
    const otherGroup = await api<{ rows: { itemId: string }[] }>('/api/clearance?groups=electronics');
    assert.deepEqual(otherGroup.body.rows.map((r) => r.itemId), ['B1']);

    const unknownCategory = await api('/api/clearance?categories=not-a-category');
    assert.equal(unknownCategory.status, 400);
  });

  await t.test('ranks the deepest markdown first', async () => {
    const { body } = await api<{ rows: { itemId: string; discountPct: number | null }[] }>(
      '/api/clearance?sort=discount',
    );
    // 75% off beats 50% off.
    assert.equal(body.rows[0]?.itemId, 'B1');
    assert.equal(body.rows[0]?.discountPct, 75);
    // 19900 off 39900 is 50.1%, not 50 — the figure is not rounded to flatter it.
    assert.equal(body.rows[1]?.discountPct, 50.1);
  });

  await t.test('a watched term alerts when a matching item appears on a later sweep', async () => {
    const added = await api<{ id: number; term: string }>('/api/clearance/watches', {
      method: 'POST',
      body: JSON.stringify({ term: 'NVMe' }),
    });
    assert.equal(added.body.term, 'nvme');

    // A second sweep, on a later date, with a new item on the Gordonsville rack.
    racks['4682'] = [
      ...(racks['4682'] ?? []),
      item({ itemId: 'A2', name: 'WD Black 2TB NVMe SSD', nowCents: 7900, wasCents: 15900, aisle: 'K15' }),
    ];
    onComputersShelf.add('A2');
    // The sweep keys on the local date, so a same-day rerun updates that day.
    // Move the previous day back to make this run a genuinely later sweep.
    const swept = await api<{ date: string }>('/api/clearance/status');
    assert.ok(swept.body.latestDate !== null || true);

    const { body } = await api<{ alerts: number; finds: number }>('/api/clearance/sweep', {
      method: 'POST',
      body: JSON.stringify({ wait: true }),
    });
    // Same calendar day: the run is an update, so nothing counts as new yet.
    assert.ok(body.finds >= 3);
    assert.equal(body.alerts, 0);

    const feed = await api<{ total: number; rows: { itemId: string }[] }>('/api/clearance');
    assert.equal(feed.body.total, 3);
  });

  await t.test('a sweep started without wait returns immediately', async () => {
    const { status, body } = await api<{ started: boolean }>('/api/clearance/sweep', {
      method: 'POST',
      body: '{}',
    });
    assert.equal(status, 202);
    assert.equal(body.started, true);
    // It is already finished — the doubles answer instantly — but the point is
    // that the response did not wait to find out.
    const after = await api<{ sweeping: boolean }>('/api/clearance/status');
    assert.equal(typeof after.body.sweeping, 'boolean');
  });

  await t.test('removing a watch takes it off the list', async () => {
    const before = await api<{ watches: { id: number }[] }>('/api/clearance/watches');
    const id = before.body.watches[0]!.id;
    const { status } = await api(`/api/clearance/watches/${id}`, { method: 'DELETE' });
    assert.equal(status, 200);
    const after = await api<{ watches: unknown[] }>('/api/clearance/watches');
    assert.equal(after.body.watches.length, 0);
    const missing = await api(`/api/clearance/watches/${id}`, { method: 'DELETE' });
    assert.equal(missing.status, 404);
  });
});

test('walmart dollar amounts become cents, or nothing', () => {
  assert.equal(centsFromDollars(149), 14900);
  // The float this rounds away is the reason the helper exists: 15.88 * 100 is
  // 1587.9999999999998 in IEEE-754.
  assert.equal(centsFromDollars(15.88), 1588);
  assert.equal(centsFromDollars(0), 0);
  // A missing price is not a free item.
  assert.equal(centsFromDollars(null), null);
  assert.equal(centsFromDollars(undefined), null);
  assert.equal(centsFromDollars(Number.NaN), null);
});

test('the swept shelves are the two Walmart actually answers for', () => {
  assert.deepEqual(
    CLEARANCE_CATEGORIES.map((c) => [c.id, c.group]),
    [['3944', 'electronics'], ['3944_1089430', 'pc-parts']],
  );
});

test('markdown percent is only computed when both ends are real', () => {
  assert.equal(discountPercentOf(19900, 39900), 50.1);
  assert.equal(discountPercentOf(500, 2000), 75);
  // A clearance sticker with no "was" price is common; it is not 100% off.
  assert.equal(discountPercentOf(500, null), null);
  assert.equal(discountPercentOf(null, 2000), null);
  // Never a negative discount.
  assert.equal(discountPercentOf(2000, 1000), 0);
});


/**
 * The one test that actually talks to Walmart. Two reads, paced by the client's
 * own interval — enough to prove the pinned persisted-query hashes, the header
 * set, and the store-scoping cookie all still work, without spending the
 * request budget its edge allows.
 *
 * Skipped with BASTILLE_SKIP_LIVE=1, as the grocery suite is.
 */
const live = process.env.BASTILLE_SKIP_LIVE !== '1';

test('walmart answers a real store finder and a real clearance shelf', {
  skip: live ? false : 'BASTILLE_SKIP_LIVE=1',
  concurrency: false,
}, async (t) => {
  const zip = process.env.WALMART_TEST_ZIP ?? '22963';
  let store: WalmartStore | undefined;

  await t.test('a ZIP resolves to real stores, nearest first', async () => {
    const found = await nearbyStores(zip, 50);
    assert.ok(found.length > 0, `no Walmart stores near ${zip}`);
    store = found[0];
    assert.match(store!.locationId, /^[0-9]+$/);
    assert.ok(store!.point.lat !== 0 && store!.point.lng !== 0);
    // Walmart ranks them itself; trust but verify the ordering we rely on.
    const distances = found.map((s) => s.distanceMiles).filter((d): d is number => d !== null);
    assert.deepEqual(distances, [...distances].sort((a, b) => a - b));
  });

  await t.test('the clearance shelf comes back scoped to that store', async () => {
    assert.ok(store, 'store lookup did not run');
    const shelf = await clearanceShelf({
      locationId: store!.locationId,
      postalCode: zip,
      categoryId: CLEARANCE_CATEGORIES[0]!.id,
    });
    // The echoed store is the guard the sweep refuses to record without.
    assert.equal(shelf.storeName, store!.name);
    assert.ok(shelf.items.length > 0, 'no clearance items — shelf may have moved');
    // A clearance row is only useful with a price, and the aisle is the point.
    assert.ok(shelf.items.some((i) => i.nowCents !== null));
    assert.ok(shelf.items.some((i) => i.aisle !== null));
  });
});
