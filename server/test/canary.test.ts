/**
 * Per-node canary: one cheap read that proves an exit point still answers for
 * the store it was attested at, taken *before* that node spends its budget.
 *
 * The failure these guard against is quiet. A residential proxy's exit IP can
 * move between runs; Walmart resolves the store from the requesting address, so
 * a node that has drifted simply starts answering for another metro's rack.
 * Without a canary that costs a night of budget and produces confident findings
 * filed under the wrong store — the most expensive kind of wrong answer here.
 *
 * No test in this file reaches Walmart: the reads are served by an undici
 * MockAgent, and the sweep's shelf reader is injected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, setGlobalDispatcher } from 'undici';
import type { EgressNode } from '../src/clearance/repo.js';

process.env.WALMART_REQUEST_INTERVAL_MS = '0';
process.env.WALMART_REQUEST_JITTER_MS = '0';
process.env.BASTILLE_MIN_REQUEST_INTERVAL_MS = '0';

const agent = new MockAgent();
agent.disableNetConnect();
setGlobalDispatcher(agent);

const { openDb } = await import('../src/db.js');
const { HostBudget } = await import('../src/clearance/host-budget.js');
const api = await import('../src/clearance/walmart-api.js');
const { setHttpDispatcher } = await import('../src/adapters/http.js');
setHttpDispatcher(agent);

const { ClearanceRepo } = await import('../src/clearance/repo.js');
const { ClearanceSweepJob, gateStoresByNodeHealth, healthOf } = await import('../src/jobs/clearance-sweep.js');
const { sweepOrder } = await import('../src/clearance/categories.js');

const pool = agent.get('https://www.walmart.com');

/** A one-page Browse response naming `storeName` — all the canary reads. */
function shelfBody(storeName: string) {
  return {
    data: {
      search: {
        searchResult: {
          aggregatedCount: 1,
          maxPage: 1,
          pageMetadata: { storeSelectionHeader: { storeDislayName: storeName } },
          itemStacks: [],
        },
      },
    },
  };
}

function answerWith(storeName: string): void {
  pool.intercept({ path: /orchestra\/snb\/graphql\/Browse/, method: 'GET' }).reply(200, shelfBody(storeName));
}

function refuseWith(status: number): void {
  pool.intercept({ path: /orchestra\/snb\/graphql\/Browse/, method: 'GET' }).reply(status, 'px');
}

/** A repo with one node, freshly paced, and no store bound yet. */
type TestContext = { after(fn: () => void): void };

