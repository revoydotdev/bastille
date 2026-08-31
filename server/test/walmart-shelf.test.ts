/**
 * The shelf parser, against the shapes Walmart's Browse operation actually
 * returns: dollars under `currentPrice.price`, the pre-markdown figure under
 * `listPrice`, the aisle under `productLocation[0].displayValue`, and the two
 * stacks — the store's rack, and a second one Walmart titles "Available for
 * shipping".
 *
 * The payloads below are trimmed from a real response captured at store 4682.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { centsFromDollars, parseShelf, type BrowseResponse } from '../src/clearance/walmart-api.js';

function beacon(type: string, subType: string): string {
  return JSON.stringify({ interpretations: [{ id: '0', type, sub_type: subType, query: 'electronics' }] });
}

function rawItem(
  id: string,
  name: string,
  opts: { aisle?: string | null; now?: number | null; list?: number } = {},
) {
  const now = opts.now === undefined ? 149 : opts.now;
  return {
    usItemId: id,
    name,
    brand: 'ACME',
    departmentName: 'Electronics',
    category: { categoryPathId: '0:3944:1089430:132959:4483' },
    canonicalUrl: `/ip/x/${id}`,
    imageInfo: { thumbnailUrl: 'https://i5.walmartimages.com/x.jpg' },
    productLocation: opts.aisle === null ? null : [{ displayValue: opts.aisle ?? 'K14' }],
    availabilityStatusV2: { value: 'IN_STOCK' },
    priceInfo: {
      currentPrice: now === null ? null : { price: now },
      listPrice: opts.list === undefined ? null : { price: opts.list },
      savingsAmount: opts.list === undefined ? null : { amount: opts.list - (now ?? 0) },
    },
  };
}

function response(stacks: unknown[]): BrowseResponse {
  return {
    data: {
      search: {
        searchResult: {
          aggregatedCount: 192,
          pageMetadata: { storeSelectionHeader: { storeDislayName: 'Gordonsville Supercenter' } },
          itemStacks: stacks,
        },
      },
    },
  } as BrowseResponse;
}

const RACK = {
  meta: { beacon: beacon('primary', 'primary'), title: 'Results for "electronics"' },
  itemsV2: [
    rawItem('A1', 'Samsung 32-Inch Curved Monitor', { now: 149, list: 199 }),
    rawItem('A2', 'Philips Surge Protector', { now: 15.88, aisle: 'L13' }),
  ],
};

const SHIPPING = {
  meta: { beacon: beacon('secondary_stack', 'inStoreShipFul'), title: 'Available for shipping' },
  itemsV2: [rawItem('S1', '14000 BTU Window Air Conditioner', { now: 289.99, list: 790.98, aisle: null })],
};

test('only the store\'s own rack is returned', () => {
  const page = parseShelf(response([RACK, SHIPPING]));
  assert.deepEqual(page.items.map((i) => i.itemId), ['A1', 'A2']);
  assert.equal(page.shippedOnly, 1);
  // The pager has to follow the page Walmart served, not the part that survived.
  assert.equal(page.pageItemCount, 3);
  assert.equal(page.totalCount, 192);
  assert.equal(page.storeName, 'Gordonsville Supercenter');
});

test('a stack whose beacon cannot be read is not treated as the rack', () => {
  const mangled = { meta: { beacon: 'not json', title: 'Results' }, itemsV2: [rawItem('X1', 'Mystery item')] };
  const page = parseShelf(response([mangled]));
  // Inventing shelf presence is the failure worth avoiding: an unreadable stack
  // is dropped rather than assumed local.
  assert.deepEqual(page.items, []);
  assert.equal(page.shippedOnly, 1);
});

test('prices and the aisle come off the fields Walmart actually sends', () => {
  const page = parseShelf(response([RACK]));
  const [monitor, surge] = page.items;
  assert.equal(monitor?.nowCents, 14900);
  assert.equal(monitor?.wasCents, 19900);
  assert.equal(monitor?.savingsCents, 5000);
  assert.equal(monitor?.aisle, 'K14');
  assert.equal(monitor?.inStock, true);
  assert.equal(monitor?.productUrl, 'https://www.walmart.com/ip/x/A1');
  // The common clearance tag: a price, no "was", and a different aisle.
  assert.equal(surge?.nowCents, 1588);
  assert.equal(surge?.wasCents, null);
  assert.equal(surge?.aisle, 'L13');
});

test('an item with no price is kept, not priced at zero', () => {
  const page = parseShelf(response([{ ...RACK, itemsV2: [rawItem('N1', 'Unpriced item', { now: null })] }]));
  assert.equal(page.items[0]?.nowCents, null);
});

test('an item Walmart returns on both stacks is recorded once', () => {
  const page = parseShelf(response([RACK, { ...RACK, itemsV2: [rawItem('A1', 'Samsung 32-Inch Curved Monitor')] }]));
  assert.deepEqual(page.items.map((i) => i.itemId), ['A1', 'A2']);
});

test('dollars become cents without float drift', () => {
  assert.equal(centsFromDollars(15.88), 1588);
  assert.equal(centsFromDollars(289.99), 28999);
  assert.equal(centsFromDollars(790.98), 79098);
});
