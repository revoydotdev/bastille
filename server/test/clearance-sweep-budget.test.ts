/**
 * The sweep's read budget, shelf priority, error classification and delta mode,
 * driven against a real SQLite file with the shelf reader replaced. No test in
 * this file reaches Walmart.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { ClearanceRepo } from '../src/clearance/repo.js';
import { ClearanceSweepJob, classifySweepError, type ShelfReader } from '../src/jobs/clearance-sweep.js';
import { HashExpiredError, WalmartCooldownError, type ClearanceItem, type ShelfPage } from '../src/clearance/walmart-api.js';
import { HttpError } from '../src/adapters/http.js';
import { sweepOrder } from '../src/clearance/categories.js';

const STORE = 'Gordonsville Supercenter';

function item(id: string): ClearanceItem {
  return {
    itemId: id,
    name: `thing ${id}`,
    brand: null,
    categoryPathId: '0:3944',
    department: 'Electronics',
    imageUrl: null,
    productUrl: null,
    nowCents: 1000,
    wasCents: 2000,
    savingsCents: 1000,
    aisle: 'K1',
    inStock: true,
  };
}

function pageOf(ids: string[], over: Partial<ShelfPage> = {}): ShelfPage {
  return { items: ids.map(item), totalCount: ids.length, pageItemCount: ids.length, shippedOnly: 0, storeName: STORE, maxPage: 1, ...over };
}

function setup(): { repo: ClearanceRepo; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bastille-budget-'));
  const repo = new ClearanceRepo(openDb(join(dir, 't.db')));
  repo.setLocalStore(STORE, null);
  // The sweep reads every store through a bound egress node; without one the
  // store is skipped and nothing is read.
  repo.upsertEgressNode({ id: 'node-test', label: 'test node', proxyUrl: 'http://127.0.0.1:1', region: null, enabled: true });
  repo.setStoreEgressNode(STORE, 'node-test');
  return { repo, dir };
}

test('shelves are read Computers, then Electronics, then Video games', () => {
  assert.deepEqual(sweepOrder().map((c) => c.slug), ['computers', 'electronics', 'video-games']);
});

test('errors are classified for the dashboard', () => {
  assert.equal(classifySweepError(new HttpError(412, 'u', 'px')), 'rate-limited');
  assert.equal(classifySweepError(new HttpError(429, 'u', '')), 'rate-limited');
  assert.equal(classifySweepError(new WalmartCooldownError(120_000)), 'rate-limited');
  assert.equal(classifySweepError(new HashExpiredError('PersistedQueryNotFound')), 'hash-expired');
  assert.equal(classifySweepError(new HttpError(500, 'u', '')), 'error');
  assert.equal(classifySweepError(new Error('boom')), 'error');
});

test('the read budget cuts the lowest-priority shelf, and says so', async (t) => {
  const { repo, dir } = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const asked: string[] = [];
  // Every shelf claims three pages.
  const reader: ShelfReader = async ({ categoryId, page }) => {
    asked.push(`${categoryId}#${page}`);
    return pageOf([`${categoryId}-${page}`], { maxPage: 3, totalCount: 120 });
  };
  const sweep = new ClearanceSweepJob(repo, reader, { readBudget: 4 });
  const r = await sweep.runOnce();

  assert.equal(r.readsSpent, 4);
  assert.equal(r.abandoned, true);
  assert.equal(r.abortReason, 'budget');
  assert.deepEqual(asked, ['3944_1089430#1', '3944_1089430#2', '3944_1089430#3', '3944#1']);
  assert.ok(r.errors[0]!.startsWith('[budget]'), r.errors[0]);
  assert.ok(r.errors[0]!.includes('video-games'));
});

test('a short page is not the end of a shelf', async (t) => {
  const { repo, dir } = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Page sizes observed live: 48, 44, 42, 34, 22. The fourth is short, and the
  // shelf still has a fifth.
  const sizes = [40, 34, 22];
  const reader: ShelfReader = async ({ categoryId, page }) =>
    categoryId === '3944'
      ? pageOf(Array.from({ length: sizes[(page ?? 1) - 1]! }, (_, i) => `E${page}-${i}`), { maxPage: 3, totalCount: 100 })
      : pageOf([]);
  const sweep = new ClearanceSweepJob(repo, reader, { readBudget: 12 });
  const r = await sweep.runOnce();
  assert.equal(r.finds, 96);
});

test('an expired hash aborts the run before more budget is spent', async (t) => {
  const { repo, dir } = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let reads = 0;
  const reader: ShelfReader = async () => {
    reads++;
    throw new HashExpiredError('Browse: PersistedQueryNotFound');
  };
  const r = await new ClearanceSweepJob(repo, reader).runOnce();
  assert.equal(reads, 1);
  assert.equal(r.abortReason, 'hash-expired');
  assert.ok(r.errors[0]!.startsWith('[hash-expired]'));
});

test('a wrong store aborts the run and is tagged', async (t) => {
  const { repo, dir } = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let reads = 0;
  const reader: ShelfReader = async () => {
    reads++;
    return pageOf(['x'], { storeName: 'Sacramento Supercenter' });
  };
  const r = await new ClearanceSweepJob(repo, reader).runOnce();
  assert.equal(reads, 1);
  assert.equal(r.storesSwept, 0);
  assert.equal(r.abortReason, 'wrong-store');
  assert.ok(r.errors[0]!.startsWith('[wrong-store]'));
});

test('a refusal is tagged, counted as a read, and not retried', async (t) => {
  const { repo, dir } = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let reads = 0;
  const reader: ShelfReader = async () => {
    reads++;
    throw new HttpError(412, 'https://www.walmart.com/x', 'blocked');
  };
  const r = await new ClearanceSweepJob(repo, reader, { cooldownMs: 1, maxConsecutiveRateLimits: 2 }).runOnce();
  assert.equal(reads, 2, 'one read per refusal, up to the consecutive limit');
  assert.equal(r.rateLimited, 2);
  assert.equal(r.readsSpent, 2);
  assert.equal(r.abortReason, 'rate-limited');
  assert.ok(r.errors.every((e) => e.startsWith('[rate-limited]')), r.errors.join('|'));
});

test('a persisted cooldown stops the run without waiting it out', async (t) => {
  const { repo, dir } = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const reader: ShelfReader = async () => {
    throw new WalmartCooldownError(10 * 60 * 1000);
  };
  const t0 = Date.now();
  const r = await new ClearanceSweepJob(repo, reader, { cooldownMs: 60_000 }).runOnce();
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(r.abortReason, 'rate-limited');
});

test('delta mode reads newest-first, stops at the familiar and carries the rest forward', async (t) => {
  const { repo, dir } = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = (repo as unknown as { db: import('../src/db.js').DB }).db;
  const store = repo.localStore()!;

  // Day one: a full pass over an Electronics shelf of six items.
  const rack = ['n6', 'n5', 'n4', 'n3', 'n2', 'n1'];
  const sorts: (string | undefined)[] = [];
  let pageSize = 3;
  const reader: ShelfReader = async ({ categoryId, page, sort }) => {
    sorts.push(sort);
    if (categoryId !== '3944') return pageOf([]);
    const p = page ?? 1;
    const ids = rack.slice((p - 1) * pageSize, p * pageSize);
    return pageOf(ids, { maxPage: Math.ceil(rack.length / pageSize), totalCount: rack.length });
  };
  const full = new ClearanceSweepJob(repo, reader, { delta: true });
  const day1 = await full.runOnce();
  assert.equal(day1.mode, 'full');
  assert.equal(repo.lastFullSweepDate(store.locationId) !== null, true);
  assert.ok(sorts.every((s) => s === 'new'));

  // Pretend that was yesterday.
  db.prepare("UPDATE clearance_find SET sweep_date = '2020-01-01'").run();
  db.prepare("UPDATE walmart_sweep_state SET last_full_date = date('now','localtime','-1 day')").run();

  // Day two: one new arrival at the front. Delta reads page 1, sees an unseen
  // id, reads page 2 (all familiar) and stops without a third read.
  rack.unshift('n7');
  pageSize = 3;
  sorts.length = 0;
  let electronicsReads = 0;
  const counting: ShelfReader = async (o) => {
    if (o.categoryId === '3944') electronicsReads++;
    return reader(o);
  };
  const day2 = await new ClearanceSweepJob(repo, counting, { delta: true }).runOnce();
  assert.equal(day2.mode, 'delta');
  assert.equal(electronicsReads, 2);
  // Today's feed is complete: n7 freshly read, the other six carried forward.
  const today = db.prepare("SELECT item_id FROM clearance_find WHERE sweep_date <> '2020-01-01'").all() as { item_id: string }[];
  assert.equal(today.length, 7);
});

test('a delta run becomes a full one once the last full pass is old', async (t) => {
  const { repo, dir } = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = repo.localStore()!;
  repo.markFullSweep(store.locationId, '2020-01-01');
  const reader: ShelfReader = async () => pageOf([]);
  const r = await new ClearanceSweepJob(repo, reader, { delta: true, fullEveryDays: 7 }).runOnce();
  assert.equal(r.mode, 'full');
});
