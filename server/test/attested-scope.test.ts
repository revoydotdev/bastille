/**
 * The attested-scope ingestion contract against a real-shaped Walmart Browse
 * response.
 *
 * The fixtures below are trimmed from the same captured payloads
 * `server/test/walmart-shelf.test.ts` uses for `parseShelf`: the stack split
 * (`primary` vs `secondary_stack`), the `storeSelectionHeader.storeDislayName`
 * echo, and the dollar-shaped money under `priceInfo.currentPrice.price`. The
 * only path under test here is the scope contract:
 *
 *   - `resolveScope` returns `ScopeProof` whose `answeredBy` is the echo.
 *   - `enumerateShelves` with a matching echo returns items.
 *   - `enumerateShelves` with a mismatched echo throws `ScopeMismatchError`
 *     BEFORE any item is surfaced — a caller cannot record an unscoped shelf.
 *
 * Network is mocked at the seam (`setHttpDispatcher(MockAgent)`); nothing
 * leaves the process. The pacer env vars are zeroed for the same reason
 * `server/test/walmart-budget.test.ts` zeroes them — the interval would
 * otherwise park each read for twenty seconds.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher } from 'undici';

process.env.WALMART_REQUEST_INTERVAL_MS = '0';
process.env.WALMART_REQUEST_JITTER_MS = '0';
process.env.BASTILLE_MIN_REQUEST_INTERVAL_MS = '0';

const agent = new MockAgent();
agent.disableNetConnect();
setGlobalDispatcher(agent);
const pool = agent.get('https://www.walmart.com');

const { setHttpDispatcher } = await import('../src/adapters/http.js');
setHttpDispatcher(agent);

const { WalmartAttestedScopeSource } = await import('../src/clearance/walmart-scope.js');
const adapterScope = await import('../src/adapters/scope.js');
const ScopeMismatchError = adapterScope.ScopeMismatchError;

const PRIMARY_BEACON = JSON.stringify({
  interpretations: [{ id: '0', type: 'primary', sub_type: 'primary', query: 'electronics' }],
});
const SECONDARY_BEACON = JSON.stringify({
  interpretations: [{ id: '0', type: 'secondary_stack', sub_type: 'inStoreShipFul' }],
});

/** One trimmed stack entry, shaped like the items Walmart returns under
 *  `itemsV2` on a clearance shelf. The fields used downstream are name,
 *  `usItemId`, the dollar under `currentPrice.price`, the `productLocation[0]
 *  .displayValue` aisle, and `availabilityStatusV2.value`. */
function rawItem(id: string, name: string, opts: { aisle?: string; now?: number; list?: number | null } = {}) {
  const now = opts.now ?? 149;
  return {
    usItemId: id,
    name,
    brand: 'ACME',
    departmentName: 'Electronics',
    category: { categoryPathId: '0:3944:1089430:132959:4483' },
    canonicalUrl: `/ip/x/${id}`,
    imageInfo: { thumbnailUrl: 'https://i5.walmartimages.com/x.jpg' },
    productLocation: [{ displayValue: opts.aisle ?? 'K14' }],
    availabilityStatusV2: { value: 'IN_STOCK' },
    priceInfo: {
      currentPrice: { price: now },
      listPrice: opts.list === undefined ? { price: 199 } : opts.list === null ? null : { price: opts.list },
      savingsAmount: { amount: (opts.list ?? 199) - now },
    },
  };
}

/** A real-shaped Browse response, trimmed from a capture at store 4682 (the
 *  Gordonsville Supercenter). The only field touched by the abstraction is
 *  `pageMetadata.storeSelectionHeader.storeDislayName`; the rest is here so
 *  any future test parsing the items still works on the same fixture. */
function browseResponse(args: { store: string; maxPage: number; stacks: unknown[]; aggregated?: number }): unknown {
  return {
    data: {
      search: {
        searchResult: {
          aggregatedCount: args.aggregated ?? 24,
          pageMetadata: { storeSelectionHeader: { storeDislayName: args.store } },
          paginationV2: { maxPage: args.maxPage },
          itemStacks: args.stacks,
        },
      },
    },
  };
}

const GORDONSVILLE_STACKS = [
  {
    meta: { beacon: PRIMARY_BEACON, title: 'Results for "electronics"' },
    itemsV2: [
      rawItem('A1', 'Samsung 32-Inch Curved Monitor', { aisle: 'K14', now: 149, list: 199 }),
      rawItem('A2', 'Philips Surge Protector', { aisle: 'L13', now: 15.88, list: null }),
    ],
  },
  {
    meta: { beacon: SECONDARY_BEACON, title: 'Available for shipping' },
    itemsV2: [rawItem('S1', '14000 BTU Window Air Conditioner', { aisle: '', now: 289.99, list: 790.98 })],
  },
];

/** Reply once with a real-shaped Browse payload. The same shape feeds both
 *  the canary (`resolveScope`) and the shelf read (`enumerateShelves`). */
