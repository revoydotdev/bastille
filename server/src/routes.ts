import type { FastifyInstance } from 'fastify';
import { adapterFor, STORE_IDS, isStoreId } from './adapters/index.js';
import type { Repo } from './repo.js';
import type { Poller } from './jobs/poller.js';
import type { Offer, StoreId } from './price/model.js';
import { describePromo } from './price/promo.js';

interface SearchResultRow {
  storeId: StoreId;
  storeLabel: string;
  offer: Offer;
  promoLabel: string | null;
  watchedGroupIds: number[];
}

function parseStores(raw: unknown): StoreId[] {
  if (typeof raw !== 'string' || raw.trim() === '') return STORE_IDS;
  const wanted = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const valid = wanted.filter(isStoreId);
  return valid.length > 0 ? valid : STORE_IDS;
}

export function registerRoutes(app: FastifyInstance, repo: Repo, poller: Poller): void {
  // Several endpoints take no body (refresh, ack, delete). Fastify's default
  // JSON parser rejects an empty body outright, which turns a perfectly
  // ordinary `fetch(url, {method: 'POST'})` into a 400.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const raw = (body as string).trim();
    if (raw === '') return done(null, undefined);
    try {
      done(null, JSON.parse(raw));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  /** Server-sent events: alerts pushed as soon as a poll produces them. */
  const sseClients = new Set<(payload: string) => void>();
  poller.onPoll(() => {
    const unread = repo.listAlerts({ unacknowledgedOnly: true, limit: 50 });
    const payload = JSON.stringify({ type: 'alerts', alerts: unread });
    for (const send of sseClients) send(payload);
  });

  app.get('/api/stores', async (req) => {
    const q = req.query as { postalCode?: string; store?: string };
    const ids = parseStores(q.store);
    const out = [];
    for (const id of ids) {
      const adapter = adapterFor(id);
      let locations: unknown[] = [];
      try {
        locations = await adapter.findLocations(q.postalCode ?? '');
      } catch {
        locations = [];
      }
      out.push({
        id,
        label: adapter.label,
        defaultLocationId: adapter.defaultLocationId,
        locations,
      });
    }
    return { stores: out };
  });

  app.get('/api/search', async (req, reply) => {
    const q = req.query as { q?: string; stores?: string; limit?: string; foodlionLocation?: string; wegmansLocation?: string };
    const query = (q.q ?? '').trim();
    if (!query) return reply.code(400).send({ error: 'q is required' });

    const stores = parseStores(q.stores);
    const limit = Math.min(Math.max(Number(q.limit ?? 20) || 20, 1), 50);
    const locations: Partial<Record<StoreId, string | undefined>> = {
      foodlion: q.foodlionLocation,
      wegmans: q.wegmansLocation,
    };

    // Group membership lets the UI show what is already on the watchlist.
    const membership = new Map<string, number[]>();
    for (const group of repo.listGroups()) {
      for (const item of group.items) {
        const key = `${item.product.storeId}:${item.product.storeProductId}`;
        membership.set(key, [...(membership.get(key) ?? []), group.id]);
      }
    }

    const settled = await Promise.allSettled(
      stores.map(async (id) => {
        const offers = await adapterFor(id).search({ query, locationId: locations[id], limit });
        return { id, offers };
      }),
    );

    const results: SearchResultRow[] = [];
    const errors: { storeId: StoreId; message: string }[] = [];
    settled.forEach((outcome, i) => {
      const id = stores[i]!;
      if (outcome.status === 'rejected') {
        errors.push({ storeId: id, message: (outcome.reason as Error)?.message ?? 'search failed' });
        return;
      }
      for (const offer of outcome.value.offers) {
        results.push({
          storeId: id,
          storeLabel: adapterFor(id).label,
          offer,
          promoLabel: describePromo(offer.price.promoKind, offer.price.promoDetail, offer.price.promoText),
          watchedGroupIds: membership.get(`${id}:${offer.product.storeProductId}`) ?? [],
        });
      }
    });

    // Cheapest comparable offer first; anything without a number sorts last
    // rather than being dropped.
    results.sort((a, b) => {
      const av = a.offer.price.effectiveUnitCents;
      const bv = b.offer.price.effectiveUnitCents;
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return av - bv;
    });

    return { query, stores, results, errors };
  });

  app.get('/api/watchlist', async () => ({ groups: repo.listGroups() }));

  /**
   * Adds an offer to the watchlist. A new group is created unless the caller
   * names an existing one, which is how a Food Lion item and a Wegmans item
   * end up compared side by side.
   */
  app.post('/api/watchlist', async (req, reply) => {
    const body = req.body as {
      storeId?: string;
      storeProductId?: string;
      locationId?: string | null;
      groupId?: number;
      label?: string;
      targetCents?: number | null;
      notifyPromos?: boolean;
    };
    if (!body.storeId || !isStoreId(body.storeId) || !body.storeProductId) {
      return reply.code(400).send({ error: 'storeId and storeProductId are required' });
    }

    const adapter = adapterFor(body.storeId);
    const locationId = body.locationId ?? adapter.defaultLocationId;
    const offer = await adapter.fetchOffer(body.storeProductId, locationId);
    if (!offer) return reply.code(404).send({ error: 'product not found at that store' });

    const product = repo.upsertProduct(offer);
    // Seed the history so the next poll has something to diff against.
    repo.insertPrice(product.id, locationId, offer.price);

    const group =
      body.groupId != null
        ? repo.getGroup(body.groupId)
        : repo.createGroup(body.label ?? offer.product.name, body.targetCents ?? null, body.notifyPromos ?? true);
    if (!group) return reply.code(404).send({ error: 'watch group not found' });

    repo.addToGroup(group.id, product.id, locationId);
    return reply.code(201).send({ group: repo.groupView(group.id) });
  });

  app.patch('/api/watchlist/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = req.body as { label?: string; targetCents?: number | null; notifyPromos?: boolean };
    const updated = repo.updateGroup(id, body);
    if (!updated) return reply.code(404).send({ error: 'watch group not found' });
    return { group: repo.groupView(id) };
  });

  app.delete('/api/watchlist/:id', async (req) => {
    repo.deleteGroup(Number((req.params as { id: string }).id));
    return { ok: true };
  });

  app.delete('/api/watchlist/item/:itemId', async (req) => {
    repo.removeWatchItem(Number((req.params as { itemId: string }).itemId));
    return { ok: true };
  });

  app.get('/api/prices/:productId', async (req) => {
    const productId = Number((req.params as { productId: string }).productId);
    const q = req.query as { locationId?: string };
    return {
      productId,
      history: repo.priceHistory(productId, q.locationId ?? null),
    };
  });

  app.get('/api/alerts', async (req) => {
    const q = req.query as { unread?: string; limit?: string };
    return {
      alerts: repo.listAlerts({
        unacknowledgedOnly: q.unread === '1' || q.unread === 'true',
        limit: Number(q.limit ?? 100) || 100,
      }),
    };
  });

  app.post('/api/alerts/:id/ack', async (req) => {
    repo.acknowledgeAlert(Number((req.params as { id: string }).id));
    return { ok: true };
  });

  app.post('/api/alerts/ack-all', async () => {
    repo.acknowledgeAll();
    return { ok: true };
  });

  app.post('/api/refresh', async () => {
    const result = await poller.pollOnce();
    return {
      itemsPolled: result.itemsPolled,
      changes: result.changes,
      errors: result.errors,
      groups: repo.listGroups(),
      alerts: repo.listAlerts({ unacknowledgedOnly: true, limit: 50 }),
    };
  });

  app.get('/api/status', async () => ({
    lastPoll: repo.lastPollRun(),
    polling: poller.isRunning,
    stores: STORE_IDS.map((id) => ({ id, label: adapterFor(id).label })),
  }));

  app.get('/api/alerts/stream', (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write(': connected\n\n');
    const send = (payload: string) => reply.raw.write(`data: ${payload}\n\n`);
    sseClients.add(send);
    const keepAlive = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(send);
    });
  });
}
