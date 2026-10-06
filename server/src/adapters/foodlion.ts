/**
 * Food Lion adapter.
 *
 * Reads the public server-rendered catalog at foodlion.com/groceries/. Those
 * pages embed the upstream Peapod product objects verbatim in the Astro
 * hydration payload, which carries price, regular price, unit price, sale /
 * BOGO / buy-more-save-more flags and coupon detail — see docs/BACKEND-MAP.md.
 *
 * There is no search endpoint on this surface (the site's search box navigates
 * to a bot-protected SPA we deliberately do not touch), so search is served
 * from a catalog index built out of the same category pages.
 */
import { fetchText, HttpError } from './http.js';
import { loadStores, zipAnchors } from './foodlion-stores.js';
import { milesBetween, normalizeZip, resolveZip, type Point, type ZipAnchor } from '../geo.js';
import type { OfferHint, SearchOptions, StoreAdapter, StoreLocation } from './types.js';
import type { Offer, PriceSnapshot, PromoDetail, PromoKind } from '../price/model.js';
import { centsFromDollars } from '../price/model.js';
import { effectiveUnitCents } from '../price/promo.js';

const SITE = 'https://foodlion.com';

/**
 * Aisles crawled to build the search index. The full tree is ~2,900 nodes;
 * these 20 top-level aisles cover the whole store and are what the site's own
 * navigation exposes.
 */
const TOP_AISLES = [
  '2098-produce', '1563-meat', '1633-seafood', '921-deli-prepared-food',
  '805-dairy-eggs', '365-beverages', '85-bread-bakery', '995-frozen',
  '1066-rice-pasta-beans', '166-baking-cooking', '530-breakfast',
  '569-condiments-sauces', '2543-snacks', '2708-soups-canned-goods',
  '7099-candy-chocolate', '1201-health-beauty', '1370-baby',
  '1448-laundry-paper-cleaning', '2057-pets', '1675-home-office',
];

interface FlFlags {
  sale?: boolean;
  bogo?: boolean;
  lowPriceEveryday?: boolean;
  outOfStock?: boolean;
  longTermOutOfStock?: boolean;
  active?: boolean;
}
interface FlCoupon {
  title?: string;
  description?: string;
  clippingRequired?: boolean;
  maxDiscount?: number;
  multiQty?: boolean;
  endDate?: string;
}
interface FlBmsmTier {
  quantity?: number;
  price?: number;
  savings?: number;
}
interface FlProduct {
  prodId: string;
  name?: string;
  brand?: string | null;
  size?: string | null;
  price?: number;
  regularPrice?: number;
  unitPrice?: number;
  unitMeasure?: string | null;
  flags?: FlFlags;
  bmsm?: boolean;
  bmsmTiers?: FlBmsmTier[];
  coupon?: FlCoupon | null;
  advertiseOnSale?: boolean;
  image?: { large?: string; medium?: string; small?: string } | null;
  rootCatName?: string | null;
  upc?: string | null;
}

/**
 * Astro serializes island props as [typeTag, value] pairs. Tag 0 is a plain
 * value or object, 1 is an array; the remaining tags are Date/Map/Set/etc.,
 * none of which appear in this payload.
 */
type Wrapped = unknown;
function unwrap(value: Wrapped): unknown {
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'number') {
    const [tag, inner] = value as [number, unknown];
    if (tag === 0) {
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        return Object.fromEntries(Object.entries(inner as Record<string, unknown>).map(([k, v]) => [k, unwrap(v)]));
      }
      return inner;
    }
    if (tag === 1) return (inner as unknown[]).map(unwrap);
    return inner;
  }
  return value;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function extractProducts(html: string): FlProduct[] {
  const match = /<astro-island[^>]*props="([^"]*)"/.exec(html);
  if (!match?.[1]) return [];
  let props: Record<string, unknown>;
  try {
    props = JSON.parse(decodeHtmlEntities(match[1])) as Record<string, unknown>;
  } catch {
    return [];
  }
  const list = unwrap(props['products']);
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => {
      const row = entry as { product?: unknown };
      const p = row?.product;
      return p && typeof p === 'object' && 'prodId' in p ? (p as FlProduct) : null;
    })
    .filter((p): p is FlProduct => p !== null);
}

