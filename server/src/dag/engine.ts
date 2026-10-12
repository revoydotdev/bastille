/**
 * The DAG engine.
 *
 * Pure over `(graph, ctx, inputs)`. No I/O; no `Date.now`; no `Math.random`;
 * no filesystem; no database; no network. Every layer of ready nodes runs in
 * parallel via `Promise.allSettled` so a single throwing node does not take
 * its siblings with it. Layers are scheduled in topological order, so
 * downstream nodes only fire after every upstream node has produced a
 * `NodeResult`.
 *
 * The engine is deterministic in the sense the plan requires: given the same
 * `ctx` (frozen clock, seeded RNG), the same `graph`, and the same `inputs`,
 * the returned `Record<NodeId, NodeResult>` is byte-identical between runs.
 *
 * Durability (todo 10): the engine itself does not touch a database. The
 * `--store` option hands it a `CheckpointStore`; the engine consults it
 * before each node to satisfy an idempotency lookup, and writes through it
 * after each node completes. A pure run with no `store` option is unchanged
 * -- the existing todo-9 tests still pass and the engine stays pure in the
 * no-store path.
 */
import type { DagGraph, DagNode, NodeId, NodeResult, NodeStatus } from './types.js';
import { DagCycleError, NodeError } from './types.js';
import type { NodeCtx } from './node.js';
import type { CheckpointStore } from './checkpoint.js';

/**
 * Optional knobs. None of them change the graph result; they only add
 * durable work for later resume / re-execution to find. Leaving the store
 * absent gives the original todo-9 semantics.
 */
export interface RunOptions {
  /** When set, the engine resolves cached results via this store and writes new ones back. */
  store?: CheckpointStore;
  /**
   * Open a new run on first call. When the caller already has a runId (a
   * resume), pass it in and the engine skips `beginRun`. The default '1'
   * never collides with `findByIdempotency` -- that key is the per-node
   * (logical_date, scope_hash) -- so a missing input here just means the
   * writes are still idempotent, not that they collide.
   */
  runId?: number;
  /** Partition key for the idempotency lookup. Same value across retries of the same nightly run. */
  logicalDate?: string;
  /** Per-node scope hash: the same node/inputs/scope combination is a cache hit. */
  scopeHash?: (node: DagNode) => string;
}

/**
 * Schedules `graph` on `ctx`, returning one `NodeResult` per node id. The
 * top-level `inputs` are seeded into the result map as upstream-shaped
 * `'succeeded'` results so nodes can read them as if from a prior layer.
 *
 * When a store is supplied, each node is preceded by an idempotency lookup
 * on `(nodeId, logicalDate, scopeHash)`; a cached `succeeded` result short-
 * circuits the node's `run` and no per-node budget is consumed for it
 * (todo 10: a resumed run must NOT double-count reads against the durable
 * host_budget ledger).
 */
export async function runDag(
  graph: DagGraph,
  ctx: NodeCtx,
  inputs: Record<NodeId, unknown> = {},
  opts: RunOptions = {},
): Promise<Record<NodeId, NodeResult>> {
  validateGraph(graph, inputs);
  const results: Record<NodeId, NodeResult> = {};
  for (const [id, value] of Object.entries(inputs)) {
    // External inputs are virtual upstream successes -- same shape as a real
    // dependency result so downstream nodes can read them uniformly.
    results[id] = { status: 'succeeded', attempt: 0, ms: 0, data: value };
  }
  (ctx as { inputs: Record<string, unknown> }).inputs = inputs;

  const store = opts.store;
  let runId = opts.runId;
  let beganRun = false;
  if (store && runId === undefined) {
    runId = store.beginRun(JSON.stringify(inputs));
    beganRun = true;
  }

  let finishedStatus: 'succeeded' | 'failed' = 'succeeded';
  try {
    const remaining: DagNode[] = graph.filter((n) => !(n.id in results));

    // Idempotency pre-pass: any node with a cached succeeded result is
    // populated into `results` BEFORE the layer loop, so its run callback
    // never fires. This is the only place the read-cache path lives; a
    // resumed run takes the same code path (see resumeDag).
    if (store && opts.logicalDate && opts.scopeHash) {
      for (const node of remaining) {
        const cached = store.findByIdempotency(node.id, opts.logicalDate, opts.scopeHash(node));
        if (cached) {
          results[node.id] = {
            status: 'succeeded',
            attempt: cached.attempt,
            ms: cached.ms,
            data: cached.data,
          };
        }
      }
    }

    await executeLayers(graph, ctx, results, remaining, (node, result, wasCached) => {
      // After each node completes: write the checkpoint so resume can pick
      // it up. We never store non-succeeded results -- a failed retry
      // needs to re-execute, not return its last-failed data. A cache hit
      // already has its durable ledger entry from the original run; a
      // second write would insert a parallel row under the new runId,
      // which is the duplicate-row bug the idempotency check exists to
      // prevent.
      if (
        !wasCached &&
        result.status === 'succeeded' &&
        store &&
        runId !== undefined &&
        opts.logicalDate &&
        opts.scopeHash
      ) {
        store.recordCheckpoint(runId, node.id, opts.logicalDate, opts.scopeHash(node), result);
      }
    });
  } catch (err) {
    finishedStatus = 'failed';
    throw err;
  } finally {
    if (beganRun && store && runId !== undefined) {
      store.finishRun(runId, finishedStatus);
    }
  }

  return results;
}

