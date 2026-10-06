/**
 * Refreshes every watched product on an interval and turns the differences
 * into alerts. One product at a time — the HTTP client already throttles per
 * host, and a watchlist is small.
 */
import { adapterFor, STORE_IDS } from '../adapters/index.js';
import { tallyRequests } from '../metrics.js';
import type { Repo, StoredProduct } from '../repo.js';
import type { PriceChange } from '../price/diff.js';

export interface PollResult {
  itemsPolled: number;
  changes: PriceChange[];
  errors: string[];
}

export class Poller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private listeners = new Set<(result: PollResult) => void>();

  constructor(
    private repo: Repo,
    private intervalMs = Number(process.env.BASTILLE_POLL_INTERVAL_MS ?? 30 * 60 * 1000),
  ) {}

  onPoll(fn: (result: PollResult) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pollOnce().catch(() => undefined);
    }, this.intervalMs);
    // Do not block startup on a network round trip.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get isRunning(): boolean {
    return this.running;
  }

  async pollOnce(): Promise<PollResult> {
    if (this.running) return { itemsPolled: 0, changes: [], errors: ['poll already in progress'] };
    this.running = true;
    const runId = this.repo.startPollRun(null);
    const result: PollResult = { itemsPolled: 0, changes: [], errors: [] };
    for (const id of STORE_IDS) adapterFor(id).beginRun?.();
    const spent = { requests: 0, bytes: 0 };

    try {
      const tallied = await tallyRequests(() => this.refreshAll(result));
      spent.requests = tallied.requests;
      spent.bytes = tallied.bytes;
      this.repo.finishPollRun(runId, result.itemsPolled, result.changes.length, result.errors.join('; ') || null, spent);
    } catch (err) {
      this.repo.finishPollRun(runId, result.itemsPolled, result.changes.length, (err as Error).message, spent);
      throw err;
    } finally {
      this.running = false;
    }

    for (const fn of this.listeners) fn(result);
    return result;
  }

  private async refreshAll(result: PollResult): Promise<void> {
    // Group by store so the two hosts poll concurrently, while each host's
    // own items stay serial (the HTTP client already throttles per host).
    const byStore = new Map<string, { product: StoredProduct; locationId: string | null }[]>();
    for (const item of this.repo.listWatchItems()) {
      const product = this.repo.getProductById(item.productId);
      if (!product) continue;
      const arr = byStore.get(product.storeId) ?? [];
      arr.push({ product, locationId: item.locationId });
      byStore.set(product.storeId, arr);
    }

    await Promise.all(
      [...byStore.values()].map(async (items) => {
        for (const item of items) {
          const { product } = item;
          try {
            const offer = await adapterFor(product.storeId).fetchOffer(
              product.storeProductId,
              item.locationId ?? undefined,
              { productUrl: product.productUrl },
            );
            if (!offer) {
              result.errors.push(`${product.storeId}:${product.storeProductId} not found`);
              continue;
            }
            // DB writes are synchronous (node:sqlite) so interleaving across
            // the two store loops is safe — no concurrent writers.
            this.repo.upsertProduct(offer);
            result.changes.push(...this.repo.recordPrice(product.id, item.locationId, offer.price));
            result.itemsPolled++;
          } catch (err) {
            result.errors.push(`${product.storeId}:${product.storeProductId} ${(err as Error).message}`);
          }
        }
      }),
    );
  }
}
