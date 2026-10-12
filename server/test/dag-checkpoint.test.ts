/**
 * DAG checkpoint / resume / idempotency tests (todo 10).
 *
 * Required scenarios from the plan:
 *  1. A run killed after 3 of 6 nodes and restarted completes the remaining
 *     3 without re-reading the first 3.
 *  2. Re-running a completed node with the same idempotency key inserts
 *     zero duplicate rows.
 *  3. A second run with the same inputs produces identical final state in
 *     the dag_node_run table.
 *
 * Plus the no-budget-double-counting guarantee from the spec body: a resumed
 * run must not increment the durable host_budget ledger for already-cached
 * nodes. The test wires a counting Budget so we can see exactly how many
 * times recordRead was called.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDb } from '../src/db.js';
import {
  runDag,
  resumeDag,
  SqliteCheckpointStore,
  type DagNode,
  type NodeCtx,
  type NodeResult,
} from '../src/dag/index.js';

// ---- helpers ---------------------------------------------------------------

function fixedClock(at: number) {
  return { now: () => at };
}

function silentLogger() {
  return { log: () => {} };
}

function passthroughTransport() {
  return { post: async () => ({ status: 0, body: null }) };
}

/** A Budget that records every recordRead call so the test can prove the
 *  resumed run did NOT spend budget for cached nodes. */
function countingBudget() {
  const reads: string[] = [];
  const speaker = {
    spent: 0,
    ceiling: Number.POSITIVE_INFINITY,
    recordRead(): number {
      reads.push(`read`);
      return ++this.spent;
    },
    assertAvailable(): void {
      // no-op for tests
    },
    _snapshot(): readonly string[] {
      return reads;
    },
    _count(): number {
      return reads.length;
    },
  };
  return speaker;
}

/** Each call to this helper records one entry on the budget -- the runtime
 *  shape of a node that makes one upstream read. The whole test hinges on
 *  the resume path NOT firing this for cached nodes. */
function oneReadNode(id: string, deps: string[], runs: NodeRunCounter, budget: ReturnType<typeof countingBudget>): DagNode {
  return {
    id,
    deps,
    run: async (_upstream, ctx) => {
      runs[id] = (runs[id] ?? 0) + 1;
      // Mirror what a network-touching node would do: one read against
      // the durable per-node ledger. Real adapters tap into the in-ctx
      // budget in their transport layer; here we wire it straight in.
      ctx.budget.recordRead();
      return { who: id, n: runs[id] };
    },
  };
}

/**
 * DB-per-test helper. Uses `openDb` so each test sees the real schema, then
 * returns the SqliteCheckpointStore pinned to it. The clock is fixed at 0 so
 * every ISO timestamp in the ledger is a deterministic value (and collisions
 * within a test cannot happen because each test gets a fresh directory).
 */
function freshStore(t: { after: (fn: () => void) => void }, seed: number = 0): {
  store: SqliteCheckpointStore;
  path: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'bastille-dag-cp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'cp.db');
  const db = openDb(path);
  return {
    store: new SqliteCheckpointStore(db, fixedClock(seed)),
    path,
  };
}

function makeCtx(budget: ReturnType<typeof countingBudget>): NodeCtx {
  return {
    clock: fixedClock(1_700_000_000_000),
    rng: { next: () => 0.5 },
    budget: budget as unknown as NodeCtx['budget'],
    logger: silentLogger() as unknown as NodeCtx['logger'],
    transport: passthroughTransport() as unknown as NodeCtx['transport'],
    inputs: {},
  };
}

/** A small in-process logger to show that node run callbacks fire on a layer. */
type NodeRunCounter = { [id: string]: number };

// ---- the three plan-mandated scenarios ------------------------------------

test('resume completes the remaining 3 nodes without re-running the first 3', async (t) => {
  const { store } = freshStore(t);
  const budget = countingBudget();
  const runs: NodeRunCounter = {};
  const graph: DagNode[] = ['a', 'b', 'c'].map((id) =>
    oneReadNode(id, [], runs, budget),
  );
  for (const id of ['d', 'e', 'f'] as const) {
    graph.push(oneReadNode(id, ['a', 'b', 'c'], runs, budget));
  }

  // Simulate a prior run that completed layer 1 (a, b, c) and was killed
  // before layer 2 fired. The "kill" is a process boundary in real life;
  // here it is a half-finished `dag_run` plus three succeeded node rows.
  const runId = store.beginRun(JSON.stringify({}));
  for (const id of ['a', 'b', 'c'] as const) {
    store.recordCheckpoint(runId, id, '2026-10-12', `hash-${id}`, {
      status: 'succeeded',
      attempt: 1,
      ms: 7,
      data: { who: id, n: 1 },
    });
  }

  const ctx = makeCtx(budget);
  const results = await resumeDag(graph, ctx, {}, runId, store);

  for (const id of ['a', 'b', 'c'] as const) {
    assert.equal(runs[id], undefined, `node ${id} should NOT have re-executed on resume`);
    assert.equal(results[id]!.status, 'succeeded');
    assert.deepEqual(results[id]!.data, { who: id, n: 1 });
  }
  for (const id of ['d', 'e', 'f'] as const) {
    assert.equal(runs[id], 1, `node ${id} should have run exactly once on resume`);
    assert.equal(results[id]!.status, 'succeeded');
  }
  // Reads are recorded per execution; the resumed nodes (d, e, f) are the
  // only ones to spend budget, exactly as an uninterrupted run would.
  assert.equal(
    budget._count(),
    3,
    'resumed run spends budget for the 3 actually-run nodes, not the 3 cached ones',
  );
});

