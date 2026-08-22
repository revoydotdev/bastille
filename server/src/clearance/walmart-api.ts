/**
 * Walmart's public storefront GraphQL tier ("orchestra").
 *
 * Walmart serves its shelves as server-rendered HTML behind PerimeterX, so the
 * pages themselves are not readable by a plain HTTP client. The XHR tier the
 * same pages call is not gated the same way: the persisted queries below
 * answer an ordinary anonymous request. Both are reads, neither is disallowed
 * by `walmart.com/robots.txt` (which does disallow `/api/`, `/search` and
 * `/store/electrode/api/*` — none of which are used here).
 *
 * Two operations are used, with the sha256 hashes the storefront's own bundle
 * ships for them:
 *
 *   storeFinderNearbyNodesQuery  ZIP -> nearby stores, with coordinates
 *   Browse                       one category shelf, scoped to one store
 *
 * Store scoping is a cookie: `locGuestData` carries the chosen store as
 * `pickup.nodeId`, and the response echoes it back in
 * `pageMetadata.storeSelectionHeader`, which is checked so a silently
 * unscoped read can never be recorded as a store's clearance.
 *
 * See docs/WALMART-CLEARANCE-API.md for the full write-up.
 */
import { fetchJson } from '../adapters/http.js';
import type { Point } from '../geo.js';

const SITE = 'https://www.walmart.com';

const STORE_FINDER_HASH =
  process.env.WALMART_STORE_FINDER_HASH ??
  '23594c3a307d6359f419a4247d6212be409ec7b74fb8963f5402147bed22e7fb';
const BROWSE_HASH =
  process.env.WALMART_BROWSE_HASH ??
  '8aa4d8ce0587319fb70bdafd8d6a70e873cdc85ae79de801a21da658d1457f12';

/** In-store clearance only. Both halves matter: `Clearance` without the
 *  fulfillment filter returns online marketplace markdowns, which are the same
 *  everywhere and are not what a store run is for. */
export const CLEARANCE_FACET = 'special_offers:Clearance||fulfillment_method:In-store';

/**
 * Walmart's edge answers a burst with 412, and measured here it takes about
 * twenty reads inside a few minutes to earn one. A store sweep is a background
 * job with all night to finish, so it waits tens of seconds between reads
 * rather than the milliseconds the grocery adapters use.
 *
 * The extra jitter spreads the load off a fixed cadence — a run that fires
 * every 20.000s puts a sharper spike on any one minute-bucket than one that
 * fires every 20-32s. It is load-spreading, not disguise: nothing here varies
 * the client's identity, headers or fingerprint between requests.
 */
const REQUEST_INTERVAL_MS = Number(process.env.WALMART_REQUEST_INTERVAL_MS ?? 20_000);
const REQUEST_JITTER_MS = Number(process.env.WALMART_REQUEST_JITTER_MS ?? 12_000);
let nextRequestAt = 0;

async function pace(): Promise<void> {
  const wait = nextRequestAt - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  nextRequestAt = Date.now() + REQUEST_INTERVAL_MS + Math.random() * REQUEST_JITTER_MS;
}

/**
 * Pushes the next read out by `ms`, so a caller that has just been rate-limited
 * can stand down without the pacer immediately letting the following request
 * through.
 */
export function backOffUntil(ms: number): void {
  nextRequestAt = Math.max(nextRequestAt, Date.now() + ms);
}

function correlationId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * The header set the storefront sends; without it the tier answers 412.
 *
 * `locGuestData` is a **gate, not a selector**: omit it and the shelf comes back
 * 412, send it and the in-store view unlocks — but its contents do not choose
 * the store, which Walmart resolves from the requesting address. So it is sent
 * on every shelf read, with whatever is known, including nothing.
 */
