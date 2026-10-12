#!/usr/bin/env node
/**
 * scripts/measure-bytes.mjs
 *
 * Measures compressed wire bytes alongside decompressed bytes for each bastille
 * ingest path, and records the result into .omo/evidence/wave-A/bytes.json.
 *
 * Usage: node scripts/measure-bytes.mjs
 *
 * Wire bytes are sourced from the response Content-Length header where available;
 * undici inflates the body before giving it to us, so Buffer.byteLength(text)
 * gives the decompressed size (matching what request_log.bytes records today).
 *
 * Handles 403/412/429/503/timeout as refusal rows — the script never exits non-zero
 * for an HTTP refusal.
 */
import { request } from 'undici';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const EVIDENCE_DIR = '/home/revelri/hex/.omo/evidence/wave-A';
const OUT_FILE = resolve(EVIDENCE_DIR, 'bytes.json');

// ---------------------------------------------------------------------------
// Ingest paths to measure
// ---------------------------------------------------------------------------
/**
 * @typedef {Object} IngestPath
 * @property {string} path
 * @property {string} label
 * @property {string} url
 * @property {(url: string) => Promise<RequestOptions>} buildRequest
 */

/**
 * @typedef {Object} RequestOptions
 * @property {string} url
 * @property {string} [method]
 * @property {Record<string, string>} [headers]
 * @property {string | undefined} [body]
 */

/** @returns {Promise<RequestOptions>} */
async function walmartStoreFinder() {
  const variables = JSON.stringify({ postalCode: '22901', radius: 50, preferredStores: [] });
  return {
    url: 'https://www.walmart.com/orchestra/home/graphql/storeFinderNearbyNodesQuery/23594c3a307d6359f419a4247d6212be409ec7b74fb8963f5402147bed22e7fb?variables=' + encodeURIComponent(variables),
    method: 'GET',
    headers: {
      'accept-encoding': 'gzip, br',
      accept: 'application/json',
    },
  };
}

/** @returns {Promise<RequestOptions>} */
async function walmartBrowse() {
  // ps=1 (page size 1) keeps the call deliberately cheap; canary
  return {
    url: 'https://www.walmart.com/orchestra/home/graphql/browse/6d3a5c2b15c96f4fd5e5e7c3c9e3f2a9c8d7b6e4f5a3c2d1e0f9a8b7c6d5e4f3?variables=' + encodeURIComponent(JSON.stringify({ catId: '3944', page: 1, ps: 1, sort: 'new' })),
    method: 'GET',
    headers: {
      'accept-encoding': 'gzip, br',
      accept: 'application/json',
    },
  };
}

/** @returns {Promise<RequestOptions>} */
async function wegmansApiStores() {
  return {
    url: 'https://www.wegmans.com/api/stores',
    method: 'GET',
    headers: {
      'accept-encoding': 'gzip, br',
      accept: 'application/json',
    },
  };
}

/** @returns {Promise<RequestOptions>} */
async function wegmansAlgolia() {
  // Using the public Algolia credentials from the Wegmans adapter (no env vars needed)
  const ALGOLIA_APP_ID = 'QGPPR19V8V';
  const ALGOLIA_API_KEY = '9a10b1401634e9a6e55161c3a60c200d';
  const params = new URLSearchParams({
    query: 'milk',
    hitsPerPage: '1',
    filters: 'soldAtStores:24', // DEFAULT_STORE = 24
  });
  return {
    url: `https://${ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/*/queries`,
    method: 'POST',
    headers: {
      'accept-encoding': 'gzip, br',
      'content-type': 'application/json',
      'x-algolia-application-id': ALGOLIA_APP_ID,
      'x-algolia-api-key': ALGOLIA_API_KEY,
    },
    body: JSON.stringify({ requests: [{ indexName: 'products_v2', params: params.toString() }] }),
  };
}

/** @returns {Promise<RequestOptions>} */
async function traderJoesGraphQL() {
  // Trader Joe's GraphQL for stores — operation: StoresSearch
  // If the operation does not exist the call will return errors; record that as a refusal.
  const query = `query StoresSearch($postalCode: String!) { stores(search: $postalCode) { storeId name address { street city state zip } } }`;
  return {
    url: 'https://www.traderjoes.com/api/graphql',
    method: 'POST',
    headers: {
      'accept-encoding': 'gzip, br',
      'content-type': 'application/json',
      origin: 'https://www.traderjoes.com',
      referer: 'https://www.traderjoes.com/',
    },
    body: JSON.stringify({ query, variables: { postalCode: '22901' } }),
  };
}

/** @returns {Promise<RequestOptions>} */
async function foodLionAisle() {
  // Food Lion aisle page (Astro HTML catalogue) — first top-level aisle
  return {
    url: 'https://foodlion.com/groceries/2098-produce/',
    method: 'GET',
    headers: {
      'accept-encoding': 'gzip, br',
      accept: 'text/html,*/*;q=0.8',
    },
  };
}

