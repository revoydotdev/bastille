/**
 * Refreshing a watched Food Lion item that lives only in a sub-aisle (C-1,
 * P-2). Scallions are the motivating case: `2098-produce` omits them and
 * `2334-fresh-vegetables` lists them, so a refresh that only knows the 20
 * top-level aisles could never find them.
 *
 * The fetch is stubbed, so this runs offline and counts exactly the reads a
 * refresh costs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FoodLionAdapter } from '../src/adapters/foodlion.js';
import { HttpError } from '../src/adapters/http.js';

const SITE = 'https://foodlion.com';

/** An aisle or product page in the shape the site serves: one astro-island with `products`. */
function page(products: { prodId: string; name: string; price: number }[], links: string[] = []): string {
  const tagged = (v: unknown) => [0, v];
  const list = [
    1,
    products.map((p) => [
      0,
      { product: tagged({ prodId: tagged(p.prodId), name: tagged(p.name), size: tagged('1 bunch'), price: tagged(p.price) }) },
    ]),
  ];
  const props = JSON.stringify({ products: list }).replace(/"/g, '&quot;');
  const anchors = links.map((l) => `<a href="/groceries/browse-aisles/${l}">x</a>`).join('');
  return `<html>${anchors}<astro-island props="${props}"></astro-island></html>`;
}

interface Stub {
  fetch: (url: string) => Promise<string>;
  urls: string[];
  /** reads that were aisle pages */
  aisleReads: () => number;
  productReads: () => string[];
}

function stubSite(over: { productPrice?: number; productPage?: 'ok' | '404' | 'down' } = {}): Stub {
  const urls: string[] = [];
  const fetch = async (url: string): Promise<string> => {
    urls.push(url);
    const aisle = /browse-aisles\/(\d+-[a-z0-9-]+)$/.exec(url)?.[1];
    if (aisle === '2098-produce') {
      return page([{ prodId: 'BAN1', name: 'Bananas', price: 0.59 }], ['2334-fresh-vegetables']);
    }
    if (aisle === '2334-fresh-vegetables') {
      return page([{ prodId: 'SC1', name: 'Green Onions Scallions', price: 0.99 }]);
    }
    if (aisle) return page([]);
    if (url.includes('/groceries/product/') && url.endsWith('/SC1')) {
      if (over.productPage === '404' || url.includes('/old-name/')) throw new HttpError(404, url, 'gone');
      if (over.productPage === 'down') throw new Error('ECONNRESET');
      return page([{ prodId: 'SC1', name: 'Green Onions Scallions', price: over.productPrice ?? 1.09 }]);
    }
    throw new HttpError(404, url, 'nope');
  };
  return {
    fetch,
    urls,
    aisleReads: () => urls.filter((u) => u.includes('/browse-aisles/')).length,
    productReads: () => urls.filter((u) => u.includes('/groceries/product/')),
  };
}

const SCALLION_URL = `${SITE}/groceries/product/green-onions-scallions-1-bunch/SC1`;

test('a sub-aisle-only item is found without prior knowledge and refreshed from its product page', async () => {
  const site = stubSite();
  const fl = new FoodLionAdapter(site.fetch);
  fl.beginRun();

  const offer = await fl.fetchOffer('SC1');
  assert.ok(offer, 'scallions must be found');
  assert.equal(offer.price.currentCents, 109, 'price comes from the product page, not the aisle copy (99)');
  assert.equal(offer.product.productUrl, SCALLION_URL);
  // 20 top-level aisles + the one sub-aisle linked from produce, then one page.
  assert.equal(site.aisleReads(), 21);
  assert.equal(site.productReads().length, 1);
});

test('once indexed, a refresh is exactly one read and never walks again', async () => {
  const site = stubSite();
  const fl = new FoodLionAdapter(site.fetch);
  fl.beginRun();
  await fl.fetchOffer('SC1');
  const before = site.urls.length;

  const again = await fl.fetchOffer('SC1');
  assert.equal(again?.price.currentCents, 109);
  assert.equal(site.urls.length - before, 1);
  assert.deepEqual(site.urls.slice(before), [SCALLION_URL]);
});

test('with the stored product URL a cold adapter spends one read and touches no aisle', async () => {
  const site = stubSite();
  const fl = new FoodLionAdapter(site.fetch);
  fl.beginRun();

  const offer = await fl.fetchOffer('SC1', 'national', { productUrl: SCALLION_URL });
  assert.equal(offer?.price.currentCents, 109);
  assert.deepEqual(site.urls, [SCALLION_URL]);
});

test('a hint that points at another product is ignored rather than trusted', async () => {
  const site = stubSite();
  const fl = new FoodLionAdapter(site.fetch);
  fl.beginRun();
  const offer = await fl.fetchOffer('SC1', undefined, { productUrl: `${SITE}/groceries/product/bananas/BAN1` });
  assert.equal(offer?.product.storeProductId, 'SC1');
  assert.ok(!site.urls.some((u) => u.endsWith('/BAN1')));
});

test('a stored URL that has gone stale falls back to the index, then to one walk', async () => {
  const site = stubSite();
  const fl = new FoodLionAdapter(site.fetch);
  fl.beginRun();
  // First learn the item through the index, so the later miss has somewhere to fall back to.
  await fl.fetchOffer('SC1');

  const stale = `${SITE}/groceries/product/old-name/SC1`;
  const before = site.urls.length;
  const offer = await fl.fetchOffer('SC1', undefined, { productUrl: stale });
  assert.equal(offer?.price.currentCents, 109);
  // stale URL 404s inside the stub, then the index URL succeeds: two reads, no walk.
  assert.equal(site.urls.length - before, 2);
  assert.equal(site.urls[before], stale);
});

test('an item nobody lists walks the aisles once per run, not once per item', async () => {
  const site = stubSite();
  const fl = new FoodLionAdapter(site.fetch);
  fl.beginRun();

  assert.equal(await fl.fetchOffer('GONE1'), null);
  const afterFirst = site.aisleReads();
  assert.equal(afterFirst, 21);

  assert.equal(await fl.fetchOffer('GONE2'), null);
  assert.equal(await fl.fetchOffer('GONE3'), null);
  assert.equal(site.aisleReads(), afterFirst, 'later misses in the same run must not walk');
  assert.equal(fl.stats().catalogueBuilds, 1);

  // A new run re-arms the allowance (the aisle cache keeps the reads themselves free).
  await new Promise((r) => setTimeout(r, 5));
  fl.beginRun();
  assert.equal(await fl.fetchOffer('GONE4'), null);
  assert.equal(fl.stats().catalogueBuilds, 2);
  assert.equal(site.aisleReads(), afterFirst, 'cached aisles inside the TTL cost no reads');
});

test('a network failure is surfaced, not mistaken for a miss that justifies a walk', async () => {
  const site = stubSite({ productPage: 'down' });
  const fl = new FoodLionAdapter(site.fetch);
  fl.beginRun();
  await assert.rejects(() => fl.fetchOffer('SC1', undefined, { productUrl: SCALLION_URL }), /ECONNRESET/);
  assert.equal(site.aisleReads(), 0);
});

test('when the page will not confirm a product the walk just found, the listed copy is returned', async () => {
  const site = stubSite({ productPage: '404' });
  const fl = new FoodLionAdapter(site.fetch);
  fl.beginRun();
  const offer = await fl.fetchOffer('SC1');
  assert.equal(offer?.price.currentCents, 99);
});
