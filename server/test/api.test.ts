/**
 * Drives the app the way the dashboard does: over HTTP, against a real server
 * process and a real SQLite file, hitting the live storefronts. No adapter is
 * reached into directly and no price is hand-constructed — if the wiring from
 * route to adapter to database to alert is broken, these fail.
 *
 * Network-dependent by design. Set BASTILLE_SKIP_LIVE=1 to skip.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb } from '../src/db.js';
import { Repo } from '../src/repo.js';
import { Poller } from '../src/jobs/poller.js';
import { registerRoutes } from '../src/routes.js';

const live = process.env.BASTILLE_SKIP_LIVE !== '1';

let dir: string;
let app: FastifyInstance;
let base: string;

async function boot(): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'bastille-test-'));
  app = Fastify();
  const db = openDb(join(dir, 'test.db'));
  const repo = new Repo(db);
  const poller = new Poller(repo, 60_000);
  registerRoutes(app, repo, poller);
  base = await app.listen({ port: 0, host: '127.0.0.1' });
}

async function shutdown(): Promise<void> {
  await app?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
}

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json()) as T };
}

interface SearchBody {
  results: {
    storeId: string;
    promoLabel: string | null;
    offer: {
      product: { storeProductId: string; name: string };
      price: { effectiveUnitCents: number | null; promoKind: string; currentCents: number | null };
    };
  }[];
  errors: { storeId: string; message: string }[];
}

test('bastille API', { skip: live ? false : 'BASTILLE_SKIP_LIVE=1', concurrency: false }, async (t) => {
  await boot();
  t.after(shutdown);

  let wegmansProductId = '';
  let foodlionProductId = '';

  await t.test('rejects a search with no query', async () => {
    const { status } = await api('/api/search');
    assert.equal(status, 400);
  });

  await t.test('searches both stores and ranks by comparable unit price', async () => {
    const { status, body } = await api<SearchBody>('/api/search?q=whole%20milk&limit=10');
    assert.equal(status, 200);
    assert.deepEqual(body.errors, []);
    assert.ok(body.results.length > 0, 'expected results from the live stores');

    const stores = new Set(body.results.map((r) => r.storeId));
    assert.ok(stores.has('wegmans'), 'expected Wegmans results');
    assert.ok(stores.has('foodlion'), 'expected Food Lion results');

    const priced = body.results.map((r) => r.offer.price.effectiveUnitCents).filter((c): c is number => c !== null);
    assert.ok(priced.length > 0, 'expected at least one comparable price');
    assert.deepEqual(priced, [...priced].sort((a, b) => a - b), 'cheapest first');

    wegmansProductId = body.results.find((r) => r.storeId === 'wegmans')!.offer.product.storeProductId;
    foodlionProductId = body.results.find((r) => r.storeId === 'foodlion')!.offer.product.storeProductId;
  });

  await t.test('searches a single store when asked', async () => {
    const { body } = await api<SearchBody>('/api/search?q=bagels&stores=wegmans&limit=5');
    assert.ok(body.results.length > 0);
    assert.ok(body.results.every((r) => r.storeId === 'wegmans'));
  });

  await t.test('surfaces non-numeric offers with their own copy intact', async () => {
    const { body } = await api<SearchBody>('/api/search?q=bagels&stores=wegmans&limit=25&wegmansLocation=1');
    const promos = body.results.filter((r) => r.offer.price.promoKind !== 'none');
    for (const p of promos) {
      assert.ok(p.promoLabel, `promo ${p.offer.price.promoKind} must carry a label`);
      if (p.offer.price.promoKind === 'multibuy') {
        // The whole point: a "2 for $13" offer still yields a per-unit number.
        assert.ok(p.offer.price.effectiveUnitCents !== null);
        assert.ok(p.offer.price.effectiveUnitCents! < p.offer.price.currentCents!);
      }
    }
  });

  interface GroupBody {
    group: {
      id: number;
      label: string;
      bestCents: number | null;
      bestStoreId: string | null;
      items: { watchItemId: number; product: { storeId: string; id: number }; price: { promoKind: string } | null }[];
    };
  }

  let groupId = 0;
  let productDbId = 0;

  await t.test('watching an item captures a first price point', async () => {
    const { status, body } = await api<GroupBody>('/api/watchlist', {
      method: 'POST',
      body: JSON.stringify({
        storeId: 'wegmans',
        storeProductId: wegmansProductId,
        locationId: '1',
        label: 'Whole milk',
        targetCents: 250,
      }),
    });
    assert.equal(status, 201);
    assert.equal(body.group.items.length, 1);
    assert.ok(body.group.items[0]!.price, 'a watched item must have a price immediately');
    groupId = body.group.id;
    productDbId = body.group.items[0]!.product.id;
  });

  await t.test('a second store joins the same group and the cheaper one wins', async () => {
    const { status, body } = await api<GroupBody>('/api/watchlist', {
      method: 'POST',
      body: JSON.stringify({ storeId: 'foodlion', storeProductId: foodlionProductId, groupId }),
    });
    assert.equal(status, 201);
    assert.equal(body.group.items.length, 2);
    assert.equal(new Set(body.group.items.map((i) => i.product.storeId)).size, 2);
    assert.ok(body.group.bestCents !== null, 'a two-store group must have a winner');
    assert.ok(['wegmans', 'foodlion'].includes(body.group.bestStoreId!));

    const cheapest = Math.min(
      ...body.group.items.map((i) => (i as unknown as { price: { effectiveUnitCents: number } }).price.effectiveUnitCents),
    );
    assert.equal(body.group.bestCents, cheapest);
  });

  await t.test('price history accumulates per product', async () => {
    const { body } = await api<{ history: unknown[] }>(`/api/prices/${productDbId}?locationId=1`);
    assert.equal(body.history.length, 1);
  });

  await t.test('a refresh re-reads every watched item and records another point', async () => {
    const { status, body } = await api<{ itemsPolled: number; errors: string[] }>('/api/refresh', { method: 'POST' });
    assert.equal(status, 200);
    assert.deepEqual(body.errors, []);
    assert.equal(body.itemsPolled, 2, 'both watched items must be re-read');

    const { body: hist } = await api<{ history: unknown[] }>(`/api/prices/${productDbId}?locationId=1`);
    assert.equal(hist.history.length, 2, 'the refresh must append a second price point');
  });

  await t.test('the watchlist survives a round trip and can be edited', async () => {
    const { body } = await api<GroupBody>(`/api/watchlist/${groupId}`, {
      method: 'PATCH',
      body: JSON.stringify({ label: 'Milk, both stores', notifyPromos: false }),
    });
    assert.equal(body.group.label, 'Milk, both stores');

    const { body: list } = await api<{ groups: GroupBody['group'][] }>('/api/watchlist');
    assert.equal(list.groups.length, 1);
    assert.equal(list.groups[0]!.label, 'Milk, both stores');
  });

  await t.test('removing an item leaves the rest of the group', async () => {
    const { body: before } = await api<{ groups: GroupBody['group'][] }>('/api/watchlist');
    const itemId = before.groups[0]!.items[0]!.watchItemId;
    await api(`/api/watchlist/item/${itemId}`, { method: 'DELETE' });
    const { body: after } = await api<{ groups: GroupBody['group'][] }>('/api/watchlist');
    assert.equal(after.groups[0]!.items.length, 1);
  });

  await t.test('deleting a group removes it', async () => {
    await api(`/api/watchlist/${groupId}`, { method: 'DELETE' });
    const { body } = await api<{ groups: unknown[] }>('/api/watchlist');
    assert.deepEqual(body.groups, []);
  });

  await t.test('status reports the poll that just ran', async () => {
    const { body } = await api<{ lastPoll: { itemsPolled: number; error: string | null } | null }>('/api/status');
    assert.ok(body.lastPoll);
    assert.equal(body.lastPoll!.error, null);
  });
});

/**
 * Alerts need two different readings of the same item, which a live store will
 * not produce on demand. Wegmans genuinely prices the same product differently
 * per store, so two real readings of one product at two real stores stand in
 * for two readings taken days apart. Everything downstream — change detection,
 * severity, the alert record and the HTTP read path — is the real thing.
 */
