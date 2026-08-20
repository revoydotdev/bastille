/**
 * Daily cross-source price snapshot.
 *
 * Once a day it records a broad set of current offers from every store into
 * `daily_snapshot`, giving a durable dataset for analysis and the corpus the
 * deals filter reads. Each store is snapshotted at one canonical location so
 * the series is consistent day to day and the job stays bounded.
 */
import { STORE_IDS, adapterFor } from '../adapters/index.js';
import type { Repo, SnapshotOffer } from '../repo.js';
import type { StoreId } from '../price/model.js';

function localDate(d = new Date()): string {
  // YYYY-MM-DD in local time — the day the snapshot belongs to.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface SnapshotResult {
  date: string;
  rows: number;
  perStore: Record<string, number>;
  errors: string[];
}

/** The location each store is snapshotted at (null = national/no per-store). */
function snapshotLocation(storeId: StoreId): string | null {
  const adapter = adapterFor(storeId);
  if (!adapter.pricesVaryByLocation) return null;
  const envKey = `SNAPSHOT_${storeId.toUpperCase()}_STORE`;
  return process.env[envKey] ?? adapter.defaultLocationId;
}

export class SnapshotJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** hour of day (local, 0-23) to run at */
  private readonly hour = Math.min(Math.max(Number(process.env.GROCER_SNAPSHOT_HOUR ?? 3), 0), 23);
  private readonly wegmansBudget = Number(process.env.WEGMANS_SNAPSHOT_PRODUCTS ?? 3000);

  constructor(private repo: Repo) {}

  get isRunning(): boolean {
    return this.running;
  }

  /** Schedules the next run at the configured hour and every 24h after. */
  start(): void {
    if (this.timer) return;
    const now = new Date();
    const next = new Date(now);
    next.setHours(this.hour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = next.getTime() - now.getTime();
    this.timer = setTimeout(() => {
      void this.runOnce().catch(() => undefined);
      this.timer = setInterval(() => void this.runOnce().catch(() => undefined), 24 * 60 * 60 * 1000);
      this.timer.unref?.();
    }, delay);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      clearInterval(this.timer);
    }
    this.timer = null;
  }

  async runOnce(): Promise<SnapshotResult> {
    if (this.running) return { date: localDate(), rows: 0, perStore: {}, errors: ['snapshot already in progress'] };
    this.running = true;
    const date = localDate();
    const runId = this.repo.startSnapshotRun(date, STORE_IDS.join(','));
    const result: SnapshotResult = { date, rows: 0, perStore: {}, errors: [] };

    try {
      const perStore = await Promise.allSettled(
        STORE_IDS.map(async (id) => {
          const location = snapshotLocation(id);
          const offers = await adapterFor(id).enumerate({
            locationId: location,
            maxProducts: id === 'wegmans' ? this.wegmansBudget : undefined,
          });
          const batch: SnapshotOffer[] = offers.map((offer) => ({ offer, locationId: location }));
          const written = this.repo.recordSnapshot(date, batch);
          return { id, written };
        }),
      );

      perStore.forEach((outcome, i) => {
        const id = STORE_IDS[i]!;
        if (outcome.status === 'fulfilled') {
          result.perStore[id] = outcome.value.written;
          result.rows += outcome.value.written;
        } else {
          result.errors.push(`${id}: ${(outcome.reason as Error)?.message ?? 'snapshot failed'}`);
        }
      });

      this.repo.finishSnapshotRun(runId, result.rows, result.errors.join('; ') || null);
    } catch (err) {
      this.repo.finishSnapshotRun(runId, result.rows, (err as Error).message);
      result.errors.push((err as Error).message);
    } finally {
      this.running = false;
    }
    return result;
  }
}
