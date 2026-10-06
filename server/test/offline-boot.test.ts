/**
 * Boots the real server entry point with BASTILLE_OFFLINE=1 and checks that it
 * comes up, serves, and made no upstream read. This is the egress-free smoke
 * test: nothing here depends on any store being reachable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = resolve(fileURLToPath(import.meta.url), '../../src/index.ts');

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });
}

async function until<T>(fn: () => Promise<T | undefined>, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('timed out waiting for the server');
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('the server boots with no egress and no schedulers under BASTILLE_OFFLINE=1', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bastille-offline-'));
  const port = await freePort();
  let log = '';
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', entry], {
    env: {
      ...process.env,
      BASTILLE_OFFLINE: '1',
      BASTILLE_DB: join(dir, 'offline.db'),
      PORT: String(port),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    rmSync(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  const status = await until(async () => {
    const res = await fetch(`${base}/api/status`);
    return res.ok ? ((await res.json()) as { polling: boolean; lastPoll: unknown }) : undefined;
  }, 20_000);
  assert.equal(status.polling, false);
  assert.equal(status.lastPoll, null);

  // Give a would-be warm() a moment to start reading, then confirm it did not.
  await new Promise((r) => setTimeout(r, 500));
  const metrics = (await (await fetch(`${base}/api/metrics`)).json()) as {
    hosts: Record<string, unknown>;
    adapters: { foodlion: { catalogueBuilds: number } };
  };
  assert.deepEqual(metrics.hosts, {}, `no upstream read may be logged; server output:\n${log}`);
  assert.equal(metrics.adapters.foodlion.catalogueBuilds, 0, 'the catalogue was not warmed');

  // A store search is refused in-process rather than attempted.
  const search = (await (await fetch(`${base}/api/search?q=milk&stores=wegmans`)).json()) as {
    errors: { message: string }[];
  };
  assert.match(search.errors[0]?.message ?? '', /offline mode/);
});
