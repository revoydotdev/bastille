#!/usr/bin/env node
/**
 * POC: clearance sweep for Electronics + Video Games shelves, top-5 Walmarts
 * nearest to ZIP 22963 (Palmyra / Fluvanna County, VA).
 *
 * Runs entirely in-process. Makes real HTTP calls to Walmart's GraphQL tier.
 * Uses the same persisted-query hashes, category IDs, and header set as
 * server/src/clearance/walmart-api.ts, but does NOT import from that module
 * (so the POC can be copied out of the repo).
 *
 * What this POC does NOT do:
 *  - Touch the durable host budget / not_before ledger. The real sweep shares
 *    that ledger with manual sweeps and restarts; this POC keeps its counters
 *    in process memory only.
 *  - Retry 412s. The real sweep stands down on refusal; this POC records
 *    the failure and stops the store early. Identical conduct rule.
 *  - Use the proxy. The store-finder query is one request; the shelf reads
 *    are five per store × five stores × two shelves = ~50 reads total, which
 *    is well under the per-edge budget. The proxy comes in when you want to
 *    cover more than the edge-budget-willing stores in one run (W-9).
 *  - Persist anything. POC output is stdout only.
 *
 * Run with: `node scripts/poc-clearance-22963.mjs`
 */

import { performance } from 'node:perf_hooks';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

// ─── Optional proxy support (set WALMART_PROXY to route all reads) ────────

const PROXY_URL = process.env.WALMART_PROXY ?? null;
// pipelining: 0 — PerimeterProxy scores connection reuse across separate calls as
// bot-shaped. Walmart's own throttle is on count, not cadence, and one of the
// consequences is that sharing a TCP connection across two GraphQL reads
// is treated differently than opening a fresh one. Disable pipelining.
const dispatcher = PROXY_URL ? new ProxyAgent({ uri: PROXY_URL, pipelining: 0 }) : null;
const fetchImpl = dispatcher ? (url, init = {}) => undiciFetch(url, { ...init, dispatcher }) : fetch;

if (PROXY_URL) {
  // Surface the proxy choice once so it's obvious in the log what the egress is.
  console.error(`[POC] using proxy: ${PROXY_URL.replace(/:[^:@]+@/, ':***@')}`);
}

// ─── Mirrors of b + v0 line items (kept in sync with walmart-api.ts) ────────

const SITE = 'https://www.walmart.com';

const STORE_FINDER_HASH =
  process.env.WALMART_STORE_FINDER_HASH ??
  '23594c3a307d6359f419a4247d6212be409ec7b74fb8963f5402147bed22e7fb';
const BROWSE_HASH =
  process.env.WALMART_BROWSE_HASH ??
  '8aa4d8ce0587319fb70bdafd8d6a70e873cdc85ae79de801a21da658d1457f12';

const CLEARANCE_FACET = 'special_offers:Clearance||fulfillment_method:In-store';

const CLEARANCE_CATEGORIES = [
  { id: '3944', slug: 'electronics', label: 'Electronics', group: 'electronics' },
  { id: '2636', slug: 'video-games', label: 'Video games', group: 'video-games' },
];

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const CATEGORY_BROWSE_SEARCH = {
  electronics: 'electronics',
  'video-games': 'video games',
};

// ─── HTTP helper (mirrors fetchJson from adapters/http.ts) ──────────────────

class HttpError extends Error {
  constructor(status, url, body) {
    super(`${status} ${url} :: ${body.slice(0, 200)}`);
    this.name = 'HttpError';
  }
}

function correlationId() {
  return globalThis.crypto.randomUUID();
}

