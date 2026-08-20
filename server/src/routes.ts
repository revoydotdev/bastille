import type { FastifyInstance } from 'fastify';
import { adapterFor, STORE_IDS, isStoreId } from './adapters/index.js';
import type { Repo } from './repo.js';
import type { Poller } from './jobs/poller.js';
import type { Offer, StoreId } from './price/model.js';
import { describePromo } from './price/promo.js';
import { discountPercent } from './price/model.js';
import type { SnapshotJob } from './jobs/snapshot.js';
import type { DealFilter, DealRow } from './repo.js';
import type { PromoKind } from './price/model.js';
import { normalizeZip, resolveZip, type ZipAnchor } from './geo.js';

interface SearchResultRow {
  storeId: StoreId;
  storeLabel: string;
  offer: Offer;
  promoLabel: string | null;
  discountPct: number | null;
  watchedGroupIds: number[];
}

const ALL_PROMO_KINDS: PromoKind[] = ['none','sale','bogo','bxgy','multibuy','percent_off','amount_off','loyalty','coupon','unknown'];

function parsePromoKinds(raw: unknown): PromoKind[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  return raw.split(',').map((s) => s.trim()).filter((k): k is PromoKind => (ALL_PROMO_KINDS as string[]).includes(k));
}

/** Applies deal filters to an in-memory result set (shared by search + deals live fallback). */
function passesFilter(
  discount: number | null,
  promoKind: PromoKind,
  f: { minDiscountPct?: number; promoKinds?: PromoKind[]; onSaleOnly?: boolean },
): boolean {
  if (f.onSaleOnly && promoKind === 'none') return false;
  if (f.minDiscountPct && f.minDiscountPct > 0 && (discount === null || discount < f.minDiscountPct)) return false;
  if (f.promoKinds && f.promoKinds.length > 0 && !f.promoKinds.includes(promoKind)) return false;
  return true;
}

function parseStores(raw: unknown): StoreId[] {
  if (typeof raw !== 'string' || raw.trim() === '') return STORE_IDS;
  const wanted = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const valid = wanted.filter(isStoreId);
  return valid.length > 0 ? valid : STORE_IDS;
}

