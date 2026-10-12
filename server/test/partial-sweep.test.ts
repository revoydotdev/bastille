/**
 * todo 13 — partial-run reporting with per-store terminal states.
 *
 * The sweep must record, per store, the terminal state of its pass —
 * `succeeded | failed | budget-exhausted | refused | wrong-store | hash-expired
 * | skipped` — and the per-store detail must be readable from the run record
 * (`sweep_run.per_store_reasons`) and the dashboard (`lastSweep.perStoreReasons`).
 *
 * A run with one refused store of three completes non-fatally: `sweep_run.error`
 * stays null, the refused store's reason is in the per-store detail, and the
 * other two are recorded as `'succeeded'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb } from '../src/db.js';
import { ClearanceRepo } from '../src/clearance/repo.js';
import {
  ClearanceSweepJob,
  classifySweepError,
  perStoreStatusForKind,
  WrongStoreError,
  type ShelfReader,
} from '../src/jobs/clearance-sweep.js';
import { registerClearanceRoutes, type StoreFinder } from '../src/clearance/routes.js';
import {
  HashExpiredError,
  type ClearanceItem,
  type ShelfPage,
  type WalmartStore,
} from '../src/clearance/walmart-api.js';
import { HttpError } from '../src/adapters/http.js';

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
  {
    locationId: '5252',
    name: 'Harrisonburg Supercenter',
    address: '1 Express Care Dr',
    city: 'Harrisonburg',
    state: 'VA',
    postalCode: '22801',
    point: { lat: 38.449, lng: -78.869 },
    distanceMiles: 35.0,
  },
];

function item(over: Partial<ClearanceItem> & Pick<ClearanceItem, 'itemId' | 'name'>): ClearanceItem {
  return {
    brand: null,
    categoryPathId: '0:3944',
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

const RACKS: Record<string, ClearanceItem[]> = {};
/** When non-null, the shelf answers under this name for the asked-for store. */
let answerAs: string | null = null;
/** Per-store HTTP error to throw from the shelf reader (rate-limit simulation). */
let throwHttp: { locationId: string; status: number } | null = null;
/** Per-store hash-expiry to throw from the shelf reader. */
let throwHashExpired: { locationId: string } | null = null;

const readShelf: ShelfReader = async ({ locationId, page }) => {
  if (throwHttp && throwHttp.locationId === locationId) {
    const { status } = throwHttp;
    throwHttp = null;
    throw new HttpError(status, 'http://walmart.test/', 'rate limited');
  }
  if (throwHashExpired && throwHashExpired.locationId === locationId) {
    throwHashExpired = null;
    throw new HashExpiredError('hash expired');
  }
  const rack = RACKS[locationId] ?? [];
  const onPage = (page ?? 1) === 1 ? rack : [];
  return {
    items: onPage,
    totalCount: rack.length,
    pageItemCount: onPage.length,
    shippedOnly: 0,
    storeName: answerAs ?? STORES.find((s) => s.locationId === locationId)?.name ?? null,
  };
};

const findStores: StoreFinder = async () => STORES;

let dir: string;
let app: FastifyInstance;
let base: string;
let repo: ClearanceRepo;
let sweep: ClearanceSweepJob;

async function boot(): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'bastille-partial-sweep-'));
  app = Fastify();
  const db = openDb(join(dir, 'test.db'));
  repo = new ClearanceRepo(db);
  // Three stores, each with its own egress node.
  for (const store of STORES) {
    repo.upsertStores([store], '22942', true);
    repo.upsertEgressNode({
      id: `node-${store.locationId}`,
      label: store.name,
      proxyUrl: 'http://127.0.0.1:1',
      region: 'VA',
      enabled: true,
    });
    repo.setStoreEgressNode(store.locationId, `node-${store.locationId}`);
  }
  sweep = new ClearanceSweepJob(repo, readShelf, {
    readBudget: 50,
    // Make the 412-refusal path run in microseconds, not 5 minutes. A single
    // refusal is enough to mark the store as 'refused'.
    cooldownMs: 0,
    maxConsecutiveRateLimits: 1,
  });
  registerClearanceRoutes(app, repo, sweep, findStores, async () => ({ storeName: STORES[0]!.name }));
  base = await app.listen({ port: 0, host: '127.0.0.1' });
}

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...(init?.headers ?? {}) } : init?.headers,
  });
  return { status: res.status, body: (await res.json()) as T };
}

