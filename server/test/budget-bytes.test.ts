/**
 * The budget's second half: it counts bytes and it is keyed per exit point.
 *
 * A read count alone cannot enforce a byte ceiling, and a budget keyed on the
 * host alone cannot survive a node being retired — the old schema faked
 * per-node ledgers by pasting the node id into the host string, which is why
 * nothing could attribute a byte to an IP either. These tests pin the real
 * (host, egress_node_id) key, the byte column, and the cascade that retires a
 * ledger with its node.
 *
 * Nothing leaves the machine: undici's MockAgent stands in for www.walmart.com.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MockAgent, setGlobalDispatcher } from 'undici';

process.env.WALMART_REQUEST_INTERVAL_MS = '0';
process.env.WALMART_REQUEST_JITTER_MS = '0';
process.env.BASTILLE_MIN_REQUEST_INTERVAL_MS = '0';

const agent = new MockAgent();
agent.disableNetConnect();
setGlobalDispatcher(agent);

const { openDb } = await import('../src/db.js');
const { HostBudget, WALMART_HOST } = await import('../src/clearance/host-budget.js');
const { LOCAL_EGRESS_NODE_ID } = await import('../src/db/migrations.js');
const api = await import('../src/clearance/walmart-api.js');
const { setHttpDispatcher } = await import('../src/adapters/http.js');
const { hostMetrics, installRequestLog, recordRequest } = await import('../src/metrics.js');
const { ClearanceRepo } = await import('../src/clearance/repo.js');
setHttpDispatcher(agent);

const pool = agent.get('https://www.walmart.com');

function tempDb(t: { after: (fn: () => void) => void }): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'bastille-bytes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return openDb(join(dir, 'bytes.db'));
}

function addNode(db: DatabaseSync, id: string): void {
  db.prepare(
    `INSERT INTO egress_node (id, label, proxy_url, enabled, added_at) VALUES (?, ?, 'http://proxy', 1, ?)`,
  ).run(id, id, new Date().toISOString());
}

test('bytes accrue exactly and the window stays open under the byte ceiling', (t) => {
  const db = tempDb(t);
  const b = new HostBudget(db, WALMART_HOST, LOCAL_EGRESS_NODE_ID, { windowMs: 60_000, windowLimit: 1_000, byteLimit: 10_000 });
  const t0 = 1_000_000;

  for (let i = 0; i < 5; i++) b.recordRead(t0, 1_000);

  assert.equal(b.state(t0).bytesInWindow, 5_000, 'five reads of 1000 bytes sum to exactly 5000');
  assert.equal(b.state(t0).readsInWindow, 5);
  assert.equal(b.waitMs(t0 + 1), 0, 'half the byte ceiling is not a block');

  // The count survives a restart: a fresh handle on the same file agrees.
  assert.equal(new HostBudget(db, WALMART_HOST, LOCAL_EGRESS_NODE_ID).state(t0).bytesInWindow, 5_000);
});

test('the byte ceiling closes the window before the read ceiling', (t) => {
  const db = tempDb(t);
  // The read cap is unreachable on purpose: the bytes are what stop the reads.
  const b = new HostBudget(db, WALMART_HOST, LOCAL_EGRESS_NODE_ID, { windowMs: 60_000, windowLimit: 1_000, byteLimit: 5_000 });
  const t0 = 1_000_000;

  for (let i = 0; i < 4; i++) b.recordRead(t0, 1_000);
  assert.equal(b.state(t0).readsInWindow, 4);
  assert.equal(b.waitMs(t0 + 1), 0, 'still under the byte ceiling');
  assert.ok(b.state(t0).readsInWindow < 1_000, 'the read cap was never reached');

  b.recordRead(t0, 1_000);
  assert.equal(b.state(t0).readsInWindow, 5, 'the fifth read is still counted');
  assert.ok(b.waitMs(t0 + 1) > 59_000, 'the byte ceiling closes the window');
});

test('a node at its byte ceiling is refused locally, without a request', async (t) => {
  api.setHostBudget(null);
  api.forgetNodePacer('fat-node');
  const db = tempDb(t);
  addNode(db, 'fat-node');
  // A window longer than MAX_PACE_WAIT_MS, so the block is raised rather than
  // slept through, and a byte ceiling the fixture's single read blows past.
  api.setNodeHostBudget(
    'fat-node',
    new HostBudget(db, WALMART_HOST, 'fat-node', { windowMs: 300_000, windowLimit: 1_000, byteLimit: 1 }),
  );
  t.after(() => api.setHostBudget(null));

  let hits = 0;
  pool
    .intercept({ path: /orchestra\/snb\/graphql\/Browse/, method: 'GET' })
    .reply(200, () => {
      hits++;
      return JSON.stringify({
        data: {
          search: {
            searchResult: {
              aggregatedCount: 0,
              maxPage: 1,
              pageMetadata: { storeSelectionHeader: { storeDislayName: 'Test Store' } },
              itemStacks: [],
            },
          },
        },
      });
    });

  await api.clearanceShelf({ categoryId: '3944', egressNodeId: 'fat-node' });
  assert.equal(hits, 1, 'the first read went out and was charged');

  const ledger = new HostBudget(db, WALMART_HOST, 'fat-node', { windowMs: 300_000, byteLimit: 1 });
  assert.ok(ledger.state().bytesInWindow > 0, 'the response bytes reached the ledger');
  assert.ok(ledger.waitMs() > 0, 'the byte ceiling blocks the next read');

  await assert.rejects(
    () => api.clearanceShelf({ categoryId: '3944', egressNodeId: 'fat-node' }),
    api.WalmartCooldownError,
  );
  assert.equal(hits, 1, 'the refused read never touched the network');
});

test('deleting an egress node cascades its budget row', (t) => {
  const db = tempDb(t);
  addNode(db, 'doomed');
  const repo = new ClearanceRepo(db);

  const b = new HostBudget(db, WALMART_HOST, 'doomed', { windowMs: 60_000, windowLimit: 5 });
  b.recordRead(1_000_000);
  b.recordRead(1_000_000, 4_000);
  assert.equal(b.state(1_000_000).readsInWindow, 2);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM host_budget WHERE egress_node_id = ?').get('doomed') as { n: number }).n,
    1,
  );

  repo.deleteEgressNode('doomed');

  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM host_budget WHERE egress_node_id = ?').get('doomed') as { n: number }).n,
    0,
    'the ledger went with the node',
  );
  // A node id can be reused without inheriting a spent window.
  addNode(db, 'doomed');
  assert.equal(new HostBudget(db, WALMART_HOST, 'doomed').state(1_000_000).readsInWindow, 0);
});

test('hostMetrics groups by host, and by host and node', (t) => {
  const db = tempDb(t);
  const uninstall = installRequestLog(db);
  t.after(uninstall);

  recordRequest({ host: WALMART_HOST, op: '/a', status: 200, ms: 10, bytes: 100, egressNodeId: 'node-a' });
  recordRequest({ host: WALMART_HOST, op: '/b', status: 412, ms: 20, bytes: 300, egressNodeId: 'node-a' });
  recordRequest({ host: WALMART_HOST, op: '/c', status: 200, ms: 30, bytes: 200, egressNodeId: 'node-b' });
  recordRequest({ host: 'wegmans.com', op: '/d', status: 200, ms: 40, bytes: 50, egressNodeId: null });

  const byHost = hostMetrics(db, 24);
  assert.deepEqual(Object.keys(byHost).sort(), ['wegmans.com', WALMART_HOST].sort());
  assert.equal(byHost[WALMART_HOST]!.requests, 3, 'every node reads as one host by default');
  assert.equal(byHost[WALMART_HOST]!.bytes, 600);
  assert.equal(byHost[WALMART_HOST]!.throttled['412'], 1);

  const byNode = hostMetrics(db, 24, new Date(), { byNode: true });
  assert.deepEqual(
    Object.keys(byNode).sort(),
    [`${WALMART_HOST}|node-a`, `${WALMART_HOST}|node-b`, 'wegmans.com|local'].sort(),
  );
  assert.equal(byNode[`${WALMART_HOST}|node-a`]!.requests, 2);
  assert.equal(byNode[`${WALMART_HOST}|node-a`]!.bytes, 400);
  assert.equal(byNode[`${WALMART_HOST}|node-b`]!.bytes, 200);
  assert.equal(byNode['wegmans.com|local']!.requests, 1, 'a read with no node is not lost');
});

test('a legacy database is migrated onto the real key', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bastille-legacy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'legacy.db');

  // The shape this change leaves behind: a single-column key, ids concatenated
  // into it, and no byte or node column anywhere.
  const old = new DatabaseSync(path);
  old.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE egress_node (id TEXT PRIMARY KEY, label TEXT NOT NULL, proxy_url TEXT NOT NULL,
      region TEXT, enabled INTEGER NOT NULL DEFAULT 1, added_at TEXT NOT NULL, last_used_at TEXT);
    INSERT INTO egress_node (id, label, proxy_url, added_at) VALUES ('node-a', 'a', 'http://p', 'now');
    CREATE TABLE host_budget (host TEXT PRIMARY KEY, not_before INTEGER NOT NULL DEFAULT 0,
      window_started_at INTEGER NOT NULL DEFAULT 0, reads_in_window INTEGER NOT NULL DEFAULT 0,
      last_status INTEGER, updated_at TEXT NOT NULL);
    INSERT INTO host_budget (host, not_before, window_started_at, reads_in_window, last_status, updated_at)
      VALUES ('www.walmart.com:node-a', 0, 1000, 7, 412, 'now');
    CREATE TABLE request_log (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, host TEXT NOT NULL,
      op TEXT NOT NULL, status INTEGER NOT NULL, ms INTEGER NOT NULL, bytes INTEGER NOT NULL DEFAULT 0);
  `);
  old.close();

  const db = openDb(path);
  assert.ok(
    (db.prepare('PRAGMA table_info(request_log)').all() as { name: string }[]).some((c) => c.name === 'egress_node_id'),
  );
  const rows = (
    db.prepare('SELECT host, egress_node_id, reads_in_window, last_status FROM host_budget').all() as Record<
      string,
      unknown
    >[]
  ).map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { host: WALMART_HOST, egress_node_id: 'node-a', reads_in_window: 7, last_status: 412 },
  ]);
  // And the migrated row is a working ledger again.
  assert.equal(new HostBudget(db, WALMART_HOST, 'node-a').state(2_000).readsInWindow, 7);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 9').get() as { n: number }).n,
    1,
    'the migration is recorded, so it does not run twice',
  );
});

test.after(() => agent.close());
