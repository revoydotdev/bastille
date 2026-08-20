import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePromoText, effectiveUnitCents, describePromo } from '../src/price/promo.js';

test('BOGO halves the effective unit price', () => {
  const parsed = parsePromoText('Buy 1 Get 1 Free')!;
  assert.equal(parsed.kind, 'bogo');
  assert.deepEqual({ buy: parsed.detail.buyQty, get: parsed.detail.getQty }, { buy: 1, get: 1 });
  assert.equal(effectiveUnitCents(499, parsed.kind, parsed.detail), 250);
});

test('BOGO is recognised from every spelling the stores use', () => {
  for (const text of ['BOGO', 'Buy One, Get One Free', 'B1G1', 'buy 1 get 1']) {
    assert.equal(parsePromoText(text)!.kind, 'bogo', text);
  }
});

test('buy 2 get 1 free prices at two thirds', () => {
  const parsed = parsePromoText('Buy 2 Get 1 Free')!;
  assert.equal(parsed.kind, 'bxgy');
  assert.equal(effectiveUnitCents(300, parsed.kind, parsed.detail), 200);
});

test('a half-off second unit is not a free one', () => {
  const parsed = parsePromoText('Buy 1 Get 1 50% Off')!;
  assert.equal(parsed.detail.percentOff, 50);
  // Pay 1 + 0.5 units for 2 units => 75% of the shelf price.
  assert.equal(effectiveUnitCents(400, parsed.kind, parsed.detail), 300);
});

test('multibuy divides the bundle across the quantity', () => {
  for (const text of ['2 for $5', '2/$5.00', 'Buy 2 for $13.00']) {
    const parsed = parsePromoText(text)!;
    assert.equal(parsed.kind, 'multibuy', text);
  }
  const parsed = parsePromoText('Buy 2 for $13.00')!;
  assert.equal(effectiveUnitCents(799, parsed.kind, parsed.detail), 650);
});

test('a multibuy prices itself when there is no shelf price', () => {
  const parsed = parsePromoText('3 for $10')!;
  assert.equal(effectiveUnitCents(null, parsed.kind, parsed.detail), 333);
});

test('percent and dollar discounts subtract from the shelf price', () => {
  const pct = parsePromoText('25% off')!;
  assert.equal(pct.kind, 'percent_off');
  assert.equal(effectiveUnitCents(400, pct.kind, pct.detail), 300);

  const amt = parsePromoText('Save $1.50')!;
  assert.equal(amt.kind, 'amount_off');
  assert.equal(effectiveUnitCents(499, amt.kind, amt.detail), 349);
});

test('a discount can never drive the price below zero', () => {
  const amt = parsePromoText('Save $9.00')!;
  assert.equal(effectiveUnitCents(499, amt.kind, amt.detail), 0);
});

test('loyalty and limit qualifiers are captured alongside the deal', () => {
  const parsed = parsePromoText('2 for $5 with MVP card, limit 4')!;
  assert.equal(parsed.kind, 'multibuy');
  assert.equal(parsed.detail.requiresLoyalty, true);
  assert.equal(parsed.detail.limitQty, 4);
});

test('a card-only price with no mechanic is still a promotion', () => {
  const parsed = parsePromoText('Members only price')!;
  assert.equal(parsed.kind, 'loyalty');
  assert.equal(parsed.detail.requiresLoyalty, true);
});

test('unrecognised copy keeps its text instead of being dropped', () => {
  const parsed = parsePromoText('Free reusable tote with purchase')!;
  assert.equal(parsed.kind, 'unknown');
  assert.equal(describePromo(parsed.kind, parsed.detail, 'Free reusable tote with purchase'), 'Free reusable tote with purchase');
  // Unquantifiable, so it must not invent a discount off the shelf price.
  assert.equal(effectiveUnitCents(599, parsed.kind, parsed.detail), 599);
});

test('empty promo text is not a promotion', () => {
  assert.equal(parsePromoText(''), null);
  assert.equal(parsePromoText(null), null);
});
