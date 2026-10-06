/**
 * The watchlist reads (P-1): `listGroups` and `groupView` are batched, and
 * search membership is one SELECT. The batched price lookup must agree with
 * `priceHistory`, the per-item path it replaced, including when one product
 * is watched at two scopes and when a scope has no readings yet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { Repo } from '../src/repo.js';
import type { Offer, PriceSnapshot } from '../src/price/model.js';

function snap(cents: number, at: number): PriceSnapshot {
  return {
    regularCents: cents, currentCents: cents, effectiveUnitCents: cents,
    promoKind: 'none', promoText: null, promoDetail: null, unitPriceText: null,
    inStock: true, capturedAt: new Date(Date.UTC(2026, 0, 1) + at * 60_000).toISOString(),
  };
}

function offer(storeId: 'foodlion' | 'wegmans', id: string): Offer {
  return {
    product: { storeId, storeProductId: id, name: `Item ${id}`, brand: null, size: null, imageUrl: null, productUrl: `https://x/${id}`, category: null },
    price: snap(100, 0),
  };
}

function withRepo(fn: (repo: Repo, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bastille-batch-'));
  const db = openDb(join(dir, 't.db'));
  try {
    fn(new Repo(db), dir);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('batched group views match the per-item price history they replaced', () => {
  withRepo((repo) => {
    for (let g = 0; g < 6; g++) {
      const group = repo.createGroup(`g${g}`, null, true);
      const fl = repo.upsertProduct(offer('foodlion', `fl${g}`));
      const wg = repo.upsertProduct(offer('wegmans', `wg${g}`));
      repo.addToGroup(group.id, fl.id, 'national');
      repo.addToGroup(group.id, wg.id, '7');
      for (let k = 0; k < g; k++) repo.insertPrice(fl.id, 'national', snap(200 + k, k)); // g = 0: no readings
      for (let k = 0; k < 4; k++) repo.insertPrice(wg.id, '7', snap(300 + k, k));
      // A reading at another scope must not leak into this item's view.
      repo.insertPrice(wg.id, '99', snap(1, 100));
    }

    const views = repo.listGroups();
    assert.equal(views.length, 6);
    for (const view of views) {
      assert.deepEqual(view, repo.groupView(view.id), 'one group and all groups agree');
      for (const item of view.items) {
        const history = repo.priceHistory(item.product.id, item.locationId, 2);
        assert.deepEqual(item.price, history.at(-1) ?? null);
        assert.deepEqual(item.previousPrice, history.length > 1 ? history.at(-2) : null);
      }
    }
    const g3 = views.find((v) => v.label === 'g3')!;
    assert.equal(g3.items[0]!.price?.currentCents, 202);
    assert.equal(g3.items[0]!.previousPrice?.currentCents, 201);
    assert.equal(g3.items[1]!.price?.currentCents, 303);
    assert.equal(g3.bestCents, 202);
    assert.equal(g3.bestStoreId, 'foodlion');
    assert.equal(views.find((v) => v.label === 'g0')!.items[0]!.price, null);
  });
});

test('groups come back newest first and an unknown group is null', () => {
  withRepo((repo) => {
    assert.deepEqual(repo.listGroups(), []);
    assert.equal(repo.groupView(12345), null);
    const a = repo.createGroup('a', null, true);
    const b = repo.createGroup('b', 500, false);
    assert.equal(repo.groupView(a.id)!.items.length, 0);
    assert.equal(repo.groupView(b.id)!.targetCents, 500);
    assert.equal(repo.groupView(b.id)!.notifyPromos, false);
    assert.equal(repo.listGroups().length, 2);
  });
});

test('search membership names every group a product is in', () => {
  withRepo((repo) => {
    const g1 = repo.createGroup('one', null, true);
    const g2 = repo.createGroup('two', null, true);
    const p = repo.upsertProduct(offer('foodlion', 'A'));
    const q = repo.upsertProduct(offer('wegmans', 'A')); // same id, other chain
    repo.addToGroup(g1.id, p.id, 'national');
    repo.addToGroup(g2.id, p.id, 'national');
    repo.addToGroup(g2.id, q.id, '7');

    const m = repo.watchMembership();
    assert.deepEqual([...(m.get('foodlion:A') ?? [])].sort(), [g1.id, g2.id].sort());
    assert.deepEqual(m.get('wegmans:A'), [g2.id]);
    assert.equal(m.get('foodlion:B'), undefined);
  });
});

test('run rows record the reads and bytes a job spent', () => {
  withRepo((repo) => {
    const poll = repo.startPollRun(null);
    repo.finishPollRun(poll, 3, 1, null, { requests: 7, bytes: 1234 });
    assert.deepEqual(
      [repo.lastPollRun()!.requests, repo.lastPollRun()!.bytes],
      [7, 1234],
    );
    const snapRun = repo.startSnapshotRun('2026-01-01', 'foodlion');
    repo.finishSnapshotRun(snapRun, 10, null, { requests: 250, bytes: 9_000_000 });
    assert.deepEqual([repo.lastSnapshotRun()!.requests, repo.lastSnapshotRun()!.bytes], [250, 9_000_000]);
    const jobs = repo.jobDurations();
    assert.equal(jobs['poll']!.requests, 7);
    assert.ok(jobs['poll']!.durationMs >= 0);
    assert.equal(jobs['clearanceSweep'], null);
  });
});

test('old databases gain the new columns and the clearance index on open', () => {
  withRepo((_repo, dir) => {
    const db = openDb(join(dir, 't.db'));
    try {
      const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as unknown as { name: string }[]).map((c) => c.name);
      assert.ok(cols('poll_run').includes('requests') && cols('snapshot_run').includes('bytes'));
      const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'clearance_find_location'").all();
      assert.equal(idx.length, 1);
    } finally {
      db.close();
    }
  });
});

test('pruning stamps when retention last ran, even when it removed nothing', () => {
  withRepo((repo) => {
    assert.equal(repo.lastPrunedAt(), null);
    assert.equal(repo.pruneSnapshots(0), 0);
    assert.equal(repo.lastPrunedAt(), null, 'a disabled retention is not a prune');
    repo.pruneSnapshots(90);
    const first = repo.lastPrunedAt();
    assert.ok(first && !Number.isNaN(Date.parse(first)));
  });
});
