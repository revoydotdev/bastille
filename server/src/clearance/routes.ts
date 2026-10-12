/**
 * HTTP surface for the Walmart clearance sweep.
 *
 * Kept apart from the grocery routes because the shape is different: there is
 * no watchlist of products here, only a set of stores to sweep, a feed of what
 * each one has marked down, and saved terms to be told about.
 */
import type { FastifyInstance } from 'fastify';
import { CLEARANCE_CATEGORIES, CATEGORY_GROUPS, categoryBySlug, isCategoryGroup, type CategoryGroup } from './categories.js';
import { clearanceShelf, nearbyStores, type WalmartStore } from './walmart-api.js';
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

/** The shelf read used to discover which store this connection is served. */
export type ShelfProbe = (opts: { categoryId: string; pageSize?: number }) => Promise<{ storeName: string | null }>;

export function registerClearanceRoutes(
  app: FastifyInstance,
  repo: ClearanceRepo,
  sweep: ClearanceSweepJob,
  findStores: StoreFinder = nearbyStores,
  readShelf: ShelfProbe = (opts) => clearanceShelf(opts),
): void {
  app.get('/api/clearance/categories', async () => ({
    categories: CLEARANCE_CATEGORIES,
    groups: CATEGORY_GROUPS,
  }));

  app.get('/api/clearance/store', async () => ({
    store: repo.localStore(),
    lastSweep: repo.lastSweep(),
    sweeping: sweep.isRunning,
    progress: sweep.currentProgress,
  }));

  /**
   * Asks Walmart which store this connection reads, and records it.
   *
   * There is nothing to choose: Walmart resolves the store from the requesting
   * address. So this reads one shelf, takes the store Walmart names in the
   * reply as the answer, and enriches it with an address from the store finder
   * when a `postalCode` is given and the names line up.
   */
  app.post('/api/clearance/store/resolve', async (req, reply) => {
    const body = (req.body ?? {}) as { postalCode?: string };
    const zip = normalizeZip(body.postalCode ?? '');
    try {
      const probe = await readShelf({ categoryId: CLEARANCE_CATEGORIES[0]!.id, pageSize: 1 });
      if (!probe.storeName) {
        return reply.code(502).send({ error: 'Walmart did not name a store for this connection' });
      }

      let detail: WalmartStore | null = null;
      if (zip) {
        const nearby = await findStores(zip, 50);
        detail = nearby.find((s) => s.name.trim().toLowerCase() === probe.storeName!.trim().toLowerCase()) ?? null;
      }
      return { store: repo.setLocalStore(probe.storeName, detail), matchedDirectory: detail !== null };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /**
   * The whole Walmart picture at once — the local store, the directory on
   * record, the rack by aisle, and what a read would cost right now.
   *
   * Answers from SQLite alone. Asking Walmart for state already written down
   * spends a read to learn nothing, which is how a nightly sweep's careful
   * budget gets eaten by a dashboard polling for status.
   */
  app.get('/api/clearance/map', async () => {
    const budget = repo.hostBudget();
    const now = Date.now();
    const state = budget.state(now);
    return {
      local: repo.localStore(),
      stores: repo.listStores(),
      date: repo.latestSweepDate(),
      aisles: repo.shelfMap().aisles,
      sweeping: sweep.isRunning,
      progress: sweep.currentProgress,
      lastSweep: repo.lastSweep(),
      budget: {
        readsInWindow: state.readsInWindow,
        windowStartedAt: new Date(state.windowStartedAt).toISOString(),
        notBefore: state.notBefore > 0 ? new Date(state.notBefore).toISOString() : null,
        waitMs: budget.waitMs(now),
        lastStatus: state.lastStatus,
      },
    };
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
      categorySlugs: slugs,
      groups: parseGroups(q['groups']),
      q: q['q'],
      minDiscountPct: parseNumber(q['minDiscount']),
      maxCents: parseNumber(q['maxPrice']) == null ? undefined : Math.round(parseNumber(q['maxPrice'])! * 100),
      newOnly: q['new'] === '1' || q['new'] === 'true',
      sort: (['discount', 'price', 'name'] as const).find((s) => s === q['sort']),
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
    store: repo.localStore(),
  }));

  /**
   * Starts a sweep of the local store's three shelves. Returns as soon as it is
   * under way — paced reads take minutes, longer than a client will hold a
   * connection — and the caller polls `/api/clearance/status`. `wait: true`
   * blocks for the result instead, which is what the tests want.
   */
  app.post('/api/clearance/sweep', async (req, reply) => {
    if (sweep.isRunning) return reply.code(409).send({ error: 'a sweep is already running' });
    const body = (req.body ?? {}) as { wait?: boolean };

    if (body.wait) {
      try {
        return await sweep.runOnce();
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    }

    // Failures land in `sweep_run` and in the run's own error list, which
    // `/status` reports; nothing is lost by not awaiting here.
    void sweep.runOnce().catch(() => undefined);
    return reply.code(202).send({ started: true, progress: sweep.currentProgress });
  });

  /**
   * Re-reads the rack behind the caller's back and answers with what is on
   * record *now*, so a client can render at once and re-read when the feed
   * changes. `/sweep` instead asks only to start work.
   *
   * The read goes out only when the durable ledger allows one. A refusal's
   * cooldown and a spent window both mean "later"; spending a request to be
   * told so helps nobody.
   */
  app.post('/api/clearance/refresh', async (req, reply) => {
    const body = (req.body ?? {}) as { date?: string };
    const cached = repo.query({ date: body.date });

    if (!sweep.isRunning) {
      const budget = repo.hostBudget();
      const now = Date.now();
      const waitMs = budget.waitMs(now);
      if (waitMs > 0) {
        return reply.code(202).send({
          started: false,
          refreshing: false,
          reason: budget.state(now).notBefore > now ? 'cooldown' : 'budget',
          retryInMs: waitMs,
          ...cached,
        });
      }
      // Failures land in `sweep_run` and in the run's own error list, which
      // `/status` reports; nothing is lost by not awaiting here.
      void sweep.runOnce().catch(() => undefined);
      return reply.code(202).send({ started: true, refreshing: true, ...cached });
    }

    // Already running: this caller's refresh is the one in flight.
    return reply.code(202).send({ started: false, refreshing: true, ...cached });
  });

  app.get('/api/clearance/monitor', async () => repo.getMonitor());

  // ---- egress nodes (W-9) -----------------------------------------------

  app.get('/api/clearance/egress-nodes', async () => ({
    nodes: repo.listEgressNodes(),
  }));

  app.post('/api/clearance/egress-nodes', async (req, reply) => {
    const body = (req.body ?? {}) as {
      id?: string;
      label?: string;
      proxyUrl?: string;
      region?: string;
      enabled?: boolean;
    };
    if (!body.id || !body.label || !body.proxyUrl) {
      return reply.code(400).send({ error: 'id, label, proxyUrl are required' });
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(body.id)) {
      return reply.code(400).send({ error: 'id must be lowercase alphanumeric / dash / underscore, 1-64 chars' });
    }
    try {
      const node = repo.upsertEgressNode({
        id: body.id,
        label: body.label,
        proxyUrl: body.proxyUrl,
        region: body.region ?? null,
        enabled: body.enabled ?? true,
      });
      return { node };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.delete('/api/clearance/egress-nodes/:id', async (req, reply) => {
    const id = (req.params as { id?: string }).id;
    if (!id) return reply.code(400).send({ error: 'id is required' });
    repo.deleteEgressNode(id);
    return { deleted: id };
  });

  /**
   * Bind a store to an egress node. Pass `null` to clear. The next sweep reads
   * the store through the node's proxy URL.
   */
  app.put('/api/clearance/store/egress', async (req, reply) => {
    const body = (req.body ?? {}) as { locationId?: string; egressNodeId?: string | null };
    if (!body.locationId) {
      return reply.code(400).send({ error: 'locationId is required' });
    }
    if (body.egressNodeId !== null) {
      const node = body.egressNodeId ? repo.getEgressNode(body.egressNodeId) : null;
      if (!node) {
        return reply.code(404).send({ error: `egress node "${body.egressNodeId}" not found` });
      }
    }
    repo.setStoreEgressNode(body.locationId, body.egressNodeId ?? null);
    return { locationId: body.locationId, egressNodeId: body.egressNodeId ?? null };
  });

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
      newOnly: q['new'] === '1' || q['new'] === 'true',
      sort: (['discount', 'price', 'name'] as const).find((s) => s === q['sort']) ?? 'discount',
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
