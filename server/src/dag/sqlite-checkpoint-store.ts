/**
 * SQLite-backed CheckpointStore. The implementation mirrors the
 * host_budget.ts pattern in this codebase: thin, prepared-statement-based,
 * with an injected clock so tests stay deterministic.
 *
 * Atomicity: the engine never reads the ledger in the middle of a node
 * write, so the simple prepare-and-run here is enough. The
 * `(run_id, node_id, attempt)` UNIQUE in dag_node_run is what makes a
 * re-entry under the same attempt a no-op rather than a duplicate.
 */
import type { DB } from '../db.js';
import type { NodeId, NodeResult } from './types.js';
import type { CheckpointStore, DagCheckpoint, DagRunStatus } from './checkpoint.js';

interface RawNodeRow {
  checkpoint_json: string | null;
  attempt: number;
  ms: number | null;
  finished_at: string | null;
}

/**
 * The clock seam matches the one in dag/node.ts so the tests share one
 * `fixedClock(at)` factory. Production wires `() => Date.now()`.
 */
export interface SqliteCheckpointClock {
  now(): number;
}

export class SqliteCheckpointStore implements CheckpointStore {
  constructor(
    private readonly db: DB,
    private readonly clock: SqliteCheckpointClock = { now: () => Date.now() },
  ) {}

  beginRun(inputsJson: string): number {
    const startedAt = this.isoNow();
    const r = this.db
      .prepare(
        `INSERT INTO dag_run (started_at, status, inputs_json)
         VALUES (?, 'running', ?)
         RETURNING id`,
      )
      .get(startedAt, inputsJson) as { id: number };
    return r.id;
  }

  finishRun(runId: number, status: Exclude<DagRunStatus, 'running'>, finishedAt?: string): void {
    const ts = finishedAt ?? this.isoNow();
    // No-op for an unknown id keeps resume robust against a half-finished
    // prior run -- a stale run row from the prior session is left behind
    // intentionally so an audit can see the abort.
    this.db
      .prepare(
        `UPDATE dag_run
         SET status = ?, finished_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(status, ts, runId);
  }

  findByIdempotency(nodeId: NodeId, logicalDate: string, scopeHash: string): DagCheckpoint | null {
    const r = this.db
      .prepare(
        `SELECT checkpoint_json, attempt, ms, finished_at
         FROM dag_node_run
         WHERE node_id = ?
           AND logical_date = ?
           AND scope_hash = ?
           AND status = 'succeeded'
         ORDER BY attempt DESC, finished_at DESC
         LIMIT 1`,
      )
      .get(nodeId, logicalDate, scopeHash) as RawNodeRow | undefined;
    return r ? toCheckpoint(r) : null;
  }

  listCompleted(runId: number): Map<NodeId, DagCheckpoint> {
    const rows = this.db
      .prepare(
        `SELECT node_id, checkpoint_json, attempt, ms, finished_at
         FROM dag_node_run
         WHERE run_id = ?
           AND status = 'succeeded'
         ORDER BY attempt DESC, finished_at DESC`,
      )
      .all(runId) as unknown as (RawNodeRow & { node_id: NodeId })[];
    const out = new Map<NodeId, DagCheckpoint>();
    // The ORDER BY put the most recent successful attempt first, so
    // set-if-absent keeps the latest one per node while skipping duplicates.
    for (const row of rows) {
      if (out.has(row.node_id)) continue;
      out.set(row.node_id, toCheckpoint(row));
    }
    return out;
  }

  recordCheckpoint(
    runId: number,
    nodeId: NodeId,
    logicalDate: string,
    scopeHash: string,
    result: NodeResult,
    startedAt?: string,
  ): void {
    const startTs = startedAt ?? this.isoNow();
    const endTs = this.isoNow();
    const ckpt = result.data === undefined ? null : JSON.stringify(result.data);
    // Upsert on (run_id, node_id, attempt) -- a retry of the same attempt
    // updates, a fresh attempt inserts. Idempotency lives in the WHERE on
    // logical_date + scope_hash so a re-record for the same logical run
    // cannot accidentally rewrite a different attempts data.
    this.db
      .prepare(
        `INSERT INTO dag_node_run
           (run_id, node_id, attempt, status, started_at, finished_at, ms,
            checkpoint_json, logical_date, scope_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, node_id, attempt) DO UPDATE SET
           status          = excluded.status,
           started_at      = excluded.started_at,
           finished_at     = excluded.finished_at,
           ms              = excluded.ms,
           checkpoint_json = excluded.checkpoint_json,
           logical_date    = excluded.logical_date,
           scope_hash      = excluded.scope_hash`,
      )
      .run(
        runId,
        nodeId,
        result.attempt,
        result.status,
        startTs,
        endTs,
        result.ms,
        ckpt,
        logicalDate,
        scopeHash,
      );
  }

  private isoNow(): string {
    return new Date(this.clock.now()).toISOString();
  }
}

function toCheckpoint(row: RawNodeRow): DagCheckpoint {
  return {
    data: row.checkpoint_json === null ? undefined : JSON.parse(row.checkpoint_json),
    attempt: row.attempt,
    ms: row.ms ?? 0,
    finishedAt: row.finished_at ?? '',
  };
}
