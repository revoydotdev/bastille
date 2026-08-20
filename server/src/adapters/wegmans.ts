/**
 * Wegmans adapter.
 *
 * Search runs against the storefront's own Algolia index using the public
 * search-only credentials the site ships to every browser. Product refreshes
 * go to the first-party REST tier. Both are documented in docs/BACKEND-MAP.md.
 */
import { fetchJson } from './http.js';
import { milesBetween, normalizeZip, resolveZip, type Point, type ZipAnchor } from '../geo.js';
import type { SearchOptions, StoreAdapter, StoreLocation } from './types.js';
import type { Offer, PriceSnapshot, PromoDetail, PromoKind } from '../price/model.js';
import { centsFromDollars } from '../price/model.js';
import { effectiveUnitCents, parsePromoText } from '../price/promo.js';

const ALGOLIA_APP_ID = process.env.WEGMANS_ALGOLIA_APP_ID ?? 'QGPPR19V8V';
const ALGOLIA_API_KEY = process.env.WEGMANS_ALGOLIA_API_KEY ?? '9a10b1401634e9a6e55161c3a60c200d';
const ALGOLIA_INDEX = 'products_v2';
const SITE = 'https://www.wegmans.com';

/** Store 24 (Pittsford, NY) is the storefront's own fallback in fetchProductDetails. */
const DEFAULT_STORE = process.env.WEGMANS_STORE ?? '24';

interface StorePrice {
  amt?: number;
  utp?: string;
  /** the REST detail endpoint spells the same two fields out */
  amount?: number;
  unitPrice?: string;
}
/**
 * The same promotion is served under two field vocabularies: the Algolia index
 * abbreviates it, the REST detail endpoint spells it out and adds quantities.
 */
interface AlgoliaLoyaltyOffer {
  nm?: string;
  sav?: number;
  exp?: number;
}
interface DetailLoyaltyOffer {
  name?: string;
  savings?: number;
  expiryDate?: string;
  triggerQuantity?: number;
  discountedQuantity?: number;
  discountPercent?: string | number;
}
type LoyaltyOffer = AlgoliaLoyaltyOffer & DetailLoyaltyOffer;

interface NormalizedOffer {
  label: string | null;
  savingsCents: number | null;
  triggerQty: number | null;
  discountedQty: number | null;
  discountPercent: number | null;
}

function normalizeOffer(raw: LoyaltyOffer | undefined): NormalizedOffer | null {
  if (!raw) return null;
  const savings = raw.savings ?? raw.sav;
  const pct = raw.discountPercent == null ? null : Number(raw.discountPercent);
  return {
    label: raw.name ?? raw.nm ?? null,
    savingsCents: savings != null && savings > 0 ? Math.round(savings * 100) : null,
    triggerQty: raw.triggerQuantity ?? null,
    discountedQty: raw.discountedQuantity ?? null,
    discountPercent: pct != null && Number.isFinite(pct) && pct > 0 ? pct : null,
  };
}
interface AlgoliaHit {
  objectID: string;
  productID?: string;
  productName?: string;
  consumerBrandName?: string | null;
  packSize?: string | null;
  images?: string[];
  categories?: { lvl0?: string };
  priceInStore?: Record<string, StorePrice>;
  priceInStoreLoyalty?: Record<string, StorePrice>;
  loyaltyDiscountInStore?: Record<string, LoyaltyOffer[]>;
  soldAtStores?: number[];
  availableStores?: number[];
  slug?: string;
}
interface AlgoliaResponse {
  results: { hits: AlgoliaHit[]; nbHits: number }[];
}

interface ProductDetail {
  productID?: string;
  productName?: string;
  consumerBrandName?: string | null;
  packSize?: string | null;
  slug?: string;
  category?: { name?: string }[];
  price_inStore?: StorePrice & { amount?: number; unitPrice?: string };
  price_inStoreLoyalty?: StorePrice & { amount?: number; unitPrice?: string };
  loyaltyInstoreDiscount?: LoyaltyOffer[] | null;
  isAvailable?: boolean;
  isSoldAtStore?: boolean;
  isBuyable?: boolean;
}

interface StoreApiRow {
  storeNumber?: number;
  name?: string;
  streetAddress?: string;
  city?: string;
  stateAbbreviation?: string;
  zip?: string;
  latitude?: number;
  longitude?: number;
  openState?: string;
}

function productUrl(id: string, slug?: string | null): string {
  return slug ? `${SITE}/product/${slug}` : `${SITE}/product/${id}`;
}

/**
 * Wegmans expresses a promotion two ways at once: a discounted loyalty price
 * (numeric) and a `nm` label that may be plain text ("Buy 2 for $13.00") or a
 * type token ("DollarOff") paired with a numeric `sav`. Both are folded here.
 */