test('price changes become alerts', { skip: live ? false : 'BASTILLE_SKIP_LIVE=1', concurrency: false }, async (t) => {
  const { WegmansAdapter } = await import('../src/adapters/wegmans.js');
  const { openDb } = await import('../src/db.js');
  const { Repo } = await import('../src/repo.js');
  const { Poller } = await import('../src/jobs/poller.js');

  const dir2 = mkdtempSync(join(tmpdir(), 'bastille-alerts-'));
  const app2 = Fastify();
  const db = openDb(join(dir2, 'alerts.db'));
  const repo = new Repo(db);
  registerRoutes(app2, repo, new Poller(repo, 60_000));
  const url = await app2.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await app2.close();
    rmSync(dir2, { recursive: true, force: true });
  });

  const wegmans = new WegmansAdapter();
  // Wegmans store 1 (Fayetteville NY) and store 8 differ on this product.
  const cheap = await wegmans.fetchOffer('94427', '1');
  const dear = await wegmans.fetchOffer('94427', '8');
  assert.ok(cheap && dear, 'expected the product at both stores');
  assert.notEqual(
    cheap!.price.effectiveUnitCents,
    dear!.price.effectiveUnitCents,
    'the two stores must disagree on price for this test to mean anything',
  );

  const product = repo.upsertProduct(cheap!);
  const group = repo.createGroup('Whole milk', null, true);
  repo.addToGroup(group.id, product.id, '1');

  repo.insertPrice(product.id, '1', cheap!.price);
  const changes = repo.recordPrice(product.id, '1', dear!.price);

  assert.ok(changes.length > 0, 'a different price must register as a change');
  const numeric = changes.find((c) => c.numeric)!;
  assert.ok(numeric, 'the movement must be reported as numeric');
  assert.equal(numeric.kind, dear!.price.effectiveUnitCents! > cheap!.price.effectiveUnitCents! ? 'price_rise' : 'price_drop');

  const res = await fetch(`${url}/api/alerts?unread=1`);
  const body = (await res.json()) as { alerts: { message: string; kind: string; groupId: number | null; numeric: boolean }[] };
  assert.ok(body.alerts.length > 0, 'the change must surface as an alert over HTTP');
  const alert = body.alerts[0]!;
  assert.equal(alert.groupId, group.id, 'the alert must be attributed to the watch group');
  assert.equal(alert.numeric, true);
  assert.match(alert.message, /Price (dropped|rose) \$\d+\.\d\d/);

  // Acknowledging it removes it from the unread feed.
  const ack = await fetch(`${url}/api/alerts/${(body.alerts[0] as unknown as { id: number }).id}/ack`, { method: 'POST' });
  assert.equal(ack.status, 200);
  const after = (await (await fetch(`${url}/api/alerts?unread=1`)).json()) as { alerts: unknown[] };
  assert.equal(after.alerts.length, body.alerts.length - 1);
});

