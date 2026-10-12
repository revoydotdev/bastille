/**
 * server/test/measure-bytes.test.mjs
 *
 * Offline unit tests for measure-bytes.mjs wire byte measurement.
 * Uses http.createServer to serve controlled gzip/identity responses so
 * assertions are unconditional and deterministic.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const { measureOneNative } = await import('../../scripts/measure-bytes.mjs');

let server;
let serverPort;

// "hello world " repeated 80 times — ~960 bytes; gzip compresses this well (~290 B, ratio ≈ 0.30)
const TEST_BODY = Buffer.from('hello world '.repeat(80));
const GZIPPED_BODY = zlib.gzipSync(TEST_BODY);

before(() => {
  server = http.createServer((req, res) => {
    if (req.headers['accept-encoding']?.includes('gzip')) {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end(GZIPPED_BODY);
    } else {
      res.writeHead(200, { 'content-encoding': 'identity' });
      res.end(TEST_BODY);
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      resolve();
    });
  });
});

after(() => {
  server.close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('gzip: wire_bytes equals actual compressed bytes sent by server', async () => {
  const result = await measureOneNative(
    `http://127.0.0.1:${serverPort}/`,
    { method: 'GET', headers: { 'accept-encoding': 'gzip, br', accept: '*/*' } }
  );

  assert.strictEqual(result.http_status, 200);
  assert.strictEqual(result.content_encoding, 'gzip');
  assert.strictEqual(result.error, null);

  // wire_bytes must be exactly the gzipped body length
  assert.strictEqual(result.wire_bytes, GZIPPED_BODY.length,
    `wire_bytes should be ${GZIPPED_BODY.length} (gzipped test body), got ${result.wire_bytes}`);
});

test('gzip: uncompressed_bytes equals decompressed body length', async () => {
  const result = await measureOneNative(
    `http://127.0.0.1:${serverPort}/`,
    { method: 'GET', headers: { 'accept-encoding': 'gzip, br', accept: '*/*' } }
  );

  assert.strictEqual(result.http_status, 200);
  assert.strictEqual(result.error, null);

  // uncompressed_bytes must be exactly TEST_BODY.length
  assert.strictEqual(result.uncompressed_bytes, TEST_BODY.length,
    `uncompressed_bytes should be ${TEST_BODY.length}, got ${result.uncompressed_bytes}`);
});

test('gzip: compression_ratio equals uncompressed / wire_bytes', async () => {
  const result = await measureOneNative(
    `http://127.0.0.1:${serverPort}/`,
    { method: 'GET', headers: { 'accept-encoding': 'gzip, br', accept: '*/*' } }
  );

  assert.strictEqual(result.http_status, 200);
  assert.strictEqual(result.error, null);

  const expectedRatio = Math.round((result.uncompressed_bytes / result.wire_bytes) * 100) / 100;
  assert.strictEqual(result.compression_ratio, expectedRatio,
    `compression_ratio should be ${expectedRatio}, got ${result.compression_ratio}`);
});

test('UNIVERSAL INVARIANT: uncompressed_bytes >= wire_bytes always', async () => {
  // This single assertion catches the old socket-delta bug where
  // wire_bytes was under-reported and uncompressed > wire (ratio > 1.0
  // on identity content — wrong).
  const result = await measureOneNative(
    `http://127.0.0.1:${serverPort}/`,
    { method: 'GET', headers: { 'accept-encoding': 'gzip, br', accept: '*/*' } }
  );

  assert.strictEqual(result.http_status, 200);
  assert.strictEqual(result.error, null);
  assert.ok(result.uncompressed_bytes >= result.wire_bytes,
    `uncompressed_bytes (${result.uncompressed_bytes}) must be >= wire_bytes (${result.wire_bytes})`);
});

test('identity: wire_bytes equals uncompressed_bytes (no compression)', async () => {
  const result = await measureOneNative(
    `http://127.0.0.1:${serverPort}/`,
    { method: 'GET', headers: { accept: '*/*' } } // no accept-encoding
  );

  assert.strictEqual(result.http_status, 200);
  assert.strictEqual(result.content_encoding, 'identity');
  assert.strictEqual(result.error, null);
  assert.strictEqual(result.wire_bytes, result.uncompressed_bytes,
    `identity: wire_bytes (${result.wire_bytes}) must equal uncompressed_bytes (${result.uncompressed_bytes})`);
  assert.strictEqual(result.compression_ratio, null,
    'identity encoding must have null compression_ratio');
});

test('refusal: 418 returns null wire_bytes and null compression_ratio', async () => {
  // Attach a one-shot server that returns 418
  const refusalServer = http.createServer((req, res) => {
    res.writeHead(418, { 'content-encoding': 'identity' });
    res.end();
  });

  await new Promise((resolve) => {
    refusalServer.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });

  try {
    const port = refusalServer.address().port;
    const result = await measureOneNative(
      `http://127.0.0.1:${port}/`,
      { method: 'GET', headers: { 'accept-encoding': 'gzip, br', accept: '*/*' } }
    );

    assert.strictEqual(result.http_status, 418);
    assert.strictEqual(result.wire_bytes, null, 'wire_bytes must be null for 418 refusal');
    assert.strictEqual(result.compression_ratio, null, 'compression_ratio must be null when wire_bytes is null');
    assert.strictEqual(result.error.kind, 'http_418');
  } finally {
    refusalServer.close();
  }
});