function walmartHeaders(operation, opts = {}) {
  const h = {
    // user-agent is required even though the prod code in adapters/http.ts sets it
    // on the dispatcher: when undici ProxyAgent is used, the Agent's UA does not
    // propagate to the proxied request, and PerimeterX scores UA-less requests as
    // bot-shaped and returns 412/418.
    'user-agent':
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    accept: 'application/json',
    referer: opts.referer ?? `${SITE}/`,
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
  if (opts.locationId || opts.postalCode) {
    const loc = {
      intent: 'PICKUP',
      storeIntent: 'PICKUP',
      mergeFlag: true,
      isExplicitIntent: true,
      ...(opts.locationId ? { pickup: { nodeId: opts.locationId, timestamp: Date.now() } } : {}),
      ...(opts.postalCode ? { postalCode: { base: opts.postalCode, timestamp: Date.now() } } : {}),
    };
    h.cookie = `locGuestData=${encodeURIComponent(JSON.stringify(loc))}`;
  }
  return h;
}

async function persistedQuery(path, operation, opts, body) {
  // Mirrors server/src/adapters/http.ts fetchText: GET request with `?variables=...`,
  // NOT a POST. Body is only sent when opts.body is set explicitly.
  const url = `${SITE}${path}?variables=${encodeURIComponent(JSON.stringify(opts.variables))}`;
  const resp = await fetchImpl(url, {
    method: 'GET',
    headers: walmartHeaders(operation, {
      referer: opts.referer,
      locationId: opts.locationId,
      postalCode: opts.postalCode,
    }),
  });
  const responseText = await resp.text();
  if (resp.status === 412 || resp.status === 429) {
    throw new HttpError(resp.status, url, responseText);
  }
  if (!resp.ok) {
    throw new HttpError(resp.status, url, responseText);
  }
  const json = JSON.parse(responseText);
  if (json.errors && json.errors.length > 0) {
    const text = json.errors.map((e) => e.message ?? 'unknown').join('; ').slice(0, 400);
    throw new Error(`${operation}: ${text}`);
  }
  return json;
}

// ─── In-process pacer + budget ledger (mirrors walmart-api.ts:99 + host-budget.ts)

let nextRequestAt = 0;
const REQUEST_INTERVAL_MS = 20_000;
const REQUEST_JITTER_MS = 12_000;
const RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;
const READS_BUDGET_PER_STORE = 4; // 2 shelves × ~2 pages each; small for POC

const PACE_MS = Number(process.env.WALMART_POC_PACE_MS ?? 1_500);
const PACE_JITTER_MS = Number(process.env.WALMART_POC_PACE_JITTER_MS ?? 800);

function inProcessBudgetState() {
  return globalThis.__wmBudget ?? (globalThis.__wmBudget = { blockedUntil: 0, reads: 0 });
}

function waitMs() {
  const s = inProcessBudgetState();
  const held = Math.max(0, s.blockedUntil - Date.now());
  const interval = Math.max(0, nextRequestAt - Date.now());
  return Math.max(held, interval);
}

async function pace() {
  const wait = waitMs();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  nextRequestAt = Date.now() + PACE_MS + Math.random() * PACE_JITTER_MS;
  const s = inProcessBudgetState();
  s.reads++;
}

// ─── Store finder ──────────────────────────────────────────────────────────

async function nearbyStores(postalCode, radiusMiles = 50) {
  await pace();
  const variables = {
    input: { postalCode, nodeTypes: ['STORE'], accessTypes: ['PICKUP_INSTORE'], radius: radiusMiles },
  };
  const body = await persistedQuery(
    `/orchestra/home/graphql/storeFinderNearbyNodesQuery/${STORE_FINDER_HASH}`,
    'storeFinderNearbyNodesQuery',
    { referer: `${SITE}/store-finder`, variables },
  );
  return (body.data?.nearByNodes?.nodes ?? [])
    .filter((n) => n.id && n.address)
    .map((n) => ({
      id: n.id,
      name: n.displayName ?? n.name ?? `Store ${n.id}`,
      address: `${n.address?.addressLineOne ?? ''}, ${n.address?.city ?? ''}, ${n.address?.state ?? ''} ${(n.address?.postalCode ?? '').slice(0, 5)}`,
      city: n.address?.city ?? '',
      state: n.address?.state ?? '',
      postalCode: (n.address?.postalCode ?? '').slice(0, 5),
      distanceMiles: typeof n.distance === 'string' ? parseFloat(n.distance) : n.distance ?? null,
    }));
}

// ─── Clearance shelf ────────────────────────────────────────────────────────

const BROWSE_FLAGS = {
  tenant: 'WM_GLASS',
  pageType: 'BrowsePage',
  version: 'v2',
  postProcessingVersion: 2,
  prg: 'desktop',
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
  enableFulfillmentTagsEnhancements: false,
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
};

function browseVariables(categoryId, page, pageSize, sort = 'best_match') {
  const searchArgs = { query: '', cat_id: categoryId, prg: 'desktop', facet: CLEARANCE_FACET };
  const shelf = {
    id: '', dealsId: '', query: '', catId: categoryId, cat_id: categoryId,
    facet: CLEARANCE_FACET, rawFacet: '', seoPath: '', page, ps: pageSize, limit: pageSize,
    sort, prg: 'desktop', ptss: '', trsp: '', beShelfId: '', _be_shelf_id: '',
    recall_set: '', module_search: '', min_price: '', max_price: '',
    nudgeContext: '', storeSlotBooked: '',
    additionalQueryParams: {
      hidden_facet: null, translation: null, isMoreOptionsTileEnabled: true,
      rootDimension: '', altQuery: '', selectedFilter: '', neuralSearchSeeAll: false,
      enableGenericItemTileOptions: false, isLMPBrowsePage: false,
    },
    searchArgs,
  };
  return {
    ...BROWSE_FLAGS, ...shelf,
    searchParams: { ...shelf, enableCopyBlock: true, enableESSCarousel: false, enableUnifiedProductFragment: false, enableVariantCount: false, enableVolumePricing: false },
    fitmentSearchParams: { ...shelf, additionalQueryParams: { hidden_facet: null, translation: null, isMoreOptionsTileEnabled: true, rootDimension: '', altQuery: '', selectedFilter: '', neuralSearchSeeAll: false, enableGenericItemTileOptions: false, isLMPBrowsePage: false } },
  };
}

function isPrimaryStack(stack) {
  const beacon = stack.meta?.beacon;
  if (typeof beacon !== 'string') return false;
  try {
    const parsed = JSON.parse(beacon);
    return (parsed.interpretations ?? []).some((i) => i.type === 'primary');
  } catch {
    return false;
  }
}

function centsFromDollars(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

function toClearanceItem(raw) {
  if (!raw.usItemId || !raw.name) return null;
  const price = raw.priceInfo ?? {};
  const status = raw.availabilityStatusV2?.value;
  return {
    itemId: raw.usItemId,
    name: raw.name,
    brand: raw.brand ?? null,
    nowCents: centsFromDollars(price.currentPrice?.price),
    wasCents: centsFromDollars(price.listPrice?.price) ?? centsFromDollars(price.wasPrice?.price),
    savingsCents: centsFromDollars(price.savingsAmount?.amount),
    aisle: raw.productLocation?.[0]?.displayValue ?? null,
    inStock: status === null ? null : status === 'IN_STOCK',
  };
}

function parseShelf(body) {
  const result = body.data?.search?.searchResult;
  const seen = new Set();
  const items = [];
  for (const stack of result?.itemStacks ?? []) {
    const onShelf = isPrimaryStack(stack);
    for (const raw of [...(stack.items ?? []), ...(stack.itemsV2 ?? [])]) {
      if (!onShelf) continue;
      const item = toClearanceItem(raw);
      if (!item || seen.has(item.itemId)) continue;
      seen.add(item.itemId);
      items.push(item);
    }
  }
  return {
    items,
    totalCount: result?.aggregatedCount ?? null,
    storeName: result?.pageMetadata?.storeSelectionHeader?.storeDislayName ?? null,
    maxPage: typeof result?.paginationV2?.maxPage === 'number' ? result.paginationV2.maxPage : null,
  };
}

async function clearanceShelf(opts) {
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? 40;
  await pace();
  const variables = browseVariables(opts.categoryId, page, pageSize, opts.sort);
  const body = await persistedQuery(
    `/orchestra/snb/graphql/Browse/${BROWSE_HASH}`,
    'Browse',
    {
      referer: `${SITE}/browse/${opts.categoryId.replace(/_/g, '/')}`,
      locationId: opts.locationId,
      postalCode: opts.postalCode,
      variables,
    },
    {},
  );
  return parseShelf(body);
}

// ─── POC main ─────────────────────────────────────────────────────────────

async function main() {
  const start = performance.now();
  console.log('== Walmart clearance POC: top-5 Walmarts near ZIP 22963 ==');
  console.log(`   Shelves: ${CLEARANCE_CATEGORIES.map((c) => c.label).join(', ')}`);
  console.log(`   Pacing: ${PACE_MS}ms + 0..${PACE_JITTER_MS}ms jitter per call`);
  console.log(`   Budget: ${READS_BUDGET_PER_STORE} reads per store (POC cap)`);
  console.log();

  // ── 1. Store finder ──
  console.log('--- 1. Store finder ---');
  const stores = await nearbyStores('22963', 50);
  const top5 = stores.slice(0, 5);
  console.log(`Returned ${stores.length} stores; using top ${top5.length}:`);
  for (const [i, s] of top5.entries()) {
    console.log(`  ${i + 1}. #${s.id}  ${s.name}`);
    console.log(`     ${s.address}  (${s.distanceMiles ?? '?'} mi)`);
  }
  console.log();

  // ── 2. Per-store clearance shelf reads ──
  console.log('--- 2. Per-store shelf reads ---');
  let totalItems = 0;
  let totalReads = 0;
  let wrongStoreAbort = 0;
  let rateLimited = 0;
  const allFindings = [];

  for (const store of top5) {
    const state = { store, reads: 0, items: [], shelves: [] };
    console.log(`\n[Store #${store.id}  ${store.name}]`);
    for (const cat of CLEARANCE_CATEGORIES) {
      const budgetLeft = READS_BUDGET_PER_STORE - state.reads;
      if (budgetLeft <= 0) {
        console.log(`  · ${cat.label}: budget exhausted (${state.reads} reads)`);
        break;
      }
      try {
        const t0 = performance.now();
        const shelf = await clearanceShelf({
          locationId: store.id,
          postalCode: store.postalCode,
          categoryId: cat.id,
          page: 1,
          pageSize: 40,
          sort: 'best_match',
        });
        const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
        state.reads += 1;
        totalReads += 1;
        // Sanity: the response must echo the store we asked for. If it doesn't,
        // we abort the rest of the run for this store (WrongStoreError policy
        // from clearance-sweep.ts:50).
        if (shelf.storeName && !shelf.storeName.toLowerCase().includes(store.name.toLowerCase().split(' ')[0])) {
          wrongStoreAbort++;
          console.log(`  · ${cat.label}: ABORT — response named a different store ("${shelf.storeName}", expected ${store.name})`);
          console.log(`    ↳ Walmart resolves store from egress IP; this server isn't in Virginia. The shelf is real, just for the wrong town.`);
          state.shelves.push({ category: cat.label, error: `wrong-store: ${shelf.storeName}` });
          break;
        }
        state.shelves.push({
          category: cat.label,
          storeName: shelf.storeName,
          totalCount: shelf.totalCount,
          itemCount: shelf.items.length,
          maxPage: shelf.maxPage,
          elapsed,
        });
        state.items.push(...shelf.items);
        console.log(
          `  · ${cat.label}  (${elapsed}s)  total=${shelf.totalCount ?? '?'}  items=${shelf.items.length}  maxPage=${shelf.maxPage ?? '?'}  store=${shelf.storeName ?? '?'}`,
        );
        if (shelf.items.length > 0) {
          totalItems += shelf.items.length;
          for (const item of shelf.items) {
            allFindings.push({ ...item, store: store.id, storeName: store.name, category: cat.slug });
          }
        }
      } catch (err) {
        if (err instanceof HttpError && (err.status === 412 || err.status === 429)) {
          rateLimited++;
          console.log(`  · ${cat.label}: RATE-LIMITED (${err.status}) — standing down this run`);
          console.log(`    ↳ PerimeterX flagged this IP. Either wait, switch egress (residential proxy per W-9), or stop.`);
          state.shelves.push({ category: cat.label, error: `rate-limited: HTTP ${err.status}` });
          // Persist a cooldown for any remaining stores in this run.
          const budget = inProcessBudgetState();
          budget.blockedUntil = Math.max(budget.blockedUntil, Date.now() + RATE_LIMIT_COOLDOWN_MS);
          break;
        }
        if (err instanceof Error && /HashExpired/i.test(err.name)) {
          console.log(`  · ${cat.label}: HASH EXPIRED — abort run`);
          state.shelves.push({ category: cat.label, error: 'hash-expired' });
          break;
        }
        console.log(`  · ${cat.label}: ERROR  ${err.message.slice(0, 120)}`);
        state.shelves.push({ category: cat.label, error: err.message });
      }
    }
    console.log(`  → reads=${state.reads}, items=${state.items.length}`);
  }

  // ── 3. Summary ──
  const elapsed = ((performance.now() - start) / 1000).toFixed(2);
  console.log('\n=== SUMMARY ===');
  console.log(`Stores queried:    ${top5.length}`);
  console.log(`Total reads made:  ${totalReads}`);
  console.log(`Items found:       ${totalItems}`);
  console.log(`Wrong-store aborts:${wrongStoreAbort}`);
  console.log(`Rate-limited hits:${rateLimited}`);
  console.log(`Elapsed:           ${elapsed}s`);

  if (wrongStoreAbort > 0) {
    console.log('\n⚠️  Wrong-store results are expected from a non-Virginia IP.');
    console.log('   The POC code works; the data is gated to a non-Virginia store.');
    console.log('   To get real 22963-area data, run this from a Virginia-residential IP,');
    console.log('   or use the IPRoyal proxy with _country-us_state-virginia (US east coast node).');
    console.log('   Walmart resolves the answering store from the egress IP, not from the ZIP we send.');
  }

  if (allFindings.length > 0) {
    console.log('\n--- Finds (first 25) ---');
    for (const f of allFindings.slice(0, 25)) {
      const now = f.nowCents != null ? `$${(f.nowCents / 100).toFixed(2)}` : '?';
      const was = f.wasCents != null ? `(was $${(f.wasCents / 100).toFixed(2)})` : '';
      const save = f.savingsCents != null ? `[save $${(f.savingsCents / 100).toFixed(2)}]` : '';
      console.log(`  [${f.category.padEnd(15)}] ${f.name.slice(0, 60).padEnd(60)} ${now} ${was} ${save}  [store #${f.store} aisle=${f.aisle ?? '?'}]`);
    }
  } else {
    console.log('\nNo clearance items found on the queried shelves.');
  }
}

main().catch((err) => {
  console.error('POC failed:', err);
  process.exit(1);
});