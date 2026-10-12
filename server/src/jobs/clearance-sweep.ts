/**
 * Nightly Walmart in-store clearance sweep.
 *
 * Reads the clearance rack of every enabled store bound to an enabled egress
 * node and records what is on it, with its aisle. Walmart resolves the store
 * from the requesting address, so there is no choosing one: each node's proxy
 * decides which metro the edge answers for, and the sweep checks the store
 * Walmart names in each response against the one on record, which is what would
 * catch the address changing under it - a VPN, a move, a new ISP route -
 * rather than quietly filing another town's clearance under this one.
 *
 * Reads are the scarce resource. Walmart's edge limits on count, not cadence,
 * so each *node* has a read budget (`WALMART_SWEEP_READ_BUDGET`, default 12)
 * spent on shelves in priority order - Computers, Electronics, Video games -
 * and the pacer in `walmart-api` shares a durable per-node ledger with every
 * other caller. The budget is per node, not per run: fanning out to three nodes
 * is three allowances, and a refusal on one exit point does not spend another's.
 *
 * Nothing here retries. A refusal stands its own node down for a cooldown, and
 * enough of them in a row end that store's pass; the other nodes keep going.
 *
 * Every error the run records starts with a classification token the dashboard
 * can show: `[rate-limited]`, `[wrong-store]`, `[hash-expired]`, `[budget]` or
 * `[error]`. Hash expiry and a wrong store abort the run, since each further
 * read would fail the same way and cost budget doing it.
 */
import { CLEARANCE_CATEGORIES, sweepOrder, type ClearanceCategory } from '../clearance/categories.js';
import { backOffUntil, clearanceShelf, HashExpiredError, WalmartCooldownError } from '../clearance/walmart-api.js';
import type { ShelfPage } from '../clearance/walmart-api.js';
import { HttpError } from '../adapters/http.js';
import type { ClearanceRepo, PerStoreCounts, PerStoreReason } from '../clearance/repo.js';

/** The one call that leaves the process. Injectable so the sweep can be driven
 *  end to end in a test without reaching Walmart. */
export type ShelfReader = (opts: {
  locationId: string;
  postalCode?: string;
  categoryId: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  proxyUrl?: string;
  egressNodeId?: string;
}) => Promise<ShelfPage>;

function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export type SweepErrorKind = 'rate-limited' | 'wrong-store' | 'hash-expired' | 'budget' | 'error';

/** The response named a different store than the one on record (or none). */
export class WrongStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WrongStoreError';
  }
}

/** The run's read budget is spent. */
class BudgetSpentError extends Error {}

/** 412 is Walmart's edge; 429 is the ordinary spelling. Either means "later". */
function isRateLimit(err: unknown): boolean {
  return err instanceof HttpError && (err.status === 412 || err.status === 429);
}

export function classifySweepError(err: unknown): SweepErrorKind {
  if (err instanceof HashExpiredError) return 'hash-expired';
  if (err instanceof WrongStoreError) return 'wrong-store';
  if (err instanceof BudgetSpentError) return 'budget';
  if (isRateLimit(err) || err instanceof WalmartCooldownError) return 'rate-limited';
  return 'error';
}

/** The seven terminal states the sweep reports per store; same vocabulary the
 *  DAG engine uses in `server/src/dag/types.ts`, so the dashboard does not
 *  need a translation table. `sweepRun.error` is reserved for run-level
 *  failures and never carries a value from this set. */
export type PerStoreStatus =
  | 'succeeded'
  | 'failed'
  | 'budget-exhausted'
  | 'refused'
  | 'wrong-store'
  | 'hash-expired'
  | 'skipped';

/** Map the sweep's five internal error kinds onto the seven terminal states. */
export function perStoreStatusForKind(kind: SweepErrorKind): PerStoreStatus {
  switch (kind) {
    case 'wrong-store':
      return 'wrong-store';
    case 'hash-expired':
      return 'hash-expired';
    case 'budget':
      return 'budget-exhausted';
    case 'rate-limited':
      return 'refused';
    case 'error':
      return 'failed';
  }
}

