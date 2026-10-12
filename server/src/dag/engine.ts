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
 */
import type { DagGraph, DagNode, NodeId, NodeResult, NodeStatus } from './types.js';
import { DagCycleError, NodeError } from './types.js';
import type { NodeCtx } from './node.js';

/**
 * Schedules `graph` on `ctx`, returning one `NodeResult` per node id. The
 * top-level `inputs` are seeded into the result map as upstream-shaped
 * `'succeeded'` results so nodes can read them as if from a prior layer.
 */
export async function runDag(
  graph: DagGraph,
  ctx: NodeCtx,
  inputs: Record<NodeId, unknown> = {},
): Promise<Record<NodeId, NodeResult>> {
  validateGraph(graph, inputs);
  const results: Record<NodeId, NodeResult> = {};
  for (const [id, value] of Object.entries(inputs)) {
    // External inputs are virtual upstream successes — same shape as a real
    // dependency result so downstream nodes can read them uniformly.
    results[id] = { status: 'succeeded', attempt: 0, ms: 0, data: value };
  }
  (ctx as { inputs: Record<string, unknown> }).inputs = inputs;
  const remaining = graph.filter((n) => !(n.id in results));
  const completed = new Set<NodeId>(Object.keys(results));

  while (remaining.length > 0) {
    const layer = remaining.filter((n) => n.deps.every((d) => completed.has(d)));
    if (layer.length === 0) {
      throw new DagCycleError(remaining.map((n) => n.id));
    }
    await Promise.allSettled(
      layer.map((node) => runNode(node, ctx, results).then((r) => {
        results[node.id] = r;
      })),
    );
    for (const n of layer) completed.add(n.id);
    // In-place compaction (duplicate ids would have been caught by
    // validateGraph). Avoids a fresh array allocation per layer.
    let write = 0;
    for (let read = 0; read < remaining.length; read++) {
      const n = remaining[read]!;
      if (!completed.has(n.id)) remaining[write++] = n;
    }
    remaining.length = write;
  }
  return results;
}

async function runNode(
  node: DagNode,
  ctx: NodeCtx,
  results: Record<NodeId, NodeResult>,
): Promise<NodeResult> {
  const upstream: Record<NodeId, NodeResult> = {};
  for (const dep of node.deps) upstream[dep] = results[dep]!;
  const t0 = ctx.clock.now();
  try {
    const data = await node.run(upstream, ctx);
    return { status: 'succeeded', attempt: 1, ms: ctx.clock.now() - t0, data };
  } catch (err) {
    const ms = ctx.clock.now() - t0;
    return {
      status: classifyError(err),
      attempt: 1,
      ms,
      data: undefined,
    };
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
