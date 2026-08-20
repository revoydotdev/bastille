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
  watchedGroupIds: number[];
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
}

export interface StoreInfo {
  id: StoreId;
  label: string;
  defaultLocationId: string;
  locations: StoreLocation[];
}
