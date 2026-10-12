/**
 * The checkpoint store: the durable half of the DAG runtime (todo 10).
 *
 * The engine itself remains pure -- no I/O, no filesystem, no database -- so
 * the act of *remembering* a node's result is split out into this seam. A
 * production wiring hands the engine a SQLite-backed store (see
 * sqlite-checkpoint-store.ts); a test can hand it any implementation. The
 * engine talks to the store only through these four operations:
 *
 *   beginRun           / finishRun     bound a logical run
 *   recordCheckpoint   writes one row  (per-node, per-attempt)
 *   findByIdempotency  the re-use path (read-through cache)
 *   listCompleted      the resume path  (read-back cache)
 *
 * Idempotency key is (nodeId, logicalDate, scopeHash); the engine passes the
 * same logicalDate and scopeHash-fn to both writes and reads so a re-run with
 * the same key is a SELECT, not an INSERT. The store is the single source of
 * truth for "did this node already produce this result today".
 */
import type { NodeId, NodeResult } from './types.js';

/**
 * A remembered result. The shape matches what the engine emits when a node
 * succeeds: `data` is JSON-roundtrippable so resume does not have to know
 * about the producer's live value. `attempt` and `ms` are preserved so a
 * resumed run's final NodeResult carries the original numbers, not zeros.
 */
export interface DagCheckpoint {
  data: unknown;
  attempt: number;
  ms: number;
  finishedAt: string;
}

export type DagRunStatus = 'running' | 'succeeded' | 'failed' | 'aborted';

/**
 * The minimum surface an engine needs to make a DAG durable. Implementations
 * decide storage; the engine never asks the store what kind it is. Every
 * method must be safe to call from a running engine -- under contention, the
 * store is responsible for atomicity. (The host_budget contract is enforced
 * one layer up by todo 12; this store is read/write idempotency only.)
 */
export interface CheckpointStore {
  /**
   * Open a new run. The returned id is the only handle the engine needs;
   * subsequent node-level calls all carry this id. The store writes a row in
   * `dag_run` with status='running' and the inputs JSON verbatim.
   */
  beginRun(inputsJson: string): number;

  /**
   * Close a run. The engine calls this on success/abort and on the catch
   * path of unexpected failures. A no-op for an unknown id keeps resume
   * robust against a half-finished prior run.
   */
  finishRun(runId: number, status: Exclude<DagRunStatus, 'running'>, finishedAt?: string): void;

  /**
   * Look up a cached result by its idempotency key. Returns the most recent
   * attempt for the key with status='succeeded', or null if none. This is
   * the read-through that lets a re-run skip the node entirely.
   */
  findByIdempotency(nodeId: NodeId, logicalDate: string, scopeHash: string): DagCheckpoint | null;

  /**
   * List the nodes that already have a succeeded row under this run, for
   * resume. The map values are the latest successful attempt per node, the
   * shape the engine uses to populate `results` without re-running.
   */
  listCompleted(runId: number): Map<NodeId, DagCheckpoint>;

  /**
   * Write (or overwrite) one node's checkpoint. Idempotent under the
   * `(run_id, node_id, attempt)` UNIQUE constraint: a retry of the same
   * attempt updates, a fresh attempt inserts. Caller passes the full
   * NodeResult so the store can persist the status alongside the data.
   */
  recordCheckpoint(
    runId: number,
    nodeId: NodeId,
    logicalDate: string,
    scopeHash: string,
    result: NodeResult,
    startedAt?: string,
  ): void;
}