interface StatusBody {
  lastSweep: {
    date: string;
    startedAt: string;
    finishedAt: string | null;
    storesSwept: number;
    storesAborted: number;
    perStoreCounts: {
      wrongStore: number;
      budgetExhausted: number;
      hashExpired: number;
      refused: number;
      failed: number;
      skipped: number;
      aborted: number;
    };
    perStoreReasons: Array<{ locationId: string; name: string; status: string; message: string | null }>;
    finds: number;
    error: string | null;
  } | null;
  sweeping: boolean;
  progress: unknown;
}

interface SweepResponse {
  date: string;
  storesSwept: number;
  storesAborted: number;
  perStoreResults: Array<{ locationId: string; name: string; status: string; message: string | null }>;
  finds: number;
  alerts: number;
  rateLimited: number;
  abandoned: boolean;
  abortReason: string | null;
  readsSpent: number;
  readBudget: number;
  mode: string;
  errors: string[];
}

test('per-store terminal states — partial run completes with per-store detail', { concurrency: false }, async (t) => {
  await boot();
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  await t.test('the seven terminal states the engine reports are all here', () => {
    // classifySweepError covers the five sweep kinds; perStoreStatusForKind
    // maps them onto the seven DAG terminal states. The mapping is what
    // makes a partial run recordable.
    const kinds = ['rate-limited', 'wrong-store', 'hash-expired', 'budget', 'error'] as const;
    const mapped = kinds.map((k) => perStoreStatusForKind(k));
    assert.deepEqual(mapped, ['refused', 'wrong-store', 'hash-expired', 'budget-exhausted', 'failed']);
  });

  await t.test('a refused store of three: run completes, error is null, refused reason is in the record', async () => {
    // Two of three stores carry a rack; the middle one refuses with a 412
    // (Walmart's edge). The sweep records all three: two succeeded, one
    // refused, sweep_run.error stays null because the run did not crash.
    RACKS['4682'] = [item({ itemId: 'A1', name: 'ASUS RTX 4060', nowCents: 19900, wasCents: 39900, aisle: 'K14' })];
    RACKS['5252'] = [item({ itemId: 'C1', name: 'Logitech mouse', nowCents: 500, wasCents: 2000, aisle: 'L3' })];
    throwHttp = { locationId: '1780', status: 412 };

    const sweepBody = await api<SweepResponse>('/api/clearance/sweep', {
      method: 'POST',
      body: JSON.stringify({ wait: true }),
    });
    assert.equal(sweepBody.body.storesSwept, 2);
    assert.equal(sweepBody.body.storesAborted, 1);
    const refused = sweepBody.body.perStoreResults.find(
      (p) => p.locationId === '1780',
    );
    assert.ok(refused, 'refused store should be in perStoreResults');
    assert.equal(refused!.status, 'refused');
    assert.match(
      refused!.message ?? '',
      /consecutive refusals|not swept|rate.?limited|cooldown|edge/i,
    );

    const status = await api<StatusBody>('/api/clearance/status');
    assert.equal(status.body.lastSweep?.storesSwept, 2);
    assert.equal(status.body.lastSweep?.storesAborted, 1);
    assert.equal(status.body.lastSweep?.perStoreCounts.refused, 1);
    assert.equal(status.body.lastSweep?.perStoreCounts.aborted, 1);
    assert.equal(status.body.lastSweep?.error, null, 'partial run must not set sweep_run.error');
    const refusedRow = status.body.lastSweep?.perStoreReasons.find(
      (p) => p.locationId === '1780',
    );
    assert.ok(refusedRow, 'refused store is in perStoreReasons on the run record');
    assert.equal(refusedRow!.status, 'refused');
    assert.match(
      refusedRow!.message ?? '',
      /consecutive refusals|not swept|rate.?limited|cooldown|edge/i,
    );
  });

  await t.test('a partial run never collapses per-store detail into a generic error', async () => {
    // Re-run with a wrong store. The dashboard's classifySweepError reads
    // the leading token ([rate-limited] / [wrong-store] / ...) and would
    // render "Walmart rate-limited the sweep" if the per-store detail were
    // collapsed into sweep_run.error. The whole point of todo 13 is that
    // it does not: the message stays on the per-store row.
    RACKS['4682'] = [item({ itemId: 'B1', name: 'A different item' })];
    RACKS['5252'] = [item({ itemId: 'C2', name: 'Another' })];
    throwHttp = null;
    answerAs = 'Some Other Supercenter';

    const sweepBody = await api<SweepResponse>('/api/clearance/sweep', {
      method: 'POST',
      body: JSON.stringify({ wait: true }),
    });
    assert.equal(sweepBody.body.storesSwept, 0);
    assert.equal(sweepBody.body.storesAborted, 3);

    const status = await api<StatusBody>('/api/clearance/status');
    assert.equal(status.body.lastSweep?.error, null);
    assert.equal(status.body.lastSweep?.perStoreCounts.wrongStore, 3);
    // Each store's per-store reason names the wrong store explicitly.
    for (const p of status.body.lastSweep?.perStoreReasons ?? []) {
      assert.equal(p.status, 'wrong-store');
      assert.match(p.message ?? '', /answered for Some Other Supercenter/);
    }
    // The dashboard's classifySweepError on a hypothetical collapsed message
    // would have read the leading [wrong-store] token and said "Walmart
    // answered for a different store" without naming which one. With
    // per-store reasons, the row says the actual store name and the actual
    // echo. This is the difference todo 13 makes.
    const someEcho = (status.body.lastSweep?.perStoreReasons ?? [])
      .map((p) => p.message ?? '')
      .find((m) => m.includes('Some Other Supercenter'));
    assert.ok(someEcho, 'a per-store reason names the actual wrong-store echo');
    answerAs = null;
  });

  await t.test('a run-level crash is the only thing that sets sweep_run.error', async () => {
    // Read the partial-run row from before the synthetic crash; the partial
    // run row has error=null by design.
    const beforeCrash = await api<StatusBody>('/api/clearance/status');
    assert.equal(beforeCrash.body.lastSweep?.error, null, 'partial run rows leave sweep_run.error null');
    assert.equal(beforeCrash.body.lastSweep?.storesAborted, 3, 'all three stores were wrong-store');
    assert.equal(beforeCrash.body.lastSweep?.perStoreCounts.wrongStore, 3);

    // Now force a run-level crash. Substitute the repo to throw on the
    // store list so the sweep's try/catch in runOnce hits its catch arm.
    const origListStores = repo.listStores.bind(repo);
    repo.listStores = () => {
      throw new Error('synthetic run-level crash');
    };
    try {
      const res = await fetch(`${base}/api/clearance/sweep`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wait: true }),
      });
      assert.equal(res.status, 500);
    } finally {
      repo.listStores = origListStores;
    }

    // The new run record is the run-level crash, and only it has
    // sweep_run.error set. The partial run row above stays clean.
    const afterCrash = await api<StatusBody>('/api/clearance/status');
    assert.match(afterCrash.body.lastSweep?.error ?? '', /synthetic run-level crash/, 'run-level crash writes to sweep_run.error');
    assert.equal(afterCrash.body.lastSweep?.storesSwept, 0, 'crashed run did not record any sweeps');
  });

  await t.test('classifySweepError (server) maps the canonical errors to their kinds', () => {
    assert.equal(
      classifySweepError(new WrongStoreError('answered for Sacramento')),
      'wrong-store',
    );
    assert.equal(classifySweepError(new HashExpiredError('hash')), 'hash-expired');
    assert.equal(classifySweepError(new HttpError(412, 'http://walmart.test/', 'rate limited')), 'rate-limited');
    assert.equal(classifySweepError(new Error('boom')), 'error');
  });
});
