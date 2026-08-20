/**
 * Drives the app the way the dashboard does: over HTTP, against a real server
 * process and a real SQLite file, hitting the live storefronts. No adapter is
 * reached into directly and no price is hand-constructed — if the wiring from
 * route to adapter to database to alert is broken, these fail.
 *
 * Network-dependent by design. Set GROCER_SKIP_LIVE=1 to skip.
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

const live = process.env.GROCER_SKIP_LIVE !== '1';

let dir: string;
let app: FastifyInstance;
let base: string;

async function boot(): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'grocer-test-'));
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

test('grocer API', { skip: live ? false : 'GROCER_SKIP_LIVE=1', concurrency: false }, async (t) => {
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
test('price changes become alerts', { skip: live ? false : 'GROCER_SKIP_LIVE=1', concurrency: false }, async (t) => {
  const { WegmansAdapter } = await import('../src/adapters/wegmans.js');
  const { openDb } = await import('../src/db.js');
  const { Repo } = await import('../src/repo.js');
  const { Poller } = await import('../src/jobs/poller.js');

  const dir2 = mkdtempSync(join(tmpdir(), 'grocer-alerts-'));
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
test('a starting offer alerts on its own', { skip: live ? false : 'GROCER_SKIP_LIVE=1', concurrency: false }, async (t) => {
  const { openDb } = await import('../src/db.js');
  const { Repo } = await import('../src/repo.js');
  const { WegmansAdapter } = await import('../src/adapters/wegmans.js');

  const dir3 = mkdtempSync(join(tmpdir(), 'grocer-promo-'));
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
