#!/usr/bin/env node
/**
 * scripts/measure-bytes.mjs
 *
 * Measures compressed wire bytes alongside decompressed bytes for each bastille
 * ingest path, and records the result into $BASTILLE_EVIDENCE_DIR/wave-A/bytes.json.
 *
 * Usage:
 *   node scripts/measure-bytes.mjs
 *   BASTILLE_EVIDENCE_DIR=/custom/path node scripts/measure-bytes.mjs
 *
 * Two arms per path:
 *   - normal:    accept-encoding: gzip, br  (production-like, compressed)
 *   - no_compression: accept-encoding: identity  (baseline, uncompressed)
 *
 * Wire bytes are sourced from the response Content-Length header where available;
 * undici inflates the body before giving it to us, so Buffer.byteLength(text)
 * gives the decompressed size (matching what request_log.bytes records today).
 *
 * Handles 403/412/418/429/503/timeout as refusal rows — the script never exits
 * non-zero for an HTTP refusal.
 */
import { request } from 'undici';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const EVIDENCE_DIR = process.env.BASTILLE_EVIDENCE_DIR ?? '/home/revelri/hex/.omo/evidence/wave-A';
const OUT_FILE = resolve(EVIDENCE_DIR, 'bytes.json');

// ---------------------------------------------------------------------------
// Ingest paths to measure
// ---------------------------------------------------------------------------

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

async function walmartBrowse() {
  // ps=40 (production page size) for realistic byte cost measurement
  return {
    url: 'https://www.walmart.com/orchestra/home/graphql/browse/6d3a5c2b15c96f4fd5e5e7c3c9e3f2a9c8d7b6e4f5a3c2d1e0f9a8b7c6d5e4f3?variables=' + encodeURIComponent(JSON.stringify({ catId: '3944', page: 1, ps: 40, sort: 'new' })),
    method: 'GET',
    headers: {
      'accept-encoding': 'gzip, br',
      accept: 'application/json',
    },
  };
}

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

