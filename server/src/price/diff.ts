/**
 * Turns two consecutive price snapshots into the set of user-visible changes.
 *
 * Numeric and non-numeric changes are first-class and independent: a promotion
 * can start without the shelf price moving (BOGO on an unchanged $4.99), and a
 * shelf price can move without any promotion. Both must alert.
 */
import type { PriceSnapshot } from './model.js';
import { describePromo } from './promo.js';

export type ChangeKind =
  | 'price_drop'
  | 'price_rise'
  | 'promo_started'
  | 'promo_ended'
  | 'promo_changed'
  | 'back_in_stock'
  | 'out_of_stock';

export interface PriceChange {
  kind: ChangeKind;
  /** true when the change is a numeric movement the shopper can subtract */
  numeric: boolean;
  fromCents: number | null;
  toCents: number | null;
  deltaCents: number | null;
  /** signed percent, negative for a drop */
  deltaPercent: number | null;
  message: string;
}

function pct(from: number, to: number): number {
  return Math.round(((to - from) / from) * 1000) / 10;
}

/**
 * @param minDeltaCents ignore numeric noise below this threshold (rounding,
 *                      per-store tax display quirks). Promo changes are never
 *                      suppressed by it — they are categorical.
 */
export function diffSnapshots(
  prev: PriceSnapshot,
  next: PriceSnapshot,
  minDeltaCents = 1,
): PriceChange[] {
  const changes: PriceChange[] = [];

  const from = prev.effectiveUnitCents;
  const to = next.effectiveUnitCents;
  if (from !== null && to !== null && Math.abs(to - from) >= minDeltaCents) {
    const delta = to - from;
    changes.push({
      kind: delta < 0 ? 'price_drop' : 'price_rise',
      numeric: true,
      fromCents: from,
      toCents: to,
      deltaCents: delta,
      deltaPercent: from === 0 ? null : pct(from, to),
      message:
        delta < 0
          ? `Price dropped $${(Math.abs(delta) / 100).toFixed(2)} to $${(to / 100).toFixed(2)}`
          : `Price rose $${(delta / 100).toFixed(2)} to $${(to / 100).toFixed(2)}`,
    });
  }

  const prevPromo = prev.promoKind;
  const nextPromo = next.promoKind;
  const prevText = describePromo(prevPromo, prev.promoDetail, prev.promoText);
  const nextText = describePromo(nextPromo, next.promoDetail, next.promoText);

  if (prevPromo === 'none' && nextPromo !== 'none') {
    changes.push({
      kind: 'promo_started',
      numeric: false,
      fromCents: from,
      toCents: to,
      deltaCents: from !== null && to !== null ? to - from : null,
      deltaPercent: from !== null && to !== null && from !== 0 ? pct(from, to) : null,
      message: `New offer: ${nextText ?? nextPromo}`,
    });
  } else if (prevPromo !== 'none' && nextPromo === 'none') {
    changes.push({
      kind: 'promo_ended',
      numeric: false,
      fromCents: from,
      toCents: to,
      deltaCents: from !== null && to !== null ? to - from : null,
      deltaPercent: null,
      message: `Offer ended: ${prevText ?? prevPromo}`,
    });
  } else if (prevPromo !== 'none' && nextPromo !== 'none' && (prevPromo !== nextPromo || prevText !== nextText)) {
    changes.push({
      kind: 'promo_changed',
      numeric: false,
      fromCents: from,
      toCents: to,
      deltaCents: from !== null && to !== null ? to - from : null,
      deltaPercent: null,
      message: `Offer changed: ${prevText ?? prevPromo} → ${nextText ?? nextPromo}`,
    });
  }

  if (prev.inStock === true && next.inStock === false) {
    changes.push({ kind: 'out_of_stock', numeric: false, fromCents: from, toCents: to, deltaCents: null, deltaPercent: null, message: 'Out of stock' });
  } else if (prev.inStock === false && next.inStock === true) {
    changes.push({ kind: 'back_in_stock', numeric: false, fromCents: from, toCents: to, deltaCents: null, deltaPercent: null, message: 'Back in stock' });
  }

  return changes;
}

/** Alert severity drives ordering and whether a push notification fires. */
export function severityOf(change: PriceChange): 'info' | 'notable' | 'urgent' {
  switch (change.kind) {
    case 'price_drop': {
      const p = change.deltaPercent;
      if (p !== null && p <= -20) return 'urgent';
      if (p !== null && p <= -5) return 'notable';
      return 'info';
    }
    case 'promo_started':
      return 'urgent';
    case 'back_in_stock':
      return 'notable';
    case 'promo_changed':
    case 'promo_ended':
    case 'out_of_stock':
      return 'notable';
    case 'price_rise':
      return 'info';
  }
}
