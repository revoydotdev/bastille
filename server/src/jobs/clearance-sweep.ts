/**
 * Nightly Walmart in-store clearance sweep.
 *
 * Reads the clearance rack of the one store Walmart serves this connection and
 * records what is on it, with its aisle. Walmart resolves the store from the
 * requesting address, so there is no choosing one: the sweep checks the store
 * Walmart names in each response against the one on record, which is what would
 * catch the address changing under it - a VPN, a move, a new ISP route -
 * rather than quietly filing another town's clearance under this one.
 *
 * Reads are the scarce resource. Walmart's edge limits on count, not cadence,
 * so a run has a *read budget* (`WALMART_SWEEP_READ_BUDGET`, default 12) spent
 * on shelves in priority order - Computers, Electronics, Video games - and the
 * pacer in `walmart-api` shares a durable ledger with every other caller.
 * Nothing here retries: a refusal stands the sweep down for a cooldown, and
 * enough of them in a row end the run.
 *
 * Every error the run records starts with a classification token the dashboard
 * can show: `[rate-limited]`, `[wrong-store]`, `[hash-expired]`, `[budget]` or
 * `[error]`. Hash expiry and a wrong store abort the run, since each further
 * read would fail the same way and cost budget doing it.
 */
import { CLEARANCE_CATEGORIES, sweepOrder, type ClearanceCategory } from '../clearance/categories.js';
import { backOffUntil, canaryProbe, clearanceShelf, HashExpiredError, WalmartCooldownError } from '../clearance/walmart-api.js';
import type { CanaryResult, ShelfPage } from '../clearance/walmart-api.js';
import { HttpError } from '../adapters/http.js';
import type { ClearanceRepo, EgressNode, NodeHealth } from '../clearance/repo.js';

/** The one call that leaves the process for a canary. Injectable so the sweep can
 *  be driven end to end in a test without reaching Walmart. */
export type CanaryProbe = (node: {
  id: string;
  proxyUrl: string;
  verifiedStore: string | null;
}) => Promise<CanaryResult>;

/**
 * A canary's outcome, mapped to the node's health. Anything that is not a
 * verified match and not a store mismatch is a node we could not reach or that
 * refused us — either way there is no reason to spend the night's budget on it.
 */
export function healthOf(result: CanaryResult): Exclude<NodeHealth, null> {
  if (result.ok) return 'ok';
  return result.error?.kind === 'mismatch' ? 'drifted' : 'blocked';
}

export interface StoreGate<S> {
  /** stores the sweep may read */
  sweepable: S[];
  /** stores held back, each with the health that held it */
  excluded: { locationId: string; egressNodeId: string; health: NodeHealth }[];
}

/**
 * Holds back every store whose egress node is not currently attested.
 *
 * A store with no node keeps the original behaviour (it is read from the
 * process's own egress, which has nothing to attest). A store on a node the
 * canary has not cleared — `drifted`, `blocked`, or never checked at all — is
 * not read, because spending a night of that node's budget on an exit point
 * that answers for the wrong store produces confident, mislabelled findings.
 *
 * Pure, and exported so the gate can be exercised over a whole node set without
 * a run behind it.
 */
export function gateStoresByNodeHealth<
  S extends { locationId: string; egressNodeId: string | null },
>(stores: S[], nodes: EgressNode[]): StoreGate<S> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const sweepable: S[] = [];
  const excluded: StoreGate<S>['excluded'] = [];
  for (const store of stores) {
    const node = store.egressNodeId ? byId.get(store.egressNodeId) : undefined;
    // Unknown or disabled nodes are reported by the store loop itself, which
    // already names them; the gate only speaks about health.
    if (!node || !store.egressNodeId || node.health === 'ok') sweepable.push(store);
    else if (node.enabled) excluded.push({ locationId: store.locationId, egressNodeId: node.id, health: node.health });
    else sweepable.push(store);
  }
  return { sweepable, excluded };
}

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

export interface SweepResult {
  date: string;
  storesSwept: number;
  finds: number;
  alerts: number;
  /** how many reads the edge refused (no retries are made) */
  rateLimited: number;
  /** true when the run stopped early: refusals, a wrong store, an expired hash or a spent budget */
  abandoned: boolean;
  /** the classification of what stopped the run, when something did */
  abortReason: SweepErrorKind | null;
  /** reads made against Walmart this run, refused ones included */
  readsSpent: number;
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
  readBudget: number;
  startedAt: string;
}

export interface SweepOptions {
  /** Reads per run. Default `WALMART_SWEEP_READ_BUDGET` or 12. */
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
  /** reads made in the run in flight */
  private readsSpent = 0;