/** A promotion appearing must alert even when the shelf price is unchanged. */
test('a starting offer alerts on its own', { skip: live ? false : 'BASTILLE_SKIP_LIVE=1', concurrency: false }, async (t) => {
  const { openDb } = await import('../src/db.js');
  const { Repo } = await import('../src/repo.js');
  const { WegmansAdapter } = await import('../src/adapters/wegmans.js');

  const dir3 = mkdtempSync(join(tmpdir(), 'bastille-promo-'));
  t.after(() => rmSync(dir3, { recursive: true, force: true }));
  const repo = new Repo(openDb(join(dir3, 'promo.db')));

  // A real Wegmans multibuy, read live.
  const offer = await new WegmansAdapter().fetchOffer('55683', '1');
  assert.ok(offer, 'expected the bagels product');
  assert.equal(offer!.price.promoKind, 'multibuy', 'this product is expected to carry a multibuy offer');

  const product = repo.upsertProduct(offer!);
  const group = repo.createGroup('Bagels', null, true);
  repo.addToGroup(group.id, product.id, '1');

  // The same item before the offer started: same shelf price, no promotion.
  repo.insertPrice(product.id, '1', {
    ...offer!.price,
    promoKind: 'none',
    promoText: null,
    promoDetail: null,
    effectiveUnitCents: offer!.price.regularCents,
  });

  const changes = repo.recordPrice(product.id, '1', offer!.price);
  const started = changes.find((c) => c.kind === 'promo_started');
  assert.ok(started, 'the offer starting must be its own change');
  assert.equal(started!.numeric, false, 'an offer starting is not a numeric movement');
  assert.match(started!.message, /^New offer: Buy 2 for \$/);

  const alerts = repo.listAlerts({ unacknowledgedOnly: true });
  assert.ok(alerts.some((a) => a.kind === 'promo_started' && a.numeric === false && a.groupId === group.id));
});

