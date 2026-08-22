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
 */
import { CLEARANCE_CATEGORIES, type ClearanceCategory } from '../clearance/categories.js';
import { clearanceShelf } from '../clearance/walmart-api.js';
import type { ShelfPage } from '../clearance/walmart-api.js';
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
  errors: string[];
}

/** Pages per category per store. 40 items a page; eight pages is 320, which
 *  clears the largest rack observed (190 items at one store) with room to
 *  spare, while bounding a shelf that claims thousands. */
const MAX_PAGES = Number(process.env.WALMART_SWEEP_MAX_PAGES ?? 8);
const PAGE_SIZE = 40;

export class ClearanceSweepJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly hour = Math.min(Math.max(Number(process.env.BASTILLE_SWEEP_HOUR ?? 4), 0), 23);
  private listeners = new Set<() => void>();

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

  async runOnce(opts: { locationIds?: string[] } = {}): Promise<SweepResult> {
    if (this.running) throw new Error('a sweep is already running');
    this.running = true;

    const date = localDate();
    const runId = this.repo.startSweep(date);
    const errors: string[] = [];
    let finds = 0;
    let alerts = 0;
    let storesSwept = 0;

    try {
      const enabled = this.repo.listStores(true);
      const stores = opts.locationIds && opts.locationIds.length > 0
        ? enabled.filter((s) => opts.locationIds!.includes(s.locationId))
        : enabled;
      const categories = CLEARANCE_CATEGORIES;

      if (stores.length === 0) {
        errors.push('no stores enabled — discover stores for a ZIP first');
      }

      for (const store of stores) {
        let sweptAnything = false;
        for (const category of categories) {
          try {
            const result = await this.sweepCategory(date, store.locationId, store.postalCode, category);
            finds += result.finds;
            alerts += result.alerts;
            sweptAnything = true;
          } catch (err) {
            errors.push(`${store.name} / ${category.slug}: ${(err as Error).message}`);
          }
        }
        if (sweptAnything) storesSwept++;
      }

      this.repo.finishSweep(runId, storesSwept, finds, errors.length > 0 ? errors.join('; ').slice(0, 2000) : null);
      if (alerts > 0) for (const fn of this.listeners) fn();
      return { date, storesSwept, finds, alerts, errors };
    } catch (err) {
      this.repo.finishSweep(runId, storesSwept, finds, (err as Error).message);
      throw err;
    } finally {
      this.running = false;
    }
  }

  private async sweepCategory(
    date: string,
    locationId: string,
    postalCode: string,
    category: ClearanceCategory,
  ): Promise<{ finds: number; alerts: number }> {
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

      // Walmart echoes the store it answered for. If the scoping cookie was
      // ignored the shelf is some other store's rack, and recording it under
      // this store would be a lie — so the category is abandoned instead.
      if (shelf.storeName === null) {
        throw new Error('response carried no store — refusing to record an unscoped shelf');
      }

      if (shelf.items.length === 0) break;

      const { written, newItemIds } = this.repo.recordFinds(
        date,
        locationId,
        category.slug,
        category.group,
        shelf.items,
      );
      finds += written;
      alerts += this.repo.alertOnNewFinds(date, locationId, newItemIds);

      if (shelf.items.length < PAGE_SIZE) break;
      if (shelf.totalCount !== null && page * PAGE_SIZE >= shelf.totalCount) break;
    }

    return { finds, alerts };
  }
}