function headers(
  referer: string,
  operation: string,
  opts: { withStoreCookie?: boolean; locationId?: string; postalCode?: string } = {},
): Record<string, string> {
  const h: Record<string, string> = {
    accept: 'application/json',
    referer,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    wm_mp: 'true',
    'x-apollo-operation-name': operation,
    'x-o-bu': 'WALMART-US',
    'x-o-ccm': 'server',
    'x-o-mart': 'B2C',
    'x-o-platform': 'rweb',
    'x-o-platform-version': 'main-1.0.0',
    'x-o-segment': 'oaoh',
    'wm_qos.correlation_id': correlationId(),
  };
  if (opts.withStoreCookie) {
    const loc = {
      intent: 'PICKUP',
      storeIntent: 'PICKUP',
      mergeFlag: true,
      isExplicitIntent: true,
      ...(opts.locationId ? { pickup: { nodeId: opts.locationId, timestamp: Date.now() } } : {}),
      ...(opts.postalCode ? { postalCode: { base: opts.postalCode, timestamp: Date.now() } } : {}),
    };
    h['cookie'] = `locGuestData=${encodeURIComponent(JSON.stringify(loc))}`;
  }
  return h;
}

interface GraphQLErrors {
  errors?: { message?: string }[];
}

/**
 * A GraphQL error arrives as HTTP 200 with `data: null`. Left unchecked that
 * reads downstream as "this store has nothing on clearance", which is the most
 * expensive kind of wrong answer here — so it is raised instead.
 */
async function persistedQuery<T>(
  path: string,
  operation: string,
  variables: unknown,
  opts: { referer: string; withStoreCookie?: boolean; locationId?: string; postalCode?: string },
): Promise<T> {
  await pace();
  const url = `${SITE}${path}?variables=${encodeURIComponent(JSON.stringify(variables))}`;
  const body = await fetchJson<T & GraphQLErrors>(url, {
    headers: headers(opts.referer, operation, opts),
    timeoutMs: 30_000,
  });
  const errors = body.errors ?? [];
  if (errors.length > 0) {
    throw new Error(`${operation}: ${errors.map((e) => e.message ?? 'unknown error').join('; ').slice(0, 400)}`);
  }
  return body;
}

// ---- store finder ----------------------------------------------------------

export interface WalmartStore {
  /** Walmart's store number, e.g. "4682". The key everything else is scoped by. */
  locationId: string;
  name: string;
  address: string;
  city: string;
  state: string;
  postalCode: string;
  point: Point;
  /** miles from the searched ZIP, as Walmart computes it */
  distanceMiles: number | null;
}

interface NearbyNodesResponse {
  data?: {
    nearByNodes?: {
      nodes?: {
        id?: string;
        displayName?: string;
        name?: string;
        address?: { addressLineOne?: string; city?: string; state?: string; postalCode?: string };
        nodeDistance?: { value?: number; unitOfMeasure?: string };
        geoPoint?: { latitude?: number; longitude?: number };
      }[];
    };
  };
}

/** Stores near a ZIP, nearest first. `radiusMiles` is Walmart's own cap. */
export async function nearbyStores(postalCode: string, radiusMiles = 50): Promise<WalmartStore[]> {
  const body = await persistedQuery<NearbyNodesResponse>(
    `/orchestra/home/graphql/storeFinderNearbyNodesQuery/${STORE_FINDER_HASH}`,
    'storeFinderNearbyNodesQuery',
    { input: { postalCode, nodeTypes: ['STORE'], accessTypes: ['PICKUP_INSTORE'], radius: radiusMiles } },
    { referer: `${SITE}/store-finder` },
  );

  const nodes = body.data?.nearByNodes?.nodes ?? [];
  const stores: WalmartStore[] = [];
  for (const n of nodes) {
    const lat = n.geoPoint?.latitude;
    const lng = n.geoPoint?.longitude;
    if (!n.id || lat == null || lng == null) continue;
    stores.push({
      locationId: n.id,
      name: n.displayName ?? n.name ?? `Store ${n.id}`,
      address: n.address?.addressLineOne ?? '',
      city: n.address?.city ?? '',
      state: n.address?.state ?? '',
      postalCode: (n.address?.postalCode ?? '').slice(0, 5),
      point: { lat, lng },
      distanceMiles: n.nodeDistance?.unitOfMeasure === 'MI' ? (n.nodeDistance?.value ?? null) : null,
    });
  }
  return stores;
}