export function registerRoutes(app: FastifyInstance, repo: Repo, poller: Poller, snapshotJob?: SnapshotJob): void {
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
  /**
   * An SSE response never ends on its own, so `app.close()` would wait for it
   * forever and the process would ignore SIGTERM. Every open stream is tracked
   * and torn down when the server closes.
   */
  const openStreams = new Set<{ end: () => void }>();
  app.addHook('onClose', async () => {
    for (const stream of openStreams) stream.end();
    openStreams.clear();
    sseClients.clear();
  });
  poller.onPoll(() => {
    const unread = repo.listAlerts({ unacknowledgedOnly: true, limit: 50 });
    const payload = JSON.stringify({ type: 'alerts', alerts: unread });
    for (const send of sseClients) send(payload);
  });

  app.get('/api/stores', async (req) => {
    const q = req.query as { postalCode?: string; store?: string };
    const ids = parseStores(q.store);
    const zip = normalizeZip(q.postalCode ?? '');

    // Resolve the ZIP once against every chain's store data, so a ZIP one
    // chain has never heard of still ranks correctly when the other has
    // stores nearby.
    let near = null;
    let zipPrecision: 'exact' | 'approximate' | null = null;
    if (zip) {
      const anchorSets = await Promise.allSettled(ids.map((id) => adapterFor(id).zipAnchors()));
      const anchors: ZipAnchor[] = anchorSets.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
      const match = resolveZip(zip, anchors);
      if (match) {
        near = match.point;
        zipPrecision = match.precision;
      }
    }

    const settled = await Promise.allSettled(
      ids.map(async (id) => ({ id, locations: await adapterFor(id).findLocations(q.postalCode ?? '', near) })),
    );

    const stores = settled.map((outcome, i) => {
      const id = ids[i]!;
      const adapter = adapterFor(id);
      return {
        id,
        label: adapter.label,
        defaultLocationId: adapter.defaultLocationId,
        pricesVaryByLocation: adapter.pricesVaryByLocation,
        locations: outcome.status === 'fulfilled' ? outcome.value.locations : [],
        error: outcome.status === 'rejected' ? ((outcome.reason as Error)?.message ?? 'store lookup failed') : null,
      };
    });

    return { zip, zipResolved: near !== null, zipPrecision, stores };
  });

  app.get('/api/search', async (req, reply) => {
    const q = req.query as { q?: string; stores?: string; limit?: string; foodlionLocation?: string; wegmansLocation?: string };
    const query = (q.q ?? '').trim();
    if (!query) return reply.code(400).send({ error: 'q is required' });

    const stores = parseStores(q.stores);
    const limit = Math.min(Math.max(Number(q.limit ?? 20) || 20, 1), 50);
    const filter = {
      minDiscountPct: Number((q as Record<string, string>).minDiscount ?? 0) || 0,
      promoKinds: parsePromoKinds((q as Record<string, string>).promoKinds),
      onSaleOnly: (q as Record<string, string>).onSale === '1' || (q as Record<string, string>).onSale === 'true',
    };
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
        const discount = discountPercent(offer.price);
        if (!passesFilter(discount, offer.price.promoKind, filter)) continue;
        results.push({
          storeId: id,
          storeLabel: adapterFor(id).label,
          offer,
          promoLabel: describePromo(offer.price.promoKind, offer.price.promoDetail, offer.price.promoText),
          discountPct: discount,
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
    const selected = body.locationId ?? adapter.defaultLocationId;
    const offer = await adapter.fetchOffer(body.storeProductId, selected);
    if (!offer) return reply.code(404).send({ error: 'product not found at that store' });

    // Record against the scope the price actually belongs to. For a chain with
    // one national price that is a single scope, so switching stores does not
    // split the history or read as a price change.
    const locationId = adapter.pricingLocationId(selected);

    const product = repo.upsertProduct(offer);
    // Seed the history so the next poll has something to diff against — but
    // only once, so re-adding an item does not stack duplicate readings taken
    // at the same instant.
    if (!repo.latestPrice(product.id, locationId)) {
      repo.insertPrice(product.id, locationId, offer.price);
    }

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


  /**
   * Deals feed: everything at or above a discount threshold, or of a chosen
   * promo kind (e.g. only BOGO), across the stores. Reads the latest daily
   * snapshot when one exists; otherwise falls back to a live catalogue scan so
   * the view works before the first snapshot has run.
   */
  app.get('/api/deals', async (req) => {
    const q = req.query as Record<string, string>;
    const filter: DealFilter = {
      minDiscountPct: Number(q.minDiscount ?? 0) || 0,
      promoKinds: parsePromoKinds(q.promoKinds),
      onSaleOnly: q.onSale === '1' || q.onSale === 'true' || (Number(q.minDiscount ?? 0) || 0) > 0,
      stores: parseStores(q.stores),
      sort: q.sort === 'price' || q.sort === 'name' ? q.sort : 'discount',
      limit: Math.min(Math.max(Number(q.limit ?? 60) || 60, 1), 500),
      offset: Math.max(Number(q.offset ?? 0) || 0, 0),
      date: q.date,
    };

    const snap = repo.queryDeals(filter);
    if (snap.date) {
      return { source: 'snapshot', date: snap.date, total: snap.total, rows: snap.rows };
    }

    // No snapshot yet — scan the live catalogue at the configured locations.
    const locations: Partial<Record<StoreId, string | undefined>> = {
      foodlion: q.foodlionLocation,
      wegmans: q.wegmansLocation,
    };
    const budget = Math.min(Number(q.liveBudget ?? 2000) || 2000, 4000);
    const settled = await Promise.allSettled(
      (filter.stores ?? []).map(async (id) => ({
        id,
        offers: await adapterFor(id).enumerate({ locationId: locations[id], maxProducts: budget }),
      })),
    );

    const rows: DealRow[] = [];
    for (const outcome of settled) {
      if (outcome.status !== 'fulfilled') continue;
      const { id, offers } = outcome.value;
      for (const offer of offers) {
        const discount = discountPercent(offer.price);
        if (!passesFilter(discount, offer.price.promoKind, filter)) continue;
        rows.push({
          storeId: id,
          storeProductId: offer.product.storeProductId,
          name: offer.product.name,
          brand: offer.product.brand,
          size: offer.product.size,
          category: offer.product.category,
          imageUrl: offer.product.imageUrl,
          productUrl: offer.product.productUrl,
          regularCents: offer.price.regularCents,
          currentCents: offer.price.currentCents,
          effectiveUnitCents: offer.price.effectiveUnitCents,
          discountPct: discount,
          promoKind: offer.price.promoKind,
          promoText: offer.price.promoText,
          unitPriceText: offer.price.unitPriceText,
          inStock: offer.price.inStock,
        });
      }
    }
    rows.sort((a, b) => {
      if (filter.sort === 'price') return (a.effectiveUnitCents ?? Infinity) - (b.effectiveUnitCents ?? Infinity);
      if (filter.sort === 'name') return a.name.localeCompare(b.name);
      return (b.discountPct ?? -1) - (a.discountPct ?? -1);
    });
    const total = rows.length;
    return { source: 'live', date: null, total, rows: rows.slice(filter.offset, (filter.offset ?? 0) + (filter.limit ?? 60)) };
  });

  app.get('/api/snapshot/status', async () => ({
    lastRun: repo.lastSnapshotRun(),
    latestDate: repo.latestSnapshotDate(),
    dates: repo.snapshotDates(),
    running: snapshotJob?.isRunning ?? false,
  }));

  app.post('/api/snapshot/run', async (_req, reply) => {
    if (!snapshotJob) return reply.code(503).send({ error: 'snapshot job not configured' });
    const result = await snapshotJob.runOnce();
    return result;
  });

  app.get('/api/status', async () => ({
    lastPoll: repo.lastPollRun(),
    polling: poller.isRunning,
    lastSnapshot: repo.lastSnapshotRun(),
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

    const close = () => {
      clearInterval(keepAlive);
      sseClients.delete(send);
      openStreams.delete(stream);
    };
    const stream = {
      end: () => {
        close();
        reply.raw.end();
      },
    };
    openStreams.add(stream);
    req.raw.on('close', close);
  });
}