test('re-running with the same idempotency key inserts zero duplicate rows', async (t) => {
  const { store } = freshStore(t);
  const budget = countingBudget();
  const runs: NodeRunCounter = {};
  const graph: DagNode[] = ['a', 'b', 'c'].map((id) =>
    oneReadNode(id, [], runs, budget),
  );
  for (const id of ['d', 'e', 'f'] as const) {
    graph.push(oneReadNode(id, ['a', 'b', 'c'], runs, budget));
  }

  // First run: a fresh runId, every node produces a checkpoint.
  const ctx = makeCtx(budget);
  const firstRunId = store.beginRun(JSON.stringify({}));
  await runDag(graph, ctx, {}, {
    store,
    runId: firstRunId,
    logicalDate: '2026-10-12',
    scopeHash: () => 'scope-A',
  });

  const rowsAfterFirst = countNodeRuns(store);
  assert.equal(
    rowsAfterFirst,
    6,
    'first run writes exactly 6 succeeded rows (one per node)',
  );

  // Second run: same logical_date + scopeHash, runId is fresh. The engine's
  // idempotency pre-pass must short-circuit every node from the prior run's
  // results, so no new dag_node_run row is created.
  const budget2 = countingBudget();
  const runs2: NodeRunCounter = {};
  const graph2: DagNode[] = ['a', 'b', 'c'].map((id) =>
    oneReadNode(id, [], runs2, budget2),
  );
  for (const id of ['d', 'e', 'f'] as const) {
    graph2.push(oneReadNode(id, ['a', 'b', 'c'], runs2, budget2));
  }
  const ctx2 = makeCtx(budget2);
  const secondRunId = store.beginRun(JSON.stringify({}));
  await runDag(graph2, ctx2, {}, {
    store,
    runId: secondRunId,
    logicalDate: '2026-10-12',
    scopeHash: () => 'scope-A',
  });

  const rowsAfterSecond = countNodeRuns(store);
  assert.equal(
    rowsAfterSecond,
    rowsAfterFirst,
    'same idempotency key inserts no new dag_node_run rows',
  );

  // No node ran a second time -- budget untouched.
  assert.equal(
    budget2._count(),
    0,
    'idempotent re-run spends zero budget (no node actually executed)',
  );

  // Run rows, however, do grow: a new runId means a new dag_run row. That
  // is intentional; only the *node* rows are controlled by the idempotency
  // key.
  const runRows = countRunRows(store);
  assert.equal(runRows, 2, 'two dag_run rows (one per call), independent of node idempotency');
});

test('a second run with the same inputs leaves dag_node_run identical to the first run', async (t) => {
  const { store } = freshStore(t);
  const build = (budget: ReturnType<typeof countingBudget>): DagNode[] => {
    const runs: NodeRunCounter = {};
    const g: DagNode[] = ['a', 'b', 'c'].map((id) =>
      oneReadNode(id, [], runs, budget),
    );
    for (const id of ['d', 'e', 'f'] as const) {
      g.push(oneReadNode(id, ['a', 'b', 'c'], runs, budget));
    }
    return g;
  };

  // Two runs, same logical_date + scope_hash. They reach the same node
  // results but the second run is a pure cache hit.
  await runDag(build(countingBudget()), makeCtx(countingBudget()), {}, {
    store,
    logicalDate: '2026-10-12',
    scopeHash: () => 'scope-A',
  });

  const snapshot = snapshotNodeRows(store);
  assert.equal(snapshot.size, 6, 'first run populates 6 node rows');

  await runDag(build(countingBudget()), makeCtx(countingBudget()), {}, {
    store,
    logicalDate: '2026-10-12',
    scopeHash: () => 'scope-A',
  });

  assert.deepEqual(
    snapshotNodeRows(store),
    snapshot,
    'after the second run the dag_node_run state is byte-identical to the first',
  );
});

// ---- supporting tests: the engine-side guarantees the spec names --------

