/**
 * Nightly Walmart in-store clearance sweep.
 *
 * Walks every enabled store x every configured category and records what is on
 * the clearance rack, with its aisle. The point of doing it per store is that
 * the answer genuinely differs per store — a rural supercentre marking down PC
 * parts is exactly the case this exists for, and the store next door will not
 * have the same rack.
 *
 * The sweep is deliberately slow. Walmart's edge answers a burst with 412, and
 * a nightly job has hours to spend, so `walmart-api` paces every read and this
 * job adds no concurrency on top: one store, one category, one page at a time.
 *
 * When the edge does push back, the sweep stands down for a cooldown rather
 * than spending the rest of the run failing every remaining store against a
 * closed door — and gives up entirely after enough consecutive refusals, on the
 * grounds that a job which cannot get an answer should stop asking.
 *
 * That refusal is the reason a run does not try to visit every store. Measured
 * against the live edge, roughly twenty reads earns a 412 no matter how far
 * apart they are spaced — spacing buys nothing past a point, because the limit
 * is on the count, not the cadence. So each run takes a slice: the stores whose
 * racks are the most stale, `WALMART_STORES_PER_SWEEP` of them, and the next
 * run takes the next slice. Two dozen stores come round over several nights,
 * every one of them carrying the date its rack was actually read.
 */
import { CLEARANCE_CATEGORIES, type ClearanceCategory } from '../clearance/categories.js';
import { backOffUntil, clearanceShelf } from '../clearance/walmart-api.js';
import type { ShelfPage } from '../clearance/walmart-api.js';
import { HttpError } from '../adapters/http.js';
import type { ClearanceRepo } from '../clearance/repo.js';

/** The one call that leaves the process. Injectable so the sweep can be driven
 *  end to end in a test without reaching Walmart. */
export type ShelfReader = (opts: {
  locationId: string;
  postalCode?: string;
  categoryId: string;
  page?: number;
  pageSize?: number;
}) => Promise<ShelfPage>;

function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface SweepResult {
  date: string;
  storesSwept: number;
  finds: number;
  alerts: number;
  /** how many reads the edge refused, after the client's own retries */
  rateLimited: number;
  /** true when the run stopped early because the edge kept refusing */
  abandoned: boolean;
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
  startedAt: string;
}

/** Pages per category per store. 40 items a page; eight pages is 320, which
 *  clears the largest rack observed (190 items at one store) with room to
 *  spare, while bounding a shelf that claims thousands. */
const MAX_PAGES = Number(process.env.WALMART_SWEEP_MAX_PAGES ?? 8);
const PAGE_SIZE = 40;

/** How long to stand down after the edge refuses a read. */
const RATE_LIMIT_COOLDOWN_MS = Number(process.env.WALMART_RATE_LIMIT_COOLDOWN_MS ?? 5 * 60 * 1000);
/** Consecutive refusals after which the run gives up rather than keep knocking. */
const MAX_CONSECUTIVE_RATE_LIMITS = Number(process.env.WALMART_MAX_CONSECUTIVE_RATE_LIMITS ?? 4);
/**
 * Stores per run. Three stores came through cleanly on two shelves each — about
 * twenty reads — before the edge started refusing. Three shelves per store now
 * makes each store dearer, so the slice stays at three; raising it does not get
 * more data, it just gets more 412s and a longer run.
 */
const STORES_PER_SWEEP = Number(process.env.WALMART_STORES_PER_SWEEP ?? 3);

/** 412 is Walmart's edge; 429 is the ordinary spelling. Either means "later". */
function isRateLimit(err: unknown): boolean {
  return err instanceof HttpError && (err.status === 412 || err.status === 429);
}

