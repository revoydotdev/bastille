/**
 * A durable read ledger for one rate-limited host.
 *
 * The allowance outlives the process: a restart, a manual sweep started from
 * the dashboard and the nightly job all draw on the same one. The in-memory
 * pacer in `walmart-api` knows only about this process, so this keeps three
 * things in SQLite:
 *
 *   not_before       no read before this instant (set when the edge refuses)
 *   window_started_at the start of the current window for this class
 *   reads_in_window  reads this class has made since the window opened
 *
 * Each priority class (see `BudgetClass`) gets its own row in the table, so
 * a button click on the unauthenticated `POST /api/clearance/sweep` (class
 * `user-initiated`) cannot spend the nightly job's budget. The `canary` class
 * is never charged — the canary path uses `skipBudgetCount: true` and never
 * calls `recordRead` — and the `experiment` class is reserved for future use.
 *
 * The window is a heuristic — the real shape of Walmart's is not known (see
 * docs/WALMART-CLEARANCE-API.md) — so the cap is deliberately conservative
 * and both numbers are overridable.
 */
import type { DB } from '../db.js';

/**
 * The classes contending for the same host's bandwidth. Each has its own
 * reservation so one class cannot starve another.
 *
 * - `nightly-sweep`: the scheduled job, started by `jobs/clearance-sweep.ts`.
 * - `user-initiated`: an unauthenticated `POST /api/clearance/sweep` (the
 *   reason the per-class model exists at all).
 * - `canary`: the per-node pre-sweep verification, which never actually
 *   counts (the read path skips the budget entirely via `skipBudgetCount`).
 * - `experiment`: reserved; adding a reservation today is fine even if no
 *   caller uses the class yet.
 */
export type BudgetClass = 'nightly-sweep' | 'user-initiated' | 'canary' | 'experiment';

export const BUDGET_CLASSES: readonly BudgetClass[] = [
  'nightly-sweep',
  'user-initiated',
  'canary',
  'experiment',
] as const;

export interface BudgetState {
  notBefore: number;
  windowStartedAt: number;
  readsInWindow: number;
  lastStatus: number | null;
  class: BudgetClass;
}

export interface HostBudgetOptions {
  /** how long a window lasts, ms */
  windowMs?: number;
  /** reads allowed per window per class; 0 disables the cap (the not-before still applies) */
  windowLimit?: number;
  /** default class for read/block calls that don't name one. Defaults to 'nightly-sweep'. */
  defaultClass?: BudgetClass;
}

export class HostBudget {
  private readonly windowMs: number;
  private readonly windowLimit: number;
  private readonly defaultClass: BudgetClass;

  constructor(
    private db: DB,
    readonly host: string = 'www.walmart.com',
    opts: HostBudgetOptions = {},
  ) {
    this.windowMs = opts.windowMs ?? Number(process.env.WALMART_BUDGET_WINDOW_MS ?? 30 * 60 * 1000);
    this.windowLimit = opts.windowLimit ?? Number(process.env.WALMART_WINDOW_READ_LIMIT ?? 18);
    this.defaultClass = opts.defaultClass ?? 'nightly-sweep';
  }

  state(now: number = Date.now(), className: BudgetClass = this.defaultClass): BudgetState {
    const cls = this.normaliseClass(className);
    const r = this.db
      .prepare(
        'SELECT not_before, window_started_at, reads_in_window, last_status FROM host_budget WHERE host = ? AND class = ?',
      )
      .get(this.host, cls) as
      | { not_before: number; window_started_at: number; reads_in_window: number; last_status: number | null }
      | undefined;
    if (!r) return { notBefore: 0, windowStartedAt: now, readsInWindow: 0, lastStatus: null, class: cls };
    const expired = now - r.window_started_at >= this.windowMs;
    return {
      notBefore: r.not_before,
      windowStartedAt: expired ? now : r.window_started_at,
      readsInWindow: expired ? 0 : r.reads_in_window,
      lastStatus: r.last_status,
      class: cls,
    };
  }

  /**
   * Milliseconds until a read is permitted for the given class: 0 now,
   * otherwise the later of the persisted not-before and, when the window cap
   * is spent, the window's end. The class decides which reservation row to
   * inspect.
   */
  waitMs(now: number = Date.now(), className: BudgetClass = this.defaultClass): number {
    const s = this.state(now, className);
    let until = s.notBefore;
    if (this.windowLimit > 0 && s.readsInWindow >= this.windowLimit) {
      until = Math.max(until, s.windowStartedAt + this.windowMs);
    }
    return Math.max(0, until - now);
  }

  /**
   * Counts one read against the class's reservation. The class is keyed on a
   * row: spending a user-initiated read does not move the nightly-sweep
   * count, and vice versa. Call when the read is about to go out.
   */
  recordRead(now: number = Date.now(), className: BudgetClass = this.defaultClass): void {
    const cls = this.normaliseClass(className);
    const s = this.state(now, cls);
    this.write(cls, s.notBefore, s.windowStartedAt, s.readsInWindow + 1, s.lastStatus, now);
  }

  /** The edge refused: nothing goes out for `ms`, on this class's row, across restarts. */
  block(ms: number, status: number | null, now: number = Date.now(), className: BudgetClass = this.defaultClass): void {
    const cls = this.normaliseClass(className);
    const s = this.state(now, cls);
    this.write(cls, Math.max(s.notBefore, now + ms), s.windowStartedAt, s.readsInWindow, status, now);
  }

  private write(
    className: BudgetClass,
    notBefore: number,
    windowStartedAt: number,
    reads: number,
    status: number | null,
    now: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO host_budget (host, class, not_before, window_started_at, reads_in_window, last_status, updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT (host, class) DO UPDATE SET not_before=excluded.not_before,
           window_started_at=excluded.window_started_at, reads_in_window=excluded.reads_in_window,
           last_status=excluded.last_status, updated_at=excluded.updated_at`,
      )
      .run(this.host, className, notBefore, windowStartedAt, reads, status, new Date(now).toISOString());
  }

  private normaliseClass(className: BudgetClass): BudgetClass {
    // Defensive: the wired callers pass a known literal, but anything that
    // somehow ends up off-list would be a hidden reservation that nothing
    // could ever inspect or refill. Reject it at the boundary instead.
    if (!(BUDGET_CLASSES as readonly string[]).includes(className)) {
      throw new Error(`unknown budget class: ${String(className)}`);
    }
    return className;
  }
}