/**
 * Resume a previously interrupted run. The engine reads the run's completed
 * nodes out of the store, populates `results`, and runs only the still-
 * pending nodes. The contract is identical to `runDag` from the caller's
 * point of view: same `(graph, ctx, inputs)`, same `Promise<Record<NodeId,
 * NodeResult>>`.
 *
 * A resumed run does NOT re-execute any node that already has a `succeeded`
 * `dag_node_run` row; consequently it does NOT double-count reads against
 * the per-node `host_budget`. The post-run invoice matches an uninterrupted
 * run.
 */
export async function resumeDag(
  graph: DagGraph,
  ctx: NodeCtx,
  inputs: Record<NodeId, unknown>,
  runId: number,
  store: CheckpointStore,
  logicalDate?: string,
  scopeHash?: (node: DagNode) => string,
): Promise<Record<NodeId, NodeResult>> {
  validateGraph(graph, inputs);
  const results: Record<NodeId, NodeResult> = {};
  for (const [id, value] of Object.entries(inputs)) {
    results[id] = { status: 'succeeded', attempt: 0, ms: 0, data: value };
  }
  (ctx as { inputs: Record<string, unknown> }).inputs = inputs;

  // Load the prior runs completed nodes from disk and treat them as if the
  // engine had just emitted them. The order matters: listCompleted is keyed
  // by node_id, not by the layer the node belongs to, so we can populate
  // results before the layer loop and let the deps check in
  // executeLayers route correctly.
  const prior = store.listCompleted(runId);
  for (const [nodeId, ckpt] of prior) {
    results[nodeId] = {
      status: 'succeeded',
      attempt: ckpt.attempt,
      ms: ckpt.ms,
      data: ckpt.data,
    };
  }

  // Defensive: a follow-up run with the same (logical_date, scope_hash)
  // should also short-circuit if nothing is pending -- the engine layer
  // loop terminates immediately when `remaining` is empty.
  const remaining: DagNode[] = graph.filter((n) => !(n.id in results));
  if (store && logicalDate && scopeHash) {
    for (const node of remaining) {
      const cached = store.findByIdempotency(node.id, logicalDate, scopeHash(node));
      if (cached && !results[node.id]) {
        results[node.id] = {
          status: 'succeeded',
          attempt: cached.attempt,
          ms: cached.ms,
          data: cached.data,
        };
      }
    }
  }
  const stillPending: DagNode[] = remaining.filter((n) => !(n.id in results));

  let finishedStatus: 'succeeded' | 'failed' = 'succeeded';
  try {
    await executeLayers(graph, ctx, results, stillPending, (node, result, wasCached) => {
      if (
        !wasCached &&
        result.status === 'succeeded' &&
        store &&
        logicalDate &&
        scopeHash
      ) {
        store.recordCheckpoint(runId, node.id, logicalDate, scopeHash(node), result);
      }
    });
  } catch (err) {
    finishedStatus = 'failed';
    throw err;
  } finally {
    // A resume never opens the run (no beginRun), but it does close it
    // when the layer loop finishes. finishRun is a no-op on a row that is
    // already non-running, so a duplicate finish call from a prior session
    // is harmless.
    store.finishRun(runId, finishedStatus);
  }

  return results;
}

/**
 * Layerwise execution. Pulled out so `runDag` and `resumeDag` share the
 * exact same scheduling logic, including how a throwing node is mapped to a
 * terminal state. Each layer runs in parallel; if the layer is empty the
 * engine has detected a cycle (some node's deps are not yet satisfied and
 * will never be).
 */
