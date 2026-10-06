/**
 * A durable read ledger for one rate-limited host (Walmart).
 *
 * Walmart's edge limits on read *count*, and the allowance that matters
 * outlives the process: a restart, a manual sweep started from the dashboard
 * and the nightly job all draw on the same one. The in-memory pacer in
 * `walmart-api` knows only about this process, so this keeps two things in
 * SQLite:
 *
 *   not_before       no read before this instant (set when the edge refuses)
 *   reads_in_window  reads made since the current window opened
 *
 * The window is a heuristic — the real shape of Walmart's is not known (see
 * docs/WALMART-CLEARANCE-API.md) — so the cap is deliberately conservative and
 * both numbers are overridable.
 */
import type { DB } from '../db.js';

export interface BudgetState {
  notBefore: number;
  windowStartedAt: number;
  readsInWindow: number;
  lastStatus: number | null;
}

export interface HostBudgetOptions {
  /** how long a window lasts, ms */
  windowMs?: number;
  /** reads allowed per window; 0 disables the cap (the not-before still applies) */
  windowLimit?: number;
}

export class HostBudget {
  private readonly windowMs: number;
  private readonly windowLimit: number;

  constructor(
    private db: DB,
    readonly host: string = 'www.walmart.com',
    opts: HostBudgetOptions = {},
  ) {
    this.windowMs = opts.windowMs ?? Number(process.env.WALMART_BUDGET_WINDOW_MS ?? 30 * 60 * 1000);
    this.windowLimit = opts.windowLimit ?? Number(process.env.WALMART_WINDOW_READ_LIMIT ?? 18);
  }

  state(now = Date.now()): BudgetState {
    const r = this.db
      .prepare('SELECT not_before, window_started_at, reads_in_window, last_status FROM host_budget WHERE host = ?')
      .get(this.host) as
      | { not_before: number; window_started_at: number; reads_in_window: number; last_status: number | null }
      | undefined;
    if (!r) return { notBefore: 0, windowStartedAt: now, readsInWindow: 0, lastStatus: null };
    const expired = now - r.window_started_at >= this.windowMs;
    return {
      notBefore: r.not_before,
      windowStartedAt: expired ? now : r.window_started_at,
      readsInWindow: expired ? 0 : r.reads_in_window,
      lastStatus: r.last_status,
    };
  }

  /**
   * Milliseconds until a read is permitted: 0 now, otherwise the later of the
   * persisted not-before and, when the window cap is spent, the window's end.
   */
  waitMs(now = Date.now()): number {
    const s = this.state(now);
    let until = s.notBefore;
    if (this.windowLimit > 0 && s.readsInWindow >= this.windowLimit) {
      until = Math.max(until, s.windowStartedAt + this.windowMs);
    }
    return Math.max(0, until - now);
  }

  /** Counts one read against the window. Call when the read is about to go out. */
  recordRead(now = Date.now()): void {
    const s = this.state(now);
    this.write(s.notBefore, s.windowStartedAt, s.readsInWindow + 1, s.lastStatus, now);
  }

  /** The edge refused: nothing goes out for `ms`, across restarts. */
  block(ms: number, status: number | null, now = Date.now()): void {
    const s = this.state(now);
    this.write(Math.max(s.notBefore, now + ms), s.windowStartedAt, s.readsInWindow, status, now);
  }

  private write(notBefore: number, windowStartedAt: number, reads: number, status: number | null, now: number): void {
    this.db
      .prepare(
        `INSERT INTO host_budget (host, not_before, window_started_at, reads_in_window, last_status, updated_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT (host) DO UPDATE SET not_before=excluded.not_before,
           window_started_at=excluded.window_started_at, reads_in_window=excluded.reads_in_window,
           last_status=excluded.last_status, updated_at=excluded.updated_at`,
      )
      .run(this.host, notBefore, windowStartedAt, reads, status, new Date(now).toISOString());
  }
}
