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
import { fetchText } from './http.js';
import { loadStores, zipAnchors } from './foodlion-stores.js';
import { milesBetween, normalizeZip, resolveZip, type Point, type ZipAnchor } from '../geo.js';
import type { SearchOptions, StoreAdapter, StoreLocation } from './types.js';
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
  fetchedAt: number;
}

const AISLE_TTL_MS = Number(process.env.FOODLION_AISLE_TTL_MS ?? 30 * 60 * 1000);

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

  private cache = new Map<string, CacheEntry>();
  /** In-flight fetches, so a burst of searches makes one request per aisle. */
  private inflight = new Map<string, Promise<FlProduct[]>>();

  private async aisle(slug: string): Promise<FlProduct[]> {
    const hit = this.cache.get(slug);
    if (hit && Date.now() - hit.fetchedAt < AISLE_TTL_MS) return hit.products;

    const pending = this.inflight.get(slug);
    if (pending) return pending;

    const job = (async () => {
      try {
        const html = await fetchText(`${SITE}/groceries/browse-aisles/${slug}`);
        const products = extractProducts(html);
        this.cache.set(slug, { products, fetchedAt: Date.now() });
        return products;
      } catch {
        // Serve a stale aisle rather than dropping the whole search.
        return hit?.products ?? [];
      } finally {
        this.inflight.delete(slug);
      }
    })();
    this.inflight.set(slug, job);
    return job;
  }

  async search({ query, limit = 24 }: SearchOptions): Promise<Offer[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    const aisles = await Promise.all(TOP_AISLES.map((slug) => this.aisle(slug)));
    const scored: { offer: Offer; score: number }[] = [];
    const seen = new Set<string>();

    for (const products of aisles) {
      for (const p of products) {
        if (seen.has(p.prodId)) continue;
        const haystack = `${p.brand ?? ''} ${p.name ?? ''} ${p.size ?? ''}`.toLowerCase();
        if (!terms.every((t) => haystack.includes(t))) continue;
        seen.add(p.prodId);
        // Prefer a name-start match, then a shorter name (less padding).
        const name = (p.name ?? '').toLowerCase();
        const score =
          (name.startsWith(terms[0]!) ? 100 : 0) +
          (name.includes(query.toLowerCase()) ? 50 : 0) -
          Math.min(name.length, 60) / 10;
        scored.push({ offer: toOffer(p), score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.offer);
  }

  async fetchOffer(storeProductId: string): Promise<Offer | null> {
    // Product pages are cheap and always current; the aisle cache is only a
    // search index, so a refresh never reads from it.
    for (const slug of TOP_AISLES) {
      const cached = this.cache.get(slug);
      const known = cached?.products.find((p) => p.prodId === storeProductId);
      if (known) {
        const html = await fetchText(this.productPageUrl(known));
        const fresh = extractProducts(html).find((p) => p.prodId === storeProductId);
        if (fresh) return toOffer(fresh);
      }
    }
    // Not in the cached aisles: fall back to reading the aisles until found.
    for (const slug of TOP_AISLES) {
      const products = await this.aisle(slug);
      const found = products.find((p) => p.prodId === storeProductId);
      if (found) return toOffer(found);
    }
    return null;
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
   * Every product across the top aisles — the same pages `search` already
   * loads and caches, so a daily snapshot costs at most one refresh per aisle.
   */
  async enumerate({ maxProducts }: { locationId?: string | null; maxProducts?: number }): Promise<Offer[]> {
    const aisles = await Promise.all(TOP_AISLES.map((slug) => this.aisle(slug)));
    const seen = new Set<string>();
    const out: Offer[] = [];
    for (const products of aisles) {
      for (const p of products) {
        if (seen.has(p.prodId)) continue;
        seen.add(p.prodId);
        out.push(toOffer(p));
        if (maxProducts && out.length >= maxProducts) return out;
      }
    }
    return out;
  }
}
