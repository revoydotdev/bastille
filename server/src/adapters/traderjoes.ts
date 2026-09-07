/**
 * Trader Joe's adapter.
 *
 * The storefront is Adobe Commerce (Magento) and talks to its own GraphQL at
 * `/api/graphql`. That endpoint is unauthenticated and carries no store
 * context — no `Store` header, no store cookie — which matches Trader Joe's
 * one-price-nationwide model, so prices are recorded under a single scope the
 * way Food Lion's are. See docs/BACKEND-MAP.md.
 *
 * `curl` is refused with a 403 on TLS fingerprint; undici is not, so the shared
 * adapter client reaches it without a browser. That is a courtesy of their edge
 * rather than a contract, so a 403 here means the fingerprint policy changed,
 * not that the API moved.
 */
import { fetchJson } from './http.js';
import { milesBetween, normalizeZip, type Point, type ZipAnchor } from '../geo.js';
import type { SearchOptions, StoreAdapter, StoreLocation } from './types.js';
import type { Offer, PriceSnapshot, PromoKind } from '../price/model.js';
import { centsFromDollars } from '../price/model.js';

const SITE = 'https://www.traderjoes.com';
const GRAPHQL = `${SITE}/api/graphql`;

/** Root category of the food tree; its children are what `enumerate` walks. */
const FOOD_CATEGORY = '8';

/**
 * The storefront's own store locator is Brandify, with the search key it ships
 * to every browser. Observed in the site's own network traffic.
 */
const BRANDIFY = 'https://alphaapi.brandify.com/rest/locatorsearch';
const BRANDIFY_APPKEY = process.env.TRADERJOES_BRANDIFY_KEY ?? '8BC3433A-60FC-11E3-991D-B2EE0C70A832';

interface TjMoney { value?: number | null; currency?: string | null }
interface TjProduct {
  sku?: string;
  item_title?: string;
  url_key?: string;
  sales_size?: number | null;
  sales_uom_description?: string | null;
  availability?: string | null;
  price_range?: {
    minimum_price?: { final_price?: TjMoney; regular_price?: TjMoney };
  };
}
interface TjCategory { id?: number; name?: string; url_key?: string; product_count?: number }

async function graphql<T>(query: string): Promise<T> {
  const res = await fetchJson<{ data?: T; errors?: { message?: string }[] }>(GRAPHQL, {
    method: 'POST',
    // The edge refuses the call without a same-origin `origin`/`referer` pair,
    // which is what a browser on the storefront sends.
    headers: {
      'content-type': 'application/json',
      origin: SITE,
      referer: `${SITE}/home/products`,
    },
    body: { variables: {}, query },
  });
  if (res.errors?.length) throw new Error(`traderjoes graphql: ${res.errors[0]?.message ?? 'error'}`);
  if (!res.data) throw new Error('traderjoes graphql: no data');
  return res.data;
}

const PRODUCT_FIELDS = `
  sku
  item_title
  url_key
  sales_size
  sales_uom_description
  availability
  price_range { minimum_price { final_price { value currency } regular_price { value } } }
`;

/**
 * Trader Joe's publishes a pack size and its unit alongside the price, so the
 * per-unit figure is derived rather than parsed out of a string. Both existing
 * adapters take the store's own unit-price text; here there is none to take.
 */
export function unitPriceText(cents: number | null, size?: number | null, uom?: string | null): string | null {
  if (cents === null || !size || size <= 0 || !uom) return null;
  const unit = uom.trim().toLowerCase();
  const per = cents / 100 / size;
  // Below a cent the rounded figure would read as $0.00, which is worse than
  // saying nothing.
  if (per < 0.005) return null;
  return `$${per.toFixed(2)}/${unit}`;
}

