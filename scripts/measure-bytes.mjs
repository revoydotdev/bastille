#!/usr/bin/env node
/**
 * scripts/measure-bytes.mjs
 *
 * Measures compressed wire bytes alongside decompressed bytes for each bastille
 * ingest path, and records the result into $BASTILLE_EVIDENCE_DIR/wave-A/bytes.json.
 *
 * Wire bytes are the raw compressed body length as received over the wire
 * (Buffer.concat(chunks).length) — NOT socket.bytesRead deltas which include
 * socket-level read-ahead and systematically under-report body size.
 *
 * The native http/https module does NOT auto-decompress like undici, so we
 * manually decompress based on content-encoding to get true uncompressed size.
 *
 * Handles 403/412/418/429/503/timeout as refusal rows — the script never exits
 * non-zero for an HTTP refusal.
 */
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
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

async function githubRawControl() {
  // GitHub raw: content-length + gzip — good offline-verifiable control that
  // wire_bytes (raw body length) matches what curl --compressed reports
  return {
    url: 'https://raw.githubusercontent.com/nodejs/node/main/README.md',
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

const REFUSAL_CODES = new Set([403, 405, 412, 418, 429, 503]);

/** A refusal/transport-error row: no measurement, only the reason. */
const refused = (status, encoding, error) => ({
  wire_bytes: null,
  uncompressed_bytes: null,
  compression_ratio: null,
  content_encoding: encoding,
  http_status: status,
  measured_at: new Date().toISOString(),
  error,
});

// ---------------------------------------------------------------------------
// Measurement using native http/https with socket byte tracking
// ---------------------------------------------------------------------------

/**
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} opts
 * @returns {Promise<{wire_bytes: number|null, uncompressed_bytes: number|null, compression_ratio: number|null, content_encoding: string, http_status: number, error: {kind: string, message: string, duration_ms: number}|null}>}
 */
async function measureOneNative(url, { method = 'GET', headers = {}, body = undefined }) {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';
      const mod = isHttps ? https : http;

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers: { ...headers },
        // One-shot agent per request: Node's global agent pools keep-alive
        // sockets, which stay referenced and keep the event loop alive long
        // after the measurement is written — the script would never exit.
        agent: false,
      };

      const req = mod.request(options, (res) => {
        const contentEncoding = (res.headers['content-encoding'] ?? 'identity').toLowerCase();

        // 4xx/5xx from the server is a refusal, not a measurement
        if (REFUSAL_CODES.has(res.statusCode)) {
          clearTimeout(timeout);
          const durationMs = Math.round(performance.now() - startedAt);
          resolve(refused(
            res.statusCode,
            contentEncoding,
            { kind: `http_${res.statusCode}`, message: `HTTP ${res.statusCode} refusal`, duration_ms: durationMs },
          ));
          return;
        }

        // Collect raw (compressed) body chunks — the native http module does NOT
        // auto-decompress, so chunks contains the true wire bytes as received.
        const chunks = [];

        res.on('data', (chunk) => {
          chunks.push(chunk);
        });

        res.on('end', () => {
          clearTimeout(timeout);
          const durationMs = Math.round(performance.now() - startedAt);

          if (chunks.length === 0) {
            resolve({
              wire_bytes: 0,
              uncompressed_bytes: 0,
              compression_ratio: null,
              content_encoding: contentEncoding,
              http_status: res.statusCode,
              measured_at: new Date().toISOString(),
              error: null,
            });
            return;
          }

          const rawBody = Buffer.concat(chunks);
          const wireBytes = rawBody.length; // actual compressed bytes on the wire

          // Uncompressed size by decompressing the observed body. A failed
          // decompression is recorded as an error, never as an assumed
          // uncompressed==wire size — the plan forbids an estimate posing as
          // a measurement.
          let uncompressedBytes = null;
          let decompressError = null;
          try {
            if (contentEncoding === 'gzip') {
              uncompressedBytes = zlib.gunzipSync(rawBody).length;
            } else if (contentEncoding === 'br') {
              uncompressedBytes = zlib.brotliDecompressSync(rawBody).length;
            } else {
              // identity (or an encoding we do not decode) — the body is the body
              uncompressedBytes = wireBytes;
            }
          } catch (err) {
            decompressError = {
              kind: 'decompress_failed',
              message: String(err.message).slice(0, 200),
              duration_ms: durationMs,
            };
          }

          if (decompressError) {
            // wire_bytes is still a true observation, so keep it; only the
            // decompressed half of the pair is unknown.
            resolve({
              wire_bytes: wireBytes,
              uncompressed_bytes: null,
              compression_ratio: null,
              content_encoding: contentEncoding,
              http_status: res.statusCode,
              measured_at: new Date().toISOString(),
              error: decompressError,
            });
            return;
          }

          // compression_ratio is null when there is nothing to compress
          // (identity encoding), where uncompressed === wire by definition.
          const compressionRatio = contentEncoding === 'identity' || uncompressedBytes <= wireBytes
            ? null
            : Math.round((uncompressedBytes / wireBytes) * 100) / 100;

          resolve({
            wire_bytes: wireBytes,
            uncompressed_bytes: uncompressedBytes,
            compression_ratio: compressionRatio,
            content_encoding: contentEncoding,
            http_status: res.statusCode,
            measured_at: new Date().toISOString(),
            error: null,
          });
        });

        res.on('error', (err) => {
          clearTimeout(timeout);
          const durationMs = Math.round(performance.now() - startedAt);
          resolve(refused(
            null,
            contentEncoding,
            { kind: 'network', message: String(err.message).slice(0, 200), duration_ms: durationMs },
          ));
        });
      });

      req.on('error', (err) => {
        clearTimeout(timeout);
        const durationMs = Math.round(performance.now() - startedAt);
        const kind = err.code === 'ECONNREFUSED' ? 'refused' : /** @type {string} */ (err.code ?? 'unknown');
        resolve(refused(
          null,
          'identity',
          { kind, message: String(err.message).slice(0, 200), duration_ms: durationMs },
        ));
      });

      req.on('abort', () => {
        clearTimeout(timeout);
        const durationMs = Math.round(performance.now() - startedAt);
        resolve(refused(
          null,
          'identity',
          { kind: 'timeout', message: 'Request aborted/timeout', duration_ms: durationMs },
        ));
      });

      controller.signal.addEventListener('abort', () => {
        req.abort();
      });

      if (body) {
        req.write(body);
      }
      req.end();
    } catch (err) {
      clearTimeout(timeout);
      const durationMs = Math.round(performance.now() - startedAt);
      resolve(refused(
        null,
        'identity',
        { kind: 'unknown', message: String(err.message).slice(0, 200), duration_ms: durationMs },
      ));
    }
  });
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
    { path: 'github-raw-control', label: 'GitHub raw README.md (content-length+gzip control)', buildRequest: githubRawControl },
  ];

  const rows = [];

  for (const { path, label, buildRequest } of paths) {
    process.stderr.write(`[measure] ${label} …\n`);

    // Arm 1: compression enabled (production-like)
    const normalOpts = await buildRequest();
    const normalResult = await measureOneNative(normalOpts.url, normalOpts);

    // Arm 2: compression disabled (identity) — same URL, strip accept-encoding
    const noCompHeaders = { ...normalOpts.headers };
    delete noCompHeaders['accept-encoding'];
    const noCompOpts = { ...normalOpts, headers: noCompHeaders };
    const noCompResult = await measureOneNative(noCompOpts.url, noCompOpts);

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
    script_version: '1.4.0',
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
    process.stdout.write('WARNING: no path showed wire_bytes < uncompressed_bytes; check socket tracking is working.\n');
  }
}

// Belt and braces: drop any pooled sockets the global agents may still hold,
// so the CLI terminates instead of idling on keep-alive connections.
process.on('beforeExit', () => {
  http.globalAgent.destroy();
  https.globalAgent.destroy();
});

// Guard: only run main() when executed directly, not when imported as a module
// (e.g. by `node --test scripts/measure-bytes.test.mjs`)
import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export { measureOneNative, REFUSAL_CODES };