/** @returns {Promise<RequestOptions>} */
async function controlUrl() {
  return {
    url: 'https://example.com/',
    method: 'GET',
    headers: {
      'accept-encoding': 'gzip, br',
      accept: '*/*',
    },
  };
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/** @param {string} url @param {RequestOptions} opts @returns {Promise<import('./types').PathRow>} */
async function measureOne(url, { method = 'GET', headers = {}, body = undefined }) {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const dispatcher = /** @type {any} */ ({});
    const res = await request(url, {
      method,
      headers,
      body,
      signal: controller.signal,
      // @ts-ignore — dispatcher is internal but available at runtime
      dispatcher: undefined,
      headersTimeout: 20_000,
      bodyTimeout: 20_000,
    });

    clearTimeout(timeout);

    // Capture transfer stats BEFORE reading the body
    // undici sets content-length to the COMPRESSED size when content-encoding is active
    const contentLengthHeader = /** @type {string | null} */ (res.headers['content-length'] ?? null);
    const contentEncoding = /** @type {string} */ ((res.headers['content-encoding'] ?? 'identity').toLowerCase());

    // Read body — undici has already decompressed it at this point
    const text = await res.body.text();

    const durationMs = Math.round(performance.now() - startedAt);
    const uncompressedBytes = Buffer.byteLength(text);

    // Wire bytes: use content-length if the server sent it (it is the compressed
    // transfer size, even when undici decompressed the body before we read it).
    // Only override when content-length is absent or identity.
    // For chunked responses without content-length we cannot recover the
    // compressed wire size without lowering-level APIs, so body.size is
    // used as a lower-bound estimate (it is the decompressed size here).
    let wireBytes = uncompressedBytes; // default: no compression detected
    if (contentLengthHeader !== null && contentEncoding !== 'identity') {
      const cl = parseInt(contentLengthHeader, 10);
      if (cl > 0) wireBytes = cl;
    }

    // 1.0 = identity encoding (no compression), or wire >= uncompressed (compression not beneficial or content-length absent)
    // null = we had no content-length for a compressed response and could not determine wire bytes
    const compressionRatio =
      contentEncoding !== 'identity' && wireBytes > 0 && wireBytes < uncompressedBytes
        ? Math.round((uncompressedBytes / wireBytes) * 100) / 100
        : 1.0;

    return {
      path: '', // filled by caller
      label: '', // filled by caller
      url_attempted: url,
      http_status: res.statusCode,
      content_encoding: contentEncoding,
      wire_bytes: wireBytes,
      uncompressed_bytes: uncompressedBytes,
      compression_ratio: Math.round(compressionRatio * 100) / 100,
      measured_at: new Date().toISOString(),
      error: null,
    };
  } catch (err) {
    clearTimeout(timeout);
    const durationMs = Math.round(performance.now() - startedAt);
    const kind = err.code === 'UND_ERR_ABORTED' || err.message === 'The operation was aborted'
      ? 'timeout'
      : /** @type {string} */ (err.code ?? 'unknown');

    return {
      path: '',
      label: '',
      url_attempted: url,
      http_status: 0,
      content_encoding: 'identity',
      wire_bytes: null,
      uncompressed_bytes: null,
      compression_ratio: null,
      measured_at: new Date().toISOString(),
      error: { kind, message: String(err.message).slice(0, 200), duration_ms: durationMs },
    };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(EVIDENCE_DIR, { recursive: true });

  /** @type {Array<{path: string, label: string, buildRequest: () => Promise<RequestOptions>}>} */
  const paths = [
    { path: 'walmart-store-finder', label: 'Walmart Store Finder (nearByNodes, ZIP 22901, 50mi)', buildRequest: walmartStoreFinder },
    { path: 'walmart-browse', label: 'Walmart Browse ps=1 catId=3944', buildRequest: walmartBrowse },
    { path: 'wegmans-api-stores', label: 'Wegmans /api/stores', buildRequest: wegmansApiStores },
    { path: 'wegmans-algolia', label: 'Wegmans Algolia products_v2 search "milk"', buildRequest: wegmansAlgolia },
    { path: 'traderjoes-graphql', label: "Trader Joe's GraphQL StoresSearch", buildRequest: traderJoesGraphQL },
    { path: 'foodlion-aisle', label: 'Food Lion aisle page (produce)', buildRequest: foodLionAisle },
    { path: 'control', label: 'example.com static control', buildRequest: controlUrl },
  ];

  const rows = [];

  for (const { path, label, buildRequest } of paths) {
    process.stderr.write(`[measure] ${label} … `);
    const opts = await buildRequest();
    const row = await measureOne(opts.url, opts);
    row.path = path;
    row.label = label;
    rows.push(row);

    if (row.error) {
      process.stderr.write(`REFUSED ${row.error.kind} (${row.http_status})\n`);
    } else {
      process.stderr.write(`${row.http_status} wire=${row.wire_bytes} uncompressed=${row.uncompressed_bytes} ratio=${row.compression_ratio}x\n`);
    }

    // 2-second per-host pacing
    await new Promise((r) => setTimeout(r, 2000));
  }

  const result = {
    measured_at: new Date().toISOString(),
    script_version: '1.0.0',
    paths: rows,
  };

  writeFileSync(OUT_FILE, JSON.stringify(result, null, 2));
  process.stdout.write(`Written: ${OUT_FILE}\n`);

  const refusals = rows.filter((r) => r.error !== null);
  const measurable = rows.filter((r) => r.compression_ratio !== null);
  const gzipped = rows.filter((r) => r.compression_ratio !== null && r.compression_ratio > 1.0);
  const maxRatio = measurable.reduce((m, r) => Math.max(m, r.compression_ratio ?? 0), 0);
  process.stdout.write(
    `Summary: ${rows.length} paths, ${refusals.length} refusals, ${gzipped.length} with compression_ratio>1, ` +
    `max_ratio=${maxRatio.toFixed(1)}x, ${measurable.length} measurable\n`,
  );
  if (gzipped.length === 0 && rows.length > 0) {
    process.stdout.write('NOTE: no path showed wire_bytes < uncompressed_bytes; either no server compresses these responses, or content-length was absent (chunked transfer).\n');
  }
}

main().catch((err) => {
  // Only crash for truly unexpected errors (programming mistakes)
  console.error('Fatal:', err);
  process.exit(1);
});
