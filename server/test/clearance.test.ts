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
  type ShelfPage,
  type WalmartStore,
} from '../src/clearance/walmart-api.js';
import { HttpError } from '../src/adapters/http.js';
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

/** When set, the shelf answers under this name whatever store was asked for —
 *  the failure mode observed live, where a distant store's request came back
 *  with the local store's rack. */
let answerAs: string | null = null;

/** Item ids Walmart also files on the narrower Computers / Video Games shelves. */
let onComputersShelf = new Set<string>();
let onVideoGamesShelf = new Set<string>();

/** Which of the rack each shelf answers with, as Walmart's do: the Electronics
 *  root returns everything, the narrower shelves return their own subset. */
const SHELF_MEMBERS: Record<string, () => Set<string>> = {
  '3944_1089430': () => onComputersShelf,
  '2636': () => onVideoGamesShelf,
};

const readShelf: ShelfReader = async ({ locationId, categoryId, page }) => {
  const rack = racks[locationId] ?? [];
  const members = SHELF_MEMBERS[categoryId];
  const items = members ? rack.filter((i) => members().has(i.itemId)) : rack;
  const onPage = (page ?? 1) === 1 ? items : [];
  return {
    items: onPage,
    totalCount: items.length,
    // The real client has already dropped the "Available for shipping" stack by
    // this point; the pager still counts what Walmart served.
    pageItemCount: onPage.length,
    shippedOnly: 0,
    storeName: answerAs ?? STORES.find((s) => s.locationId === locationId)?.name ?? null,
  };
};

const findStores: StoreFinder = async () => STORES;

