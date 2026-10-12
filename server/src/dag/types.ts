/**
 * DAG types: the node contract and its result envelope.
 *
 * The contract is intentionally narrow. A node is `async (inputs, ctx) =>
 * NodeResult`; the engine knows nothing about what nodes read, write, or
 * where they reach. Terminal states are declared up front so partial runs can
 * be reported without ambiguity (todo 13 will surface these in the UI).
 */
import type { NodeCtx } from './node.js';

export type NodeId = string;

/**
 * Terminal states a node can return. A node that throws is mapped to one of
 * these by inspecting the thrown value's `.status` field (a `NodeError`),
 * otherwise `'failed'`. `'skipped'` is reserved for nodes the caller marked
 * out of scope; the engine does not invent it.
 */
export type NodeStatus =
  | 'succeeded'
  | 'failed'
  | 'budget-exhausted'
  | 'refused'
  | 'wrong-store'
  | 'hash-expired'
  | 'skipped';

export interface NodeResult {
  status: NodeStatus;
  /** 1-based attempt count; the engine emits exactly 1 per node today. */
  attempt: number;
  /** Wall-clock duration reported by `ctx.clock`. */
  ms: number;
  /** Node-defined output payload. Undefined for non-`'succeeded'` results. */
  data?: unknown;
}

/**
 * `deps` lists upstream node ids whose `NodeResult` is fed into `run` under
 * the dep id key. `inputs` is `{ [depId]: NodeResult }`. The optional
 * `attempt` is the engine's current retry index (todo 10); it is `1` for a
 * fresh execution and `> 1` only when the engine decides to re-run a node
 * after a prior attempt recorded in dag_node_run.
 */
export interface DagNode<TIn = unknown, TOut = unknown> {
  id: NodeId;
  deps: NodeId[];
  run(inputs: TIn, ctx: NodeCtx, attempt?: number): Promise<TOut>;
}

export type DagGraph = DagNode[];

/**
 * Carries `status` so the engine can route a thrown error to the right
 * terminal state without string-matching the message.
 */
export class NodeError extends Error {
  override readonly name = 'NodeError';
  constructor(
    readonly status: Exclude<NodeStatus, 'succeeded'>,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

export class BudgetExhaustedError extends NodeError {
  constructor(cause?: unknown) {
    super('budget-exhausted', 'budget exhausted', cause);
  }
}

export class DagCycleError extends Error {
  override readonly name = 'DagCycleError';
  constructor(public readonly remaining: NodeId[]) {
    super(`DAG has a cycle; remaining: ${remaining.join(', ')}`);
  }
}
