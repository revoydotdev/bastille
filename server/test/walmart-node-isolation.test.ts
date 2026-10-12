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

  const a = new HostBudget(db, 'www.walmart.com:node-a', { windowMs: 60_000, windowLimit: 2 });
  const b = new HostBudget(db, 'www.walmart.com:node-b', { windowMs: 60_000, windowLimit: 2 });
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
// ---- node lifecycle -------------------------------------------------------
// A node that is deleted, unbound or re-pointed must not leave its spent
// window or its cooldown behind: a reused id has to start clean.

function dbRowCount(db: ReturnType<typeof openDb>, sql: string, ...args: unknown[]): number {
  return (db.prepare(sql).get(...(args as [])) as { n: number }).n;
}

test('deleteEgressNode removes the budget row and the pacer slot', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bastille-node-lifecycle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, 'lc.db'));
  const { ClearanceRepo } = await import('../src/clearance/repo.js');

  const repo = new ClearanceRepo(db);
  repo.upsertEgressNode({
    id: 'node-x',
    label: 'X',
    proxyUrl: 'http://proxy-x:1',
    region: 'rva',
    enabled: true,
  });
  repo.installEgressBudgets();

  const budget = new HostBudget(db, 'www.walmart.com:node-x', { windowMs: 60_000, windowLimit: 2 });
  budget.recordRead();
  budget.recordRead();
  assert.ok(budget.waitMs() > 59_000, 'node-x should be spent');
  assert.equal(dbRowCount(db, 'SELECT COUNT(*) AS n FROM host_budget WHERE host = ?', 'www.walmart.com:node-x'), 1);

  // Put the in-memory pacer on cooldown too, so both halves are live.
  api.setNodeHostBudget('node-x', budget);
  api.backOffUntil(120_000, 'node-x');

  repo.deleteEgressNode('node-x');

  assert.equal(
    dbRowCount(db, 'SELECT COUNT(*) AS n FROM host_budget WHERE host = ?', 'www.walmart.com:node-x'),
    0,
    'the node ledger row must be gone',
  );
  assert.equal(dbRowCount(db, 'SELECT COUNT(*) AS n FROM egress_node WHERE id = ?', 'node-x'), 0);

  // The pacer slot and its per-node budget binding are gone, so a read on the
  // same id is neither paced nor blocked.
  pool
    .intercept({ path: /orchestra\/snb\/graphql\/Browse/, method: 'GET' })
    .reply(200, shelfBody('Henrico Supercenter'));
  const started = Date.now();
  const got = await api.clearanceShelf({ categoryId: '3944', egressNodeId: 'node-x' });
  assert.equal(got.storeName, 'Henrico Supercenter');
  assert.ok(Date.now() - started < 5_000, 'a deleted node id must not inherit its cooldown');
});

test('re-registering the same node id yields waitMs() === 0', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bastille-node-lifecycle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, 'lc2.db'));
  const { ClearanceRepo } = await import('../src/clearance/repo.js');

  const repo = new ClearanceRepo(db);
  const node = {
    id: 'node-y',
    label: 'Y',
    proxyUrl: 'http://proxy-y:1',
    region: 'rva',
    enabled: true,
  };
  repo.upsertEgressNode(node);
  repo.installEgressBudgets();

  const spent = new HostBudget(db, 'www.walmart.com:node-y', { windowMs: 60_000, windowLimit: 2 });
  spent.recordRead();
  spent.recordRead();
  assert.ok(spent.waitMs() > 59_000);
  api.setNodeHostBudget('node-y', spent);
  api.backOffUntil(120_000, 'node-y');

  repo.deleteEgressNode('node-y');
  repo.upsertEgressNode(node);
  repo.installEgressBudgets();

  const fresh = new HostBudget(db, 'www.walmart.com:node-y', { windowMs: 60_000, windowLimit: 2 });
  assert.equal(fresh.waitMs(), 0, 'a re-registered node id must start from a clean ledger');

  pool
    .intercept({ path: /orchestra\/snb\/graphql\/Browse/, method: 'GET' })
    .reply(200, shelfBody('Chester Supercenter'));
  const started = Date.now();
  await api.clearanceShelf({ categoryId: '3944', egressNodeId: 'node-y' });
  assert.ok(Date.now() - started < 5_000, 'no stale cooldown on a reused id');
});

test('re-pointing a node at another proxy resets its budget', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bastille-node-lifecycle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, 'lc3.db'));
  const { ClearanceRepo } = await import('../src/clearance/repo.js');

  const repo = new ClearanceRepo(db);
  repo.upsertEgressNode({
    id: 'node-z',
    label: 'Z',
    proxyUrl: 'http://proxy-z-rva:1',
    region: 'rva',
    enabled: true,
  });
  const first = new HostBudget(db, 'www.walmart.com:node-z', { windowMs: 60_000, windowLimit: 2 });
  first.recordRead();
  first.recordRead();
  assert.ok(first.waitMs() > 59_000);

  repo.upsertEgressNode({
    id: 'node-z',
    label: 'Z',
    proxyUrl: 'http://proxy-z-iad:1',
    region: 'iad',
    enabled: true,
  });

  const second = new HostBudget(db, 'www.walmart.com:node-z', { windowMs: 60_000, windowLimit: 2 });
  assert.equal(second.waitMs(), 0, 'a re-pointed node is a different region: clean budget');
});

test('unbinding the last store frees the pacer; rebinding does not carry it over', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bastille-node-lifecycle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, 'lc4.db'));
  const { ClearanceRepo } = await import('../src/clearance/repo.js');

  db.prepare(
    `INSERT INTO walmart_store (location_id, name, lat, lng, enabled, added_at)
     VALUES (?,?,?,?,1,?)`,
  ).run('s1', 'Store One', 38.0, -78.0, new Date().toISOString());

  const repo = new ClearanceRepo(db);
  repo.upsertEgressNode({
    id: 'node-a',
    label: 'A',
    proxyUrl: 'http://proxy-a:1',
    region: null,
    enabled: true,
  });
  repo.upsertEgressNode({
    id: 'node-b',
    label: 'B',
    proxyUrl: 'http://proxy-b:1',
    region: null,
    enabled: true,
  });

  api.setHostBudget(null);
  repo.setStoreEgressNode('s1', 'node-a');
  api.backOffUntil(120_000, 'node-a');

  // Move the store to node-b: node-a has no remaining bound store, so its
  // cooldown slot must be released rather than left lying around.
  repo.setStoreEgressNode('s1', 'node-b');

  pool
    .intercept({ path: /orchestra\/snb\/graphql\/Browse/, method: 'GET' })
    .reply(200, shelfBody('Sheila Lane Supercenter'));
  const started = Date.now();
  await api.clearanceShelf({ categoryId: '3944', egressNodeId: 'node-a' });
  assert.ok(Date.now() - started < 5_000, 'node-a must not keep a cooldown after losing its last store');
  void t;
});
