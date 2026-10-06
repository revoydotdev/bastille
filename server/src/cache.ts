/**
 * Tiny TTL + LRU cache for memoizing expensive upstream reads (store searches).
 * Bounded in both entries and age so it never becomes a memory or staleness
 * liability. Single-process, no external dependency.
 */
export class TtlCache<T> {
  private map = new Map<string, { value: T; expires: number }>();
  /** Concurrent identical computations share one upstream call. */
  private inflight = new Map<string, Promise<T>>();
  private hits = 0;
  private misses = 0;
  private joined = 0;

  constructor(
    private ttlMs: number,
    private maxEntries = 200,
  ) {}

  get(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh LRU position.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: T): void {
    this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
    if (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  /**
   * Returns the cached value or computes, stores and returns it. Callers that
   * arrive while a computation for the same key is running wait for that one
   * instead of going upstream again; a failure reaches all of them and is not
   * cached.
   */
  wrap(key: string, compute: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) {
      this.hits++;
      return Promise.resolve(cached);
    }
    const pending = this.inflight.get(key);
    if (pending) {
      this.joined++;
      return pending;
    }
    this.misses++;
    const job = (async () => {
      try {
        const value = await compute();
        this.set(key, value);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, job);
    return job;
  }

  /** Counters for `/api/metrics`. A joined call avoided an upstream read, so it counts as a hit. */
  stats(): { hits: number; misses: number; joined: number; size: number; hitRatio: number | null } {
    const served = this.hits + this.joined;
    const total = served + this.misses;
    return { hits: this.hits, misses: this.misses, joined: this.joined, size: this.map.size, hitRatio: total === 0 ? null : served / total };
  }
}