/** True when `url` is a Food Lion product page for exactly this product id. */
export function isProductPageFor(url: string, prodId: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname.endsWith('foodlion.com') && u.pathname.startsWith('/groceries/product/') && u.pathname.split('/').filter(Boolean).at(-1) === prodId;
  } catch {
    return false;
  }
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Food Lion carries several promotion mechanics that are not a single number:
 * a BOGO flag, buy-more-save-more tiers, and clipped coupons. Each is mapped
 * to a structured promotion, and only then to an effective unit price.
 */
export function toPrice(p: FlProduct): PriceSnapshot {
  const regularCents = centsFromDollars(p.regularPrice ?? null);
  const currentCents = centsFromDollars(p.price ?? null);
  const flags = p.flags ?? {};

  let promoKind: PromoKind = 'none';
  let promoText: string | null = null;
  let promoDetail: PromoDetail | null = null;

  if (flags.bogo) {
    promoKind = 'bogo';
    promoDetail = { buyQty: 1, getQty: 1 };
    promoText = 'Buy 1 get 1 free';
  } else if (p.bmsm && (p.bmsmTiers?.length ?? 0) > 0) {
    // Buy-more-save-more: take the deepest tier, which is what the shelf tag
    // advertises. Tier price is the per-unit price at that quantity.
    const best = [...p.bmsmTiers!].sort((a, b) => (b.quantity ?? 0) - (a.quantity ?? 0))[0]!;
    const qty = best.quantity ?? 1;
    const tierCents = centsFromDollars(best.price ?? null);
    promoKind = 'multibuy';
    promoDetail = { buyQty: qty, bundleCents: tierCents === null ? undefined : tierCents * qty };
    promoText = tierCents === null ? `Buy ${qty} and save` : `${qty} for $${((tierCents * qty) / 100).toFixed(2)}`;
  } else if (p.coupon) {
    promoKind = 'coupon';
    promoDetail = {
      requiresLoyalty: p.coupon.clippingRequired !== false,
      ...(p.coupon.maxDiscount != null ? { amountOffCents: Math.round(p.coupon.maxDiscount * 100) } : {}),
    };
    promoText = p.coupon.title ?? p.coupon.description ?? 'Coupon available';
  } else if (flags.sale || p.advertiseOnSale) {
    promoKind = 'sale';
    promoText = 'On sale';
    promoDetail = {};
  } else if (flags.lowPriceEveryday) {
    promoKind = 'sale';
    promoText = 'Low price every day';
    promoDetail = {};
  }

  // The coupon's headline discount often applies to an order, not the item
  // ("$5 off delivery"), so it must not be subtracted from the shelf price.
  const base = currentCents;
  const kindForMath: PromoKind = promoKind === 'coupon' ? 'unknown' : promoKind;

  return {
    regularCents,
    currentCents,
    effectiveUnitCents: effectiveUnitCents(base, kindForMath, promoDetail),
    promoKind,
    promoText,
    promoDetail,
    unitPriceText:
      p.unitPrice != null && p.unitMeasure ? `$${p.unitPrice.toFixed(2)}/${p.unitMeasure}` : null,
    inStock: flags.outOfStock || flags.longTermOutOfStock ? false : flags.active === false ? false : true,
    capturedAt: new Date().toISOString(),
  };
}

export function toOffer(p: FlProduct): Offer {
  const name = p.name ?? p.prodId;
  return {
    product: {
      storeId: 'foodlion',
      storeProductId: p.prodId,
      name,
      brand: p.brand ?? null,
      size: p.size ?? null,
      imageUrl: p.image?.large ?? p.image?.medium ?? p.image?.small ?? null,
      productUrl: `${SITE}/groceries/product/${slugify(`${name} ${p.size ?? ''}`)}/${p.prodId}`,
      category: p.rootCatName ?? null,
    },
    price: toPrice(p),
  };
}

