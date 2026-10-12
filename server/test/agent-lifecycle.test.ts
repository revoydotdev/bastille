/**
 * ProxyAgent lifecycle: one agent per proxy URL, closed at shutdown.
 *
 * The bug these guard against was `new ProxyAgent(...)` per proxied read,
 * never closed. It looked harmless because the agent reads as config, but a
 * ProxyAgent owns a socket pool and a tunnel, so every read leaked one and DAG
 * fan-out multiplied it. The count of constructions is the whole assertion, so
 * the factory is swapped for a counting stub — no real proxy is ever dialled.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher } from 'undici';

process.env.WALMART_REQUEST_INTERVAL_MS = '0';
process.env.WALMART_REQUEST_JITTER_MS = '0';
process.env.WALMART_RATE_LIMIT_COOLDOWN_MS = '60000';
process.env.BASTILLE_MIN_REQUEST_INTERVAL_MS = '0';

const mock = new MockAgent();
mock.disableNetConnect();
setGlobalDispatcher(mock);

const api = await import('../src/clearance/walmart-api.js');
const { setHttpDispatcher } = await import('../src/adapters/http.js');
setHttpDispatcher(mock);

const pool = mock.get('https://www.walmart.com');
pool
  .intercept({ path: /orchestra.*/, method: 'GET' })
  .reply(200, {
    data: {
      search: {
        searchResult: {
          aggregatedCount: 1,
          maxPage: 1,
          pageMetadata: { storeSelectionHeader: { storeDislayName: 'Fake Store' } },
          itemStacks: [
            {
              meta: { title: 'Results', beacon: JSON.stringify({ interpretations: [{ type: 'primary' }] }) },
              items: [{ usItemId: '1', name: 'thing', priceInfo: { currentPrice: { price: 10 } } }],
            },
          ],
        },
      },
    },
  })
  .persist();

interface BuiltAgent {
  uri: string;
  destroyed: boolean;
  dispatch: typeof pool.dispatch;
}

/** Counts constructions and hands each fake agent the mock pool to dispatch on. */
function useCountingAgents(): BuiltAgent[] {
  const built: BuiltAgent[] = [];
  api.setProxyAgentFactory((uri: string) => {
    const rec: BuiltAgent = {
      uri,
      destroyed: false,
      dispatch: pool.dispatch.bind(pool),
    };
    built.push(rec);
    return {
      dispatch: rec.dispatch,
      destroy: async () => {
        rec.destroyed = true;
      },
    } as never;
  });
  return built;
}

function readThrough(proxyUrl: string) {
  return api.clearanceShelf({
    categoryId: '1226734',
    locationId: '101',
    postalCode: '22901',
    proxyUrl,
    egressNodeId: proxyUrl,
  });
}

test('three reads on one proxy URL build one agent and reuse it', async () => {
  await api.closeProxyAgents();
  const built = useCountingAgents();

  for (let n = 0; n < 3; n++) {
    const shelf = await readThrough('http://proxy-a:8080');
    assert.equal(shelf.totalCount, 1);
  }

  assert.equal(built.length, 1, 'exactly one ProxyAgent for three reads');
  assert.equal(built[0].uri, 'http://proxy-a:8080');
  await api.closeProxyAgents();
});

test('two proxy URLs get two distinct agents and neither is reused', async () => {
  await api.closeProxyAgents();
  const built = useCountingAgents();

  await readThrough('http://proxy-a:8080');
  await readThrough('http://proxy-b:8080');
  await readThrough('http://proxy-a:8080');
  await readThrough('http://proxy-b:8080');

  assert.equal(built.length, 2, 'one agent per proxy URL, not one per read');
  assert.notEqual(built[0].dispatch, built[1].dispatch);
  assert.deepEqual(built.map((b) => b.uri).sort(), ['http://proxy-a:8080', 'http://proxy-b:8080']);
  await api.closeProxyAgents();
});

test('shutdown destroys every cached agent', async () => {
  await api.closeProxyAgents();
  const built = useCountingAgents();
  await readThrough('http://proxy-a:8080');
  await readThrough('http://proxy-b:8080');
  assert.equal(built.length, 2);

  await api.closeProxyAgents();

  assert.deepEqual(built.map((b) => b.destroyed), [true, true]);
  await readThrough('http://proxy-a:8080');
  assert.equal(built.length, 3, 'an emptied pool builds a fresh agent');
  await api.closeProxyAgents();
});

test('forgetProxyAgent drops one URL and leaves the rest intact', async () => {
  await api.closeProxyAgents();
  const built = useCountingAgents();
  await readThrough('http://proxy-a:8080');
  await readThrough('http://proxy-b:8080');
  assert.equal(built.length, 2);

  api.forgetProxyAgent('http://proxy-a:8080');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(built.map((b) => b.destroyed), [true, false], 'only proxy-a closed');

  await readThrough('http://proxy-b:8080');
  await readThrough('http://proxy-a:8080');
  assert.equal(built.length, 3, 'only the forgotten URL rebuilt an agent');
  assert.equal(built[2].uri, 'http://proxy-a:8080');
  await api.closeProxyAgents();
});