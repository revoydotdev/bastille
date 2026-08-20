/**
 * Food Lion store directory.
 *
 * `stores.foodlion.com` is a Yext Pages site and publishes its whole directory
 * as one JSON document — 1,149 stores with coordinates, city, state and street
 * address, plus a postal code per city. It is open: no bot protection, no key.
 *
 * This gives the user a real store to pick. It does NOT give per-store prices:
 * see docs/BACKEND-MAP.md for why Food Lion's public catalogue is national.
 */
import { fetchJson } from './http.js';
import type { Point, ZipAnchor } from '../geo.js';

const INDEX_URL = 'https://stores.foodlion.com/index.json';
const SITE = 'https://stores.foodlion.com';
const TTL_MS = Number(process.env.FOODLION_STORES_TTL_MS ?? 24 * 60 * 60 * 1000);

export interface FoodLionStore {
  /** slug path, e.g. "va/palmyra/264-turkeysag-trail" — the store's identity here */
  id: string;
  street: string;
  city: string;
  state: string;
  postalCode: string | null;
  point: Point;
  url: string;
}

/** Shape of the parts of the Yext directory document we read. */
interface DirNode {
  key?: string;
  url?: string;
  latitude?: number;
  longitude?: number;
  children?: Record<string, DirNode> | null;
  sampleEntity?: { profile?: { address?: { postalCode?: string; region?: string; city?: string } } };
}
interface DirDoc {
  directoryHierarchy?: Record<string, DirNode>;
}

let cache: { stores: FoodLionStore[]; fetchedAt: number } | null = null;
let inflight: Promise<FoodLionStore[]> | null = null;

/**
 * Walks state → city → store. Only city nodes carry a postal code, so each
 * store inherits its city's — enough to search by ZIP, and the exact street
 * address is shown alongside so the choice is never ambiguous.
 */
function flatten(doc: DirDoc): FoodLionStore[] {
  const out: FoodLionStore[] = [];

  const visitCity = (city: DirNode, stateName: string): void => {
    const address = city.sampleEntity?.profile?.address;
    const postalCode = address?.postalCode?.slice(0, 5) ?? null;
    const state = address?.region ?? stateName;
    for (const store of Object.values(city.children ?? {})) {
      if (store.latitude == null || store.longitude == null || !store.url) continue;
      out.push({
        id: store.url,
        street: store.key ?? store.url,
        city: city.key ?? '',
        state,
        postalCode,
        point: { lat: store.latitude, lng: store.longitude },
        url: `${SITE}/${store.url}`,
      });
    }
  };

  const visit = (node: DirNode, stateName: string): void => {
    const children = node.children;
    if (!children) return;
    const first = Object.values(children)[0];
    // A node whose children carry coordinates is a city; anything else is a
    // further level of the state/region hierarchy.
    if (first && first.latitude != null) visitCity(node, stateName);
    else for (const child of Object.values(children)) visit(child, node.key ?? stateName);
  };

  for (const [stateKey, state] of Object.entries(doc.directoryHierarchy ?? {})) {
    visit(state, state.key ?? stateKey.toUpperCase());
  }
  return out;
}

export async function loadStores(): Promise<FoodLionStore[]> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.stores;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const doc = await fetchJson<DirDoc>(INDEX_URL, { timeoutMs: 60_000 });
      const stores = flatten(doc);
      if (stores.length > 0) cache = { stores, fetchedAt: Date.now() };
      return stores;
    } catch (err) {
      // A stale directory beats no store picker at all.
      if (cache) return cache.stores;
      throw err;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export async function zipAnchors(): Promise<ZipAnchor[]> {
  const stores = await loadStores();
  return stores
    .filter((s): s is FoodLionStore & { postalCode: string } => s.postalCode !== null)
    .map((s) => ({ zip: s.postalCode, point: s.point }));
}