function replyBrowseOnce(store: string, maxPage: number, stacks: unknown[] = GORDONSVILLE_STACKS): void {
  pool
    .intercept({ path: /orchestra\/snb\/graphql\/Browse/, method: 'GET' })
    .reply(200, browseResponse({ store, maxPage, stacks }));
}

test('resolveScope returns a ScopeProof whose answeredBy equals the echoed store', async () => {
  replyBrowseOnce('Gordonsville Supercenter', 2);
  const src = new WalmartAttestedScopeSource({ categoryId: '3944' });
  const proof = await src.resolveScope({ locationId: '4682', postalCode: '22942' });

  assert.equal(proof.answeredBy, 'Gordonsville Supercenter');
  assert.equal(proof.requested.locationId, '4682');
  assert.equal(proof.requested.postalCode, '22942');
  assert.equal(proof.provenance, 'persisted-query');
  // The proof is the abstraction's only attestation: the implementation must
  // not invent a name when one is present, so the persisted-query echo is
  // bit-for-bit what's returned.
  assert.equal(proof.answeredBy, 'Gordonsville Supercenter');
});

test('a ScopeProof travels through the rest of the contract', async () => {
  // Two reads succeed with the same store echoed both times.
  replyBrowseOnce('Gordonsville Supercenter', 1);
  replyBrowseOnce('Gordonsville Supercenter', 1);
  const src = new WalmartAttestedScopeSource({ categoryId: '3944' });
  const proof = await src.resolveScope({ locationId: '4682' });
  const page = await src.enumerateShelves(proof, null);

  assert.equal(page.complete, true, 'maxPage=1 means the one page was the whole shelf');
  assert.equal(page.cursor, null);
  // Only the primary stack's items survive the parse — that lift lives in
  // walmart-api's `parseShelf` and is unchanged here.
  assert.deepEqual(page.items.map((i) => i.itemId), ['A1', 'A2']);
  assert.ok(page.items.every((i) => i.aisle !== null), 'aisles come off `productLocation[0]`');
});

test('a mismatched echo throws ScopeMismatchError before any find is recorded', async () => {
  // First call is the canary: returns the "right" store. Second call is the
  // shelf read: returns a different one, simulating the live-observed failure
  // where one node's egress now answers for another shop.
  pool
    .intercept({ path: /orchestra\/snb\/graphql\/Browse/, method: 'GET' })
    .reply(200, browseResponse({ store: 'Gordonsville Supercenter', maxPage: 1, stacks: GORDONSVILLE_STACKS }));
  pool
    .intercept({ path: /orchestra\/snb\/graphql\/Browse/, method: 'GET' })
    .reply(200, browseResponse({ store: 'Sacramento Supercenter', maxPage: 1, stacks: GORDONSVILLE_STACKS }));

  const src = new WalmartAttestedScopeSource({ categoryId: '3944' });
  const proof = await src.resolveScope({ locationId: '4682' });
  assert.equal(proof.answeredBy, 'Gordonsville Supercenter');

  await assert.rejects(
    () => src.enumerateShelves(proof, null),
    (err: unknown) => {
      if (!(err instanceof ScopeMismatchError)) return false;
      assert.equal(err.expected, 'Gordonsville Supercenter');
      assert.equal(err.got, 'Sacramento Supercenter');
      assert.equal(err.proofProvenance, 'persisted-query');
      return true;
    },
    'mismatched echo must surface a typed ScopeMismatchError',
  );

  // A second shelf read with the matching echo returns items: nothing about a
  // failed first read is sticky in the abstraction's state.
  replyBrowseOnce('Gordonsville Supercenter', 1);
  const page = await src.enumerateShelves(proof, null);
  assert.deepEqual(page.items.map((i) => i.itemId), ['A1', 'A2']);
});

test('a null echo at canary is preserved through the abstraction', async () => {
  // Some Browse shapes omit `pageMetadata` entirely. The proof carries the
  // null forward, and a later shelf read with a non-null echo is the mismatch.
  pool
    .intercept({ path: /orchestra\/snb\/graphql\/Browse/, method: 'GET' })
    .reply(200, {
      data: {
        search: {
          searchResult: {
            aggregatedCount: 0,
            itemStacks: [],
          },
        },
      },
    });

  const src = new WalmartAttestedScopeSource({ categoryId: '3944' });
  const proof = await src.resolveScope({ locationId: '4682' });
  assert.equal(proof.answeredBy, null);

  // A subsequent page that names a store mismatches the null proof.
  replyBrowseOnce('Gordonsville Supercenter', 1);
  await assert.rejects(
    () => src.enumerateShelves(proof, null),
    (err: unknown) =>
      err instanceof ScopeMismatchError &&
      err.expected === null &&
      err.got === 'Gordonsville Supercenter',
  );
});

test.after(() => agent.close());
