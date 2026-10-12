/**
 * Per-node isolation: N egress nodes must behave as N independent readers.
 *
 * The bug these guard against was a single module-level pacer that every node
 * shared. It looked correct with one node and collapsed N nodes into one
 * queue, and a 412 on any node set a global cooldown that stalled the whole
 * run. Measured 2026-10-11: three VA residential IPs answer for three
 * different Walmart stores with no 412 between them, so per-node identity is
 * the real unit of rate limiting.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, setGlobalDispatcher } from 'undici';

process.env.WALMART_REQUEST_INTERVAL_MS = '0';
process.env.WALMART_REQUEST_JITTER_MS = '0';
process.env.WALMART_RATE_LIMIT_COOLDOWN_MS = '60000';
process.env.BASTILLE_MIN_REQUEST_INTERVAL_MS = '0';

const agent = new MockAgent();
agent.disableNetConnect();
setGlobalDispatcher(agent);

const { openDb } = await import('../src/db.js');
const { HostBudget } = await import('../src/clearance/host-budget.js');
const api = await import('../src/clearance/walmart-api.js');
const { setHttpDispatcher } = await import('../src/adapters/http.js');
setHttpDispatcher(agent);

const pool = agent.get('https://www.walmart.com');

function shelfBody(storeName: string) {
  return {
    data: {
      search: {
        searchResult: {
          aggregatedCount: 12,
          maxPage: 1,
          pageMetadata: { storeSelectionHeader: { storeDislayName: storeName } },
          itemStacks: [
            {
              meta: { title: 'Results', beacon: JSON.stringify({ interpretations: [{ type: 'primary' }] }) },
              items: [{ usItemId: '1', name: 'thing', priceInfo: { currentPrice: { price: 10 } } }],
            },
          ],
        },
      },
    },
  };
}

test('two nodes get two different stores: egress IP decides, not the cookie', async (t) => {
  api.setHostBudget(null);
  for (const [node, store] of [
    ['us-va-charlottesville', 'Chester Supercenter'],
    ['us-va-richmond', 'Henrico Supercenter'],
  ] as const) {
    pool
      .intercept({ path: /orchestra\/snb\/graphql\/Browse/, method: 'GET' })
      .reply(200, shelfBody(store));
    const got = await api.clearanceShelf({ categoryId: '3944', locationId: '1', egressNodeId: node });
    assert.equal(got.storeName, store);
  }
  void t;
});

test('a 412 on one node leaves the other node free to read', async (t) => {
  api.setHostBudget(null);
  api.forgetNodePacer('blocked-node');
  api.forgetNodePacer('healthy-node');

  pool.intercept({ path: /orchestra\/snb\/graphql\/Browse/, method: 'GET' }).reply(412, '');
  await assert.rejects(() =>
    api.clearanceShelf({ categoryId: '3944', egressNodeId: 'blocked-node' }),
  );

  // The healthy node must not inherit the blocked node's cooldown.
  pool
    .intercept({ path: /orchestra\/snb\/graphql\/Browse/, method: 'GET' })
    .reply(200, shelfBody('Sheila Lane Supercenter'));
  const ok = await api.clearanceShelf({ categoryId: '3944', egressNodeId: 'healthy-node' });
  assert.equal(ok.storeName, 'Sheila Lane Supercenter');
  void t;
});

test('backOffUntil is node-local', async (t) => {
  api.setHostBudget(null);
  api.forgetNodePacer('a');
  api.forgetNodePacer('b');

  // Blocking node `a` for a minute must leave `b` readable with no wait.
  api.backOffUntil(60_000, 'a');

  pool
    .intercept({ path: /orchestra\/snb\/graphql\/Browse/, method: 'GET' })
    .reply(200, shelfBody('Henrico Supercenter'));
  const started = Date.now();
  const got = await api.clearanceShelf({ categoryId: '3944', egressNodeId: 'b' });
  assert.equal(got.storeName, 'Henrico Supercenter');
  assert.ok(Date.now() - started < 5_000, 'node b should not have waited on node a');
  void t;
});

test('each node keeps its own durable budget row', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bastille-node-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, 'nb.db'));

  for (const id of ['node-a', 'node-b']) {
    db.prepare(
      `INSERT INTO egress_node (id, label, proxy_url, enabled, added_at) VALUES (?, ?, 'http://p', 1, ?)`,
    ).run(id, id, new Date().toISOString());
  }

  const a = new HostBudget(db, 'www.walmart.com', 'node-a', { windowMs: 60_000, windowLimit: 2 });
  const b = new HostBudget(db, 'www.walmart.com', 'node-b', { windowMs: 60_000, windowLimit: 2 });
  assert.equal(a.waitMs(), 0);
  assert.equal(b.waitMs(), 0);

  a.recordRead();
  a.recordRead();
  // node-a is spent; node-b is untouched.
  assert.ok(a.waitMs() > 59_000);
  assert.equal(b.waitMs(), 0);

  b.recordRead();
  assert.ok(b.waitMs() === 0);
});

test.after(() => agent.close());