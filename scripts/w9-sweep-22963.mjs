#!/usr/bin/env node
/**
 * Driver: run the Walmart clearance sweep across the top-5 Walmarts near ZIP
 * 22963, switching the egress IP per store (W-9 federation).
 *
 * For each store, builds a per-store proxy URL by appending the store's
 * postal code as a geo suffix to the IPRoyal base password, runs the existing
 * `clearanceShelf` through that proxy, and prints what comes back.
 *
 * Run: node scripts/w9-sweep-22963.mjs
 *
 * ---- KNOWN LIMITATION (verified live 2026-10-11) ----
 * Walmart's edge IP→store mapping does NOT behave as the W-9 design
 * assumes. Through every US east-coast residential IP we tested (VA
 * Ashburn, MD Baltimore, NC Charlotte, MA Worcester, CT Moosup, DE
 * Hockessin, ME Scarborough), Walmart answers for "Sacramento
 * Supercenter" — its commercial-IP default — regardless of the locGuestData
 * cookie the script sets. So one IP from this proxy pool cannot reach a VA
 * store. The run returns `wrong-store` aborts for every store and finds
 * nothing.
 *
 * What this POC DOES prove: the wire-in is correct end-to-end.
 *   - server/src/adapters/http.ts: `fetchText` accepts a per-call dispatcher.
 *   - server/src/clearance/walmart-api.ts: `persistedQuery` builds a
 *     per-call ProxyAgent, threads `proxyUrl` + `egressNodeId`, and keeps
 *     the host budget keyed by `(host, nodeId)`.
 *   - server/src/clearance/repo.ts: CRUD for `egress_node` rows plus
 *     `setStoreEgressNode()`.
 *   - server/src/clearance/routes.ts: `/api/clearance/egress-nodes` and
 *     `/api/clearance/store/egress`.
 *   - server/src/jobs/clearance-sweep.ts: `installEgressBudgets()` +
 *     per-store proxy resolution.
 *
 * What the POC does NOT prove (and is blocked on): actually *reaching
 * multiple stores* via residential IPs. That requires either (a) a proxy
 * pool with a wider US east-coast footprint whose IPs map to distinct
 * Walmart store zones, or (b) finding a different store-resolution signal
 * in the persisted-query variables that overrides the egress-IP default.
 * The current variable set already passes `postalCode` in `locGuestData`;
 * Walmart ignores it for this endpoint.
 */

import { performance } from 'node:perf_hooks';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

// ─── config ────────────────────────────────────────────────────────────────

const ZIP = process.env.WALMART_ZIP ?? '22963';
const USER = process.env.WALMART_PROXY_USER ?? 'NHWWUHKZcJLxuBVM';
const PASS = process.env.WALMART_PROXY_PASS ?? 'yD0mxSVqHrpyUeyb';
const GATEWAY = process.env.WALMART_PROXY_GATEWAY ?? 'geo.iproyal.com:12321';
const TOP_N = Number(process.env.WALMART_TOP_N ?? 5);
const PACE_MS = Number(process.env.WALMART_POC_PACE_MS ?? 20_000);
const PACE_JITTER_MS = Number(process.env.WALMART_POC_PACE_JITTER_MS ?? 8_000);

// Maps a Walmart US state code (e.g. "VA", "CA") to the full state name
// IPRoyal's state selector uses. Verified 2026-10-11 — `_state-va` returns
// 503 (unknown code); `_state-virginia` works.
const US_STATE_CODE_TO_NAME = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas',
  CA: 'california', CO: 'colorado', CT: 'connecticut', DE: 'delaware',
  DC: 'district-of-columbia', FL: 'florida', GA: 'georgia', HI: 'hawaii',
  ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa',
  KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine',
  MD: 'maryland', MA: 'massachusetts', MI: 'michigan', MN: 'minnesota',
  MS: 'mississippi', MO: 'missouri', MT: 'montana', NE: 'nebraska',
  NV: 'nevada', NH: 'new-hampshire', NJ: 'new-jersey', NM: 'new-mexico',
  NY: 'new-york', NC: 'north-carolina', ND: 'north-dakota', OH: 'ohio',
  OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania', RI: 'rhode-island',
  SC: 'south-carolina', SD: 'south-dakota', TN: 'tennessee', TX: 'texas',
  UT: 'utah', VT: 'vermont', VA: 'virginia', WA: 'washington',
  WV: 'west-virginia', WI: 'wisconsin', WY: 'wyoming',
};