function setup(t: TestContext, nodeId = 'node-a') {
  const dir = mkdtempSync(join(tmpdir(), 'bastille-canary-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, 'c.db'));
  const repo = new ClearanceRepo(db);
  // Drop any pacing state left by an earlier test on this node id, *then*
  // install the node's budget, so the ledger under test is the live one.
  api.forgetNodePacer(nodeId);
  // An empty proxy_url means "use the injected dispatcher" — a real one would
  // build its own ProxyAgent and leave the machine.
  repo.upsertEgressNode({ id: nodeId, label: nodeId, proxyUrl: '', region: 'va,us', enabled: true });
  repo.installEgressBudgets();
  return { repo, db, dir };
}

test('a canary that names the attested store leaves the node ok', async (t) => {
  const { repo } = setup(t);
  const at = '2026-10-12T04:00:00.000Z';
  repo.setNodeHealth('node-a', 'ok', 'Charlottesville Supercenter', at);

  assert.deepEqual(repo.getEgressNodesDueForCanary(Date.parse(at)), []);

  answerWith('Charlottesville Supercenter');
  const result = await api.canaryProbe({
    id: 'node-a',
    proxyUrl: '',
    verifiedStore: repo.getEgressNode('node-a')!.verifiedStore,
  });
  assert.equal(result.ok, true);
  assert.equal(result.error, null);

  const after = '2026-10-12T04:05:00.000Z';
  repo.setNodeHealth('node-a', healthOf(result), result.answeredStore, after);
  const node = repo.getEgressNode('node-a')!;
  assert.equal(node.health, 'ok');
  assert.equal(node.verifiedStore, 'Charlottesville Supercenter');
  assert.equal(node.verifiedAt, after);
});

test('a canary that names a different store marks the node drifted and keeps the old attestation', async (t) => {
  const { repo } = setup(t);
  repo.setNodeHealth('node-a', 'ok', 'Charlottesville Supercenter', '2026-10-11T04:00:00.000Z');

  answerWith('Gordonsville Supercenter');
  const result = await api.canaryProbe({
    id: 'node-a',
    proxyUrl: '',
    verifiedStore: repo.getEgressNode('node-a')!.verifiedStore,
  });

  assert.equal(result.ok, false);
  assert.equal(result.answeredStore, 'Gordonsville Supercenter');
  assert.equal(result.error?.kind, 'mismatch');
  assert.equal(healthOf(result), 'drifted');

  repo.setNodeHealth('node-a', healthOf(result), result.ok ? result.answeredStore : null);
  const node = repo.getEgressNode('node-a')!;
  assert.equal(node.health, 'drifted');
  // Not overwritten: the answered store is the evidence, and adopting it would
  // make every later canary agree with the drift.
  assert.equal(node.verifiedStore, 'Charlottesville Supercenter');
});

test('a 412 marks the node blocked, not drifted', async (t) => {
  const { repo } = setup(t);
  repo.setNodeHealth('node-a', 'ok', 'Charlottesville Supercenter', '2026-10-11T04:00:00.000Z');

  refuseWith(412);
  const result = await api.canaryProbe({
    id: 'node-a',
    proxyUrl: '',
    verifiedStore: repo.getEgressNode('node-a')!.verifiedStore,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, 'http_412');
  assert.equal(healthOf(result), 'blocked');

  repo.setNodeHealth('node-a', healthOf(result), result.ok ? result.answeredStore : null);
  assert.equal(repo.getEgressNode('node-a')!.health, 'blocked');
});

test('a node that has never been attested adopts whatever store answers', async (t) => {
  const { repo } = setup(t);
  assert.equal(repo.getEgressNode('node-a')!.verifiedStore, null);

  answerWith('Gordonsville Supercenter');
  const result = await api.canaryProbe({
    id: 'node-a',
    proxyUrl: '',
    verifiedStore: repo.getEgressNode('node-a')!.verifiedStore,
  });
  assert.equal(result.ok, true, 'a first canary attests, it does not condemn');

  const at = '2026-10-12T04:00:00.000Z';
  repo.setNodeHealth('node-a', healthOf(result), result.answeredStore, at);
  const node = repo.getEgressNode('node-a')!;
  assert.equal(node.health, 'ok');
  assert.equal(node.verifiedStore, 'Gordonsville Supercenter');
  assert.equal(node.verifiedAt, at);
});

test('the canary read is not charged to the node budget', async (t) => {
  const { repo, db } = setup(t);
  const budget = new HostBudget(db, 'www.walmart.com:node-a');
  const before = budget.state().readsInWindow;

  answerWith('Charlottesville Supercenter');
  const result = await api.canaryProbe({
    id: 'node-a',
    proxyUrl: '',
    verifiedStore: null,
  });
  assert.equal(result.ok, true);

  assert.equal(
    budget.state().readsInWindow,
    before,
    'the canary decides whether the budget is spent; it cannot spend it itself',
  );
});

test('the sweep reads an ok node and skips a drifted one', async (t) => {
  const { repo } = setup(t);
  repo.setLocalStore('Charlottesville Supercenter', null);
  repo.setStoreEgressNode('Charlottesville Supercenter', 'node-a');
  // Attested long enough ago that the canary is due again; it then drifts.
  repo.setNodeHealth('node-a', 'ok', 'Charlottesville Supercenter', '2020-01-01T00:00:00.000Z');
  answerWith('Gordonsville Supercenter');
  const drifted = new ClearanceSweepJob(repo, async () => {
    throw new Error('the drifted node must not be read');
  });
  const first = await drifted.runOnce();

  assert.equal(repo.getEgressNode('node-a')!.health, 'drifted');
  assert.equal(first.storesSwept, 0);
  assert.ok(first.errors.some((e) => e.includes('node-a')), first.errors.join(' | '));
  assert.ok(first.errors.some((e) => e.includes('drifted')), first.errors.join(' | '));
});

test('the sweep reads every node the canary cleared', async (t) => {
  const { repo } = setup(t);
  repo.setLocalStore('Charlottesville Supercenter', null);
  repo.setStoreEgressNode('Charlottesville Supercenter', 'node-a');

  // Freshly attested, so no canary is due and the node is swept.
  repo.setNodeHealth('node-a', 'ok', 'Charlottesville Supercenter', new Date().toISOString());

  let reads = 0;
  const job = new ClearanceSweepJob(repo, async () => {
    reads++;
    return { items: [], totalCount: 0, pageItemCount: 0, shippedOnly: 0, storeName: 'Charlottesville Supercenter', maxPage: 1 };
  });
  const result = await job.runOnce();

  assert.equal(reads, sweepOrder().length, 'every shelf of a cleared node is read');
  assert.equal(result.storesSwept, 1);
});

test('only the nodes whose canary passed are swept', () => {
  const stores = [
    { locationId: '1', egressNodeId: 'a' },
    { locationId: '2', egressNodeId: 'b' },
    { locationId: '3', egressNodeId: 'c' },
  ];
  const nodes = (health: Record<string, 'ok' | 'drifted' | 'blocked' | null>): EgressNode[] =>
    (['a', 'b', 'c'] as const).map((id) => ({
      id,
      label: id,
      proxyUrl: '',
      region: null,
      enabled: true,
      addedAt: '',
      lastUsedAt: null,
      verifiedStore: id.toUpperCase(),
      verifiedAt: '',
      health: health[id],
    }));

  const allOk = gateStoresByNodeHealth(stores, nodes({ a: 'ok', b: 'ok', c: 'ok' }));
  assert.deepEqual(allOk.sweepable.map((s) => s.locationId), ['1', '2', '3']);
  assert.equal(allOk.excluded.length, 0);

  const oneDrifted = gateStoresByNodeHealth(stores, nodes({ a: 'ok', b: 'ok', c: 'drifted' }));
  assert.deepEqual(oneDrifted.sweepable.map((s) => s.locationId), ['1', '2']);
  assert.deepEqual(oneDrifted.excluded, [{ locationId: '3', egressNodeId: 'c', health: 'drifted' }]);

  // A store on no node at all is the process's own egress: nothing to attest.
  const unbound = gateStoresByNodeHealth([{ locationId: '9', egressNodeId: null }], []);
  assert.equal(unbound.sweepable.length, 1);
});

test('a node the canary never checked is not swept either', () => {
  const gate = gateStoresByNodeHealth(
    [{ locationId: '1', egressNodeId: 'a' }],
    [
      {
        id: 'a',
        label: 'a',
        proxyUrl: '',
        region: null,
        enabled: true,
        addedAt: '',
        lastUsedAt: null,
        verifiedStore: null,
        verifiedAt: null,
        health: null,
      },
    ],
  );
  assert.equal(gate.sweepable.length, 0);
});

test.after(() => agent.close());