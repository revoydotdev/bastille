import test from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshots, severityOf } from '../src/price/diff.js';
import type { PriceSnapshot } from '../src/price/model.js';

function snap(patch: Partial<PriceSnapshot>): PriceSnapshot {
  return {
    regularCents: 499,
    currentCents: 499,
    effectiveUnitCents: 499,
    promoKind: 'none',
    promoText: null,
    promoDetail: null,
    unitPriceText: null,
    inStock: true,
    capturedAt: new Date().toISOString(),
    ...patch,
  };
}

test('a numeric drop is reported as a numeric change', () => {
  const [change, ...rest] = diffSnapshots(snap({}), snap({ currentCents: 399, effectiveUnitCents: 399 }));
  assert.equal(rest.length, 0);
  assert.equal(change!.kind, 'price_drop');
  assert.equal(change!.numeric, true);
  assert.equal(change!.deltaCents, -100);
  assert.equal(change!.deltaPercent, -20);
});

test('a rise is reported too, and rated lower than a drop', () => {
  const [change] = diffSnapshots(snap({}), snap({ currentCents: 599, effectiveUnitCents: 599 }));
  assert.equal(change!.kind, 'price_rise');
  assert.equal(severityOf(change!), 'info');
});

test('a BOGO starting on an unchanged shelf price still alerts', () => {
  const before = snap({});
  const after = snap({
    promoKind: 'bogo',
    promoText: 'Buy 1 get 1 free',
    promoDetail: { buyQty: 1, getQty: 1 },
    effectiveUnitCents: 250,
  });
  const kinds = diffSnapshots(before, after).map((c) => c.kind);
  assert.deepEqual(kinds.sort(), ['price_drop', 'promo_started']);
  const promo = diffSnapshots(before, after).find((c) => c.kind === 'promo_started')!;
  assert.equal(promo.numeric, false);
  assert.equal(promo.message, 'New offer: Buy 1 get 1 free');
  assert.equal(severityOf(promo), 'urgent');
});

test('a promotion whose shelf price does not move is still detected', () => {
  const before = snap({});
  const after = snap({ promoKind: 'coupon', promoText: 'Clip $1 coupon' });
  const changes = diffSnapshots(before, after);
  assert.deepEqual(changes.map((c) => c.kind), ['promo_started']);
  assert.equal(changes[0]!.numeric, false);
});

test('an offer ending is its own change', () => {
  const before = snap({ promoKind: 'bogo', promoText: 'Buy 1 get 1 free', effectiveUnitCents: 250 });
  const after = snap({});
  const kinds = diffSnapshots(before, after).map((c) => c.kind);
  assert.ok(kinds.includes('promo_ended'));
});

test('swapping one offer for another reports a change, not a start', () => {
  const before = snap({ promoKind: 'bogo', promoText: 'Buy 1 get 1 free' });
  const after = snap({ promoKind: 'multibuy', promoText: '2 for $7', promoDetail: { buyQty: 2, bundleCents: 700 } });
  const change = diffSnapshots(before, after).find((c) => c.kind === 'promo_changed')!;
  assert.equal(change.message, 'Offer changed: Buy 1 get 1 free → 2 for $7');
});

test('stock transitions are reported in both directions', () => {
  assert.equal(diffSnapshots(snap({}), snap({ inStock: false }))[0]!.kind, 'out_of_stock');
  assert.equal(diffSnapshots(snap({ inStock: false }), snap({}))[0]!.kind, 'back_in_stock');
});

test('sub-threshold noise is not an alert', () => {
  assert.deepEqual(diffSnapshots(snap({}), snap({}), 5), []);
  assert.deepEqual(diffSnapshots(snap({}), snap({ effectiveUnitCents: 497 }), 5), []);
});

test('a deep drop is urgent, a shallow one is not', () => {
  const deep = diffSnapshots(snap({}), snap({ effectiveUnitCents: 349 }))[0]!;
  const shallow = diffSnapshots(snap({}), snap({ effectiveUnitCents: 494 }))[0]!;
  assert.equal(severityOf(deep), 'urgent');
  assert.equal(severityOf(shallow), 'info');
});