// ---- clearance shelf -------------------------------------------------------

export interface ClearanceItem {
  itemId: string;
  name: string;
  brand: string | null;
  /** Walmart's own category chain for the item, e.g. "0:3944:1089430:132959" */
  categoryPathId: string | null;
  /** the top-level department Walmart files it under, e.g. "Electronics" */
  department: string | null;
  imageUrl: string | null;
  productUrl: string | null;
  /** the marked-down price actually charged at this store */
  nowCents: number | null;
  /** the pre-clearance list price, when Walmart still shows one */
  wasCents: number | null;
  /** Walmart's own "SAVE $x" figure, when present */
  savingsCents: number | null;
  /** in-store shelf location, e.g. "K14" — the whole point of a store run */
  aisle: string | null;
  inStock: boolean | null;
}

export interface ShelfPage {
  /** items physically on this store's rack — the primary stack only */
  items: ClearanceItem[];
  /** how many the shelf claims in total, across pages */
  totalCount: number | null;
  /**
   * Every item the page returned, shelf and shipping alike. Only the pager
   * uses this: paging must follow the page Walmart actually served, not the
   * subset that survived filtering.
   */
  pageItemCount: number;
  /** items dropped because they ship rather than sit on the rack */
  shippedOnly: number;
  /** the store Walmart says it answered for; guards against an unscoped read */
  storeName: string | null;
}

export interface BrowseResponse {
  data?: {
    search?: {
      searchResult?: {
        aggregatedCount?: number | null;
        pageMetadata?: { storeSelectionHeader?: { storeDislayName?: string } };
        itemStacks?: RawStack[];
      };
    };
  };
}

/**
 * A shelf comes back in stacks. The first is the store's actual rack; Walmart
 * appends a second titled "Available for shipping" (`secondary_stack` /
 * `inStoreShipFul`) of things it will post to you instead. Those carry no aisle
 * and are identical at every store, so recording them would bury the local
 * finds this exists for under national noise.
 */
interface RawStack {
  items?: RawItem[];
  itemsV2?: RawItem[];
  meta?: { beacon?: string | null; title?: string | null } | null;
}

/**
 * True when the stack is the store's own rack. The beacon is a JSON string
 * Walmart uses for its own analytics; its `interpretations[].type` is the
 * structured statement of what a stack is, and the display title is not.
 * A stack whose beacon cannot be read is treated as *not* primary — inventing
 * shelf presence is the failure worth avoiding here.
 */
function isPrimaryStack(stack: RawStack): boolean {
  const beacon = stack.meta?.beacon;
  if (typeof beacon !== 'string') return false;
  try {
    const parsed = JSON.parse(beacon) as { interpretations?: { type?: string }[] };
    return (parsed.interpretations ?? []).some((i) => i.type === 'primary');
  } catch {
    return false;
  }
}

/** Money on this tier arrives as dollars, not cents, under a `price` key. */
interface RawPrice {
  price?: number | null;
  priceString?: string | null;
}

interface RawItem {
  usItemId?: string;
  name?: string;
  brand?: string | null;
  canonicalUrl?: string | null;
  departmentName?: string | null;
  category?: { categoryPathId?: string | null } | null;
  imageInfo?: { thumbnailUrl?: string | null } | null;
  /** one entry per in-store location; the first carries the shelf code */
  productLocation?: { displayValue?: string | null }[] | null;
  availabilityStatusV2?: { value?: string | null } | null;
  priceInfo?: {
    currentPrice?: RawPrice | null;
    /** the pre-markdown price; `wasPrice` is usually null on a clearance tag */
    listPrice?: RawPrice | null;
    wasPrice?: RawPrice | null;
    savingsAmount?: { amount?: number | null; priceString?: string | null } | null;
  } | null;
}

