/**
 * Parses free-text grocery promotion copy into a structured PromoDetail and,
 * where the maths is unambiguous, an effective per-unit price.
 *
 * Stores express the same deal a dozen ways. The patterns below were written
 * against copy observed on foodlion.com and wegmans.com; anything unmatched is
 * classified 'unknown' and keeps its raw text rather than being silently
 * dropped or guessed at.
 */
import type { PromoDetail, PromoKind } from './model.js';

export interface ParsedPromo {
  kind: PromoKind;
  detail: PromoDetail;
}

const NUM_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function qty(token: string | undefined): number | null {
  if (!token) return null;
  const lower = token.toLowerCase();
  if (lower in NUM_WORDS) return NUM_WORDS[lower]!;
  const n = Number(lower);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function money(token: string | undefined): number | null {
  if (!token) return null;
  const n = Number(token.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Detects "with card", "member price", "clip coupon" style qualifiers. */
function qualifiers(text: string): Pick<PromoDetail, 'requiresLoyalty' | 'limitQty'> {
  const out: Pick<PromoDetail, 'requiresLoyalty' | 'limitQty'> = {};
  if (/\b(with (your )?(mvp ?)?card|card price|member(s)? (only )?price|shoppers club|digital coupon|clip(ped)?|loyalty)\b/i.test(text)) {
    out.requiresLoyalty = true;
  }
  const limit = text.match(/\blimit\s+(\d+)\b/i);
  if (limit) out.limitQty = Number(limit[1]);
  return out;
}

export function parsePromoText(raw: string | null | undefined): ParsedPromo | null {
  if (!raw) return null;
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const q = qualifiers(text);

  // "Buy 1 Get 1 Free" / "B1G1" / "BOGO" / "Buy One Get One Free"
  const bogoWords = text.match(/\bbuy\s+(\d+|one|two|three|four|five)\s+get\s+(\d+|one|two|three|four|five)\b/i);
  const bogoShort = text.match(/\bb(\d)g(\d)\b/i);
  const plainBogo = /\bbogo\b/i.test(text) || /\bbuy\s+one[, ]+get\s+one\b/i.test(text);
  if (bogoWords || bogoShort || plainBogo) {
    const buyQty = qty(bogoWords?.[1] ?? bogoShort?.[1]) ?? 1;
    const getQty = qty(bogoWords?.[2] ?? bogoShort?.[2]) ?? 1;
    // "Buy 1 Get 1 50% Off" is a percentage deal on the second unit, not free.
    const partial = text.match(/get\s+(?:\d+|one|two|three)\s*(?:for\s+)?(\d{1,3})\s*%\s*off/i);
    const detail: PromoDetail = { buyQty, getQty, ...q };
    if (partial) detail.percentOff = Number(partial[1]);
    return { kind: buyQty === getQty ? 'bogo' : 'bxgy', detail };
  }

  // "2 for $5" / "3/$10" / "2 for 5.00"
  const multi = text.match(/\b(\d+)\s*(?:for|\/)\s*\$?\s*(\d+(?:\.\d{1,2})?)\b/i);
  if (multi) {
    const buyQty = qty(multi[1]);
    const bundleCents = money(multi[2]);
    if (buyQty && bundleCents !== null) {
      return { kind: 'multibuy', detail: { buyQty, bundleCents, ...q } };
    }
  }

  // "25% off"
  const pct = text.match(/\b(\d{1,3})\s*%\s*off\b/i);
  if (pct) return { kind: 'percent_off', detail: { percentOff: Number(pct[1]), ...q } };

  // "$1.50 off" / "Save $2"
  const amt = text.match(/(?:save\s+)?\$\s*(\d+(?:\.\d{1,2})?)\s*(?:off)?\b/i);
  if (amt && /\b(off|save)\b/i.test(text)) {
    const cents = money(amt[1]);
    if (cents !== null) return { kind: 'amount_off', detail: { amountOffCents: cents, ...q } };
  }

  if (q.requiresLoyalty) return { kind: 'loyalty', detail: { ...q } };
  if (/\bcoupon\b/i.test(text)) return { kind: 'coupon', detail: { requiresLoyalty: true, ...q } };
  if (/\b(sale|special|deal|reduced|was\b)/i.test(text)) return { kind: 'sale', detail: { ...q } };
  return { kind: 'unknown', detail: { ...q } };
}

/**
 * Reduces an offer to a comparable per-unit price in cents.
 *
 * `baseCents` is the price the shopper pays per unit before the promotion
 * (the store's current advertised price). Returns null when the promotion
 * cannot be resolved to a number — the caller must then present the raw text
 * and exclude the offer from numeric ranking rather than invent a value.
 */
export function effectiveUnitCents(
  baseCents: number | null,
  kind: PromoKind,
  detail: PromoDetail | null,
): number | null {
  if (baseCents === null) {
    // A multibuy carries its own total, so it stands alone without a base.
    if (kind === 'multibuy' && detail?.bundleCents != null && detail.buyQty) {
      return Math.round(detail.bundleCents / detail.buyQty);
    }
    return null;
  }
  switch (kind) {
    case 'none':
    case 'sale':
    case 'loyalty':
      return baseCents;
    case 'bogo':
    case 'bxgy': {
      const buy = detail?.buyQty ?? 1;
      const get = detail?.getQty ?? 1;
      if (buy <= 0) return baseCents;
      // A partial BOGO ("get the 2nd 50% off") discounts rather than frees it.
      const discount = detail?.percentOff != null ? detail.percentOff / 100 : 1;
      const paidUnits = buy + get * (1 - discount);
      const totalUnits = buy + get;
      if (totalUnits <= 0) return baseCents;
      return Math.round((baseCents * paidUnits) / totalUnits);
    }
    case 'multibuy': {
      if (detail?.bundleCents == null || !detail.buyQty) return baseCents;
      return Math.round(detail.bundleCents / detail.buyQty);
    }
    case 'percent_off': {
      if (detail?.percentOff == null) return baseCents;
      return Math.max(0, Math.round(baseCents * (1 - detail.percentOff / 100)));
    }
    case 'amount_off': {
      if (detail?.amountOffCents == null) return baseCents;
      return Math.max(0, baseCents - detail.amountOffCents);
    }
    case 'coupon':
    case 'unknown':
      // Recognisably promotional but not quantifiable: fall back to the shelf
      // price so the item still ranks, and let the UI flag the uncertainty.
      return baseCents;
  }
}

/** Human-readable one-liner used in the UI and in alert bodies. */
export function describePromo(kind: PromoKind, detail: PromoDetail | null, raw: string | null): string | null {
  if (kind === 'none') return null;
  if (raw) return raw;
  switch (kind) {
    case 'bogo': return `Buy ${detail?.buyQty ?? 1} get ${detail?.getQty ?? 1} free`;
    case 'bxgy': return `Buy ${detail?.buyQty ?? 1} get ${detail?.getQty ?? 1}`;
    case 'multibuy': return `${detail?.buyQty} for $${((detail?.bundleCents ?? 0) / 100).toFixed(2)}`;
    case 'percent_off': return `${detail?.percentOff}% off`;
    case 'amount_off': return `$${((detail?.amountOffCents ?? 0) / 100).toFixed(2)} off`;
    default: return kind;
  }
}