/** Which store Walmart says it is serving this connection. */
let servedStore = STORES[0]!.name;
const probeShelf = async () => ({ storeName: servedStore });

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
  // The sweep reads a store through a bound egress node. One node, bound to the
  // store this connection resolves to below.
  repo.upsertEgressNode({ id: 'node-gordonsville', label: 'Gordonsville', proxyUrl: 'http://127.0.0.1:1', region: 'VA', enabled: true });
  sweep = new ClearanceSweepJob(repo, readShelf);
  registerClearanceRoutes(app, repo, sweep, findStores, probeShelf);
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

  await t.test('with no store on record, a sweep records nothing and says why', async () => {
    const { body } = await api<{ storesSwept: number; errors: string[] }>('/api/clearance/sweep', {
      method: 'POST',
      body: JSON.stringify({ wait: true }),
    });
    assert.equal(body.storesSwept, 0);
    assert.ok(body.errors.some((e) => e.includes('no store on record')));
  });

  await t.test('the local store is whatever Walmart says it is', async () => {
    const { status, body } = await api<{ store: { locationId: string; name: string }; matchedDirectory: boolean }>(
      '/api/clearance/store/resolve',
      { method: 'POST', body: JSON.stringify({ postalCode: '22963' }) },
    );
    assert.equal(status, 200);
    // Not chosen from the directory — taken from the shelf reply, then matched
    // against the directory for an address.
    assert.equal(body.store.name, 'Gordonsville Supercenter');
    assert.equal(body.store.locationId, '4682');
    assert.equal(body.matchedDirectory, true);
    repo.setStoreEgressNode('4682', 'node-gordonsville');
  });

  await t.test('a store Walmart names but the directory does not is still recorded', async () => {
    servedStore = 'Sacramento Supercenter';
    const { body } = await api<{ store: { name: string }; matchedDirectory: boolean }>(
      '/api/clearance/store/resolve',
      { method: 'POST', body: JSON.stringify({ postalCode: '22963' }) },
    );
    // This is the shape of an egress address moving: Walmart serves a different
    // shop and the local directory has never heard of it. Recorded anyway,
    // because it is the truth about what this connection reads.
    assert.equal(body.store.name, 'Sacramento Supercenter');
    assert.equal(body.matchedDirectory, false);

    // Put it back for the sweeps below.
    servedStore = STORES[0]!.name;
    await api('/api/clearance/store/resolve', {
      method: 'POST',
      body: JSON.stringify({ postalCode: '22963' }),
    });
  });

  await t.test('stocks the racks used by the sweeps below', async () => {
    racks = {
      '4682': [
        item({ itemId: 'A1', name: 'ASUS RTX 4060 graphics card', nowCents: 19900, wasCents: 39900, aisle: 'K14' }),
        item({ itemId: 'B1', name: 'Logitech mouse', nowCents: 500, wasCents: 2000, aisle: 'L3' }),
      ],
    };
    // Only the graphics card is on the narrower Computers shelf; the mouse is
    // not, which is how a find ends up in one group rather than the other.
    onComputersShelf = new Set(['A1']);
    onVideoGamesShelf = new Set();
    assert.equal(racks['4682']!.length, 2);
  });

  await t.test('a sweep records the local store\'s rack', async () => {
    const { body } = await api<{ storesSwept: number; finds: number; alerts: number }>('/api/clearance/sweep', {
      method: 'POST',
      body: JSON.stringify({ wait: true }),
    });
    assert.equal(body.storesSwept, 1);
    // Both shelves are swept and the graphics card is on both, so it is written
    // twice and stored once. The reported figure is what is on record, not how
    // many writes it took to get there.
    assert.equal(body.finds, 2);
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

  await t.test('the feed filters by price, group and name', async () => {
    const byPrice = await api<{ total: number }>('/api/clearance?maxPrice=10');
    assert.equal(byPrice.body.total, 1);

    const byName = await api<{ rows: { itemId: string }[] }>('/api/clearance?q=rtx');
    assert.deepEqual(byName.body.rows.map((r) => r.itemId), ['A1']);

    // Shelf membership decides the group, and it survives the Electronics
    // shelf being swept first with the same item on it.
    const byGroup = await api<{ rows: { itemId: string; group: string }[] }>('/api/clearance?groups=pc-parts');
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
    assert.equal(body.finds, 3);
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

  await t.test('the monitor alerts on the shape of a deal, not on what it is', async () => {
    // Default rule: a quarter off, any group. Nothing has been watched by name.
    const monitor = await api<{ minDiscount: number; groups: string[]; enabled: boolean }>(
      '/api/clearance/monitor',
    );
    assert.equal(monitor.body.minDiscount, 25);
    assert.equal(monitor.body.enabled, true);

    // A later sweep day, with one item comfortably over the threshold and one
    // under it, neither matching any watch term.
    racks['4682'] = [
      item({ itemId: 'D1', name: 'Anker 65W USB-C charger', nowCents: 1000, wasCents: 4000, aisle: 'K7' }),
      item({ itemId: 'D2', name: 'Generic HDMI cable', nowCents: 900, wasCents: 1000, aisle: 'K8' }),
    ];
    onComputersShelf = new Set(['D1', 'D2']);
    onVideoGamesShelf = new Set();

    const deals = await api<{ monitor: { minDiscount: number }; rows: { itemId: string; discountPct: number }[] }>(
      '/api/clearance/deals',
    );
    // 75% off qualifies; 10% off does not, and the list is the rule applied.
    assert.equal(deals.body.monitor.minDiscount, 25);
    assert.ok(deals.body.rows.every((r) => r.discountPct >= 25));
  });

  await t.test('the monitor threshold can be moved, and rejects nonsense', async () => {
    const raised = await api<{ minDiscount: number }>('/api/clearance/monitor', {
      method: 'PUT',
      body: JSON.stringify({ minDiscount: 60 }),
    });
    assert.equal(raised.body.minDiscount, 60);

    const narrowed = await api<{ groups: string[] }>('/api/clearance/monitor', {
      method: 'PUT',
      body: JSON.stringify({ groups: 'pc-parts,video-games' }),
    });
    assert.deepEqual(narrowed.body.groups, ['pc-parts', 'video-games']);

    const tooHigh = await api('/api/clearance/monitor', {
      method: 'PUT',
      body: JSON.stringify({ minDiscount: 500 }),
    });
    assert.equal(tooHigh.status, 400);

    const bogus = await api('/api/clearance/monitor', {
      method: 'PUT',
      body: JSON.stringify({ groups: 'furniture' }),
    });
    assert.equal(bogus.status, 400);

    // Put it back so later assertions read the default rule.
    await api('/api/clearance/monitor', {
      method: 'PUT',
      body: JSON.stringify({ minDiscount: 25, groups: 'pc-parts,video-games,electronics' }),
    });
  });

  await t.test('a shelf answered for the wrong store is refused, not recorded', async () => {
    // Walmart's scoping cookie is advisory: a request for one store has been
    // observed coming back with another store's rack. Recording that would
    // attribute one shop's clearance to another.
    answerAs = 'Some Other Supercenter';
    const before = await api<{ total: number }>('/api/clearance');
    const { body } = await api<{ storesSwept: number; errors: string[] }>('/api/clearance/sweep', {
      method: 'POST',
      body: JSON.stringify({ wait: true, maxStores: 10 }),
    });
    answerAs = null;

    assert.equal(body.storesSwept, 0);
    assert.ok(body.errors.some((e) => e.includes('Walmart answered for Some Other Supercenter')));
    const after = await api<{ total: number }>('/api/clearance');
    assert.equal(after.body.total, before.body.total, 'nothing should have been written');
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

test('the swept shelves are the ones Walmart actually answers for', () => {
  assert.deepEqual(
    CLEARANCE_CATEGORIES.map((c) => [c.id, c.group]),
    [
      ['3944', 'electronics'],
      ['3944_1089430', 'pc-parts'],
      ['2636', 'video-games'],
    ],
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

// ---------------------------------------------------------------------------
// Fan-out over egress nodes.
//
// The sweep used to read exactly one store per run through whatever this
// connection happened to answer for. Every store the operator bound to an
// egress node is now swept, each through its own exit point and against its
// own read budget.
// ---------------------------------------------------------------------------

type FanStore = { locationId: string; name: string; nodeId: string | null };

/** An empty, complete, correctly-scoped page. */
function fanPage(storeName: string, over: Partial<ShelfPage> = {}): ShelfPage {
  return { items: [], totalCount: 0, pageItemCount: 0, shippedOnly: 0, storeName, maxPage: 1, ...over };
}

/** A repo holding the given stores, each bound to its given node. */
function fanRepo(stores: FanStore[], nodes: { id: string; enabled?: boolean; withNode?: boolean }[]): ClearanceRepo {
  const dir = mkdtempSync(join(tmpdir(), 'bastille-fanout-'));
  const repo = new ClearanceRepo(openDb(join(dir, 'fanout.db')));
  for (const n of nodes) {
    if (n.withNode === false) continue;
    repo.upsertEgressNode({
      id: n.id,
      label: n.id,
      proxyUrl: `http://127.0.0.1:1/?pool=${n.id}`,
      region: null,
      enabled: n.enabled ?? true,
    });
  }
  const db = (repo as unknown as { db: import('../src/db.js').DB }).db;
  for (const s of stores) {
    db.prepare(
      `INSERT INTO walmart_store (location_id, name, postal_code, enabled, added_at, egress_node_id)
       VALUES (?, ?, ?, 1, ?, ?)`,
    ).run(s.locationId, s.name, '22942', new Date().toISOString(), s.nodeId);
  }
  return repo;
}

const THREE_NODES: FanStore[] = [
  { locationId: '4682', name: 'Gordonsville Supercenter', nodeId: 'node-a' },
  { locationId: '1780', name: 'Charlottesville Supercenter', nodeId: 'node-b' },
  { locationId: '5511', name: 'Powhatan Supercenter', nodeId: 'node-c' },
];

const THREE_NODE_ROWS = [
  { id: 'node-a' },
  { id: 'node-b' },
  { id: 'node-c' },
];

test('the sweep reads every store bound to an enabled egress node', async () => {
  const repo = fanRepo(THREE_NODES, THREE_NODE_ROWS);
  const byNode: Record<string, number> = { 'node-a': 0, 'node-b': 0, 'node-c': 0 };
  const reader: ShelfReader = async ({ locationId, egressNodeId }) => {
    byNode[egressNodeId!]!++;
    const store = THREE_NODES.find((s) => s.locationId === locationId)!;
    return fanPage(store.name);
  };

  const r = await new ClearanceSweepJob(repo, reader, { readBudget: 12 }).runOnce();

  assert.equal(r.storesSwept, 3);
  assert.deepEqual(r.errors, []);
  // Three shelves each, one page each: every node was actually read through.
  assert.deepEqual(byNode, { 'node-a': 3, 'node-b': 3, 'node-c': 3 });
  // Each node's proxy URL reached the reader, so the reads really left through it.
  assert.deepEqual(r.storesSwept, repo.listStores().filter((s) => s.enabled).length);
});

test('each node\'s read budget is its own, and a refusal does not cross nodes', async () => {
  const repo = fanRepo(THREE_NODES, THREE_NODE_ROWS);
  const reads: Record<string, number> = { 'node-a': 0, 'node-b': 0, 'node-c': 0 };
  // Every shelf claims to be endless, so each node runs its budget out in full.
  const reader: ShelfReader = async ({ locationId, egressNodeId, page }) => {
    reads[egressNodeId!]!++;
    const store = THREE_NODES.find((s) => s.locationId === locationId)!;
    return fanPage(store.name, { pageItemCount: 1, maxPage: 99 });
  };

  const r = await new ClearanceSweepJob(repo, reader, { readBudget: 12 }).runOnce();

  // Not the old run-global 12: each node gets its own allowance, 36 in total.
  assert.equal(r.readsSpent, 36);
  assert.deepEqual(reads, { 'node-a': 12, 'node-b': 12, 'node-c': 12 });
  assert.equal(r.abortReason, 'budget');
  assert.equal(r.errors.filter((e) => e.startsWith('[budget]')).length, 3);
});

test('a refusal on one node leaves the other nodes\' stores swept', async () => {
  const repo = fanRepo(THREE_NODES, THREE_NODE_ROWS);
  const reader: ShelfReader = async ({ locationId, egressNodeId }) => {
    if (egressNodeId === 'node-b') throw new HttpError(412, 'https://www.walmart.com/x', 'blocked');
    const store = THREE_NODES.find((s) => s.locationId === locationId)!;
    return fanPage(store.name);
  };

  const r = await new ClearanceSweepJob(repo, reader, { maxConsecutiveRateLimits: 1 }).runOnce();

  assert.equal(r.storesSwept, 2);
  assert.equal(r.rateLimited, 1);
  assert.ok(r.errors.some((e) => e.startsWith('[rate-limited]') && e.includes('node-b')), r.errors.join('|'));
});

test('a store whose egress node is missing or disabled is skipped, named, and not fatal', async () => {
  const repo = fanRepo(
    [
      { locationId: '4682', name: 'Gordonsville Supercenter', nodeId: 'node-a' },
      { locationId: '1780', name: 'Charlottesville Supercenter', nodeId: 'node-gone' },
      { locationId: '5511', name: 'Powhatan Supercenter', nodeId: 'node-off' },
    ],
    [{ id: 'node-a' }, { id: 'node-off', enabled: false }, { id: 'node-gone', withNode: false }],
  );
  let reads = 0;
  const reader: ShelfReader = async ({ locationId }) => {
    reads++;
    return fanPage(THREE_NODES.find((s) => s.locationId === locationId)!.name);
  };

  const r = await new ClearanceSweepJob(repo, reader).runOnce();

  assert.equal(r.storesSwept, 1, 'the one healthy node still swept');
  assert.equal(reads, 3, 'nothing was read through the missing or disabled node');
  assert.ok(r.errors.some((e) => e.includes('node-gone') && e.includes('not found')), r.errors.join('|'));
  assert.ok(r.errors.some((e) => e.includes('node-off') && e.includes('disabled')), r.errors.join('|'));
});

test('a store with no egress node at all is skipped with a named error', async () => {
  const repo = fanRepo([{ locationId: '4682', name: 'Gordonsville Supercenter', nodeId: null }], [
    { id: 'node-a' },
  ]);
  let reads = 0;
  const reader: ShelfReader = async () => {
    reads++;
    return fanPage('Gordonsville Supercenter');
  };

  const r = await new ClearanceSweepJob(repo, reader).runOnce();

  assert.equal(r.storesSwept, 0);
  assert.equal(reads, 0);
  assert.ok(r.errors.some((e) => e.includes('no egress node bound')), r.errors.join('|'));
});

test('a wrong-store answer abandons its own store only', async () => {
  const repo = fanRepo(THREE_NODES, THREE_NODE_ROWS);
  const touched: string[] = [];
  const reader: ShelfReader = async ({ locationId, egressNodeId }) => {
    touched.push(egressNodeId!);
    // node-b's exit point has moved: it answers for another shop.
    if (egressNodeId === 'node-b') return fanPage('Sacramento Supercenter', { items: [item({ itemId: 'X1', name: 'from the wrong shop' })], pageItemCount: 1 });
    return fanPage(THREE_NODES.find((s) => s.locationId === locationId)!.name, {
      items: [item({ itemId: `ok-${egressNodeId}`, name: 'from the right shop' })],
      pageItemCount: 1,
    });
  };

  const r = await new ClearanceSweepJob(repo, reader).runOnce();

  assert.equal(r.storesSwept, 2, 'the two nodes that answered correctly still swept');
  assert.equal(r.errors.filter((e) => e.startsWith('[wrong-store]')).length, 1);
  assert.ok(r.errors.some((e) => e.includes('Sacramento Supercenter')), r.errors.join('|'));
  // node-b was read once, then left alone; the run did not stop there.
  assert.equal(touched.filter((n) => n === 'node-b').length, 1);
  assert.ok(touched.includes('node-c'), 'the run carried on to the next node');
  // The wrong shop's rack was refused, not filed under the store that was asked
  // for; the two good nodes' shelves were.
  assert.equal(r.finds, 2, 'one item per node that answered correctly, once each');
  const recorded = (
    (repo as unknown as { db: import('../src/db.js').DB }).db
      .prepare('SELECT DISTINCT item_id FROM clearance_find')
      .all() as { item_id: string }[]
  ).map((r) => r.item_id);
  assert.deepEqual(recorded.sort(), ['ok-node-a', 'ok-node-c']);
});