export interface SweepResult {
  date: string;
  storesSwept: number;
  /** stores that did not end in 'succeeded', regardless of terminal state */
  storesAborted: number;
  /** per-store terminal state, in store order */
  perStoreResults: PerStoreReason[];
  finds: number;
  alerts: number;
  /** how many reads the edge refused (no retries are made) */
  rateLimited: number;
  /** true when anything was left unswept: refusals, a wrong store, an expired hash or a spent budget */
  abandoned: boolean;
  /** the classification of what was abandoned, when something was */
  abortReason: SweepErrorKind | null;
  /** reads made against Walmart this run across every node, refused ones included */
  readsSpent: number;
  /** the read budget *per egress node*, not for the run as a whole */
  readBudget: number;
  /** `full` reads every shelf to its end; `delta` reads newest-first and stops at the familiar */
  mode: 'full' | 'delta';
  errors: string[];
}

/** What the sweep is doing right now, for a run that takes an hour. */
export interface SweepProgress {
  storesTotal: number;
  storesDone: number;
  currentStore: string | null;
  currentCategory: string | null;
  finds: number;
  rateLimited: number;
  readsSpent: number;
  /** per-node budget; the run total may be a multiple of it */
  readBudget: number;
  startedAt: string;
}

export interface SweepOptions {
  /** Reads per egress node per run. Default `WALMART_SWEEP_READ_BUDGET` or 12. */
  readBudget?: number;
  /** Stand-down after a refusal, ms. */
  cooldownMs?: number;
  /** Refusals in a row after which the run gives up. */
  maxConsecutiveRateLimits?: number;
  /** Newest-first reads that stop at the familiar. Default `WALMART_SWEEP_DELTA=1`. */
  delta?: boolean;
  /** A delta run is promoted to a full one when the last full pass is this old. */
  fullEveryDays?: number;
  /** Walmart sort token. Default `WALMART_SWEEP_SORT` or `new`. */
  sort?: string;
}

/**
 * Items per page. Walmart does not honour a larger one: measured 2026-10-06,
 * `ps=100` is answered as `ps=20` (more pages, smaller ones), while 40 is
 * served as asked. 40 is the largest size known to work.
 */
const PAGE_SIZE = 40;
/** Backstop against a shelf that never says it is over. */
const MAX_PAGES_GUARD = 30;

function resolveOptions(o: SweepOptions): Required<SweepOptions> {
  return {
    readBudget: o.readBudget ?? Number(process.env.WALMART_SWEEP_READ_BUDGET ?? 12),
    cooldownMs: o.cooldownMs ?? Number(process.env.WALMART_RATE_LIMIT_COOLDOWN_MS ?? 5 * 60 * 1000),
    maxConsecutiveRateLimits:
      o.maxConsecutiveRateLimits ?? Number(process.env.WALMART_MAX_CONSECUTIVE_RATE_LIMITS ?? 4),
    delta: o.delta ?? (process.env.WALMART_SWEEP_DELTA === '1' || process.env.WALMART_SWEEP_DELTA === 'true'),
    fullEveryDays: o.fullEveryDays ?? Number(process.env.WALMART_FULL_SWEEP_DAYS ?? 7),
    sort: o.sort ?? process.env.WALMART_SWEEP_SORT ?? 'new',
  };
}

