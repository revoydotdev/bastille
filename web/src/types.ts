export type StoreId = 'foodlion' | 'wegmans';

export type PromoKind =
  | 'none' | 'sale' | 'bogo' | 'bxgy' | 'multibuy'
  | 'percent_off' | 'amount_off' | 'loyalty' | 'coupon' | 'unknown';

export interface PromoDetail {
  buyQty?: number;
  getQty?: number;
  bundleCents?: number;
  percentOff?: number;
  amountOffCents?: number;
  requiresLoyalty?: boolean;
  limitQty?: number;
}

export interface PriceSnapshot {
  regularCents: number | null;
  currentCents: number | null;
  effectiveUnitCents: number | null;
  promoKind: PromoKind;
  promoText: string | null;
  promoDetail: PromoDetail | null;
  unitPriceText: string | null;
  inStock: boolean | null;
  capturedAt: string;
}

export interface Product {
  storeId: StoreId;
  storeProductId: string;
  name: string;
  brand: string | null;
  size: string | null;
  imageUrl: string | null;
  productUrl: string | null;
  category: string | null;
}

export interface Offer {
  product: Product;
  price: PriceSnapshot;
}

export interface SearchResult {
  storeId: StoreId;
  storeLabel: string;
  offer: Offer;
  promoLabel: string | null;
  discountPct: number | null;
  watchedGroupIds: number[];
}

export interface DealRow {
  storeId: StoreId;
  storeProductId: string;
  name: string;
  brand: string | null;
  size: string | null;
  category: string | null;
  imageUrl: string | null;
  productUrl: string | null;
  regularCents: number | null;
  currentCents: number | null;
  effectiveUnitCents: number | null;
  discountPct: number | null;
  promoKind: PromoKind;
  promoText: string | null;
  unitPriceText: string | null;
  inStock: boolean | null;
}

export interface DealsResponse {
  source: 'snapshot' | 'live';
  date: string | null;
  total: number;
  rows: DealRow[];
}

export interface DealFilters {
  minDiscount: number;
  promoKinds: PromoKind[];
  onSale: boolean;
  stores: StoreId[];
  sort: 'discount' | 'price' | 'name';
}

export interface SnapshotStatus {
  lastRun: { date: string; startedAt: string; finishedAt: string | null; rows: number; error: string | null } | null;
  latestDate: string | null;
  dates: string[];
  running: boolean;
}

export interface StoredProduct extends Product {
  id: number;
}

export interface WatchEntry {
  watchItemId: number;
  product: StoredProduct;
  locationId: string | null;
  price: PriceSnapshot | null;
  previousPrice: PriceSnapshot | null;
}

export interface WatchGroup {
  id: number;
  label: string;
  createdAt: string;
  targetCents: number | null;
  notifyPromos: boolean;
  items: WatchEntry[];
  bestCents: number | null;
  bestStoreId: StoreId | null;
}

export interface Alert {
  id: number;
  createdAt: string;
  kind: string;
  numeric: boolean;
  severity: 'info' | 'notable' | 'urgent';
  fromCents: number | null;
  toCents: number | null;
  deltaCents: number | null;
  deltaPercent: number | null;
  message: string;
  acknowledged: boolean;
  productName: string;
  storeId: StoreId;
  groupId: number | null;
  groupLabel: string | null;
}

export interface StoreLocation {
  storeId: StoreId;
  locationId: string;
  name: string;
  address: string | null;
  postalCode: string | null;
  distanceMiles?: number | null;
}

export interface StoreInfo {
  id: StoreId;
  label: string;
  defaultLocationId: string;
  /** false when the chain publishes one price for every store */
  pricesVaryByLocation: boolean;
  locations: StoreLocation[];
  error: string | null;
}

export interface StoresResponse {
  zip: string | null;
  zipResolved: boolean;
  zipPrecision: 'exact' | 'approximate' | null;
  stores: StoreInfo[];
}

/** The store the shopper picked for each chain, plus the ZIP that found them. */
export interface StoreSelection {
  zip: string;
  foodlion: string | null;
  wegmans: string | null;
}

// ---- Walmart in-store clearance -------------------------------------------

export type ClearanceGroup = 'pc-parts' | 'video-games' | 'electronics';

export interface ClearanceCategory {
  id: string;
  slug: string;
  label: string;
}

export interface ClearanceGroupOption {
  id: ClearanceGroup;
  label: string;
}

export interface ClearanceStore {
  locationId: string;
  name: string;
  address: string;
  city: string;
  state: string;
  postalCode: string;
  distanceMiles: number | null;
  enabled: boolean;
  discoveredZip: string | null;
  lastSweptAt: string | null;
}

export interface ClearanceRow {
  id: number;
  sweepDate: string;
  locationId: string;
  storeName: string;
  storeCity: string | null;
  distanceMiles: number | null;
  itemId: string;
  categorySlug: string;
  group: ClearanceGroup;
  categoryPath: string | null;
  department: string | null;
  name: string;
  brand: string | null;
  imageUrl: string | null;
  productUrl: string | null;
  nowCents: number | null;
  wasCents: number | null;
  savingsCents: number | null;
  discountPct: number | null;
  /** in-store shelf location, e.g. "K14" */
  aisle: string | null;
  inStock: boolean | null;
  isNew: boolean;
}

export interface ClearanceResponse {
  date: string | null;
  total: number;
  rows: ClearanceRow[];
}

export interface DealMonitor {
  minDiscount: number;
  groups: ClearanceGroup[];
  enabled: boolean;
  updatedAt: string;
}

export interface ClearanceDealsResponse extends ClearanceResponse {
  monitor: DealMonitor;
}

export interface SweepRun {
  date: string;
  startedAt: string;
  finishedAt: string | null;
  storesSwept: number;
  finds: number;
  error: string | null;
}

export interface SweepProgress {
  storesTotal: number;
  storesDone: number;
  currentStore: string | null;
  currentCategory: string | null;
  finds: number;
  rateLimited: number;
  startedAt: string;
}

export interface ClearanceStatus {
  lastSweep: SweepRun | null;
  sweeping: boolean;
  progress: SweepProgress | null;
  latestDate: string | null;
  enabledStores: number;
}

export interface ClearanceWatch {
  id: number;
  term: string;
  maxCents: number | null;
  minDiscount: number | null;
  createdAt: string;
}

export interface ClearanceFilters {
  stores: string[];
  groups: ClearanceGroup[];
  q: string;
  minDiscount: number;
  maxPrice: number | null;
  maxDistance: number | null;
  newOnly: boolean;
  sort: 'discount' | 'price' | 'distance' | 'name';
}