export function toOffer(p: TjProduct): Offer | null {
  const sku = p.sku?.trim();
  if (!sku) return null;
  const min = p.price_range?.minimum_price;
  const currentCents = centsFromDollars(min?.final_price?.value ?? null);
  const regularCents = centsFromDollars(min?.regular_price?.value ?? null);

  // Trader Joe's does not run the promotions the grocers do — no BOGO, no
  // loyalty tier, no coupons. A final price below the regular one is the only
  // discount the schema can express.
  const onSale = currentCents !== null && regularCents !== null && currentCents < regularCents;
  const promoKind: PromoKind = onSale ? 'sale' : 'none';

  const price: PriceSnapshot = {
    regularCents,
    currentCents,
    effectiveUnitCents: currentCents,
    promoKind,
    promoText: onSale ? 'Sale price' : null,
    promoDetail: null,
    unitPriceText: unitPriceText(currentCents, p.sales_size, p.sales_uom_description),
    // `availability` is the only stock signal exposed; absent means unknown,
    // which is recorded as unknown rather than guessed as in stock.
    inStock: p.availability == null ? null : /^(1|true|in ?stock|available)$/i.test(String(p.availability)),
    capturedAt: new Date().toISOString(),
  };

  return {
    product: {
      storeId: 'traderjoes',
      storeProductId: sku,
      name: p.item_title ?? sku,
      brand: "Trader Joe's",
      size: p.sales_size && p.sales_uom_description ? `${p.sales_size} ${p.sales_uom_description}` : null,
      imageUrl: null,
      productUrl: p.url_key ? `${SITE}/home/products/pdp/${p.url_key}` : null,
      category: null,
    },
    price,
  };
}

interface BrandifyRow {
  clientkey?: string;
  name?: string;
  address1?: string;
  city?: string;
  state?: string;
  postalcode?: string;
  latitude?: number | string;
  longitude?: number | string;
  /** Brandify's own distance from the searched location. */
  _distance?: number | string;
  _distanceuom?: string;
}

export class TraderJoesAdapter implements StoreAdapter {
  readonly id = 'traderjoes' as const;
  readonly label = "Trader Joe's";
  /** One price nationwide; the store choice is pickup context, not pricing. */
  readonly defaultLocationId = 'national';
  readonly pricesVaryByLocation = false;

  /** Every reading is one national series — see the Food Lion note. */
  pricingLocationId(): string {
    return 'national';
  }

  async search({ query, limit = 24 }: SearchOptions): Promise<Offer[]> {
    const term = query.trim();
    if (term === '') return [];
    const escaped = JSON.stringify(term);
    // Ask for more than we need: Magento's `search` matches any term, so
    // "peanut butter" comes back full of plain butter. The surplus is filtered
    // below rather than shown.
    const data = await graphql<{ products?: { items?: TjProduct[] } }>(
      `{ products(search: ${escaped}, pageSize: ${Math.min(Math.max(limit * 4, 20), 100)}, currentPage: 1) {
           items { ${PRODUCT_FIELDS} } } }`,
    );
    const terms = term.toLowerCase().split(/\s+/).filter(Boolean);
    return (data.products?.items ?? [])
      .map(toOffer)
      .filter((o): o is Offer => o !== null)
      // Every word the shopper typed must appear. A row that matched only
      // "butter" is not a peanut-butter result, and letting it through would
      // make this chain's rows incomparable with the grocers' — those are
      // held to the same rule.
      .filter((o) => {
        const hay = `${o.product.name} ${o.product.size ?? ''}`.toLowerCase();
        return terms.every((t) => hay.includes(t));
      })
      .slice(0, limit);
  }

  async fetchOffer(storeProductId: string): Promise<Offer | null> {
    const data = await graphql<{ products?: { items?: TjProduct[] } }>(
      `{ products(filter: {sku: {eq: ${JSON.stringify(storeProductId)}}}, pageSize: 1) {
           items { ${PRODUCT_FIELDS} } } }`,
    );
    const item = data.products?.items?.[0];
    return item ? toOffer(item) : null;
  }

