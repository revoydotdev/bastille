/**
 * A durable read ledger for one rate-limited host (Walmart), on one exit point.
 *
 * Walmart's edge limits on read *count*, and the allowance that matters
 * outlives the process: a restart, a manual sweep started from the dashboard
 * and the nightly job all draw on the same one. The in-memory pacer in
 * `walmart-api` knows only about this process, so this keeps three things in
 * SQLite:
 *
 *   not_before       no read before this instant (set when the edge refuses)
 *   reads_in_window  reads made since the current window opened
 *   bytes_in_window  bytes spent since the current window opened
 *
 * The window is a heuristic — the real shape of Walmart's is not known (see
 * docs/WALMART-CLEARANCE-API.md) — so the cap is deliberately conservative and
 * all three numbers are overridable.
 *
 * The key is `(host, egressNodeId)`, not a string built by pasting the two
 * together: the limit is per exit IP, and an operator who adds or retires a
 * node has to be able to reach the row without parsing a key.
 *
 * Bytes are the *decompressed* size the HTTP layer already measures into
 * `request_log.bytes`. That is deliberately the same number, so the ledger and
 * the log can never disagree about what a read cost.
 */
import type { DB } from '../db.js';
import { LOCAL_EGRESS_NODE_ID } from '../db/migrations.js';

/** The only host with a durable budget today; the key's first half. */
export const WALMART_HOST = 'www.walmart.com';

export interface BudgetState {
  notBefore: number;
  windowStartedAt: number;
  readsInWindow: number;
  bytesInWindow: number;
  lastStatus: number | null;
}

export interface HostBudgetOptions {
  /** how long a window lasts, ms */
  windowMs?: number;
  /** reads allowed per window; 0 disables the cap (the not-before still applies) */
  windowLimit?: number;
  /** bytes allowed per window; 0 disables the cap */
  byteLimit?: number;
}

export class HostBudget {
  private readonly windowMs: number;
  private readonly windowLimit: number;
  private readonly byteLimit: number;

  constructor(
    private db: DB,
    readonly host: string = WALMART_HOST,
    readonly egressNodeId: string = LOCAL_EGRESS_NODE_ID,
    opts: HostBudgetOptions = {},
  ) {
    this.windowMs = opts.windowMs ?? Number(process.env.WALMART_BUDGET_WINDOW_MS ?? 30 * 60 * 1000);
    this.windowLimit = opts.windowLimit ?? Number(process.env.WALMART_WINDOW_READ_LIMIT ?? 18);
    this.byteLimit = opts.byteLimit ?? Number(process.env.WALMART_WINDOW_BYTE_LIMIT ?? 8 * 1024 * 1024);
  }

  state(now = Date.now()): BudgetState {
    const r = this.db
      .prepare(
        `SELECT not_before, window_started_at, reads_in_window, bytes_in_window, last_status
           FROM host_budget WHERE host = ? AND egress_node_id = ?`,
      )
      .get(this.host, this.egressNodeId) as
      | {
          not_before: number;
          window_started_at: number;
          reads_in_window: number;
          bytes_in_window: number;
          last_status: number | null;
        }
      | undefined;
    if (!r) return { notBefore: 0, windowStartedAt: now, readsInWindow: 0, bytesInWindow: 0, lastStatus: null };
    const expired = now - r.window_started_at >= this.windowMs;
    return {
      notBefore: r.not_before,
      windowStartedAt: expired ? now : r.window_started_at,
      readsInWindow: expired ? 0 : r.reads_in_window,
      bytesInWindow: expired ? 0 : r.bytes_in_window,
      lastStatus: r.last_status,
    };
  }

  /**
   * Milliseconds until a read is permitted: 0 now, otherwise the later of the
   * persisted not-before and, when either cap is spent, the window's end.
   *
   * A read costs bytes whether or not it counts against the read cap, so
   * whichever ceiling is reached first closes the window.
   */
  waitMs(now = Date.now()): number {
    const s = this.state(now);
    let until = s.notBefore;
    const readsSpent = this.windowLimit > 0 && s.readsInWindow >= this.windowLimit;
    const bytesSpent = this.byteLimit > 0 && s.bytesInWindow >= this.byteLimit;
    if (readsSpent || bytesSpent) until = Math.max(until, s.windowStartedAt + this.windowMs);
    return Math.max(0, until - now);
  }

  /**
   * Counts one read against the window. Call when the read is about to go out;
   * `bytes` is that read's known cost, when it is known before the call.
   */
  recordRead(now = Date.now(), bytes = 0): void {
    const s = this.state(now);
    this.write(s.notBefore, s.windowStartedAt, s.readsInWindow + 1, s.bytesInWindow + bytes, s.lastStatus, now);
  }

  /**
   * Charges a completed read's bytes to the window without counting a second
   * read. The count is taken up front by `recordRead`; the size is only known
   * once the body has been read.
   */
  recordBytes(bytes: number, now = Date.now()): void {
    if (!(bytes > 0)) return;
    const s = this.state(now);
    this.write(s.notBefore, s.windowStartedAt, s.readsInWindow, s.bytesInWindow + bytes, s.lastStatus, now);
  }

  /** The edge refused: nothing goes out for `ms`, across restarts. */
  block(ms: number, status: number | null, now = Date.now()): void {
    const s = this.state(now);
    this.write(Math.max(s.notBefore, now + ms), s.windowStartedAt, s.readsInWindow, s.bytesInWindow, status, now);
  }

  private write(
    notBefore: number,
    windowStartedAt: number,
    reads: number,
    bytes: number,
    status: number | null,
    now: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO host_budget (host, egress_node_id, not_before, window_started_at, reads_in_window, bytes_in_window, last_status, updated_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT (host, egress_node_id) DO UPDATE SET not_before=excluded.not_before,
           window_started_at=excluded.window_started_at, reads_in_window=excluded.reads_in_window,
           bytes_in_window=excluded.bytes_in_window,
           last_status=excluded.last_status, updated_at=excluded.updated_at`,
      )
      .run(this.host, this.egressNodeId, notBefore, windowStartedAt, reads, bytes, status, new Date(now).toISOString());
  }
}