function stateToSelector(state) {
  if (!state) return '';
  // If already a full name (no code), lowercase + hyphenate.
  if (state.length > 2) return state.toLowerCase().replace(/\s+/g, '-');
  // Otherwise, treat as a 2-letter USPS code and look up the name.
  return US_STATE_CODE_TO_NAME[state.toUpperCase()] ?? state.toLowerCase();
}

// Maps a US state code to a representative city/region pair that IPRoyal
// has a residential pool for. For states not in this map we fall back to
// the store's postal code prefix. Verified live 2026-10-11 via the proxy
// pool: VA -> ashburn (real), MD -> baltimore (real), NC -> real, etc.
const STATE_FALLBACK_CITY = {
  VA: 'ashburn',
  MD: 'baltimore',
  NC: 'charlotte',
  SC: 'charleston',
  GA: 'atlanta',
  FL: 'miami',
  NY: 'new_york',
  PA: 'pittsburgh',
  CT: 'hartford',
  DE: 'wilmington',
  MA: 'boston',
  OH: 'columbus',
  ME: 'scarborough',
  VT: 'burlington',
};

// ─── Walmart + helpers (mirrors scripts/poc-clearance-22963.mjs) ─────────

const SITE = 'https://www.walmart.com';
const STORE_FINDER_HASH =
  '23594c3a307d6359f419a4247d6212be409ec7b74fb8963f5402147bed22e7fb';
const BROWSE_HASH =
  '8aa4d8ce0587319fb70bdafd8d6a70e873cdc85ae79de801a21da658d1457f12';
const CLEARANCE_FACET = 'special_offers:Clearance||fulfillment_method:In-store';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