test('resumed run does NOT double-count reads against the durable ledger', async (t) => {
  const { store } = freshStore(t);
  // 4-node chain: n1 -> n2 -> n3 -> n4. Simulate kill after n1 and n2.
  const budget = countingBudget();
  const runs: NodeRunCounter = {};
  const graph: DagNode[] = ['n1', 'n2', 'n3', 'n4'].map((id) =>
    oneReadNode(
      id,
      id === 'n1' ? [] : id === 'n2' ? ['n1'] : id === 'n3' ? ['n2'] : ['n3'],
      runs,
      budget,
    ),
  );

  const runId = store.beginRun(JSON.stringify({}));
  store.recordCheckpoint(
    runId,
    'n1',
    '2026-10-12',
    'scope',
    { status: 'succeeded', attempt: 1, ms: 1, data: { who: 'n1', n: 1 } },
    '2026-10-12T00:00:00.000Z',
  );
  store.recordCheckpoint(
    runId,
    'n2',
    '2026-10-12',
    'scope',
    { status: 'succeeded', attempt: 1, ms: 1, data: { who: 'n2', n: 1 } },
    '2026-10-12T00:00:00.000Z',
  );

  await resumeDag(graph, makeCtx(budget), {}, runId, store);

  // Only n3 and n4 actually executed. budget.recordRead was called exactly
  // twice (once per node), and the durable host_budget the engine would
  // have ticked was therefore touched exactly twice. Resuming after a kill
  // does not double-count.
  assert.deepEqual(
    runs,
    { n3: 1, n4: 1 },
    'only the still-pending nodes ran their callbacks',
  );
  assert.equal(budget._count(), 2, 'budget spent exactly equals number of actually-run nodes');
});

test('idempotency pre-pass returns cached data without calling node.run', async (t) => {
  const { store } = freshStore(t);
  let runCount = 0;
  const graph: DagNode[] = [
    {
      id: 'cached',
      deps: [],
      run: async () => {
        runCount++;
        return { firstTime: true };
      },
    },
    {
      id: 'downstream',
      deps: ['cached'],
      run: async (upstream) => {
        // If upstream.data round-trips, the cache hit is working.
        return (upstream as Record<string, NodeResult>).cached!.data;
      },
    },
  ];

  // Pre-seed a cached succeeded row.
  const runId = store.beginRun(JSON.stringify({}));
  store.recordCheckpoint(
    runId,
    'cached',
    '2026-10-12',
    'hash',
    { status: 'succeeded', attempt: 1, ms: 0, data: { firstTime: false } },
    '2026-10-12T00:00:00.000Z',
  );

  await runDag(graph, makeCtx(countingBudget()), {}, {
    store,
    runId,
    logicalDate: '2026-10-12',
    scopeHash: () => 'hash',
  });

  assert.equal(runCount, 0, 'node.run was never called for the cached node');
});

// ---- store-level support -------------------------------------------------

test('two distinct (logical_date, scope_hash) keys never share a cache hit', async (t) => {
  const { store } = freshStore(t);
  let count = 0;
  const graph: DagNode[] = [
    {
      id: 'n',
      deps: [],
      run: async () => {
        count++;
        return { count };
      },
    },
  ];

  const ctx = makeCtx(countingBudget());

  await runDag(graph, ctx, {}, {
    store,
    logicalDate: '2026-10-12',
    scopeHash: () => 'scope-A',
  });
  assert.equal(count, 1);

  await runDag(graph, ctx, {}, {
    store,
    logicalDate: '2026-10-13',
    scopeHash: () => 'scope-A',
  });
  assert.equal(count, 2, 'different logical_date -> cache miss, node re-runs');

  await runDag(graph, ctx, {}, {
    store,
    logicalDate: '2026-10-13',
    scopeHash: () => 'scope-B',
  });
  assert.equal(count, 3, 'different scope_hash -> cache miss, node re-runs');

  // Same triple: cache hit.
  await runDag(graph, ctx, {}, {
    store,
    logicalDate: '2026-10-13',
    scopeHash: () => 'scope-B',
  });
  assert.equal(count, 3, 'same (node_id, logical_date, scope_hash) -> cache hit');
});

// These helpers poke the SQLite layer through the SqliteCheckpointStore to
// read the underlying tables directly without exporting new internals. The
// cast-through-unknown is the standard SQLite-to-typed-row bridge used in
// the rest of the codebase (see server/src/db.ts consumers).

function storeDb(store: SqliteCheckpointStore): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
}

function countNodeRuns(store: SqliteCheckpointStore): number {
  const r = storeDb(store)
    .prepare(`SELECT COUNT(*) AS n FROM dag_node_run`)
    .get() as { n: number };
  return r.n;
}

function countRunRows(store: SqliteCheckpointStore): number {
  const r = storeDb(store)
    .prepare(`SELECT COUNT(*) AS n FROM dag_run`)
    .get() as { n: number };
  return r.n;
}

/**
 * Capture a structural snapshot of dag_node_run so two runs can be compared
 * field-by-field. Stable across the same graph+key, byte-identical to a
 * re-run that hits the cache.
 */
function snapshotNodeRows(store: SqliteCheckpointStore): Map<string, Record<string, unknown>> {
  const rows = storeDb(store)
    .prepare(
      `SELECT node_id, attempt, status, ms, checkpoint_json, logical_date, scope_hash
       FROM dag_node_run
       ORDER BY id ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  const out = new Map<string, Record<string, unknown>>();
  for (const row of rows) out.set(row.node_id as string, row);
  return out;
}

// Reference the NodeResult type so a future refactor that removes it from
// the DAG surface breaks this sentinel first -- the test depends on the
// checkpoint_json round-tripping through NodeResult.data.
type _UseNodeResult = NodeResult;
const _useNodeResult: _UseNodeResult | undefined = undefined;
void _useNodeResult;