export class ClearanceSweepJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly hour = Math.min(Math.max(Number(process.env.BASTILLE_SWEEP_HOUR ?? 4), 0), 23);
  private listeners = new Set<() => void>();
  private progressListeners = new Set<(p: SweepProgress) => void>();
  private progress: SweepProgress | null = null;
  private readonly opts: Required<SweepOptions>;
  /** reads made in the run in flight, across every node */
  private readsSpent = 0;
  /** reads made per egress node in the run in flight: the budget is a node's, not the run's */
  private readsByNode = new Map<string, number>();

  constructor(
    private repo: ClearanceRepo,
    private readShelf: ShelfReader = clearanceShelf,
    opts: SweepOptions = {},
  ) {
    this.opts = resolveOptions(opts);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Notifies when a sweep produces alerts, so the SSE stream can push them. */
  onAlerts(fn: () => void): void {
    this.listeners.add(fn);
  }

  /** Progress of the run in flight, or null when nothing is running. */
  get currentProgress(): SweepProgress | null {
    return this.progress;
  }

  onProgress(fn: (p: SweepProgress) => void): void {
    this.progressListeners.add(fn);
  }

  private publish(): void {
    if (!this.progress) return;
    this.progress.readsSpent = this.readsSpent;
    const snapshot = { ...this.progress };
    for (const fn of this.progressListeners) fn(snapshot);
  }

  start(): void {
    if (this.timer) return;
    const now = new Date();
    const next = new Date(now);
    next.setHours(this.hour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    this.timer = setTimeout(() => {
      void this.runOnce().catch(() => undefined);
      this.timer = setInterval(() => void this.runOnce().catch(() => undefined), 24 * 60 * 60 * 1000);
      this.timer.unref?.();
    }, next.getTime() - now.getTime());
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<SweepResult> {
    if (this.running) throw new Error('a sweep is already running');
    this.running = true;
    this.readsSpent = 0;
    this.readsByNode = new Map<string, number>();

    // Per-node host budgets. Each egress node burns its own 18-read window
    // against walmart.com so a block on one IP doesn't stop the others.
    this.repo.installEgressBudgets();

    const date = localDate();
    const runId = this.repo.startSweep(date);
    const errors: string[] = [];
    let finds = 0;
    let alerts = 0;
    let storesSwept = 0;
    let rateLimited = 0;
    let abandoned = false;
    /** set only by what is true run-wide (an expired hash) and stops the store loop */
    let runAborted = false;
    let abortReason: SweepErrorKind | null = null;
    let mode: 'full' | 'delta' = 'full';
    const perStoreResults: PerStoreReason[] = [];
    const perStoreCounts: PerStoreCounts = {
      wrongStore: 0,
      budgetExhausted: 0,
      hashExpired: 0,
      refused: 0,
      failed: 0,
      skipped: 0,
      aborted: 0,
    };
    const recordPerStore = (
      locationId: string,
      name: string,
      status: PerStoreStatus,
      message: string | null,
    ): void => {
      perStoreResults.push({ locationId, name, status, message });
      if (status === 'succeeded') return;
      perStoreCounts.aborted++;
      if (status === 'wrong-store') perStoreCounts.wrongStore++;
      else if (status === 'budget-exhausted') perStoreCounts.budgetExhausted++;
      else if (status === 'hash-expired') perStoreCounts.hashExpired++;
      else if (status === 'refused') perStoreCounts.refused++;
      else if (status === 'failed') perStoreCounts.failed++;
      else if (status === 'skipped') perStoreCounts.skipped++;
    };

    /** Stands the whole run down: what failed will fail for every node. */
    const abort = (kind: SweepErrorKind) => {
      abandoned = true;
      runAborted = true;
      abortReason = kind;
    };
    /** Stands one node's store down. The run carries on over the next node. */
    const abandonStore = (kind: SweepErrorKind) => {
      abandoned = true;
      abortReason = kind;
    };

    try {
      // Every enabled store, not just the one this connection happens to
      // answer for: each is read through its own egress node, and that is what
      // lets one night cover several metros.
      const stores = this.repo.listStores().filter((s) => s.enabled);
      const categories = sweepOrder(CLEARANCE_CATEGORIES);

      if (stores.length === 0) {
        errors.push('[error] no store on record - resolve the local store first');
      }

      this.progress = {
        storesTotal: stores.length,
        storesDone: 0,
        currentStore: null,
        currentCategory: null,
        finds: 0,
        rateLimited: 0,
        readsSpent: 0,
        readBudget: this.opts.readBudget,
        startedAt: new Date().toISOString(),
      };
      this.publish();

      for (const store of stores) {
        if (runAborted) break;
        // Counted per node: a refusal on one exit point is not evidence about
        // the next one's.
        let consecutiveRateLimits = 0;

        // Resolve this store's egress node once, here, and use it for every
        // read of this store. A store with no node, or one whose node is gone
        // or disabled, cannot be read at all: there is no other way to be sure
        // which shop Walmart answers for, so it is skipped and named rather
        // than read out of this process's own egress and filed under whichever
        // store that happens to resolve to.
        if (!store.egressNodeId) {
          const msg = `no egress node bound - every store swept must be read through one`;
          errors.push(`[error] ${store.name} (${store.locationId}): ${msg}`);
          recordPerStore(store.locationId, store.name, 'skipped', msg);
          continue;
        }
        const node = this.repo.getEgressNode(store.egressNodeId);
        if (!node) {
          const msg = `assigned egress node "${store.egressNodeId}" not found`;
          errors.push(`[error] ${store.name} (${store.locationId}): ${msg}`);
          recordPerStore(store.locationId, store.name, 'skipped', msg);
          continue;
        }
        if (!node.enabled) {
          const msg = `egress node "${store.egressNodeId}" is disabled`;
          errors.push(`[error] ${store.name} (${store.locationId}): ${msg}`);
          recordPerStore(store.locationId, store.name, 'skipped', msg);
          continue;
        }
        const proxyUrl = node.proxyUrl;
        const egressNodeId = node.id;

        // Delta only when there is a previous full pass recent enough to lean on.
        const lastFull = this.repo.lastFullSweepDate(store.locationId);
        const delta =
          this.opts.delta && lastFull !== null && daysBetween(lastFull, date) < this.opts.fullEveryDays;
        mode = delta ? 'delta' : 'full';
        const known = delta ? this.repo.knownItemIds(store.locationId) : new Set<string>();

        let sweptAnything = false;
        let allComplete = true;
        for (const category of categories) {
          this.progress.currentStore = store.name;
          this.progress.currentCategory = category.slug;
          this.publish();
          try {
            const result = await this.sweepCategory(
              date, store, category, delta ? known : null, proxyUrl, egressNodeId,
            );
            finds += result.finds;
            alerts += result.alerts;
            sweptAnything = true;
            if (!result.complete) allComplete = false;
            consecutiveRateLimits = 0;
          } catch (err) {
            allComplete = false;
            const kind = classifySweepError(err);

            if (kind === 'budget') {
              const left = categories.slice(categories.indexOf(category)).map((c) => c.slug).join(', ');
              const msg = `read budget of ${this.opts.readBudget} spent on node "${egressNodeId}" (${this.readsOnNode(egressNodeId)} reads) - not fully read: ${left}`;
              errors.push(`[budget] ${msg}`);
              // This node's allowance is gone; the next node still has its own.
              abandonStore('budget');
              recordPerStore(store.locationId, store.name, perStoreStatusForKind(kind), msg);
              break;
            }

            errors.push(`[${kind}] ${store.name} / ${category.slug}: ${(err as Error).message}`);

            if (kind === 'wrong-store') {
              // The exit point answered for another shop. Every further read
              // through it would fail the same way and spend budget doing it -
              // but another node reads for its own store, so this abandons the
              // store, not the run.
              abandonStore(kind);
              recordPerStore(
                store.locationId,
                store.name,
                perStoreStatusForKind(kind),
                (err as Error).message,
              );
              break;
            }
            if (kind === 'hash-expired') {
              // The hash is shared by every node's reads, so there is nothing
              // left worth spending.
              abort(kind);
              recordPerStore(
                store.locationId,
                store.name,
                perStoreStatusForKind(kind),
                (err as Error).message,
              );
              break;
            }
            if (kind !== 'rate-limited') {
              // 'error': an unexpected thrown value. Treat the store as failed
              // and move on; the rest of the run is not its fault.
              recordPerStore(
                store.locationId,
                store.name,
                perStoreStatusForKind(kind),
                (err as Error).message,
              );
              break;
            }

            rateLimited++;
            consecutiveRateLimits++;
            this.progress.rateLimited = rateLimited;
            this.publish();

            if (err instanceof WalmartCooldownError) {
              // The ledger says the edge is closed for longer than a read will
              // wait. Come back on the next run for this node; the others are
              // unaffected.
              abandonStore('rate-limited');
              recordPerStore(
                store.locationId,
                store.name,
                perStoreStatusForKind(kind),
                (err as Error).message,
              );
              break;
            }
            if (consecutiveRateLimits >= this.opts.maxConsecutiveRateLimits) {
              const msg = `gave up on node "${egressNodeId}" after ${consecutiveRateLimits} consecutive refusals - this store is not swept`;
              errors.push(`[rate-limited] ${msg}`);
              abandonStore('rate-limited');
              recordPerStore(
                store.locationId,
                store.name,
                perStoreStatusForKind(kind),
                msg,
              );
              break;
            }
            // Stand down. The pacer and the ledger are told too, so the next
            // read does not go out the moment this sleep ends - or after a
            // restart.
            backOffUntil(this.opts.cooldownMs, egressNodeId);
            await new Promise((r) => setTimeout(r, this.opts.cooldownMs));
          }
        }
        // Only a store that actually answered counts as swept, and only that
        // store moves to the back of the rotation queue. One that was refused
        // stays at the front and is retried first next run.
        // Marked after the pass, not before: `last_used_at` says when this node
        // was actually read, which is what an operator ages nodes on.
        this.repo.touchEgressNode(node.id);
        if (sweptAnything) {
          // A store that answered at least one category is 'succeeded' for
          // the partial-run record, even when its pass was budget-truncated
          // mid-shelf. The specific reason is already in perStoreResults if
          // abandonStore() fired; this is the success path.
          if (
            perStoreResults.length === 0 ||
            perStoreResults[perStoreResults.length - 1]!.locationId !== store.locationId
          ) {
            recordPerStore(store.locationId, store.name, 'succeeded', null);
          }
          storesSwept++;
          this.repo.markSwept(store.locationId);
          if (delta) this.repo.carryForward(date, store.locationId);
          else if (allComplete) this.repo.markFullSweep(store.locationId, date);
        } else {
          // A store that answered zero categories: record it as failed with
          // the prior error message if we can find one, otherwise a generic
          // "no categories read" message. (In practice the inner catch already
          // recorded something; this is the read-loop fell-through case.)
          const last = perStoreResults[perStoreResults.length - 1];
          if (!last || last.locationId !== store.locationId) {
            recordPerStore(
              store.locationId,
              store.name,
              'failed',
              'no category answered before the run ended',
            );
          }
        }
        this.progress.storesDone++;
        this.progress.finds = finds;
        this.publish();
      }

      // `finds` counted writes; an item on both shelves is written twice and
      // stored once. Report what is actually on record.
      const recorded = this.repo.countFinds(date, stores.map((s) => s.locationId));
      // todo 13: sweep_run.error is for run-level crashes only. A partial run
      // that completed with stores_swept=7 and stores_aborted=5 leaves it
      // null; the per-store detail is in per_store_reasons. The main path
      // here is the "the sweep completed, with per-store outcomes" path -
      // the catch below is the only one that writes a non-null error.
      this.repo.finishSweep(
        runId,
        storesSwept,
        recorded,
        perStoreCounts,
        perStoreResults,
        null,
      );
      if (alerts > 0) for (const fn of this.listeners) fn();
      return {
        date,
        storesSwept,
        storesAborted: perStoreCounts.aborted,
        perStoreResults,
        finds: recorded,
        alerts,
        rateLimited,
        abandoned,
        abortReason,
        readsSpent: this.readsSpent,
        readBudget: this.opts.readBudget,
        mode,
        errors,
      };
    } catch (err) {
      this.repo.finishSweep(
        runId,
        storesSwept,
        finds,
        perStoreCounts,
        perStoreResults,
        `[error] ${(err as Error).message}`,
      );
      throw err;
    } finally {
      this.running = false;
      this.progress = null;
    }
  }

  /** reads made against one egress node in the run in flight */
  private readsOnNode(egressNodeId: string | undefined): number {
    return this.readsByNode.get(egressNodeId ?? '') ?? 0;
  }

  private spendRead(egressNodeId: string | undefined): void {
    const key = egressNodeId ?? '';
    this.readsByNode.set(key, (this.readsByNode.get(key) ?? 0) + 1);
    this.readsSpent++;
  }

  /**
   * Reads one shelf page by page. `known` is the set of item ids already on
   * record at this store; when given the read is a delta - newest first, ending
   * at the first page that holds nothing unfamiliar. `complete` says the shelf
   * was read to its end rather than cut short by the budget or an error.
   *
   * `store` is the full SweptStore (with `egressNodeId`). The job resolves that
   * node once per store and hands its proxy URL down, so every page of this
   * shelf goes out the same exit point - and is counted against that node's
   * budget rather than the run's.
   */
  private async sweepCategory(
    date: string,
    store: {
      locationId: string;
      postalCode: string;
      name: string;
      egressNodeId: string | null;
    },
    category: ClearanceCategory,
    known: Set<string> | null,
    proxyUrl: string | undefined,
    egressNodeId: string | undefined,
  ): Promise<{ finds: number; alerts: number; complete: boolean }> {
    const { locationId, postalCode } = store;
    let finds = 0;
    let alerts = 0;

    for (let page = 1; page <= MAX_PAGES_GUARD; page++) {
      // The budget is the node's, not the run's: three nodes on a night get
      // three allowances, and one node running dry cannot starve the others.
      if (this.readsOnNode(egressNodeId) >= this.opts.readBudget) {
        throw new BudgetSpentError(`read budget of ${this.opts.readBudget} spent on node ${egressNodeId}`);
      }
      this.spendRead(egressNodeId);
      this.publish();
      const shelf = await this.readShelf({
        locationId,
        postalCode,
        categoryId: category.id,
        page,
        pageSize: PAGE_SIZE,
        sort: this.opts.sort,
        proxyUrl,
        egressNodeId,
      });

      // Walmart echoes the store it answered for, and it is not always the one
      // that was asked for: the scoping cookie is advisory, and a request for a
      // store in another state has been observed coming back with the local
      // one's rack. Recording that under the requested store would attribute
      // one shop's clearance to another, so the name has to match.
      if (shelf.storeName === null) {
        throw new WrongStoreError('response carried no store - refusing to record an unscoped shelf');
      }
      if (shelf.storeName.trim().toLowerCase() !== store.name.trim().toLowerCase()) {
        throw new WrongStoreError(
          `asked for ${store.name} but Walmart answered for ${shelf.storeName} - refusing to record it`,
        );
      }

      // Only an empty page is the end for certain. A short page is not: pages
      // come back anywhere from 22 to 48 items (ad tiles and repeats included)
      // and a shelf's last-but-one page can be shorter than the full one.
      if (shelf.pageItemCount === 0) return { finds, alerts, complete: true };

      if (shelf.items.length > 0) {
        const { written, newItemIds } = this.repo.recordFinds(
          date,
          locationId,
          category.slug,
          category.group,
          shelf.items,
        );
        finds += written;
        alerts += this.repo.alertOnNewFinds(date, locationId, newItemIds);

        // Delta: nothing on this page was ever seen before, so by the shelf's
        // newest-first order nothing deeper is new either.
        if (known && shelf.items.every((i) => known.has(i.itemId))) return { finds, alerts, complete: true };
      }

      // `maxPage` is Walmart's own page count and moves by one between reads,
      // so it is a bound, not a promise; the empty page above is the proof.
      if (shelf.maxPage != null) {
        if (page >= shelf.maxPage) return { finds, alerts, complete: true };
      } else if (shelf.totalCount !== null && page * PAGE_SIZE >= shelf.totalCount) {
        return { finds, alerts, complete: true };
      }
    }

    return { finds, alerts, complete: false };
  }
}