export class ClearanceSweepJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly hour = Math.min(Math.max(Number(process.env.BASTILLE_SWEEP_HOUR ?? 4), 0), 23);
  private listeners = new Set<() => void>();
  private progressListeners = new Set<(p: SweepProgress) => void>();
  private progress: SweepProgress | null = null;

  constructor(
    private repo: ClearanceRepo,
    private readShelf: ShelfReader = clearanceShelf,
  ) {}

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

  async runOnce(opts: { locationIds?: string[]; maxStores?: number } = {}): Promise<SweepResult> {
    if (this.running) throw new Error('a sweep is already running');
    this.running = true;

    const date = localDate();
    const runId = this.repo.startSweep(date);
    const errors: string[] = [];
    let finds = 0;
    let alerts = 0;
    let storesSwept = 0;
    let rateLimited = 0;
    let consecutiveRateLimits = 0;
    let abandoned = false;

    try {
      // An explicit list is taken at its word — that is a deliberate ask. With
      // no list, the run takes the stalest slice.
      const stores = opts.locationIds && opts.locationIds.length > 0
        ? this.repo.listStores(true).filter((s) => opts.locationIds!.includes(s.locationId))
        : this.repo.storesDueForSweep(opts.maxStores ?? STORES_PER_SWEEP);
      const categories = CLEARANCE_CATEGORIES;

      if (stores.length === 0) {
        errors.push('no stores enabled — discover stores for a ZIP first');
      }

      this.progress = {
        storesTotal: stores.length,
        storesDone: 0,
        currentStore: null,
        currentCategory: null,
        finds: 0,
        rateLimited: 0,
        startedAt: new Date().toISOString(),
      };
      this.publish();

      for (const store of stores) {
        if (abandoned) break;
        let sweptAnything = false;
        for (const category of categories) {
          this.progress.currentStore = store.name;
          this.progress.currentCategory = category.slug;
          this.publish();
          try {
            const result = await this.sweepCategory(date, store, category);
            finds += result.finds;
            alerts += result.alerts;
            sweptAnything = true;
            consecutiveRateLimits = 0;
          } catch (err) {
            errors.push(`${store.name} / ${category.slug}: ${(err as Error).message}`);
            if (!isRateLimit(err)) continue;

            rateLimited++;
            consecutiveRateLimits++;
            this.progress.rateLimited = rateLimited;
            this.publish();

            if (consecutiveRateLimits >= MAX_CONSECUTIVE_RATE_LIMITS) {
              errors.push(
                `gave up after ${consecutiveRateLimits} consecutive refusals — ${stores.length - this.progress.storesDone} store(s) not swept`,
              );
              abandoned = true;
              break;
            }
            // Stand down. The pacer is told too, so the next read does not go
            // out the moment this sleep ends.
            backOffUntil(RATE_LIMIT_COOLDOWN_MS);
            await new Promise((r) => setTimeout(r, RATE_LIMIT_COOLDOWN_MS));
          }
        }
        // Only a store that actually answered counts as swept, and only that
        // store moves to the back of the rotation queue. One that was refused
        // stays at the front and is retried first next run.
        if (sweptAnything) {
          storesSwept++;
          this.repo.markSwept(store.locationId);
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
      return { date, storesSwept, finds: recorded, alerts, rateLimited, abandoned, errors };
    } catch (err) {
      this.repo.finishSweep(runId, storesSwept, finds, (err as Error).message);
      throw err;
    } finally {
      this.running = false;
      this.progress = null;
    }
  }

  private async sweepCategory(
    date: string,
    store: { locationId: string; postalCode: string; name: string },
    category: ClearanceCategory,
  ): Promise<{ finds: number; alerts: number }> {
    const { locationId, postalCode } = store;
    let finds = 0;
    let alerts = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const shelf = await this.readShelf({
        locationId,
        postalCode,
        categoryId: category.id,
        page,
        pageSize: PAGE_SIZE,
      });

      // Walmart echoes the store it answered for, and it is not always the one
      // that was asked for: the scoping cookie is advisory, and a request for a
      // store in another state has been observed coming back with the local
      // one's rack. Recording that under the requested store would attribute
      // one shop's clearance to another, so the name has to match.
      if (shelf.storeName === null) {
        throw new Error('response carried no store — refusing to record an unscoped shelf');
      }
      if (shelf.storeName.trim().toLowerCase() !== store.name.trim().toLowerCase()) {
        throw new Error(
          `asked for ${store.name} but Walmart answered for ${shelf.storeName} — refusing to record it`,
        );
      }

      // A page can be all shipping-only items, which is not the end of the
      // shelf — only an empty page from Walmart is.
      if (shelf.pageItemCount === 0) break;
      if (shelf.items.length === 0) {
        if (shelf.pageItemCount < PAGE_SIZE) break;
        continue;
      }

      const { written, newItemIds } = this.repo.recordFinds(
        date,
        locationId,
        category.slug,
        category.group,
        shelf.items,
      );
      finds += written;
      alerts += this.repo.alertOnNewFinds(date, locationId, newItemIds);

      if (shelf.pageItemCount < PAGE_SIZE) break;
      if (shelf.totalCount !== null && page * PAGE_SIZE >= shelf.totalCount) break;
    }

    return { finds, alerts };
  }
}
