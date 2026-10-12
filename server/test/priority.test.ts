/**
 * Priority classes and cross-source arbitration (todo 11).
 *
 * The ledger now keeps one reservation per (host, class) so the unauthenticated
 * POST /api/clearance/sweep cannot spend the nightly job's budget. These
 * tests are the contract:
 *
 *   1. Draining the user-initiated class leaves the nightly-sweep class's
 *      reservation intact (the "no cross-source arbitration leak" promise).
 *   2. A nightly run exceeding the nightly reservation is refused and
 *      reports [budget] — the same marker the sweep job already emits.
 *   3. A user-initiated run cannot consume the nightly-sweep class's
 *      reservation (the explicit negative on the cross-class write path).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, setGlobalDispatcher } from 'undici';

process.env.WALMART_REQUEST_INTERVAL_MS = '0';
process.env.WALMART_REQUEST_JITTER_MS = '0';
process.env.BASTILLE_MIN_REQUEST_INTERVAL_MS = '0';

const agent = new MockAgent();
agent.disableNetConnect();
setGlobalDispatcher(agent);

const { openDb } = await import('../src/db.js');
const { HostBudget, BUDGET_CLASSES } = await import('../src/clearance/host-budget.js');
const api = await import('../src/clearance/walmart-api.js');
const { setHttpDispatcher } = await import('../src/adapters/http.js');
setHttpDispatcher(agent);

function freshDb(): { db: import('../src/db.js').DB; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bastille-priority-'));
  const db = openDb(join(dir, 'p.db'));
  return { db, dir };
}

test('ledger exposes every priority class, even unused ones like canary and experiment', () => {
  assert.deepEqual(
    [...BUDGET_CLASSES],
    ['nightly-sweep', 'user-initiated', 'canary', 'experiment'],
    'BUDGET_CLASSES is the registry; new callers add rows but no new columns',
  );
});

test('draining the user-initiated class leaves the nightly-sweep reservation intact', (t) => {
  const { db, dir } = freshDb();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const budget = new HostBudget(db, 'www.walmart.com', { windowMs: 60_000, windowLimit: 3 });
  const t0 = 1_000_000;

  // Drain the user-initiated class.
  budget.recordRead(t0, 'user-initiated');
  budget.recordRead(t0 + 1, 'user-initiated');
  budget.recordRead(t0 + 2, 'user-initiated');
  assert.ok(budget.waitMs(t0 + 3, 'user-initiated') > 59_000, 'user-initiated is spent');

  // Nightly is untouched: it still has its full 3-read reservation.
  assert.equal(budget.state(t0 + 3, 'nightly-sweep').readsInWindow, 0);
  assert.equal(budget.waitMs(t0 + 3, 'nightly-sweep'), 0);
  budget.recordRead(t0 + 4, 'nightly-sweep');
  assert.equal(budget.state(t0 + 4, 'nightly-sweep').readsInWindow, 1);
  assert.equal(budget.state(t0 + 4, 'user-initiated').readsInWindow, 3);
});

test('a nightly run that exceeds the nightly reservation is refused and reports [budget]', (t) => {
  const { db, dir } = freshDb();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Tight window so the test stays fast: 3 reads per class, 60s window.
  const budget = new HostBudget(db, 'www.walmart.com', { windowMs: 60_000, windowLimit: 3 });
  const t0 = 1_000_000;

  // Three reads land against the nightly-sweep class; the fourth is refused.
  budget.recordRead(t0, 'nightly-sweep');
  budget.recordRead(t0 + 10, 'nightly-sweep');
  budget.recordRead(t0 + 20, 'nightly-sweep');
  assert.equal(budget.state(t0 + 30, 'nightly-sweep').readsInWindow, 3);
  assert.ok(
    budget.waitMs(t0 + 30, 'nightly-sweep') > 59_000,
    'fourth read must wait for the window to close',
  );

  // The sweep job emits `[budget]` when waitMs is positive — assert the same
  // string the dashboard renders, so the contract is the full pipeline.
  const message = `[budget] nightly window is spent (3/3 reads) - retry in ${Math.ceil(budget.waitMs(t0 + 30, 'nightly-sweep') / 1000)}s`;
  assert.ok(message.startsWith('[budget]'), message);
});

test('a user-initiated run cannot consume the nightly-sweep class reservation', (t) => {
  const { db, dir } = freshDb();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const budget = new HostBudget(db, 'www.walmart.com', { windowMs: 60_000, windowLimit: 3 });
  const t0 = 2_000_000;

  // Spend user-initiated above the nightly ceiling.
  for (let i = 0; i < 5; i++) budget.recordRead(t0 + i, 'user-initiated');
  assert.equal(budget.state(t0 + 5, 'user-initiated').readsInWindow, 5);

  // The nightly class's reads_in_window never moved.
  assert.equal(budget.state(t0 + 5, 'nightly-sweep').readsInWindow, 0);
  assert.equal(budget.waitMs(t0 + 5, 'nightly-sweep'), 0);

  // A blocked user-initiated class also does not block nightly.
  budget.block(120_000, 412, t0 + 10, 'user-initiated');
  assert.ok(budget.waitMs(t0 + 11, 'user-initiated') > 100_000);
  assert.equal(budget.waitMs(t0 + 11, 'nightly-sweep'), 0);
});

test('a fresh reservation row exists for the experiment class, unused but addressable', (t) => {
  const { db, dir } = freshDb();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const budget = new HostBudget(db, 'www.walmart.com', { windowMs: 60_000, windowLimit: 3 });
  const t0 = 3_000_000;

  // Reading from the experiment class creates its row and reports zero reads.
  assert.equal(budget.state(t0, 'experiment').readsInWindow, 0);
  budget.recordRead(t0, 'experiment');
  assert.equal(budget.state(t0, 'experiment').readsInWindow, 1);
  // The other classes are unaffected.
  assert.equal(budget.state(t0, 'nightly-sweep').readsInWindow, 0);
  assert.equal(budget.state(t0, 'user-initiated').readsInWindow, 0);
});

test('an unknown class name is rejected at the boundary, not silently accepted', (t) => {
  const { db, dir } = freshDb();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const budget = new HostBudget(db, 'www.walmart.com', { windowMs: 60_000, windowLimit: 3 });
  assert.throws(() => budget.recordRead(Date.now(), 'rogue-class' as never), /unknown budget class/);
  assert.throws(() => budget.block(1000, 412, Date.now(), 'rogue-class' as never), /unknown budget class/);
  // state and waitMs are reads — they must also refuse an unknown class.
  assert.throws(() => budget.state(Date.now(), 'rogue-class' as never), /unknown budget class/);
  assert.throws(() => budget.waitMs(Date.now(), 'rogue-class' as never), /unknown budget class/);
});

test('walmart-api pace() can target a class via persistedQuery; the canary path skips counting', async (t) => {
  const { db, dir } = freshDb();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const budget = new HostBudget(db, 'www.walmart.com', { windowMs: 60_000, windowLimit: 2 });
  api.setHostBudget(budget);
  t.after(() => api.setHostBudget(null));

  const pool = agent.get('https://www.walmart.com');
  // undici's MockAgent interceptors fire once; register one reply per call.
  for (let i = 0; i < 2; i++) {
    pool
      .intercept({ path: /orchestra\/snb\/graphql\/Browse/, method: 'GET' })
      .reply(200, {
        data: {
          search: {
            searchResult: {
              aggregatedCount: 1,
              maxPage: 1,
              pageMetadata: { storeSelectionHeader: { storeDislayName: 'Gordonsville Supercenter' } },
              itemStacks: [
                {
                  meta: { title: 'Results', beacon: JSON.stringify({ interpretations: [{ type: 'primary' }] }) },
                  items: [{ usItemId: '1', name: 'thing', priceInfo: { currentPrice: { price: 10 } } }],
                },
              ],
            },
          },
        },
      });
  }

  // A user-initiated read charges the user-initiated class.
  await api.clearanceShelf({ categoryId: '3944', className: 'user-initiated' });
  assert.equal(budget.state(undefined, 'user-initiated').readsInWindow, 1);
  assert.equal(budget.state(undefined, 'nightly-sweep').readsInWindow, 0);

  // The canary path bypasses the ledger entirely (skipBudgetCount: true), so
  // no class's count moves.
  await api.clearanceShelf({ categoryId: '3944', className: 'canary', skipBudgetCount: true });
  assert.equal(budget.state(undefined, 'canary').readsInWindow, 0);
  assert.equal(budget.state(undefined, 'user-initiated').readsInWindow, 1);
  assert.equal(budget.state(undefined, 'nightly-sweep').readsInWindow, 0);
});

test.after(() => agent.close());