  private async categories(): Promise<TjCategory[]> {
    const data = await graphql<{ categoryList?: { children?: TjCategory[] }[] }>(
      `{ categoryList(filters: {ids: {in: ["${FOOD_CATEGORY}"]}}) {
           children { id name url_key product_count } } }`,
    );
    return data.categoryList?.[0]?.children ?? [];
  }

  /**
   * Walks the food tree a category at a time. Magento caps a page at 100, so
   * each category is paged to its own `product_count` rather than assuming one
   * request covers it.
   */
  async enumerate({ maxProducts }: { locationId?: string | null; maxProducts?: number }): Promise<Offer[]> {
    const out: Offer[] = [];
    const seen = new Set<string>();
    const pageSize = 100;

    for (const category of await this.categories()) {
      if (category.id == null) continue;
      const total = category.product_count ?? 0;
      for (let page = 1; (page - 1) * pageSize < total; page++) {
        const data = await graphql<{ products?: { items?: TjProduct[] } }>(
          `{ products(filter: {category_id: {eq: "${category.id}"}}, pageSize: ${pageSize}, currentPage: ${page}) {
               items { ${PRODUCT_FIELDS} } } }`,
        );
        const items = data.products?.items ?? [];
        if (items.length === 0) break;
        for (const item of items) {
          const offer = toOffer(item);
          if (!offer || seen.has(offer.product.storeProductId)) continue;
          seen.add(offer.product.storeProductId);
          offer.product.category = category.name ?? null;
          out.push(offer);
          if (maxProducts && out.length >= maxProducts) return out;
        }
      }
    }
    return out;
  }

  private async stores(postalCode: string): Promise<BrandifyRow[]> {
    const body = {
      request: {
        appkey: BRANDIFY_APPKEY,
        formdata: {
          geoip: false,
          dataview: 'store_default',
          limit: 25,
          geolocs: { geoloc: [{ addressline: postalCode, country: 'US', latitude: '', longitude: '' }] },
          searchradius: '100',
        },
      },
    };
    const res = await fetchJson<{ response?: { collection?: BrandifyRow[] } }>(BRANDIFY, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    return res.response?.collection ?? [];
  }

  async findLocations(postalCode: string, near?: Point | null): Promise<StoreLocation[]> {
    const zip = normalizeZip(postalCode ?? '');
    const rows = (await this.stores(zip || postalCode)).filter((r) => r.latitude != null && r.longitude != null);

    const ranked = rows.map((row) => {
      const lat = Number(row.latitude);
      const lng = Number(row.longitude);
      // Prefer the locator's own distance from the searched ZIP. Deriving it
      // instead from these same rows would be self-referential — the nearest
      // store would geocode to itself and report 0 miles.
      const reported =
        row._distanceuom?.toLowerCase().startsWith('mile') ? Number(row._distance) : NaN;
      const miles = Number.isFinite(reported)
        ? reported
        : near && Number.isFinite(lat) && Number.isFinite(lng)
          ? milesBetween(near, { lat, lng })
          : null;
      return { row, miles };
    });
    ranked.sort((a, b) => (a.miles ?? Infinity) - (b.miles ?? Infinity));

    return ranked.slice(0, 25).map(({ row, miles }) => ({
      storeId: 'traderjoes' as const,
      locationId: String(row.clientkey ?? row.name ?? ''),
      name: row.name ?? 'Trader Joe\'s',
      address: [row.address1, row.city, row.state].filter(Boolean).join(', ') || null,
      postalCode: row.postalcode ?? null,
      distanceMiles: miles === null ? null : Math.round(miles * 10) / 10,
    }));
  }

  /**
   * The locator is a search API, not a directory: it answers for a ZIP rather
   * than listing every store, so this chain contributes no anchors to the
   * shared ZIP lookup and relies on the other chains' store data.
   */
  async zipAnchors(): Promise<ZipAnchor[]> {
    return [];
  }
}