interface CacheEntry {
  products: FlProduct[];
  /** Sub-aisle slugs linked from this page; see `extractAisleLinks`. */
  children: string[];
  fetchedAt: number;
}

/**
 * Aisle pages link their own sub-aisles. A top-level page carries only part of
 * its subtree — `2098-produce` lists 520 products but omits scallions and
 * shallots, which appear on `2334-fresh-vegetables` — so the snapshot descends
 * one level. The full tree is ~2,900 nodes and is deliberately not walked.
 */
const AISLE_LINK = /browse-aisles\/([0-9]+-[a-z0-9-]+)/g;

export function extractAisleLinks(html: string): string[] {
  return [...new Set(Array.from(html.matchAll(AISLE_LINK), (m) => m[1]!))];
}

/**
 * Must outlast the poll interval: at the old 30 minutes the cache expired
 * exactly as each poll began, so every poll paid for a cold walk. Twice the
 * interval (and never under two hours) lets consecutive polls share reads.
 */
const POLL_INTERVAL_MS = Number(process.env.BASTILLE_POLL_INTERVAL_MS ?? 30 * 60 * 1000);
const AISLE_TTL_MS = Number(process.env.FOODLION_AISLE_TTL_MS ?? Math.max(2 * 60 * 60 * 1000, 2 * POLL_INTERVAL_MS));
/**
 * The deep walk costs ~250 requests, so it is rebuilt far less often than a
 * single aisle is refreshed.
 */
const CATALOGUE_TTL_MS = Number(process.env.FOODLION_CATALOGUE_TTL_MS ?? 6 * 60 * 60 * 1000);

export class FoodLionAdapter implements StoreAdapter {
  readonly id = 'foodlion' as const;
  readonly label = 'Food Lion';
  /** The /groceries/ surface serves one national price set. */
  readonly defaultLocationId = 'national';
  readonly pricesVaryByLocation = false;

  /**
   * Whichever store the shopper picks, the price came from the national
   * catalogue — so every reading is recorded under one scope. Keying history
   * by store would split one series into many identical ones and make a store
   * change look like a price event.
   */
  pricingLocationId(): string {
    return 'national';
  }

  /** The read itself is injectable so refresh logic can be tested without egress. */
  constructor(private fetch: (url: string) => Promise<string> = (url) => fetchText(url)) {}

  private cache = new Map<string, CacheEntry>();
  /** In-flight fetches, so a burst of searches makes one request per aisle. */
  private inflight = new Map<string, Promise<CacheEntry>>();

  private async aisle(slug: string): Promise<FlProduct[]> {
    return (await this.load(slug)).products;
  }

  /** Fetches one aisle page, caching both its products and its sub-aisles. */
  private async load(slug: string): Promise<CacheEntry> {
    const hit = this.cache.get(slug);
    if (hit && Date.now() - hit.fetchedAt < AISLE_TTL_MS) return hit;

    const pending = this.inflight.get(slug);
    if (pending) return pending;

    const job = (async () => {
      try {
        const html = await this.fetch(`${SITE}/groceries/browse-aisles/${slug}`);
        const entry: CacheEntry = {
          products: extractProducts(html),
          children: extractAisleLinks(html),
          fetchedAt: Date.now(),
        };
        this.cache.set(slug, entry);
        return entry;
      } catch {
        // Serve a stale aisle rather than dropping the whole search.
        return hit ?? { products: [], children: [], fetchedAt: 0 };
      } finally {
        this.inflight.delete(slug);
      }
    })();
    this.inflight.set(slug, job);
    return job;
  }

  private catalogue: { products: FlProduct[]; index: Map<string, FlProduct>; builtAt: number } | null = null;
  private catalogueBuild: Promise<FlProduct[]> | null = null;
  /** Deep walks started, and when the last one did; both feed `/api/metrics`. */
  private catalogueBuilds = 0;
  private lastWalkAt = 0;
  /** Set by `beginRun`; a miss may trigger one walk per run, never more. */
  private runStartedAt = 0;