async function executeLayers(
  graph: DagGraph,
  ctx: NodeCtx,
  results: Record<NodeId, NodeResult>,
  remaining: DagNode[],
  onComplete: (node: DagNode, result: NodeResult, wasCached: boolean) => void,
): Promise<void> {
  while (remaining.length > 0) {
    const layer = remaining.filter((n) => n.deps.every((d) => results[d] !== undefined));
    if (layer.length === 0) {
      throw new DagCycleError(remaining.map((n) => n.id));
    }
    await Promise.allSettled(
      layer.map((node) =>
        runOne(node, ctx, results).then(({ result, wasCached }) =>
          onComplete(node, result, wasCached),
        ),
      ),
    );
    // In-place compaction (duplicate ids would have been caught by
    // validateGraph). Avoids a fresh array allocation per layer.
    let write = 0;
    for (let read = 0; read < remaining.length; read++) {
      const n = remaining[read]!;
      if (results[n.id] === undefined) remaining[write++] = n;
    }
    remaining.length = write;
  }
}

async function runOne(
  node: DagNode,
  ctx: NodeCtx,
  results: Record<NodeId, NodeResult>,
): Promise<{ result: NodeResult; wasCached: boolean }> {
  // Pre-populated by the idempotency pre-pass -- do not re-run, do not
  // touch the budget, do not write a second ledger entry. The caller sees
  // it as a normal succeeded result.
  if (results[node.id] !== undefined) {
    return { result: results[node.id]!, wasCached: true };
  }

  const upstream: Record<NodeId, NodeResult> = {};
  for (const dep of node.deps) upstream[dep] = results[dep]!;
  const t0 = ctx.clock.now();
  try {
    const data = await node.run(upstream, ctx, 1);
    const ms = ctx.clock.now() - t0;
    const result: NodeResult = { status: 'succeeded', attempt: 1, ms, data };
    results[node.id] = result;
    return { result, wasCached: false };
  } catch (err) {
    const ms = ctx.clock.now() - t0;
    const result: NodeResult = {
      status: classifyError(err),
      attempt: 1,
      ms,
      data: undefined,
    };
    results[node.id] = result;
    return { result, wasCached: false };
  }
}

function classifyError(err: unknown): NodeStatus {
  if (err instanceof NodeError) return err.status;
  if (
    err &&
    typeof err === 'object' &&
    'status' in err &&
    typeof (err as { status: unknown }).status === 'string' &&
    isNodeStatus((err as { status: string }).status)
  ) {
    const s = (err as { status: string }).status as NodeStatus;
    if (s !== 'succeeded') return s;
  }
  return 'failed';
}

const STATUSES: ReadonlySet<NodeStatus> = new Set<NodeStatus>([
  'succeeded',
  'failed',
  'budget-exhausted',
  'refused',
  'wrong-store',
  'hash-expired',
  'skipped',
]);

function isNodeStatus(s: string): s is NodeStatus {
  return STATUSES.has(s as NodeStatus);
}

function validateGraph(graph: DagGraph, inputs: Record<NodeId, unknown>): void {
  const ids = new Set<NodeId>();
  for (const n of graph) {
    if (ids.has(n.id)) throw new Error(`duplicate node id: ${n.id}`);
    ids.add(n.id);
    if (typeof n.id !== 'string') throw new Error(`node id must be a string`);
    if (!Array.isArray(n.deps)) throw new Error(`node ${n.id}: deps must be an array`);
    if (typeof n.run !== 'function') throw new Error(`node ${n.id}: run must be a function`);
  }
  for (const id of Object.keys(inputs)) ids.add(id);
  for (const n of graph) {
    for (const d of n.deps) {
      if (!ids.has(d)) throw new Error(`node ${n.id}: unknown dep ${d}`);
    }
  }
}

/**
 * Layerwise topological order. Exported for inspection; `runDag` computes its
 * own layer-by-layer schedule. A cycle throws `DagCycleError` with the
 * unreachable node ids.
 */
export function topoSort(graph: DagGraph): DagNode[] {
  const byId = new Map<NodeId, DagNode>();
  for (const n of graph) byId.set(n.id, n);
  const temp = new Set<NodeId>();
  const perm = new Set<NodeId>();
  const order: DagNode[] = [];
  const visit = (id: NodeId): void => {
    if (perm.has(id)) return;
    if (temp.has(id)) throw new DagCycleError([id]);
    temp.add(id);
    const node = byId.get(id);
    if (node) for (const d of node.deps) visit(d);
    temp.delete(id);
    perm.add(id);
    if (node) order.push(node);
  };
  for (const n of graph) visit(n.id);
  return order;
}