let nextRequestAt = 0;
let proxyAgent = null;
function setProxy(url) {
  if (url) {
    proxyAgent = new ProxyAgent({ uri: url, pipelining: 0 });
  } else {
    proxyAgent = null;
  }
}
async function pace() {
  const wait = Math.max(0, nextRequestAt - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  nextRequestAt = Date.now() + PACE_MS + Math.random() * PACE_JITTER_MS;
}

function headers(operation, opts = {}) {
  const h = {
    'user-agent': UA,
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
    'wm_qos.correlation_id': crypto.randomUUID(),
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

async function persistedQuery(path, operation, variables, opts = {}) {
  await pace();
  const url = `${SITE}${path}?variables=${encodeURIComponent(JSON.stringify(variables))}`;
  const init = { method: 'GET', headers: headers(operation, opts) };
  if (proxyAgent) init.dispatcher = proxyAgent;
  const r = await undiciFetch(url, init);
  const t = await r.text();
  if (r.status === 412 || r.status === 429) {
    throw new Error(`rate-limited HTTP ${r.status}: ${t.slice(0, 200)}`);
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
  const j = JSON.parse(t);
  if (j.errors?.length > 0) {
    throw new Error(`${operation}: ${j.errors.map((e) => e.message).join('; ').slice(0, 200)}`);
  }
  return j;
}

// ─── W-9 federation: build a per-store proxy URL ─────────────────────────
//
// Each store gets a different US east-coast egress IP. The list is ordered
// so that geographically-distant stores get more-distant egresses — Walmart
// resolves to the closest store to the egress IP, and we want each call
// to land on a different store.
//
// If a state isn't in STATE_FALLBACK_CITY, we fall back to the store's
// own state (which will route to whichever city IPRoyal has for that state).
const FALLBACK_EGRESS_STATES = ['VA', 'MD', 'NC', 'PA', 'DE', 'GA', 'NY', 'CT'];

function proxyUrlForStore(store, index) {
  // Pick a state. Prefer the store's own state; otherwise rotate through
  // FALLBACK_EGRESS_STATES so each store in this run gets a distinct IP.
  const preferred = STATE_FALLBACK_CITY[store.state] ? store.state : null;
  const state = preferred ?? FALLBACK_EGRESS_STATES[index % FALLBACK_EGRESS_STATES.length];
  const city = STATE_FALLBACK_CITY[state] ?? store.city.toLowerCase().replace(/\s+/g, '_');
  const suffix = `_country-us_state-${stateToSelector(state)}_city-${city}`;
  return `http://${USER}:${PASS}${suffix}@${GATEWAY}`;
}

// ─── main ─────────────────────────────────────────────────────────────────

async function nearbyStores(postalCode, radius = 50) {
  const body = await persistedQuery(
    `/orchestra/home/graphql/storeFinderNearbyNodesQuery/${STORE_FINDER_HASH}`,
    'storeFinderNearbyNodesQuery',
    { input: { postalCode, nodeTypes: ['STORE'], accessTypes: ['PICKUP_INSTORE'], radius } },
    { referer: `${SITE}/store-finder` },
  );
  return (body.data?.nearByNodes?.nodes ?? [])
    .filter((n) => n.id && n.geoPoint?.latitude != null)
    .map((n) => ({
      id: n.id,
      name: n.displayName ?? n.name ?? `Store ${n.id}`,
      address: n.address?.addressLineOne ?? '',
      city: n.address?.city ?? '',
      state: n.address?.state ?? '',
      postalCode: (n.address?.postalCode ?? '').slice(0, 5),
      point: { lat: n.geoPoint.latitude, lng: n.geoPoint.longitude },
      distanceMiles: n.nodeDistance?.unitOfMeasure === 'MI' ? (n.nodeDistance?.value ?? null) : null,
    }));
}

const BROWSE_FLAGS = {
  tenant: 'WM_GLASS', pageType: 'BrowsePage', version: 'v2', postProcessingVersion: 2,
  prg: 'desktop', fetchDataV1: true, fetchDataV2: false, fetchMarquee: false,
  fetchSkyline: false, fetchSbaTop: false, fetchDac: false, fetchGallery: false,
  fungibilityEnabled: false, enableUnifiedSchema: true, enablePortableFacets: true,
  enableFacetCount: true, enablePromoData: true, enableCopyBlock: true,
  enableSlaBadgeV2: true, enableGenericSeo: true, enablePartialRenderingDGF: true,
  enableCachingOnEmptyResultsForBrowseAndSearch: true, enableAdsPromoData: false,
  enableAdsUnifiedProductTile: false, enableCanAddToList: false,
  enableDebugAnalyticsTags: false, enableESSCarousel: false, enableFashionTopNav: false,
  enableFulfillmentTagsEnhancements: false, enableHero4: false,
  enableImageBannerCarousel: false, enableInStoreShelfMessage: false,
  enableIsFreeWarranty: false, enableItemLimits: false, enableItemRank: false,
  enableMultiSave: false, enableOptimisticWeightUpdate: false,
  enablePromotionMessages: false, enableRxDrugScheduleModal: false,
  enableSellerType: false, enableSeoBrowseMetaDataShortDesc: false,
  enableSeoLangUrl: false, enableShopSimilarBottomSheet: false,
  enableSignInToSeePrice: false, enableSimpleEmailSignUp: false,
  enableUnifiedProductFragment: false, enableVariantCount: false,
  enableVolumePricing: false,
  fitmentFieldParams: {
    powerSportEnabled: true, dynamicFitmentEnabled: true,
    extendedAttributesEnabled: true, extendedAttributesV2Enabled: true, fuelTypeEnabled: true,
  },
};

const EMPTY_QUERY_PARAMS = {
  hidden_facet: null, translation: null, isMoreOptionsTileEnabled: true,
  rootDimension: '', altQuery: '', selectedFilter: '', neuralSearchSeeAll: false,
  enableGenericItemTileOptions: false, isLMPBrowsePage: false,
};

function browseVariables(categoryId, page, pageSize, sort = 'best_match') {
  const searchArgs = { query: '', cat_id: categoryId, prg: 'desktop', facet: CLEARANCE_FACET };
  const shelf = {
    id: '', dealsId: '', query: '', catId: categoryId, cat_id: categoryId,
    facet: CLEARANCE_FACET, rawFacet: '', seoPath: '', page, ps: pageSize, limit: pageSize,
    sort, prg: 'desktop', ptss: '', trsp: '', beShelfId: '', _be_shelf_id: '',
    recall_set: '', module_search: '', min_price: '', max_price: '',
    nudgeContext: '', storeSlotBooked: '',
    additionalQueryParams: EMPTY_QUERY_PARAMS,
    searchArgs,
  };
  return {
    ...BROWSE_FLAGS, ...shelf,
    searchParams: { ...shelf, enableCopyBlock: true, enableESSCarousel: false, enableUnifiedProductFragment: false, enableVariantCount: false, enableVolumePricing: false },
    fitmentSearchParams: { ...shelf, additionalQueryParams: EMPTY_QUERY_PARAMS },
  };
}

function isPrimaryStack(stack) {
  const beacon = stack.meta?.beacon;
  if (typeof beacon !== 'string') return false;
  try {
    const parsed = JSON.parse(beacon);
    return (parsed.interpretations ?? []).some((i) => i.type === 'primary');
  } catch { return false; }
}

function centsFromDollars(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.round(v * 100);
}

function toClearanceItem(raw) {
  if (!raw.usItemId || !raw.name) return null;
  const price = raw.priceInfo ?? {};
  return {
    itemId: raw.usItemId,
    name: raw.name,
    brand: raw.brand ?? null,
    nowCents: centsFromDollars(price.currentPrice?.price),
    wasCents: centsFromDollars(price.listPrice?.price) ?? centsFromDollars(price.wasPrice?.price),
    savingsCents: centsFromDollars(price.savingsAmount?.amount),
    aisle: raw.productLocation?.[0]?.displayValue ?? null,
    inStock: raw.availabilityStatusV2?.value === 'IN_STOCK',
  };
}

function parseShelf(body) {
  const result = body.data?.search?.searchResult;
  const seen = new Set();
  const items = [];
  for (const stack of result?.itemStacks ?? []) {
    if (!isPrimaryStack(stack)) continue;
    for (const raw of [...(stack.items ?? []), ...(stack.itemsV2 ?? [])]) {
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
  const body = await persistedQuery(
    `/orchestra/snb/graphql/Browse/${BROWSE_HASH}`,
    'Browse',
    browseVariables(opts.categoryId, opts.page ?? 1, opts.pageSize ?? 40, opts.sort),
    {
      referer: `${SITE}/browse/${opts.categoryId.replace(/_/g, '/')}`,
      locationId: opts.locationId,
      postalCode: opts.postalCode,
    },
  );
  return parseShelf(body);
}

// ─── main loop ───────────────────────────────────────────────────────────

async function main() {
  const t0 = performance.now();
  console.log('=== W-9 sweep: top', TOP_N, 'Walmarts near', ZIP, '===');
  console.log('  IPC proxy: per-store US residential node');
  console.log('  Pacing:    ', PACE_MS, 'ms + 0..', PACE_JITTER_MS, 'ms jitter');
  console.log();

  // 1. Store finder. This call doesn't need a proxy — it works from any
  //    egress — but we do it through the proxy to keep the run reproducible.
  setProxy(`http://${USER}:${PASS}@${GATEWAY}`);
  console.log('--- 1. Store finder ---');
  const stores = (await nearbyStores(ZIP, 50)).slice(0, TOP_N);
  for (const [i, s] of stores.entries()) {
    console.log(`  ${i + 1}. #${s.id}  ${s.name}`);
    console.log(`     ${s.address}, ${s.city}, ${s.state} ${s.postalCode}  (${s.distanceMiles} mi)`);
  }
  console.log();

  // 2. For each store, dial the proxy for that store's geography and read
  //    two shelves (Electronics, Video games). Each call is on a fresh
  //    residential IP, so each store's host_budget window is independent.
  const allFindings = [];
  let totalReads = 0;
  let totalAborts = 0;

  for (const [i, store] of stores.entries()) {
    const proxy = proxyUrlForStore(store, i);
    // Mask only the user:pass@ part, keep the geo suffix visible.
    const masked = proxy.replace(/\/\/[^@]+@/, '//***@');
    console.log(`\n[Store #${store.id}  ${store.name}]`);
    console.log(`  proxy: ${masked}`);
    setProxy(proxy);

    let storeReads = 0;
    for (const cat of [
      { id: '3944', label: 'Electronics' },
      { id: '2636', label: 'Video games' },
    ]) {
      try {
        const t1 = performance.now();
        const shelf = await clearanceShelf({
          locationId: store.id,
          postalCode: store.postalCode,
          categoryId: cat.id,
          page: 1,
          pageSize: 40,
          sort: 'best_match',
        });
        const elapsed = ((performance.now() - t1) / 1000).toFixed(2);
        storeReads++;
        totalReads++;

        // The "answered-for" store name. If it doesn't match the store we
        // asked for, the egress IP is in the wrong metro and the data is for
        // some other town. Skip — same rule as the real sweep (WrongStoreError).
        if (shelf.storeName && !shelf.storeName.toLowerCase().includes(store.name.toLowerCase().split(' ')[0])) {
          totalAborts++;
          console.log(`  · ${cat.label}  (${elapsed}s)  ABORT — answered for "${shelf.storeName}" (not ${store.name})`);
          console.log(`    ↳ wrong metro: proxy routed to a different US node`);
          continue;
        }

        console.log(
          `  · ${cat.label}  (${elapsed}s)  total=${shelf.totalCount ?? '?'}  items=${shelf.items.length}  maxPage=${shelf.maxPage ?? '?'}  store=${shelf.storeName ?? '?'}`,
        );
        for (const item of shelf.items) {
          allFindings.push({ ...item, store: store.id, storeName: store.name, category: cat.label });
        }
      } catch (err) {
        storeReads++;
        totalReads++;
        console.log(`  · ${cat.label}  ERROR  ${err.message?.slice(0, 120) ?? err}`);
        console.log(`    stack: ${err.stack?.split('\n').slice(0, 3).join(' | ') ?? '(no stack)'}`);
        if (/rate-limited/i.test(err.message ?? '')) {
          console.log(`    ↳ standing down for this run`);
          break;
        }
      }
    }
    console.log(`  → reads=${storeReads}, items=${allFindings.filter((f) => f.store === store.id).length}`);
  }

  const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
  console.log('\n=== SUMMARY ===');
  console.log(`Stores queried:        ${stores.length}`);
  console.log(`Total reads made:      ${totalReads}`);
  console.log(`Items found:           ${allFindings.length}`);
  console.log(`Wrong-store aborts:    ${totalAborts}`);
  console.log(`Elapsed:               ${elapsed}s`);

  if (allFindings.length > 0) {
    console.log('\n--- Finds (first 30) ---');
    for (const f of allFindings.slice(0, 30)) {
      const now = f.nowCents != null ? `$${(f.nowCents / 100).toFixed(2)}` : '?';
      const was = f.wasCents != null ? `(was $${(f.wasCents / 100).toFixed(2)})` : '';
      const save = f.savingsCents != null ? `[save $${(f.savingsCents / 100).toFixed(2)}]` : '';
      console.log(`  [${f.storeName.padEnd(34)}] ${f.name.slice(0, 50).padEnd(50)} ${now} ${was} ${save}  [aisle=${f.aisle ?? '?'}]`);
    }
  }
}

main().catch((err) => {
  console.error('W-9 sweep failed:', err);
  process.exit(1);
});