  constructor(
    private repo: ClearanceRepo,
    private readShelf: ShelfReader = clearanceShelf,
    opts: SweepOptions = {},
    private probe: CanaryProbe = canaryProbe,
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
    let consecutiveRateLimits = 0;
    let abandoned = false;
    let abortReason: SweepErrorKind | null = null;
    let mode: 'full' | 'delta' = 'full';

    const abort = (kind: SweepErrorKind) => {
      abandoned = true;
      abortReason = kind;
    };

    try {
      const local = this.repo.localStore();

      // Canary first, and before the store loop: one read per due node asking
      // which store it still answers for. It is deliberately not charged to the
      // node's budget — the point is to decide whether that budget is spent.
      const now = new Date().toISOString();
      for (const node of this.repo.getEgressNodesDueForCanary()) {
        let result: CanaryResult;
        try {
          result = await this.probe({
            id: node.id,
            proxyUrl: node.proxyUrl,
            verifiedStore: node.verifiedStore,
          });
        } catch (err) {
          result = { ok: false, answeredStore: null, error: { kind: 'transport', message: (err as Error).message, duration_ms: 0 } };
        }
        const health = healthOf(result);
        this.repo.setNodeHealth(node.id, health, result.ok ? result.answeredStore : null, now);
        // A passing canary deliberately leaves no trace here: it would mark a
        // healthy sweep as errored, and the node row already records it.
        if (health !== 'ok') {
          errors.push(`[canary] ${node.id}: ${health} (${result.error?.kind}) - skipped this run`);
        }
      }

      const gate = gateStoresByNodeHealth(local ? [local] : [], this.repo.listEgressNodes());
      for (const held of gate.excluded) {
        errors.push(
          `[canary] ${held.locationId} (node ${held.egressNodeId}): not read - node health is "${held.health}"`,
        );
      }
      const stores = gate.sweepable;
      const categories = sweepOrder(CLEARANCE_CATEGORIES);

      if (local && stores.length === 0) {
        errors.push('[canary] every bound egress node is drifted or blocked - nothing read this run');
      } else if (stores.length === 0) {
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
        if (abandoned) break;

        // Look up the egress node for this store. Without one, the read goes
        // out the process's own egress (which Walmart's edge resolves to one
        // store, typically the closest to the server's real IP). With one, the
        // read goes through the residential proxy, and Walmart picks the store
        // that node is in. This is what lets one sweep cover multiple metros.
        const node = store.egressNodeId ? this.repo.getEgressNode(store.egressNodeId) : null;
        if (store.egressNodeId) {
          if (!node) {
            errors.push(`[error] ${store.name} (${store.locationId}): assigned egress node "${store.egressNodeId}" not found`);
            continue;
          }
          if (!node.enabled) {
            errors.push(`[error] ${store.name} (${store.locationId}): egress node "${store.egressNodeId}" is disabled`);
            continue;
          }
          this.repo.touchEgressNode(node.id);
        }
        const proxyUrl = node?.proxyUrl;
        const egressNodeId = node?.id;

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
              errors.push(
                `[budget] read budget of ${this.opts.readBudget} spent (${this.readsSpent} reads) - not fully read: ${left}`,
              );
              abort('budget');
              break;
            }

            errors.push(`[${kind}] ${store.name} / ${category.slug}: ${(err as Error).message}`);

            if (kind === 'hash-expired' || kind === 'wrong-store') {
              // Every further read would fail the same way and spend budget
              // doing it.
              abort(kind);
              break;
            }
            if (kind !== 'rate-limited') continue;

            rateLimited++;
            consecutiveRateLimits++;
            this.progress.rateLimited = rateLimited;
            this.publish();

            if (err instanceof WalmartCooldownError) {
              // The ledger says the edge is closed for longer than a read will
              // wait. Come back on the next run.
              abort('rate-limited');
              break;
            }
            if (consecutiveRateLimits >= this.opts.maxConsecutiveRateLimits) {
              errors.push(
                `[rate-limited] gave up after ${consecutiveRateLimits} consecutive refusals - ${stores.length - this.progress.storesDone} store(s) not swept`,
              );
              abort('rate-limited');
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
        if (sweptAnything) {
          storesSwept++;
          this.repo.markSwept(store.locationId);
          if (delta) this.repo.carryForward(date, store.locationId);
          else if (allComplete) this.repo.markFullSweep(store.locationId, date);
        }
        this.progress.storesDone++;
        this.progress.finds = finds;
        this.publish();
      }

      // `finds` counted writes; an item on both shelves is written twice and
      // stored once. Report what is actually on record.
      const recorded = this.repo.countFinds(date, stores.map((s) => s.locationId));
      this.repo.finishSweep(runId, storesSwept, recorded, errors.length > 0 ? errors.join('; ').slice(0, 2000) : null);
      if (alerts > 0) for (const fn of this.listeners) fn();
      return {
        date,
        storesSwept,
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
      this.repo.finishSweep(runId, storesSwept, finds, `[error] ${(err as Error).message}`);
      throw err;
    } finally {
      this.running = false;
      this.progress = null;
    }
  }

  /**
   * Reads one shelf page by page. `known` is the set of item ids already on
   * record at this store; when given the read is a delta - newest first, ending
   * at the first page that holds nothing unfamiliar. `complete` says the shelf
   * was read to its end rather than cut short by the budget or an error.
   *
   * `store` is the full SweptStore (with `egressNodeId` if assigned). The
   * per-store egress node is resolved to a proxy URL once and used for every
   * page of this shelf. Nodes are looked up in `localEgressNodes` which the
   * job pre-populates from the repo at run start.
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
      if (this.readsSpent >= this.opts.readBudget) throw new BudgetSpentError('read budget spent');
      this.readsSpent++;
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
