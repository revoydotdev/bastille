import test from 'node:test';
import assert from 'node:assert/strict';
import { TtlCache } from '../src/cache.js';

test('concurrent wraps for one key share a single computation', async () => {
  const cache = new TtlCache<number>(60_000);
  let calls = 0;
  const compute = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return 42;
  };
  const results = await Promise.all([cache.wrap('k', compute), cache.wrap('k', compute), cache.wrap('k', compute)]);
  assert.deepEqual(results, [42, 42, 42]);
  assert.equal(calls, 1);
  assert.equal(await cache.wrap('k', compute), 42, 'and the value is then cached');
  assert.equal(calls, 1);
});

test('different keys do not wait on each other', async () => {
  const cache = new TtlCache<string>(60_000);
  let calls = 0;
  await Promise.all(['a', 'b'].map((k) => cache.wrap(k, async () => (calls++, k))));
  assert.equal(calls, 2);
});

test('a failed computation reaches every waiter and is not cached', async () => {
  const cache = new TtlCache<number>(60_000);
  let calls = 0;
  const boom = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    throw new Error('upstream down');
  };
  const settled = await Promise.allSettled([cache.wrap('k', boom), cache.wrap('k', boom)]);
  assert.deepEqual(settled.map((s) => s.status), ['rejected', 'rejected']);
  assert.equal(calls, 1);
  assert.equal(await cache.wrap('k', async () => 7), 7, 'the next call retries');
});

test('stats count hits, misses and joined calls', async () => {
  const cache = new TtlCache<number>(60_000);
  const slow = async () => {
    await new Promise((r) => setTimeout(r, 10));
    return 1;
  };
  await Promise.all([cache.wrap('k', slow), cache.wrap('k', slow)]); // 1 miss, 1 joined
  await cache.wrap('k', slow); // 1 hit
  const s = cache.stats();
  assert.deepEqual([s.misses, s.joined, s.hits, s.size], [1, 1, 1, 1]);
  assert.equal(s.hitRatio, 2 / 3);
});