async function wegmansAlgolia() {
  const ALGOLIA_APP_ID = 'QGPPR19V8V';
  const ALGOLIA_API_KEY = '9a10b1401634e9a6e55161c3a60c200d';
  const params = new URLSearchParams({
    query: 'milk',
    hitsPerPage: '1',
    filters: 'soldAtStores:24',
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

async function traderJoesGraphQL() {
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

async function foodLionAisle() {
  return {
    url: 'https://foodlion.com/groceries/2098-produce/',
    method: 'GET',
    headers: {
      'accept-encoding': 'gzip, br',
      accept: 'text/html,*/*;q=0.8',
    },
  };
}

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
// Refusal codes
// ---------------------------------------------------------------------------

const REFUSAL_CODES = new Set([403, 412, 418, 429, 503]);

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} opts
 * @returns {Promise<{wire_bytes: number|null, uncompressed_bytes: number|null, compression_ratio: number|null, content_encoding: string, http_status: number, error: {kind: string, message: string, duration_ms: number}|null}>}
 */
async function measureOne(url, { method = 'GET', headers = {}, body = undefined }) {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const res = await request(url, {
      method,
      headers,
      body,
      signal: controller.signal,
      headersTimeout: 20_000,
      bodyTimeout: 20_000,
    });

    clearTimeout(timeout);

    // content-length is the compressed wire size when content-encoding is active;
    // undici has already decompressed the body before we read it.
    const contentLengthHeader = /** @type {string | null} */ (res.headers['content-length'] ?? null);
    const contentEncoding = /** @type {string} */ ((res.headers['content-encoding'] ?? 'identity').toLowerCase());

    // 4xx from the server is a refusal
    if (REFUSAL_CODES.has(res.statusCode)) {
      const durationMs = Math.round(performance.now() - startedAt);
      return {
        wire_bytes: null,
        uncompressed_bytes: null,
        compression_ratio: null,
        content_encoding: contentEncoding,
        http_status: res.statusCode,
        error: { kind: `http_${res.statusCode}`, message: `HTTP ${res.statusCode} refusal`, duration_ms: durationMs },
      };
    }

    const text = await res.body.text();
    const durationMs = Math.round(performance.now() - startedAt);
    const uncompressedBytes = Buffer.byteLength(text);

    // wire_bytes: only derivable from content-length when the server sent it.
    // When absent (chunked transfer) and compression is active, we cannot know
    // the compressed size — do NOT fabricate an estimate.
    let wireBytes = null;
    if (contentLengthHeader !== null && contentEncoding !== 'identity') {
      const cl = parseInt(contentLengthHeader, 10);
      if (cl > 0) wireBytes = cl;
    }

    // compression_ratio: null when we have no wire_bytes for a compressed response
    let compressionRatio = null;
    if (wireBytes !== null && wireBytes > 0 && wireBytes < uncompressedBytes) {
      compressionRatio = Math.round((uncompressedBytes / wireBytes) * 100) / 100;
    }

    return {
      wire_bytes: wireBytes,
      uncompressed_bytes: uncompressedBytes,
      compression_ratio: compressionRatio,
      content_encoding: contentEncoding,
      http_status: res.statusCode,
      error: null,
    };
  } catch (err) {
    clearTimeout(timeout);
    const durationMs = Math.round(performance.now() - startedAt);
    const kind = err.code === 'UND_ERR_ABORTED' || err.message === 'The operation was aborted'
      ? 'timeout'
      : /** @type {string} */ (err.code ?? 'unknown');

    return {
      wire_bytes: null,
      uncompressed_bytes: null,
      compression_ratio: null,
      content_encoding: 'identity',
      http_status: 0,
      error: { kind, message: String(err.message).slice(0, 200), duration_ms: durationMs },
    };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(EVIDENCE_DIR, { recursive: true });

  /** @type {Array<{path: string, label: string, buildRequest: () => Promise<any>}>} */
  const paths = [
    { path: 'walmart-store-finder', label: 'Walmart Store Finder (nearByNodes, ZIP 22901, 50mi)', buildRequest: walmartStoreFinder },
    { path: 'walmart-browse', label: 'Walmart Browse ps=40 catId=3944', buildRequest: walmartBrowse },
    { path: 'wegmans-api-stores', label: 'Wegmans /api/stores', buildRequest: wegmansApiStores },
    { path: 'wegmans-algolia', label: 'Wegmans Algolia products_v2 search "milk"', buildRequest: wegmansAlgolia },
    { path: 'traderjoes-graphql', label: "Trader Joe's GraphQL StoresSearch", buildRequest: traderJoesGraphQL },
    { path: 'foodlion-aisle', label: 'Food Lion aisle page (produce)', buildRequest: foodLionAisle },
    { path: 'control', label: 'example.com static control', buildRequest: controlUrl },
  ];

  const rows = [];

  for (const { path, label, buildRequest } of paths) {
    process.stderr.write(`[measure] ${label} …\n`);

    // Arm 1: compression enabled (production-like)
    const normalOpts = await buildRequest();
    const normalResult = await measureOne(normalOpts.url, normalOpts);

    // Arm 2: compression disabled (identity) — same URL, strip accept-encoding
    const noCompHeaders = { ...normalOpts.headers };
    delete noCompHeaders['accept-encoding'];
    const noCompOpts = { ...normalOpts, headers: noCompHeaders };
    const noCompResult = await measureOne(noCompOpts.url, noCompOpts);

    const row = {
      path,
      label,
      url_attempted: normalOpts.url,
      normal: normalResult,
      no_compression: noCompResult,
    };
    rows.push(row);

    if (normalResult.error) {
      process.stderr.write(`  normal: REFUSED ${normalResult.error.kind} (${normalResult.http_status})\n`);
    } else {
      process.stderr.write(`  normal: ${normalResult.http_status} wire=${normalResult.wire_bytes} uncompressed=${normalResult.uncompressed_bytes} ratio=${normalResult.compression_ratio}x ce=${normalResult.content_encoding}\n`);
    }

    if (noCompResult.error) {
      process.stderr.write(`  no_compression: REFUSED ${noCompResult.error.kind} (${noCompResult.http_status})\n`);
    } else {
      process.stderr.write(`  no_compression: ${noCompResult.http_status} wire=${noCompResult.wire_bytes} uncompressed=${noCompResult.uncompressed_bytes} ce=${noCompResult.content_encoding}\n`);
    }

    // 2-second per-host pacing
    await new Promise((r) => setTimeout(r, 2000));
  }

  const result = {
    measured_at: new Date().toISOString(),
    script_version: '1.1.0',
    paths: rows,
  };

  writeFileSync(OUT_FILE, JSON.stringify(result, null, 2));
  process.stdout.write(`Written: ${OUT_FILE}\n`);

  const refusals = rows.filter((r) => r.normal.error !== null || r.no_compression.error !== null);
  const withRatio = rows.filter((r) => r.normal.compression_ratio !== null);
  const gzipped = withRatio.filter((r) => r.normal.compression_ratio > 1.0);
  const maxRatio = withRatio.reduce((m, r) => Math.max(m, r.normal.compression_ratio ?? 0), 0);
  process.stdout.write(
    `Summary: ${rows.length} paths, ${refusals.length} refusals, ${gzipped.length} with compression_ratio>1, ` +
    `max_ratio=${maxRatio.toFixed(1)}x, ${withRatio.length} measurable\n`,
  );
  if (gzipped.length === 0 && rows.length > 0) {
    process.stdout.write('NOTE: no path showed wire_bytes < uncompressed_bytes; either no server compresses these responses, or content-length was absent (chunked transfer).\n');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
