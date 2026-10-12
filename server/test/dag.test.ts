/**
 * DAG engine tests. The plan calls for: a frozen-clock + seeded-RNG run that
 * is byte-identical between two runs; a fan-out of 5 nodes that all execute;
 * a throwing sibling that does not block the rest; and a real-clock sanity
 * check that the engine does not throw on `Date.now()`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runDag,
  topoSort,
  NodeError,
  type NodeCtx,
  type DagNode,
  type NodeResult,
  type NodeId,
} from '../src/dag/index.js';
import { DagCycleError } from '../src/dag/index.js';

function fixedClock(at: number) {
  return { now: () => at };
}

function seededRng(seed: number) {
  let state = seed >>> 0;
  return {
    next() {
      // Mulberry32 — deterministic, period 2^32, no platform RNG.
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

function passthroughBudget() {
  let spent = 0;
  return {
    spent,
    ceiling: Number.POSITIVE_INFINITY,
    recordRead() {
      return ++spent;
    },
    assertAvailable() {
      if (spent >= Number.POSITIVE_INFINITY) throw new Error('unreachable');
    },
  };
}

function silentLogger() {
  return { log: () => {} };
}

function passthroughTransport() {
  return {
    post: async () => ({ status: 0, body: null }),
  };
}

function makeCtx(overrides: Partial<NodeCtx> = {}): NodeCtx {
  return {
    clock: fixedClock(1_700_000_000_000),
    rng: seededRng(0xc0ffee),
    budget: passthroughBudget() as unknown as NodeCtx['budget'],
    logger: silentLogger() as unknown as NodeCtx['logger'],
    transport: passthroughTransport() as unknown as NodeCtx['transport'],
    inputs: {},
    ...overrides,
  };
}

test('same seeded graph, frozen clock, seeded RNG: two runs are byte-identical', async () => {
  const buildGraph = (): DagNode[] => [
    {
      id: 'seed',
      deps: [],
      run: async () => 7,
    },
    {
      id: 'pick',
      deps: ['seed'],
      run: async (upstream) => (upstream.seed!.data as number) + 1,
    },
    {
      // Touches both ctx.clock and ctx.rng so a hidden global would diverge.
      id: 'rand',
      deps: ['seed'],
      run: async (_u, ctx) => {
        const a = ctx.clock.now();
        const r = ctx.rng.next();
        return { a, r };
      },
    },
    {
      id: 'join',
      deps: ['pick', 'rand'],
      run: async (upstream) => ({
        pick: upstream.pick!.data,
        rand: upstream.rand!.data,
      }),
    },
  ];
  const a = await runDag(buildGraph(), makeCtx(), {});
  const b = await runDag(buildGraph(), makeCtx(), {});
  // Byte-identical means JSON.stringify gives the exact same string. We are
  // explicit: equal numbers, equal ids, equal data, equal ms fields.
  assert.equal(Object.keys(a).sort().join(','), Object.keys(b).sort().join(','));
  for (const id of Object.keys(a)) {
    assert.deepEqual(a[id], b[id], `result for ${id} differs between runs`);
  }
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('a fan-out of 5 sibling nodes executes all 5', async () => {
  let parentRuns = 0;
  const childRuns = new Map<string, number>();
  const ctx = makeCtx();
  const graph: DagNode[] = [
    {
      id: 'root',
      deps: [],
      run: async () => {
        parentRuns++;
        return { fanout: 5 };
      },
    },
    ...Array.from({ length: 5 }, (_, i): DagNode => ({
      id: `fan-${i}`,
      deps: ['root'],
      run: async (upstream) => {
        childRuns.set(`fan-${i}`, (childRuns.get(`fan-${i}`) ?? 0) + 1);
        return { idx: i, took: upstream.root!.data };
      },
    })),
  ];
  const results = await runDag(graph, ctx, {});
  assert.equal(parentRuns, 1, 'parent runs exactly once');
  assert.equal(childRuns.size, 5, 'all 5 children executed');
  for (let i = 0; i < 5; i++) {
    assert.ok(results[`fan-${i}`], `missing result for fan-${i}`);
    assert.equal(results[`fan-${i}`]!.status, 'succeeded');
    assert.deepEqual(results[`fan-${i}`]!.data, { idx: i, took: { fanout: 5 } });
  }
});

test('a throwing node does not prevent siblings from completing', async () => {
  const ctx = makeCtx();
  const graph: DagNode[] = [
    {
      id: 'root',
      deps: [],
      run: async () => 'ok',
    },
    {
      id: 'throws',
      deps: ['root'],
      run: async () => {
        throw new NodeError('wrong-store', 'echo mismatched node-7 expected node-9');
      },
    },
    {
      id: 'also-ok',
      deps: ['root'],
      run: async () => 'also-ok',
    },
    {
      id: 'plain-throw',
      deps: ['root'],
      run: async () => {
        throw new Error('boom');
      },
    },
  ];
  const results = await runDag(graph, ctx, {});
  assert.equal(results.root!.status, 'succeeded');
  assert.equal(results.root!.data, 'ok');
  assert.equal(results['throws']!.status, 'wrong-store', 'typed NodeError → its status');
  assert.equal(results['plain-throw']!.status, 'failed', 'plain Error → failed');
  assert.equal(results['also-ok']!.status, 'succeeded', 'sibling unaffected by throws');
  assert.equal((results['also-ok']!.data as string), 'also-ok');
});

test('a downstream node receives all upstream results as inputs', async () => {
  const ctx = makeCtx();
  const graph: DagNode[] = [
    { id: 'a', deps: [], run: async () => 1 },
    { id: 'b', deps: [], run: async () => 2 },
    {
      id: 'sum',
      deps: ['a', 'b'],
      run: async (upstream) =>
        (upstream.a!.data as number) + (upstream.b!.data as number),
    },
  ];
  const results = await runDag(graph, ctx, {});
  assert.equal(results.sum!.status, 'succeeded');
  assert.equal(results.sum!.data, 3);
});

test('the engine does not throw on a real, unfrozen clock', async () => {
  const graph: DagNode[] = [
    { id: 'a', deps: [], run: async () => 1 },
    {
      id: 'b',
      deps: ['a'],
      run: async (_u, ctx) => ctx.clock.now(),
    },
  ];
  // Real Date.now() — no Math.random, no Date.now in engine code.
  const ctx: NodeCtx = {
    clock: { now: () => Date.now() },
    rng: { next: () => 0.5 },
    budget: passthroughBudget() as unknown as NodeCtx['budget'],
    logger: silentLogger() as unknown as NodeCtx['logger'],
    transport: passthroughTransport() as unknown as NodeCtx['transport'],
    inputs: {},
  };
  const results = await runDag(graph, ctx, {});
  assert.equal(results.b!.status, 'succeeded');
  assert.ok(typeof results.b!.data === 'number');
});

test('topological sort visits deps before dependents', () => {
  const graph: DagNode[] = [
    { id: 'c', deps: ['b'], run: async () => null },
    { id: 'a', deps: [], run: async () => null },
    { id: 'b', deps: ['a'], run: async () => null },
  ];
  const order = topoSort(graph).map((n) => n.id);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('a cyclic graph throws DagCycleError', () => {
  const graph: DagNode[] = [
    { id: 'a', deps: ['b'], run: async () => null },
    { id: 'b', deps: ['a'], run: async () => null },
  ];
  assert.throws(() => topoSort(graph), (e: unknown) => e instanceof DagCycleError);
  assert.rejects(runDag(graph, makeCtx(), {}), (e: unknown) => e instanceof DagCycleError);
});

test('seed inputs flow to a node with no deps', async () => {
  const ctx = makeCtx();
  const graph: DagNode[] = [
    {
      id: 'echo',
      deps: [],
      run: async (_u, c) => c.inputs.seedValue,
    },
    {
      id: 'passthru',
      deps: ['echo'],
      run: async (u) => u.echo!.data,
    },
  ];
  const results = await runDag(graph, ctx, { seedValue: 'hello' });
  assert.equal(results.echo!.data, 'hello');
  assert.equal(results.passthru!.data, 'hello');
});

test('all results carry attempt: 1 and a non-negative ms', async () => {
  const ctx = makeCtx();
  const graph: DagNode[] = [
    { id: 'a', deps: [], run: async () => 1 },
    { id: 'b', deps: ['a'], run: async () => 2 },
  ];
  const results = await runDag(graph, ctx, {});
  for (const id of Object.keys(results) as NodeId[]) {
    const r: NodeResult = results[id]!;
    assert.equal(r.attempt, 1);
    assert.ok(r.ms >= 0);
    assert.ok(typeof r.status === 'string');
  }
});