interface StoresBody {
  zip: string | null;
  zipResolved: boolean;
  zipPrecision: 'exact' | 'approximate' | null;
  stores: {
    id: string;
    label: string;
    pricesVaryByLocation: boolean;
    error: string | null;
    locations: { locationId: string; name: string; address: string | null; distanceMiles: number | null }[];
  }[];
}

test('store finder', { skip: live ? false : 'BASTILLE_SKIP_LIVE=1', concurrency: false }, async (t) => {
  const dir4 = mkdtempSync(join(tmpdir(), 'bastille-stores-'));
  const app4 = Fastify();
  const { openDb } = await import('../src/db.js');
  const { Repo } = await import('../src/repo.js');
  const { Poller } = await import('../src/jobs/poller.js');
  const repo4 = new Repo(openDb(join(dir4, 'stores.db')));
  registerRoutes(app4, repo4, new Poller(repo4, 60_000));
  const url = await app4.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await app4.close();
    rmSync(dir4, { recursive: true, force: true });
  });

  const get = async (path: string) => (await (await fetch(`${url}${path}`)).json()) as StoresBody;

  await t.test('a ZIP returns both chains, nearest first', async () => {
    const body = await get('/api/stores?postalCode=22963');
    assert.equal(body.zip, '22963');
    assert.equal(body.zipResolved, true);
    assert.equal(body.zipPrecision, 'exact');
    assert.equal(body.stores.length, 2);

    for (const store of body.stores) {
      assert.equal(store.error, null, `${store.id}: ${store.error}`);
      assert.ok(store.locations.length > 0, `${store.id} returned no stores`);
      const miles = store.locations.map((l) => l.distanceMiles);
      assert.ok(miles.every((m) => m !== null), `${store.id} must report distances`);
      assert.deepEqual(miles, [...miles].sort((a, b) => a! - b!), `${store.id} must be nearest first`);
      // 22963 is Palmyra, VA — both chains have a store within an easy drive.
      assert.ok(miles[0]! < 30, `${store.id} nearest was ${miles[0]} mi away`);
    }
  });

  await t.test('the two chains disagree about whether a store sets the price', async () => {
    const body = await get('/api/stores?postalCode=22963');
    const foodlion = body.stores.find((s) => s.id === 'foodlion')!;
    const wegmans = body.stores.find((s) => s.id === 'wegmans')!;
    assert.equal(wegmans.pricesVaryByLocation, true);
    assert.equal(foodlion.pricesVaryByLocation, false);
  });

  await t.test('a ZIP one chain has never heard of still ranks that chain', async () => {
    // 22902 is Charlottesville: Wegmans sits in that ZIP, Food Lion does not.
    // The shared resolver means Food Lion still gets a real distance.
    const body = await get('/api/stores?postalCode=22902&store=foodlion');
    assert.equal(body.zipResolved, true);
    assert.ok(body.stores[0]!.locations[0]!.distanceMiles! < 30);
  });

  await t.test('an unknown ZIP is reported rather than guessed at', async () => {
    const body = await get('/api/stores?postalCode=99999');
    assert.equal(body.zipResolved, false);
    assert.equal(body.zipPrecision, null);
    // Stores are still listed, just not ranked — no invented distances.
    assert.ok(body.stores.every((s) => s.locations.every((l) => l.distanceMiles === null)));
  });

  await t.test('no ZIP at all is not an error', async () => {
    const body = await get('/api/stores');
    assert.equal(body.zip, null);
    assert.ok(body.stores.every((s) => s.locations.length > 0));
  });

  await t.test('the Wegmans store choice is what sets the price', async () => {
    const body = await get('/api/stores?postalCode=14580&store=wegmans');
    const nearby = body.stores[0]!.locations.slice(0, 4).map((l) => l.locationId);
    // Plus one deliberately far store, so the sample spans price regions.
    const ids = [...new Set([...nearby, '8'])];

    const { WegmansAdapter } = await import('../src/adapters/wegmans.js');
    const wegmans = new WegmansAdapter();
    const prices = new Map<string, number>();
    for (const id of ids) {
      const offer = await wegmans.fetchOffer('94427', id);
      if (offer?.price.effectiveUnitCents != null) prices.set(id, offer.price.effectiveUnitCents);
    }
    assert.ok(prices.size >= 2, 'expected several stores to price this product');
    assert.ok(
      new Set(prices.values()).size >= 2,
      `expected the price to differ by store, got ${JSON.stringify([...prices])}`,
    );
  });

  await t.test('Food Lion records every store under one price scope', async () => {
    const body = await get('/api/stores?postalCode=22963&store=foodlion');
    const [first, second] = body.stores[0]!.locations;
    assert.ok(first && second, 'expected at least two Food Lion stores near 22963');

    const { adapterFor } = await import('../src/adapters/index.js');
    const foodlion = adapterFor('foodlion');
    assert.equal(foodlion.pricingLocationId(first.locationId), 'national');
    assert.equal(foodlion.pricingLocationId(second.locationId), 'national');

    // So watching the same item after switching stores must not fork history.
    const search = (await (
      await fetch(`${url}/api/search?q=bananas&stores=foodlion&limit=1`)
    ).json()) as SearchBody;
    const productId = search.results[0]!.offer.product.storeProductId;

    const watch = async (locationId: string, groupId?: number) =>
      (await (
        await fetch(`${url}/api/watchlist`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ storeId: 'foodlion', storeProductId: productId, locationId, groupId, label: 'Bananas' }),
        })
      ).json()) as { group: { id: number; items: { product: { id: number } }[] } };

    const created = await watch(first.locationId);
    const dbId = created.group.items[0]!.product.id;
    await watch(second.locationId, created.group.id);

    const history = (await (await fetch(`${url}/api/prices/${dbId}?locationId=national`)).json()) as {
      history: unknown[];
    };
    assert.equal(history.history.length, 1, 'switching stores must not add a second reading');
  });
});

