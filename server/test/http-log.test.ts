/**
 * The HTTP client's two shared responsibilities: pace reads per host without a
 * check-then-act race (C-4), and account for every read in `request_log`
 * without keeping anything personal (O-1). Runs against a loopback server, so
 * it needs no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The floor is read when http.ts loads, so set it first.
process.env.BASTILLE_MIN_REQUEST_INTERVAL_MS = '80';
const { fetchText } = await import('../src/adapters/http.js');
const { installRequestLog, tallyRequests, hostMetrics, pruneRequestLog } = await import('../src/metrics.js');
const { openDb } = await import('../src/db.js');

async function withServer(
  handler: (url: string, hits: { t: number; url: string }[]) => { status: number; body: string },
  fn: (base: string, hits: { t: number; url: string }[]) => Promise<void>,
): Promise<void> {
  const hits: { t: number; url: string }[] = [];
  const server = createServer((req, res) => {
    hits.push({ t: Date.now(), url: req.url ?? '' });
    const { status, body } = handler(req.url ?? '', hits);
    res.writeHead(status, { 'content-type': 'text/plain' }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

test('concurrent reads to one host leave the server at least the floor apart', async () => {
  await withServer(() => ({ status: 200, body: 'ok' }), async (base, hits) => {
    await Promise.all([1, 2, 3, 4, 5].map((i) => fetchText(`${base}/p${i}`)));
    assert.equal(hits.length, 5);
    for (let i = 1; i < hits.length; i++) {
      // 80 ms floor; allow scheduler jitter but nowhere near a burst.
      assert.ok(hits[i]!.t - hits[i - 1]!.t >= 60, `gap ${i} was ${hits[i]!.t - hits[i - 1]!.t}ms`);
    }
  });
});

test('every read is logged with host, path, status, latency and size, and no query string', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bastille-httplog-'));
  const db = openDb(join(dir, 't.db'));
  const uninstall = installRequestLog(db);
  try {
    await withServer(
      (url) => (url.startsWith('/missing') ? { status: 404, body: 'no' } : { status: 200, body: 'hello' }),
      async (base) => {
        const tallied = await tallyRequests(async () => {
          await fetchText(`${base}/shelf?postalCode=90210&q=insulin`);
          await assert.rejects(() => fetchText(`${base}/missing`), /404/);
        });
        assert.equal(tallied.requests, 2);
        assert.equal(tallied.bytes, 'hello'.length + 'no'.length);
      },
    );

    const rows = db.prepare('SELECT * FROM request_log ORDER BY id').all() as unknown as {
      host: string; op: string; status: number; ms: number; bytes: number;
    }[];
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => [r.op, r.status, r.bytes]), [['/shelf', 200, 5], ['/missing', 404, 2]]);
    assert.ok(rows.every((r) => r.host.startsWith('127.0.0.1:') && r.ms >= 0));
    assert.ok(!JSON.stringify(rows).includes('90210') && !JSON.stringify(rows).includes('insulin'));

    const host = hostMetrics(db)[rows[0]!.host]!;
    assert.equal(host.requests, 2);
    assert.equal(host.status['2xx'], 1);
    assert.equal(host.status['4xx'], 1);
    assert.equal(host.bytes, 7);
    assert.ok(host.p50Ms !== null && host.p95Ms !== null && host.p95Ms >= host.p50Ms);
  } finally {
    uninstall();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('412 and 429 are counted on their own as well as under 4xx', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bastille-httplog-'));
  const db = openDb(join(dir, 't.db'));
  try {
    const ins = db.prepare('INSERT INTO request_log (ts, host, op, status, ms, bytes) VALUES (?,?,?,?,?,?)');
    const ts = new Date().toISOString();
    for (const [status, ms] of [[200, 10], [412, 20], [412, 30], [429, 40], [503, 50], [0, 60]] as const) {
      ins.run(ts, 'h', '/x', status, ms, 1);
    }
    const m = hostMetrics(db).h!;
    assert.deepEqual(m.status, { '2xx': 1, '3xx': 0, '4xx': 3, '5xx': 1, errors: 1 });
    assert.deepEqual(m.throttled, { '412': 2, '429': 1 });
    assert.equal(m.p50Ms, 30);
    assert.equal(m.p95Ms, 60);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the request log is bounded by age', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bastille-httplog-'));
  const db = openDb(join(dir, 't.db'));
  try {
    const ins = db.prepare('INSERT INTO request_log (ts, host, op, status, ms, bytes) VALUES (?,?,?,?,?,?)');
    ins.run('2020-01-01T00:00:00.000Z', 'h', '/old', 200, 1, 1);
    ins.run(new Date().toISOString(), 'h', '/new', 200, 1, 1);
    assert.equal(pruneRequestLog(db), 1);
    const left = db.prepare('SELECT op FROM request_log').all() as unknown as { op: string }[];
    assert.deepEqual(left.map((r) => r.op), ['/new']);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BASTILLE_OFFLINE=1 refuses a read before it leaves the process', async () => {
  await withServer(() => ({ status: 200, body: 'ok' }), async (base, hits) => {
    process.env.BASTILLE_OFFLINE = '1';
    try {
      await assert.rejects(() => fetchText(`${base}/x`), /offline mode/);
    } finally {
      delete process.env.BASTILLE_OFFLINE;
    }
    assert.equal(hits.length, 0);
  });
});