/**
 * Walmart sends money as a dollar number (`149`, `15.88`). Rounding through
 * cents avoids the float error that turns $15.88 into 1587.9999999999998, and
 * anything that is not a finite number — a null, a range, a missing key —
 * yields null rather than a figure the UI would present as fact.
 */
export function centsFromDollars(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/** The parts of the shelf query that never vary, lifted from the storefront's
 *  own `initialSearchQueryVariables`. Flags that fetch ad modules are off: this
 *  reads a catalogue, it has no use for sponsored placements. */
const BROWSE_FLAGS = {
  tenant: 'WM_GLASS',
  pageType: 'BrowsePage',
  version: 'v2',
  postProcessingVersion: 2,
  prg: 'desktop',
  sort: 'best_match',
  fetchDataV1: true,
  fetchDataV2: false,
  fetchMarquee: false,
  fetchSkyline: false,
  fetchSbaTop: false,
  fetchDac: false,
  fetchGallery: false,
  fungibilityEnabled: false,
  enableUnifiedSchema: true,
  enablePortableFacets: true,
  enableFacetCount: true,
  enablePromoData: true,
  enableCopyBlock: true,
  enableSlaBadgeV2: true,
  enableGenericSeo: true,
  enablePartialRenderingDGF: true,
  enableCachingOnEmptyResultsForBrowseAndSearch: true,
  enableAdsPromoData: false,
  enableAdsUnifiedProductTile: false,
  enableCanAddToList: false,
  enableDebugAnalyticsTags: false,
  enableESSCarousel: false,
  enableFashionTopNav: false,
  enableFulfillmentTagsEnhacements: false,
  enableHero4: false,
  enableImageBannerCarousel: false,
  enableInStoreShelfMessage: false,
  enableIsFreeWarranty: false,
  enableItemLimits: false,
  enableItemRank: false,
  enableMultiSave: false,
  enableOptimisticWeightUpdate: false,
  enablePromotionMessages: false,
  enableRxDrugScheduleModal: false,
  enableSellerType: false,
  enableSeoBrowseMetaDataShortDesc: false,
  enableSeoLangUrl: false,
  enableShopSimilarBottomSheet: false,
  enableSignInToSeePrice: false,
  enableSimpleEmailSignUp: false,
  enableUnifiedProductFragment: false,
  enableVariantCount: false,
  enableVolumePricing: false,
  fitmentFieldParams: {
    powerSportEnabled: true,
    dynamicFitmentEnabled: true,
    extendedAttributesEnabled: true,
    extendedAttributesV2Enabled: true,
    fuelTypeEnabled: true,
  },
} as const;

const EMPTY_QUERY_PARAMS = {
  hidden_facet: null,
  translation: null,
  isMoreOptionsTileEnabled: true,
  rootDimension: '',
  altQuery: '',
  selectedFilter: '',
  neuralSearchSeeAll: false,
  enableGenericItemTileOptions: false,
  isLMPBrowsePage: false,
} as const;

function browseVariables(categoryId: string, page: number, pageSize: number): Record<string, unknown> {
  const searchArgs = { query: '', cat_id: categoryId, prg: 'desktop', facet: CLEARANCE_FACET };
  // The shelf identity is repeated in three places the storefront sends it:
  // top level, `searchArgs`, and the nested `searchParams`/`fitmentSearchParams`
  // copies. Leaving any of them on a different category returns the wrong shelf.
  const shelf = {
    id: '',
    dealsId: '',
    query: '',
    catId: categoryId,
    cat_id: categoryId,
    facet: CLEARANCE_FACET,
    rawFacet: '',
    seoPath: '',
    page,
    ps: pageSize,
    limit: pageSize,
    sort: 'best_match',
    prg: 'desktop',
    ptss: '',
    trsp: '',
    beShelfId: '',
    _be_shelf_id: '',
    recall_set: '',
    module_search: '',
    min_price: '',
    max_price: '',
    nudgeContext: '',
    storeSlotBooked: '',
    additionalQueryParams: EMPTY_QUERY_PARAMS,
    searchArgs,
  };
  return {
    ...BROWSE_FLAGS,
    ...shelf,
    searchParams: { ...shelf, enableCopyBlock: true, enableESSCarousel: false, enableUnifiedProductFragment: false, enableVariantCount: false, enableVolumePricing: false },
    fitmentSearchParams: { ...shelf, additionalQueryParams: EMPTY_QUERY_PARAMS },
  };
}

function toClearanceItem(raw: RawItem): ClearanceItem | null {
  if (!raw.usItemId || !raw.name) return null;
  const price = raw.priceInfo ?? {};
  const status = raw.availabilityStatusV2?.value ?? null;
  return {
    itemId: raw.usItemId,
    name: raw.name,
    brand: raw.brand ?? null,
    categoryPathId: raw.category?.categoryPathId ?? null,
    department: raw.departmentName ?? null,
    imageUrl: raw.imageInfo?.thumbnailUrl ?? null,
    productUrl: raw.canonicalUrl ? `${SITE}${raw.canonicalUrl}` : null,
    nowCents: centsFromDollars(price.currentPrice?.price),
    // Walmart puts the pre-markdown figure in `listPrice` on a clearance tag
    // and in `wasPrice` on a rollback; whichever is present is the "was".
    wasCents: centsFromDollars(price.listPrice?.price) ?? centsFromDollars(price.wasPrice?.price),
    savingsCents: centsFromDollars(price.savingsAmount?.amount),
    aisle: raw.productLocation?.[0]?.displayValue ?? null,
    inStock: status === null ? null : status === 'IN_STOCK',
  };
}

/**
 * Turns one Browse response into a page of rack. Pure, and exported so the
 * stack split and the price/aisle mapping can be exercised against captured
 * payloads without a network in the way.
 */
export function parseShelf(body: BrowseResponse): ShelfPage {
  const result = body.data?.search?.searchResult;
  const seen = new Set<string>();
  const items: ClearanceItem[] = [];
  let pageItemCount = 0;
  let shippedOnly = 0;

  for (const stack of result?.itemStacks ?? []) {
    const onShelf = isPrimaryStack(stack);
    for (const raw of [...(stack.items ?? []), ...(stack.itemsV2 ?? [])]) {
      pageItemCount++;
      if (!onShelf) {
        shippedOnly++;
        continue;
      }
      const item = toClearanceItem(raw);
      if (!item || seen.has(item.itemId)) continue;
      seen.add(item.itemId);
      items.push(item);
    }
  }

  return {
    items,
    totalCount: result?.aggregatedCount ?? null,
    pageItemCount,
    shippedOnly,
    storeName: result?.pageMetadata?.storeSelectionHeader?.storeDislayName ?? null,
  };
}

/**
 * One page of one category's in-store clearance at one store.
 *
 * Items arrive under `items` or `itemsV2` depending on which schema the shelf
 * answers with; both are read, and duplicates across the two stacks are
 * collapsed on item id.
 */
export async function clearanceShelf(opts: {
  /** Only ever a hint; Walmart picks the store from the requesting address. */
  locationId?: string;
  postalCode?: string;
  categoryId: string;
  page?: number;
  pageSize?: number;
}): Promise<ShelfPage> {
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? 40;
  const body = await persistedQuery<BrowseResponse>(
    `/orchestra/snb/graphql/Browse/${BROWSE_HASH}`,
    'Browse',
    browseVariables(opts.categoryId, page, pageSize),
    {
      referer: `${SITE}/browse/${opts.categoryId.replace(/_/g, '/')}`,
      withStoreCookie: true,
      locationId: opts.locationId,
      postalCode: opts.postalCode,
    },
  );

  return parseShelf(body);
}
