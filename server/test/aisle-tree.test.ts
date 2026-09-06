/**
 * Sub-aisle discovery. A Food Lion aisle page links its own children in the
 * same `browse-aisles/<id>-<slug>` form the top-level nav uses, and the
 * snapshot descends one level into them because a top-level page carries only
 * part of its subtree: `2098-produce` lists 520 products and omits scallions,
 * which appear on `2334-fresh-vegetables`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAisleLinks } from '../src/adapters/foodlion.js';

test('sub-aisle slugs are read out of the page links', () => {
  const html = `
    <nav><a href="/groceries/browse-aisles/2098-produce">Produce</a></nav>
    <a href="/groceries/browse-aisles/2334-fresh-vegetables">Fresh Vegetables</a>
    <a href="https://foodlion.com/groceries/browse-aisles/2106-fresh-herbs">Fresh Herbs</a>`;
  assert.deepEqual(extractAisleLinks(html), [
    '2098-produce',
    '2334-fresh-vegetables',
    '2106-fresh-herbs',
  ]);
});

test('a slug linked more than once is returned once', () => {
  const html = `
    <a href="/groceries/browse-aisles/2334-fresh-vegetables">Vegetables</a>
    <a href="/groceries/browse-aisles/2334-fresh-vegetables">See all</a>`;
  assert.deepEqual(extractAisleLinks(html), ['2334-fresh-vegetables']);
});

test('links that are not aisles are ignored', () => {
  const html = `
    <a href="/groceries/product/12345-bananas">Bananas</a>
    <a href="/stores/va/palmyra">Store</a>
    <a href="/groceries/browse-aisles/1563-meat">Meat</a>`;
  assert.deepEqual(extractAisleLinks(html), ['1563-meat']);
});

test('a page with no aisle links yields nothing rather than throwing', () => {
  assert.deepEqual(extractAisleLinks('<html><body>down for maintenance</body></html>'), []);
});