test('deals filtering and daily snapshot', { skip: live ? false : 'BASTILLE_SKIP_LIVE=1', concurrency: false }, async (t) => {
  const dir5 = mkdtempSync(join(tmpdir(), 'bastille-deals-'));
  const app5 = Fastify();
  const { openDb } = await import('../src/db.js');
  const { Repo } = await import('../src/repo.js');
  const { Poller } = await import('../src/jobs/poller.js');
  const { SnapshotJob } = await import('../src/jobs/snapshot.js');
  process.env.WEGMANS_SNAPSHOT_PRODUCTS = '200';
  process.env.SNAPSHOT_WEGMANS_STORE = '1';
  const repo5 = new Repo(openDb(join(dir5, 'deals.db')));
  const snap = new SnapshotJob(repo5);
  registerRoutes(app5, repo5, new Poller(repo5, 60_000), snap);
  const url = await app5.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await app5.close();
    rmSync(dir5, { recursive: true, force: true });
  });

  interface Deals {
    source: 'snapshot' | 'live';
    date: string | null;
    total: number;
    rows: { storeId: string; discountPct: number | null; promoKind: string; effectiveUnitCents: number | null }[];
  }
  const deals = async (qs: string) => (await (await fetch(`${url}/api/deals?${qs}`)).json()) as Deals;

  const search = async (qs: string) => (await (await fetch(`${url}/api/search?${qs}`)).json()) as SearchBody & { results: { discountPct: number | null; offer: { price: { promoKind: string } } }[] };

  await t.test('search honours an on-sale filter', async () => {
    const body = await search('q=cheese&stores=wegmans&wegmansLocation=1&limit=25&onSale=1');
    assert.ok(body.results.length > 0, 'expected some cheese on sale at Wegmans store 1');
    assert.ok(body.results.every((r) => r.offer.price.promoKind !== 'none'), 'every result must be on sale');
  });

  await t.test('search honours a minimum discount', async () => {
    const body = await search('q=soda&stores=foodlion&limit=40&minDiscount=25');
    for (const r of body.results) {
      assert.ok(r.discountPct !== null && r.discountPct >= 25, `row discount ${r.discountPct} < 25`);
    }
  });

  await t.test('deals runs live before any snapshot exists', async () => {
    const d = await deals('stores=foodlion&minDiscount=40&sort=discount&limit=15');
    assert.equal(d.source, 'live');
    assert.ok(d.rows.length > 0, 'expected some Food Lion items 40%+ off');
    assert.ok(d.rows.every((r) => (r.discountPct ?? 0) >= 40), 'all rows must clear the threshold');
    // sorted by discount, deepest first
    const ds = d.rows.map((r) => r.discountPct ?? 0);
    assert.deepEqual(ds, [...ds].sort((a, b) => b - a));
  });

  await t.test('the BOGO switch only returns BOGO offers', async () => {
    const d = await deals('stores=foodlion,wegmans&wegmansLocation=1&promoKinds=bogo&limit=20');
    assert.ok(d.rows.every((r) => r.promoKind === 'bogo'), 'only BOGO rows');
  });

  let snapDate = '';
  await t.test('a snapshot records both stores and deals then read from it', async () => {
    const res = (await (await fetch(`${url}/api/snapshot/run`, { method: 'POST' })).json()) as {
      date: string;
      rows: number;
      perStore: Record<string, number>;
      errors: string[];
    };
    assert.deepEqual(res.errors, []);
    assert.ok(res.perStore['foodlion']! > 100, 'Food Lion catalogue snapshotted');
    assert.ok(res.perStore['wegmans']! > 0, 'Wegmans snapshotted');
    snapDate = res.date;

    const d = await deals('stores=foodlion&minDiscount=30&limit=10');
    assert.equal(d.source, 'snapshot', 'deals now read the snapshot');
    assert.equal(d.date, snapDate);
    assert.ok(d.rows.every((r) => (r.discountPct ?? 0) >= 30));
  });

  await t.test('re-running the same day overwrites rather than duplicating', async () => {
    const before = (await (await fetch(`${url}/api/snapshot/status`)).json()) as { latestDate: string; dates: string[] };
    await fetch(`${url}/api/snapshot/run`, { method: 'POST' });
    const after = (await (await fetch(`${url}/api/snapshot/status`)).json()) as { latestDate: string; dates: string[] };
    assert.deepEqual(after.dates, before.dates, 'still exactly one snapshot date');
  });
});