  /**
   * Every product across the top-level aisles and the sub-aisles they link,
   * deduplicated. One build runs at a time; concurrent callers share it.
   */
  private buildCatalogue(): Promise<FlProduct[]> {
    if (this.catalogueBuild) return this.catalogueBuild;
    this.catalogueBuilds++;
    this.lastWalkAt = Date.now();
    const job = (async () => {
      const roots = await Promise.all(TOP_AISLES.map((slug) => this.load(slug)));
      const slugs = new Set<string>(TOP_AISLES);
      for (const entry of roots) for (const child of entry.children) slugs.add(child);

      const byId = new Map<string, FlProduct>();
      for (const slug of slugs) {
        for (const p of (await this.load(slug)).products) byId.set(p.prodId, p);
      }
      const products = [...byId.values()];
      this.catalogue = { products, index: byId, builtAt: Date.now() };
      return products;
    })();
    this.catalogueBuild = job.finally(() => {
      this.catalogueBuild = null;
    }) as Promise<FlProduct[]>;
    return this.catalogueBuild;
  }

  /**
   * Starts the deep walk without waiting for it. The server calls this at
   * boot so the first search is not the one that pays for the crawl.
   */
  warm(): void {
    void this.buildCatalogue().catch(() => {
      // A failed warm is not fatal: search falls back to the top-level aisles
      // and the next call retries.
    });
  }

  /**
   * The corpus search reads. A built catalogue is served immediately and
   * refreshed behind the request once stale; until the first build lands,
   * search answers from the 20 top-level aisles rather than making the user
   * wait on ~250 pages. `load` deduplicates in-flight fetches, so the
   * fallback and the build share the same requests instead of racing.
   */
  private async searchCorpus(): Promise<FlProduct[]> {
    if (this.catalogue) {
      if (Date.now() - this.catalogue.builtAt >= CATALOGUE_TTL_MS) this.warm();
      return this.catalogue.products;
    }
    this.warm();
    const aisles = await Promise.all(TOP_AISLES.map((slug) => this.aisle(slug)));
    const byId = new Map<string, FlProduct>();
    for (const products of aisles) for (const p of products) byId.set(p.prodId, p);
    return [...byId.values()];
  }

