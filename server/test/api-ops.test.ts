/**
 * Operational and recipe endpoints, driven over HTTP against a real SQLite
 * file. None of these reach a store, so unlike api.test.ts they always run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb } from '../src/db.js';
import { Repo } from '../src/repo.js';
import { Poller } from '../src/jobs/poller.js';
import { registerRoutes } from '../src/routes.js';
import type { ClearanceRepo } from '../src/clearance/repo.js';
import type { ClearanceSweepJob } from '../src/jobs/clearance-sweep.js';

let dir: string;
let app: FastifyInstance;
let base: string;
let repo: Repo;
let fireSweepAlerts: () => void = () => undefined;
const listAlertsCalls: unknown[] = [];

const FAKE_ALERT = { id: 5, createdAt: '2026-10-06T04:00:00.000Z', message: 'rtx 4070 at 40% off', acknowledged: false, term: 'rtx', find: { itemId: '1' } };

test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bastille-ops-'));
  app = Fastify();
  const db = openDb(join(dir, 'test.db'));
  repo = new Repo(db);
  const clearance = {
    repo: { listAlerts: (opts: unknown) => (listAlertsCalls.push(opts), [FAKE_ALERT]) } as unknown as ClearanceRepo,
    sweep: { onAlerts: (fn: () => void) => { fireSweepAlerts = fn; } } as unknown as ClearanceSweepJob,
  };
  registerRoutes(app, repo, new Poller(repo, 60_000), undefined, { clearance });
  base = await app.listen({ port: 0, host: '127.0.0.1' });
});

test.after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test('POST /api/recipes/parse returns one parsed ingredient per non-empty line', async () => {
  const { status, body } = await post('/api/recipes/parse', {
    text: '2 cups all-purpose flour\n\n  1 tsp kosher salt  \r\n3 large eggs\n',
  });
  assert.equal(status, 200);
  assert.equal(body.ingredients.length, 3);
  assert.deepEqual(body.ingredients.map((i: any) => i.raw), ['2 cups all-purpose flour', '1 tsp kosher salt', '3 large eggs']);
  assert.ok(body.ingredients.every((i: any) => Array.isArray(i.queries) && typeof i.pantry === 'boolean'));
  assert.equal(body.truncated, undefined);
});

test('POST /api/recipes/parse rejects a missing or blank text', async () => {
  assert.equal((await post('/api/recipes/parse', {})).status, 400);
  assert.equal((await post('/api/recipes/parse', { text: '   \n ' })).status, 400);
  assert.equal((await post('/api/recipes/parse', { text: 5 })).status, 400);
});

test('POST /api/recipes/parse caps at 200 lines and says so', async () => {
  const text = Array.from({ length: 250 }, (_, i) => `${i + 1} cups flour`).join('\n');
  const { status, body } = await post('/api/recipes/parse', { text });
  assert.equal(status, 200);
  assert.equal(body.ingredients.length, 200);
  assert.equal(body.truncated, true);
});

test('GET /api/snapshot/status exposes when retention last ran', async () => {
  const before = await (await fetch(`${base}/api/snapshot/status`)).json() as any;
  assert.equal(before.lastPrunedAt, null);
  repo.pruneSnapshots(90);
  const after = await (await fetch(`${base}/api/snapshot/status`)).json() as any;
  assert.equal(typeof after.lastPrunedAt, 'string');
  assert.ok('dates' in after && 'running' in after && 'lastRun' in after, 'existing fields stay');
});

test('GET /api/metrics reports hosts, caches, jobs and SSE clients', async () => {
  repo['db'].prepare('INSERT INTO request_log (ts, host, op, status, ms, bytes) VALUES (?,?,?,?,?,?)')
    .run(new Date().toISOString(), 'example.test', '/a', 429, 12, 100);
  const run = repo.startPollRun(null);
  repo.finishPollRun(run, 1, 0, null, { requests: 4, bytes: 50 });

  const m = await (await fetch(`${base}/api/metrics`)).json() as any;
  assert.equal(m.hosts['example.test'].requests, 1);
  assert.equal(m.hosts['example.test'].throttled['429'], 1);
  assert.equal(m.hosts['example.test'].status['4xx'], 1);
  assert.deepEqual(Object.keys(m.caches.search).sort(), ['hitRatio', 'hits', 'joined', 'misses', 'size']);
  assert.equal(m.jobs.poll.requests, 4);
  assert.equal(m.jobs.snapshot, null);
  assert.equal(m.sse.clients, 0);
  assert.equal(typeof m.generatedAt, 'string');
  assert.ok('foodlion' in m.adapters && 'catalogueBuilds' in m.adapters.foodlion);
});

test('a sweep that raises alerts is pushed on the alerts stream as clearance-alerts', async () => {
  const ctl = new AbortController();
  const res = await fetch(`${base}/api/alerts/stream`, { signal: ctl.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  const next = async () => {
    const { value } = await reader.read();
    seen += decoder.decode(value);
  };
  await next(); // ": connected"

  assert.equal(((await (await fetch(`${base}/api/metrics`)).json()) as any).sse.clients, 1);

  fireSweepAlerts();
  while (!seen.includes('clearance-alerts')) await next();
  const line = seen.split('\n').find((l) => l.startsWith('data: '))!;
  assert.deepEqual(JSON.parse(line.slice(6)), { type: 'clearance-alerts', alerts: [FAKE_ALERT] });
  assert.deepEqual(listAlertsCalls.at(-1), { unacknowledgedOnly: true });
  ctl.abort();
});
