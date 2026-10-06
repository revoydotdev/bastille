/**
 * What `walmart-api` does when Walmart pushes back, against an in-process stand
 * in for www.walmart.com (undici's MockAgent) - nothing leaves the machine.
 *
 * The environment is set before the modules load: the pacer reads its interval
 * at import time.
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
const { HostBudget } = await import('../src/clearance/host-budget.js');
const api = await import('../src/clearance/walmart-api.js');
const { HttpError, setHttpDispatcher } = await import('../src/adapters/http.js');
setHttpDispatcher(agent);

const pool = agent.get('https://www.walmart.com');

test('host budget persists its not-before and window count across handles', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bastille-hb-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'hb.db');

  const a = new HostBudget(openDb(path), 'h', { windowMs: 60_000, windowLimit: 3 });
  assert.equal(a.waitMs(), 0);
  a.recordRead();
  a.recordRead();
  a.block(120_000, 412);

  // A "restart": a fresh handle on the same file sees all of it.
  const b = new HostBudget(openDb(path), 'h', { windowMs: 60_000, windowLimit: 3 });
  assert.ok(b.waitMs() > 100_000);
  assert.equal(b.state().readsInWindow, 2);
  assert.equal(b.state().lastStatus, 412);
});

test('a spent window holds reads until it closes', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bastille-hb-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const b = new HostBudget(openDb(join(dir, 'hb.db')), 'h', { windowMs: 60_000, windowLimit: 2 });
  const t0 = 1_000_000;
  b.recordRead(t0);
  assert.equal(b.waitMs(t0 + 1), 0);
  b.recordRead(t0 + 10);
  assert.ok(b.waitMs(t0 + 20) > 59_000);
  // After the window the count starts over.
  assert.equal(b.waitMs(t0 + 60_001), 0);
});

// Declared here, registered last: a refusal pushes the in-memory pacer out by
// the cooldown, which would stall every test that follows it.
async function refusalIsNotRetried(t: import('node:test').TestContext): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bastille-hb-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const budget = new HostBudget(openDb(join(dir, 'hb.db')));
  api.setHostBudget(budget);
  t.after(() => api.setHostBudget(null));

  let hits = 0;
  pool
    .intercept({ path: /orchestra\/snb\/graphql\/Browse/, method: 'GET' })
    .reply(412, () => {
      hits++;
      return '{"blocked":true}';
    })

  await assert.rejects(
    () => api.clearanceShelf({ categoryId: '3944' }),
    (err: unknown) => err instanceof HttpError && err.status === 412,
  );
  assert.equal(hits, 1, 'one request: the client must not retry a refusal');
  assert.ok(budget.waitMs() > 60_000, 'the refusal is persisted as a cooldown');
  assert.equal(budget.state().readsInWindow, 1);

  // The next read is refused locally, without touching the network.
  await assert.rejects(() => api.clearanceShelf({ categoryId: '3944' }), api.WalmartCooldownError);
  assert.equal(hits, 1);
}

test('PersistedQueryNotFound surfaces as an expired hash', async (t) => {
  api.setHostBudget(null);
  pool
    .intercept({ path: /orchestra\/snb\/graphql\/Browse/, method: 'GET' })
    .reply(200, { errors: [{ message: 'PersistedQueryNotFound' }], data: null });
  await assert.rejects(() => api.clearanceShelf({ categoryId: '3944' }), api.HashExpiredError);
  void t;
});

test('a validation error from the tier surfaces as an expired hash', async () => {
  pool
    .intercept({ path: /orchestra\/snb\/graphql\/Browse/, method: 'GET' })
    .reply(200, {
      errors: [{ message: 'missing variable `$fetchDac`', extensions: { code: 'VALIDATION_INVALID_TYPE_VARIABLE' } }],
      data: null,
    });
  await assert.rejects(() => api.clearanceShelf({ categoryId: '3944' }), api.HashExpiredError);
});

test('the sort token reaches the query', () => {
  const v = api.browseVariables('3944', 2, 40, 'new') as { sort: string; searchParams: { sort: string }; page: number };
  assert.equal(v.sort, 'new');
  assert.equal(v.searchParams.sort, 'new');
  assert.equal(v.page, 2);
  assert.equal((api.browseVariables('3944', 1, 40) as { sort: string }).sort, 'best_match');
});

test('a 412 is not retried, and parks the host in the ledger', refusalIsNotRetried);

test.after(() => agent.close());