  async search({ query, limit = 24 }: SearchOptions): Promise<Offer[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    const scored: { offer: Offer; score: number }[] = [];
    for (const p of await this.searchCorpus()) {
      const haystack = `${p.brand ?? ''} ${p.name ?? ''} ${p.size ?? ''}`.toLowerCase();
      if (!terms.every((t) => haystack.includes(t))) continue;
      // Prefer a name-start match, then a shorter name (less padding).
      const name = (p.name ?? '').toLowerCase();
      const score =
        (name.startsWith(terms[0]!) ? 100 : 0) +
        (name.includes(query.toLowerCase()) ? 50 : 0) -
        Math.min(name.length, 60) / 10;
      scored.push({ offer: toOffer(p), score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.offer);
  }

  /**
   * Starts a poll run. A refresh that cannot place a product may walk the
   * catalogue once per run; this is what re-arms that allowance.
   */
  beginRun(): void {
    this.runStartedAt = Date.now();
  }

  stats(): Record<string, number> {
    return { catalogueBuilds: this.catalogueBuilds, lastWalkAt: this.lastWalkAt };
  }

  /** The product as the search index last saw it, sub-aisles included. */
  private indexed(prodId: string): FlProduct | undefined {
    const fromCatalogue = this.catalogue?.index.get(prodId);
    if (fromCatalogue) return fromCatalogue;
    for (const entry of this.cache.values()) {
      const hit = entry.products.find((p) => p.prodId === prodId);
      if (hit) return hit;
    }
    return undefined;
  }

  /** A miss may walk the aisles at most once per run (once per TTL outside one). */
  private canWalk(): boolean {
    return this.lastWalkAt < Math.max(this.runStartedAt, Date.now() - AISLE_TTL_MS);
  }

  /**
   * Re-reads one product's price. The product page is the source of truth, and
   * the cheap path is one read: the URL stored when the product was last seen
   * (`hint`), else the URL the deep catalogue index implies. The index covers
   * sub-aisles, so an item that exists only on `2334-fresh-vegetables` is found
   * without crawling anything. Only when neither place knows the product does
   * a walk run, and then at most once per run so a discontinued item cannot
   * make every poll pay for the crawl.
   */
  async fetchOffer(storeProductId: string, _locationId?: string, hint?: OfferHint): Promise<Offer | null> {
    const tried = new Set<string>();
    const readPage = async (url: string): Promise<Offer | null> => {
      tried.add(url);
      try {
        const html = await this.fetch(url);
        const fresh = extractProducts(html).find((p) => p.prodId === storeProductId);
        return fresh ? toOffer(fresh) : null;
      } catch (err) {
        // A page that is gone is a miss; a network failure is not, and must
        // not be mistaken for one (it would trigger a walk during an outage).
        if (err instanceof HttpError && err.status < 500) return null;
        throw err;
      }
    };

    if (hint?.productUrl && isProductPageFor(hint.productUrl, storeProductId)) {
      const offer = await readPage(hint.productUrl);
      if (offer) return offer;
    }

    let known = this.indexed(storeProductId);
    if (known && !tried.has(this.productPageUrl(known))) {
      const offer = await readPage(this.productPageUrl(known));
      if (offer) return offer;
    }

    if (!this.catalogueBuild && !this.canWalk()) return null;
    await this.buildCatalogue().catch(() => undefined);
    known = this.indexed(storeProductId);
    if (!known) return null;
    if (!tried.has(this.productPageUrl(known))) {
      const offer = await readPage(this.productPageUrl(known));
      if (offer) return offer;
    }
    // The page would not confirm it, but the walk just found it listed.
    return toOffer(known);
  }

  private productPageUrl(p: FlProduct): string {
    const name = p.name ?? p.prodId;
    return `${SITE}/groceries/product/${slugify(`${name} ${p.size ?? ''}`)}/${p.prodId}`;
  }

  /**
   * Real stores, from the open Yext directory, nearest first. The price these
   * stores share is the national catalogue price — `pricesVaryByLocation` says
   * so, and the UI must not imply otherwise.
   */
  async findLocations(postalCode: string, near?: Point | null): Promise<StoreLocation[]> {
    const stores = await loadStores();
    const zip = normalizeZip(postalCode ?? '');
    const point = near ?? (zip ? resolveZip(zip, await zipAnchors())?.point ?? null : null);

    const ranked = point
      ? stores
          .map((s) => ({ store: s, miles: milesBetween(point, s.point) }))
          .sort((a, b) => a.miles - b.miles)
      : stores.slice(0, 25).map((store) => ({ store, miles: null as number | null }));

    return ranked.slice(0, 25).map(({ store, miles }) => ({
      storeId: 'foodlion' as const,
      locationId: store.id,
      name: `${store.city}, ${store.state}`,
      address: store.street,
      postalCode: store.postalCode,
      distanceMiles: miles === null ? null : Math.round(miles * 10) / 10,
    }));
  }

  zipAnchors(): Promise<ZipAnchor[]> {
    return zipAnchors();
  }

  /**
   * The daily-snapshot corpus: the same deep walk search reads, awaited to
   * completion because the snapshot wants the store, not whatever is warm.
   */
  async enumerate({ maxProducts }: { locationId?: string | null; maxProducts?: number }): Promise<Offer[]> {
    // A catalogue built inside the aisle TTL is as fresh as a rebuild would be
    // (the rebuild would reuse the same cached aisles), so the snapshot takes
    // it rather than walking again. A build it does trigger restamps
    // `builtAt`, which is what keeps search from rebuilding right behind it.
    const fresh = this.catalogue && Date.now() - this.catalogue.builtAt < AISLE_TTL_MS;
    const products = fresh ? this.catalogue!.products : await this.buildCatalogue();
    const out: Offer[] = [];
    for (const p of products) {
      out.push(toOffer(p));
      if (maxProducts && out.length >= maxProducts) break;
    }
    return out;
  }
}
