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
