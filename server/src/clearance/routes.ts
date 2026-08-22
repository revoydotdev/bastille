/**
 * HTTP surface for the Walmart clearance sweep.
 *
 * Kept apart from the grocery routes because the shape is different: there is
 * no watchlist of products here, only a set of stores to sweep, a feed of what
 * each one has marked down, and saved terms to be told about.
 */
import type { FastifyInstance } from 'fastify';
import { CLEARANCE_CATEGORIES, CATEGORY_GROUPS, categoryBySlug, isCategoryGroup, type CategoryGroup } from './categories.js';
import { nearbyStores, type WalmartStore } from './walmart-api.js';
import type { ClearanceRepo, ClearanceFilter } from './repo.js';
import type { ClearanceSweepJob } from '../jobs/clearance-sweep.js';
import { normalizeZip } from '../geo.js';

function parseList(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function parseGroups(raw: unknown): CategoryGroup[] {
  return parseList(raw).filter(isCategoryGroup);
}

function parseNumber(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Walmart's store finder. Injectable for the same reason the shelf reader is:
 *  it is the other call that leaves the process. */
export type StoreFinder = (postalCode: string, radiusMiles?: number) => Promise<WalmartStore[]>;

export function registerClearanceRoutes(
  app: FastifyInstance,
  repo: ClearanceRepo,
  sweep: ClearanceSweepJob,
  findStores: StoreFinder = nearbyStores,
): void {
  app.get('/api/clearance/categories', async () => ({
    categories: CLEARANCE_CATEGORIES,
    groups: CATEGORY_GROUPS,
  }));

  app.get('/api/clearance/stores', async () => ({
    stores: repo.listStores(),
    lastSweep: repo.lastSweep(),
    sweeping: sweep.isRunning,
    progress: sweep.currentProgress,
  }));

  /**
   * Discovers the Walmarts near a ZIP and records them. New stores are
   * disabled by default unless `enable=1`: sweeping 24 stores unasked is a lot
   * of reads against a rate-limited edge, and which ones are worth driving to
   * is the user's call.
   */
  app.post('/api/clearance/stores/discover', async (req, reply) => {
    const body = (req.body ?? {}) as { postalCode?: string; radiusMiles?: number; enable?: boolean };
    const zip = normalizeZip(body.postalCode ?? '');
    if (!zip) return reply.code(400).send({ error: 'postalCode is required' });

    const radius = Math.min(Math.max(body.radiusMiles ?? 50, 1), 100);
    try {
      const found = await findStores(zip, radius);
      repo.upsertStores(found, zip, body.enable === true);
      return { zip, radiusMiles: radius, found: found.length, stores: repo.listStores() };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.patch('/api/clearance/stores/:locationId', async (req, reply) => {
    const { locationId } = req.params as { locationId: string };
    const body = (req.body ?? {}) as { enabled?: boolean };
    if (typeof body.enabled !== 'boolean') return reply.code(400).send({ error: 'enabled is required' });
    if (!repo.setStoreEnabled(locationId, body.enabled)) {
      return reply.code(404).send({ error: 'store not found' });
    }
    return { locationId, enabled: body.enabled };
  });

  app.get('/api/clearance', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const slugs = parseList(q['categories']);
    const unknown = slugs.filter((s) => categoryBySlug(s) === null);
    if (unknown.length > 0) {
      return reply.code(400).send({ error: `unknown categories: ${unknown.join(', ')}` });
    }

    const filter: ClearanceFilter = {
      date: q['date'],
      locationIds: parseList(q['stores']),
      categorySlugs: slugs,
      groups: parseGroups(q['groups']),
      q: q['q'],
      minDiscountPct: parseNumber(q['minDiscount']),
      maxCents: parseNumber(q['maxPrice']) == null ? undefined : Math.round(parseNumber(q['maxPrice'])! * 100),
      maxDistanceMiles: parseNumber(q['maxDistance']),
      newOnly: q['new'] === '1' || q['new'] === 'true',
      sort: (['discount', 'price', 'distance', 'name'] as const).find((s) => s === q['sort']),
      limit: parseNumber(q['limit']),
      offset: parseNumber(q['offset']),
    };
    return repo.query(filter);
  });

  app.get('/api/clearance/status', async () => ({
    lastSweep: repo.lastSweep(),
    sweeping: sweep.isRunning,
    // A full sweep runs for the better part of an hour, so "is it running" is
    // not enough to go on — where it has got to is the useful answer.
    progress: sweep.currentProgress,
    latestDate: repo.latestSweepDate(),
    enabledStores: repo.listStores(true).length,
  }));

  /**
   * Starts a sweep of the stores whose racks are stalest — not all of them; see
   * the rotation note in `clearance-sweep.ts`. `stores` overrides the selection,
   * `maxStores` its size.
   *
   * Returns as soon as the run is under way, because even four stores is far
   * longer than an HTTP client will hold a connection open; the caller polls
   * `/api/clearance/status`. `wait: true` blocks for the result instead, which
   * is what the tests and a single-store run want.
   */
  app.post('/api/clearance/sweep', async (req, reply) => {
    if (sweep.isRunning) return reply.code(409).send({ error: 'a sweep is already running' });
    const body = (req.body ?? {}) as { stores?: string; wait?: boolean; maxStores?: number };
    const locationIds = body.stores ? parseList(body.stores) : undefined;
    const maxStores = typeof body.maxStores === 'number' ? Math.max(1, Math.round(body.maxStores)) : undefined;

    if (body.wait) {
      try {
        return await sweep.runOnce({ locationIds, maxStores });
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    }

    // Failures land in `sweep_run` and in the run's own error list, which
    // `/status` reports; nothing is lost by not awaiting here.
    void sweep.runOnce({ locationIds, maxStores }).catch(() => undefined);
    return reply.code(202).send({ started: true, progress: sweep.currentProgress });
  });

  app.get('/api/clearance/monitor', async () => repo.getMonitor());

  app.put('/api/clearance/monitor', async (req, reply) => {
    const body = (req.body ?? {}) as { minDiscount?: number; groups?: string; enabled?: boolean };
    if (body.minDiscount !== undefined && (typeof body.minDiscount !== 'number' || body.minDiscount < 0 || body.minDiscount > 99)) {
      return reply.code(400).send({ error: 'minDiscount must be between 0 and 99' });
    }
    if (body.groups !== undefined) {
      const unknown = parseList(body.groups).filter((g) => !isCategoryGroup(g));
      if (unknown.length > 0) return reply.code(400).send({ error: `unknown groups: ${unknown.join(', ')}` });
    }
    return repo.setMonitor({
      minDiscount: body.minDiscount,
      groups: body.groups === undefined ? undefined : parseGroups(body.groups),
      enabled: body.enabled,
    });
  });

  /**
   * Everything currently qualifying under the monitor, across every store, one
   * ranked list. The same rule the nightly run alerts on, so what is on screen
   * and what lands in the alert feed can never disagree.
   */
  app.get('/api/clearance/deals', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const monitor = repo.getMonitor();
    const result = repo.query({
      date: q['date'],
      minDiscountPct: monitor.minDiscount,
      groups: monitor.groups,
      locationIds: parseList(q['stores']),
      maxDistanceMiles: parseNumber(q['maxDistance']),
      newOnly: q['new'] === '1' || q['new'] === 'true',
      sort: (['discount', 'price', 'distance', 'name'] as const).find((s) => s === q['sort']) ?? 'discount',
      limit: parseNumber(q['limit']),
      offset: parseNumber(q['offset']),
    });
    return { monitor, ...result };
  });

  app.get('/api/clearance/watches', async () => ({ watches: repo.listWatches() }));

  app.post('/api/clearance/watches', async (req, reply) => {
    const body = (req.body ?? {}) as { term?: string; maxPrice?: number; minDiscount?: number };
    const term = (body.term ?? '').trim();
    if (term === '') return reply.code(400).send({ error: 'term is required' });
    return repo.addWatch(
      term,
      typeof body.maxPrice === 'number' ? Math.round(body.maxPrice * 100) : null,
      typeof body.minDiscount === 'number' ? body.minDiscount : null,
    );
  });

  app.delete('/api/clearance/watches/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!repo.removeWatch(Number(id))) return reply.code(404).send({ error: 'watch not found' });
    return { removed: Number(id) };
  });

  app.get('/api/clearance/alerts', async (req) => {
    const q = req.query as { unread?: string; limit?: string };
    return {
      alerts: repo.listAlerts({
        unacknowledgedOnly: q.unread === '1' || q.unread === 'true',
        limit: parseNumber(q.limit),
      }),
    };
  });

  app.post('/api/clearance/alerts/:id/ack', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!repo.acknowledgeAlert(Number(id))) return reply.code(404).send({ error: 'alert not found' });
    return { acknowledged: Number(id) };
  });

  app.post('/api/clearance/alerts/ack-all', async () => ({ acknowledged: repo.acknowledgeAllAlerts() }));
}
