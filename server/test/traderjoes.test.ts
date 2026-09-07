/**
 * Trader Joe's price mapping. Their GraphQL carries no unit price — it gives a
 * pack size and its unit — so the per-unit figure is derived here rather than
 * read off the store, which is the opposite of both grocery adapters.
 *
 * Payload shapes are trimmed from real /api/graphql responses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { toOffer, unitPriceText } from '../src/adapters/traderjoes.js';

function product(over: Record<string, unknown> = {}) {
  return {
    sku: '084838',
    item_title: 'Organic Pumpkin Pie Spice Creamer',
    url_key: '084838-organic-pumpkin-spice-creamer',
    sales_size: 16,
    sales_uom_description: 'Fl Oz',
    availability: '1',
    price_range: { minimum_price: { final_price: { value: 2.99, currency: 'USD' }, regular_price: { value: 2.99 } } },
    ...over,
  };
}

test('a pack size and unit become a per-unit price', () => {
  assert.equal(unitPriceText(299, 16, 'Fl Oz'), '$0.19/fl oz');
  assert.equal(unitPriceText(499, 32, 'Oz'), '$0.16/oz');
});

test('a unit price that would round to zero is omitted, not shown as $0.00', () => {
  assert.equal(unitPriceText(99, 5000, 'Ct'), null);
});

test('a missing size or unit yields no unit price rather than a guess', () => {
  assert.equal(unitPriceText(299, null, 'Oz'), null);
  assert.equal(unitPriceText(299, 16, null), null);
  assert.equal(unitPriceText(null, 16, 'Oz'), null);
});

test('an ordinary product maps to a plain shelf price', () => {
  const offer = toOffer(product())!;
  assert.equal(offer.product.storeId, 'traderjoes');
  assert.equal(offer.product.storeProductId, '084838');
  assert.equal(offer.product.size, '16 Fl Oz');
  assert.equal(offer.price.currentCents, 299);
  assert.equal(offer.price.effectiveUnitCents, 299);
  assert.equal(offer.price.promoKind, 'none');
  assert.equal(offer.price.unitPriceText, '$0.19/fl oz');
});

test('a final price below the regular one is the only discount the schema expresses', () => {
  const offer = toOffer(product({
    price_range: { minimum_price: { final_price: { value: 1.99 }, regular_price: { value: 2.99 } } },
  }))!;
  assert.equal(offer.price.promoKind, 'sale');
  assert.equal(offer.price.regularCents, 299);
  assert.equal(offer.price.effectiveUnitCents, 199);
});

test('absent availability is recorded as unknown, never assumed in stock', () => {
  assert.equal(toOffer(product({ availability: null }))!.price.inStock, null);
  assert.equal(toOffer(product({ availability: '1' }))!.price.inStock, true);
  assert.equal(toOffer(product({ availability: '0' }))!.price.inStock, false);
});

test('a product without a sku is dropped rather than keyed on a blank id', () => {
  assert.equal(toOffer(product({ sku: undefined })), null);
  assert.equal(toOffer(product({ sku: '  ' })), null);
});