function buildPrice(
  regular: StorePrice | undefined,
  loyalty: StorePrice | undefined,
  offers: LoyaltyOffer[] | undefined,
  inStock: boolean | null,
): PriceSnapshot {
  const regularCents = centsFromDollars(regular?.amt ?? regular?.amount ?? null);
  const loyaltyCents = centsFromDollars(loyalty?.amt ?? loyalty?.amount ?? null);
  const currentCents = loyaltyCents ?? regularCents;

  const offer = normalizeOffer(offers?.[0]);
  let promoKind: PromoKind = 'none';
  let promoText: string | null = null;
  let promoDetail: PromoDetail | null = null;

  if (offer) {
    const parsed = offer.label ? parsePromoText(offer.label) : null;
    if (parsed && parsed.kind !== 'unknown' && parsed.kind !== 'sale') {
      // "Buy 2 for $13.00", "Buy 1 Get 1 Free" and friends carry their own maths.
      promoKind = parsed.kind;
      promoDetail = { ...parsed.detail, requiresLoyalty: true };
      promoText = offer.label;
    } else if (offer.savingsCents !== null) {
      // "DollarOff" is a type token, not shopper-facing copy: the numeric
      // saving is the promotion.
      promoKind = 'amount_off';
      promoDetail = { amountOffCents: offer.savingsCents, requiresLoyalty: true };
      promoText = `$${(offer.savingsCents / 100).toFixed(2)} off with Shoppers Club`;
    } else if (offer.discountPercent !== null) {
      promoKind = 'percent_off';
      promoDetail = { percentOff: offer.discountPercent, requiresLoyalty: true };
      promoText = offer.label ?? `${offer.discountPercent}% off with Shoppers Club`;
    } else {
      promoKind = 'loyalty';
      promoDetail = { requiresLoyalty: true };
      promoText = offer.label ?? 'Shoppers Club price';
    }
    // The detail endpoint reports the quantities the deal keys off; keep them
    // when the label itself did not spell them out.
    if (promoDetail.buyQty == null && offer.triggerQty) promoDetail.buyQty = offer.triggerQty;
    if (promoDetail.getQty == null && offer.discountedQty) promoDetail.getQty = offer.discountedQty;
  } else if (loyaltyCents !== null && regularCents !== null && loyaltyCents < regularCents) {
    promoKind = 'loyalty';
    promoText = 'Shoppers Club price';
    promoDetail = { requiresLoyalty: true };
  }

  return {
    regularCents,
    // For a multibuy the loyalty amount is the bundle total, not a shelf
    // price; reporting it as "current" would read as a price rise.
    currentCents: promoKind === 'multibuy' ? regularCents : currentCents,
    effectiveUnitCents: resolveEffective(regularCents, loyaltyCents, promoKind, promoDetail),
    promoKind,
    promoText,
    promoDetail,
    unitPriceText: loyalty?.utp ?? loyalty?.unitPrice ?? regular?.utp ?? regular?.unitPrice ?? null,
    inStock,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * `priceInStoreLoyalty` is the price *after* the promotion, so applying the
 * promotion's own maths to it a second time would double-count the discount.
 * A multibuy is the exception: its loyalty amount is the bundle total, and the
 * per-unit price has to be derived from the parsed quantity.
 */
function resolveEffective(
  regularCents: number | null,
  loyaltyCents: number | null,
  kind: PromoKind,
  detail: PromoDetail | null,
): number | null {
  if (kind === 'multibuy') {
    if (detail?.bundleCents != null && detail.buyQty) return Math.round(detail.bundleCents / detail.buyQty);
    return effectiveUnitCents(regularCents, kind, detail);
  }
  if (loyaltyCents !== null) return loyaltyCents;
  return effectiveUnitCents(regularCents, kind, detail);
}

function hitToOffer(hit: AlgoliaHit, storeNumber: string): Offer | null {
  const id = hit.productID ?? hit.objectID;
  if (!id) return null;
  const sold = hit.soldAtStores ?? [];
  const available = hit.availableStores ?? [];
  const n = Number(storeNumber);
  // A product not carried by the selected store has no comparable price.
  if (sold.length > 0 && !sold.includes(n)) return null;

  return {
    product: {
      storeId: 'wegmans',
      storeProductId: id,
      name: hit.productName ?? id,
      brand: hit.consumerBrandName ?? null,
      size: hit.packSize ?? null,
      imageUrl: hit.images?.[0] ?? null,
      productUrl: productUrl(id, hit.slug),
      category: hit.categories?.lvl0 ?? null,
    },
    price: buildPrice(
      hit.priceInStore?.[storeNumber],
      hit.priceInStoreLoyalty?.[storeNumber],
      hit.loyaltyDiscountInStore?.[storeNumber],
      available.length > 0 ? available.includes(n) : null,
    ),
  };
}

export class WegmansAdapter implements StoreAdapter {
  readonly id = 'wegmans' as const;
  readonly label = 'Wegmans';
  readonly defaultLocationId = DEFAULT_STORE;
  /** Observed spread on one gallon of milk in a single day: $2.49 to $5.09. */
  readonly pricesVaryByLocation = true;

  pricingLocationId(selectedLocationId?: string | null): string {
    return selectedLocationId ?? this.defaultLocationId;
  }

  async search({ query, locationId, limit = 24 }: SearchOptions): Promise<Offer[]> {
    const store = locationId ?? this.defaultLocationId;
    const params = new URLSearchParams({
      query,
      hitsPerPage: String(Math.min(limit * 2, 100)),
      filters: `soldAtStores:${store}`,
    });
    const res = await fetchJson<AlgoliaResponse>(
      `https://${ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/*/queries`,
      {
        method: 'POST',
        headers: {
          'x-algolia-application-id': ALGOLIA_APP_ID,
          'x-algolia-api-key': ALGOLIA_API_KEY,
        },
        body: { requests: [{ indexName: ALGOLIA_INDEX, params: params.toString() }] },
      },
    );
    const hits = res.results[0]?.hits ?? [];
    return hits
      .map((h) => hitToOffer(h, store))
      .filter((o): o is Offer => o !== null)
      .slice(0, limit);
  }

  async fetchOffer(storeProductId: string, locationId?: string): Promise<Offer | null> {
    const store = locationId ?? this.defaultLocationId;
    const d = await fetchJson<ProductDetail>(
      `${SITE}/api/products/${encodeURIComponent(store)}/${encodeURIComponent(storeProductId)}`,
    );
    if (!d || !d.productID) return null;

    const regular = d.price_inStore?.amount != null ? d.price_inStore : undefined;
    const loyalty = d.price_inStoreLoyalty?.amount != null ? d.price_inStoreLoyalty : undefined;

    return {
      product: {
        storeId: 'wegmans',
        storeProductId: d.productID,
        name: d.productName ?? storeProductId,
        brand: d.consumerBrandName ?? null,
        size: d.packSize ?? null,
        imageUrl: null,
        productUrl: productUrl(d.productID, d.slug),
        category: d.category?.[0]?.name ?? null,
      },
      price: buildPrice(
        regular,
        loyalty,
        d.loyaltyInstoreDiscount ?? undefined,
        d.isAvailable ?? d.isSoldAtStore ?? null,
      ),
    };
  }

  /** Nearest open stores to a ZIP, by great-circle distance. */
  async findLocations(postalCode: string, near?: Point | null): Promise<StoreLocation[]> {
    const rows = (await this.stores()).filter(
      (r) => r.storeNumber != null && r.openState !== 'Closed',
    );
    const zip = normalizeZip(postalCode ?? '');
    const point = near ?? (zip ? resolveZip(zip, this.anchorsFrom(rows))?.point ?? null : null);

    const ranked = point
      ? rows
          .filter((r) => r.latitude != null && r.longitude != null)
          .map((r) => ({
            row: r,
            miles: milesBetween(point, { lat: r.latitude!, lng: r.longitude! }),
          }))
          .sort((a, b) => a.miles - b.miles)
      : rows.map((row) => ({ row, miles: null as number | null }));

    return ranked.slice(0, 25).map(({ row, miles }) => ({
      storeId: 'wegmans' as const,
      locationId: String(row.storeNumber),
      name: row.name ?? `Store ${row.storeNumber}`,
      address: [row.streetAddress, row.city, row.stateAbbreviation].filter(Boolean).join(', ') || null,
      postalCode: row.zip ?? null,
      distanceMiles: miles === null ? null : Math.round(miles * 10) / 10,
    }));
  }

  private storeCache: { rows: StoreApiRow[]; fetchedAt: number } | null = null;

  private async stores(): Promise<StoreApiRow[]> {
    const ttl = Number(process.env.WEGMANS_STORES_TTL_MS ?? 24 * 60 * 60 * 1000);
    if (this.storeCache && Date.now() - this.storeCache.fetchedAt < ttl) return this.storeCache.rows;
    try {
      const rows = await fetchJson<StoreApiRow[]>(`${SITE}/api/stores`);
      this.storeCache = { rows, fetchedAt: Date.now() };
      return rows;
    } catch (err) {
      if (this.storeCache) return this.storeCache.rows;
      throw err;
    }
  }

  private anchorsFrom(rows: StoreApiRow[]): ZipAnchor[] {
    return rows
      .filter((r) => r.zip && r.latitude != null && r.longitude != null)
      .map((r) => ({ zip: r.zip!.slice(0, 5), point: { lat: r.latitude!, lng: r.longitude! } }));
  }

  /** ZIP reference points this chain can contribute to a shared lookup. */
  async zipAnchors(): Promise<ZipAnchor[]> {
    return this.anchorsFrom(await this.stores());
  }
}
