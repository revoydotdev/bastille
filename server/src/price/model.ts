/**
 * Normalized price/promotion model shared by every store adapter.
 *
 * The hard requirement this file exists to satisfy: a grocery offer is not
 * always a number. "$3.49" is comparable by subtraction; "BOGO", "2 for $5",
 * "Buy 2 Get 1 Free", "$1.00 off with card" are not. We keep both — the raw
 * promotional text (so nothing is lost) and a structured interpretation that
 * yields an *effective unit price* wherever one can honestly be derived.
 */

export type StoreId = 'foodlion' | 'wegmans' | 'traderjoes';

/** How an offer is expressed, independent of its numeric value. */
export type PromoKind =
  | 'none' // plain shelf price
  | 'sale' // temporarily reduced numeric price
  | 'bogo' // buy N get N free
  | 'bxgy' // buy X get Y free (Y < X)
  | 'multibuy' // N for $M
  | 'percent_off' // X% off
  | 'amount_off' // $X off
  | 'loyalty' // card/members-only price
  | 'coupon' // requires clipping a digital coupon
  | 'unknown'; // recognised as promotional, not parsed

export interface PromoDetail {
  /** units you must buy to unlock the deal */
  buyQty?: number;
  /** units you receive free/discounted */
  getQty?: number;
  /** for multibuy: the bundle total in cents */
  bundleCents?: number;
  /** for percent_off */
  percentOff?: number;
  /** for amount_off, in cents */
  amountOffCents?: number;
  /** deal requires a loyalty card / clipped coupon to realise */
  requiresLoyalty?: boolean;
  /** deal caps out after this many units */
  limitQty?: number;
}

export interface PriceSnapshot {
  /** undiscounted shelf price in cents, when the store exposes one */
  regularCents: number | null;
  /** price the store is currently advertising, in cents, before promo math */
  currentCents: number | null;
  /**
   * Per-unit price in cents once the promotion is applied, assuming the
   * shopper buys the quantity the deal requires. This is the single field the
   * comparison UI sorts on, and it is what makes BOGO comparable to $2.49.
   * null when the offer cannot be reduced to a number (e.g. "free gift").
   */
  effectiveUnitCents: number | null;
  promoKind: PromoKind;
  /** verbatim promotional copy from the store, never synthesised */
  promoText: string | null;
  promoDetail: PromoDetail | null;
  /** e.g. "$0.21/oz" — kept as text because stores disagree on the unit */
  unitPriceText: string | null;
  inStock: boolean | null;
  /** ISO-8601 */
  capturedAt: string;
}

export interface Product {
  storeId: StoreId;
  /** store's own product identifier — stable join key for price history */
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

export function centsFromDollars(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function formatCents(cents: number | null): string {
  if (cents === null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Percent off the regular unit price, once the promotion is applied. This is
 * the figure the deals filter thresholds on ("70% or more off"). Returns null
 * when it cannot be computed honestly — no regular price, or an offer that
 * doesn't reduce to a number (e.g. an un-parseable promo). A regular price
 * equal to or below the effective price yields 0, never a negative "discount".
 */
export function discountPercent(price: PriceSnapshot): number | null {
  const regular = price.regularCents;
  const effective = price.effectiveUnitCents;
  if (regular === null || regular <= 0 || effective === null) return null;
  if (effective >= regular) return 0;
  return Math.round(((regular - effective) / regular) * 1000) / 10;
}
