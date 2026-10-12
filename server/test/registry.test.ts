/**
 * Tests for the config-driven source registry (todo 16).
 *
 * Two paths to cover:
 *  1. A test-only config entry is discovered by the registry, the web
 *     typecheck still passes after codegen, and `/api/stores` lists it.
 *  2. An entry declaring a capability the named adapter does not implement
 *     is rejected at boot with a named `RegistryCapabilityError`.
 *
 * The happy path is end-to-end: we write a temp registry, point the
 * codegen and the server entry at it via `BASTILLE_REGISTRY_PATH`, run the
 * codegen and `tsc -b` on the web package, then boot the real server in
 * `BASTILLE_OFFLINE=1` mode and hit `/api/stores`. The original registry
 * and TS files are snapshotted up front and restored in `finally`, so a
 * crash mid-test leaves the repo exactly as it was.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RegistryCapabilityError,
  loadRegistry,
  loadRegistryConfig,
  resolveRegistry,
  KNOWN_ADAPTERS,
} from '../src/adapters/registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const REGISTRY_FILE = join(REPO, 'data/registry.json');
const SERVER_MODEL = join(REPO, 'server/src/price/model.ts');
const WEB_TYPES = join(REPO, 'web/src/types.ts');
const CODEGEN = join(REPO, 'scripts/codegen-registry.mjs');
const SERVER_ENTRY = join(REPO, 'server/src/index.ts');

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

function snapshot(): {
  registry: string;
  serverModel: string;
  webTypes: string;
} {
  return {
    registry: readFileSync(REGISTRY_FILE, 'utf8'),
    serverModel: readFileSync(SERVER_MODEL, 'utf8'),
    webTypes: readFileSync(WEB_TYPES, 'utf8'),
  };
}

function restore(snap: { registry: string; serverModel: string; webTypes: string }): void {
  writeFileSync(REGISTRY_FILE, snap.registry);
  writeFileSync(SERVER_MODEL, snap.serverModel);
  writeFileSync(WEB_TYPES, snap.webTypes);
}

function runCodegen(registryPath: string): void {
  const r = spawnSync('node', [CODEGEN], {
    cwd: REPO,
    env: { ...process.env, BASTILLE_REGISTRY_PATH: registryPath },
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`codegen failed (exit ${r.status}):\n${r.stderr || r.stdout}`);
  }
}

function runWebTypecheck(): void {
  const r = spawnSync('npm', ['run', 'typecheck', '--workspace=web'], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  if (r.status !== 0) {
    throw new Error(`web typecheck failed (exit ${r.status}):\n${r.stderr || r.stdout}`);
  }
}

async function waitForApi(port: number, timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/api/status`;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
      lastErr = new Error(`status ${r.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for server on :${port}: ${lastErr}`);
}

/** The happy-path test is end-to-end (codegen + web typecheck + server boot),
 *  so it runs serially against the shared files and must restore state on
 *  exit. We mark it `concurrency: false` to be safe. */
test(
  'a test-only config entry is discovered, the web typecheck still passes, and /api/stores lists it',
  { concurrency: false },
  async (t) => {
    const snap = snapshot();
    const dir = mkdtempSync(join(tmpdir(), 'bastille-registry-'));
    const tmpRegistry = join(dir, 'registry.json');
    const original = JSON.parse(snap.registry) as { sources: unknown[] };
    // Append a test-only entry that re-uses an existing adapter class. The id
    // must be brand-new so the codegen-emitted union widens visibly.
    const sources = [
      ...original.sources,
      {
        id: 'test-store-1',
        label: 'Test Store 1',
        adapter: 'FoodLionAdapter',
        defaultLocationId: 'national',
        pricesVaryByLocation: false,
        enabled: true,
        capabilities: {
          search: true,
          fetchOffer: true,
          enumerate: true,
          findLocations: true,
          zipAnchors: true,
          warm: true,
          stats: true,
          clearance: false,
          promotionParsing: true,
        },
        transport: { requiresProxy: false, requiresEgressNode: false },
        cost_per_read_bytes: 0,
      },
    ];
    writeFileSync(tmpRegistry, JSON.stringify({ sources }, null, 2));

    t.after(() => {
      restore(snap);
      rmSync(dir, { recursive: true, force: true });
    });

    runCodegen(tmpRegistry);

    // The codegen must have widened the union on BOTH sides.
    const serverModel = readFileSync(SERVER_MODEL, 'utf8');
    const webTypes = readFileSync(WEB_TYPES, 'utf8');
    assert.match(serverModel, /'test-store-1'/, 'server model.ts union should now contain test-store-1');
    assert.match(webTypes, /'test-store-1'/, 'web types.ts union should now contain test-store-1');

    // The web package must still typecheck against the widened union.
    runWebTypecheck();

    // Boot the real server entry with BASTILLE_OFFLINE=1 so nothing leaves the
    // process, pointing at the temp registry. Hit /api/stores and assert the
    // test id is present alongside the three production ones.
    const port = await freePort();
    const child = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--import', 'tsx', SERVER_ENTRY],
      {
        cwd: REPO,
        env: {
          ...process.env,
          BASTILLE_OFFLINE: '1',
          BASTILLE_REGISTRY_PATH: tmpRegistry,
          BASTILLE_DB: join(dir, 'offline.db'),
          PORT: String(port),
          HOST: '127.0.0.1',
          LOG_LEVEL: 'warn',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let serverOut = '';
    child.stdout.on('data', (d) => (serverOut += d));
    child.stderr.on('data', (d) => (serverOut += d));
    t.after(() => {
      child.kill('SIGTERM');
      void new Promise((r) => child.once('exit', r));
    });

    await waitForApi(port, 20_000);
    const stores = (await (await fetch(`http://127.0.0.1:${port}/api/stores`)).json()) as {
      stores: { id: string; label: string }[];
    };
    const ids = stores.stores.map((s) => s.id);
    assert.ok(
      ids.includes('test-store-1'),
      `/api/stores should include test-store-1; got ${ids.join(',')}\nserver log:\n${serverOut}`,
    );
    assert.ok(ids.includes('foodlion'), 'production stores must remain');
    assert.ok(ids.includes('wegmans'), 'production stores must remain');
    assert.ok(ids.includes('traderjoes'), 'production stores must remain');
  },
);

test('the loader rejects an entry declaring a capability the adapter does not implement', () => {
  // WegmansAdapter has search/fetchOffer/enumerate/findLocations/zipAnchors,
  // but no warm() method. Declaring warm:true must throw the named error.
  const cfg = {
    sources: [
      {
        id: 'wegmans',
        label: 'Wegmans',
        adapter: 'WegmansAdapter',
        defaultLocationId: 'national',
        pricesVaryByLocation: false,
        enabled: true,
        capabilities: { warm: true },
        transport: { requiresProxy: false, requiresEgressNode: false },
        cost_per_read_bytes: 0,
      },
    ],
  };
  assert.throws(
    () => resolveRegistry(cfg),
    (err: unknown) => {
      assert.ok(err instanceof RegistryCapabilityError);
      assert.equal((err as RegistryCapabilityError).id, 'wegmans');
      assert.equal((err as RegistryCapabilityError).capability, 'warm');
      assert.match((err as Error).message, /registry: source "wegmans" declares capability "warm"/);
      return true;
    },
  );
});

test('the loader rejects duplicate source ids', () => {
  const cfg = {
    sources: [
      {
        id: 'foodlion',
        label: 'Food Lion A',
        adapter: 'FoodLionAdapter',
        defaultLocationId: 'national',
        pricesVaryByLocation: false,
        enabled: true,
        capabilities: {},
        transport: { requiresProxy: false, requiresEgressNode: false },
        cost_per_read_bytes: 0,
      },
      {
        id: 'foodlion',
        label: 'Food Lion B',
        adapter: 'FoodLionAdapter',
        defaultLocationId: 'national',
        pricesVaryByLocation: false,
        enabled: true,
        capabilities: {},
        transport: { requiresProxy: false, requiresEgressNode: false },
        cost_per_read_bytes: 0,
      },
    ],
  };
  assert.throws(() => resolveRegistry(cfg), /duplicate source id "foodlion"/);
});

test('disabled entries are excluded from the registry but kept in the JSON', () => {
  const cfg = {
    sources: [
      {
        id: 'foodlion',
        label: 'Food Lion',
        adapter: 'FoodLionAdapter',
        defaultLocationId: 'national',
        pricesVaryByLocation: false,
        enabled: false,
        capabilities: {},
        transport: { requiresProxy: false, requiresEgressNode: false },
        cost_per_read_bytes: 0,
      },
    ],
  };
  const resolved = resolveRegistry(cfg);
  assert.deepEqual(resolved.entries.map((e) => e.id), []);
  assert.deepEqual(Object.keys(resolved.adapters), []);
});

test('the default registry JSON loads without throwing and exposes the three production ids', () => {
  const cfg = loadRegistryConfig();
  const resolved = resolveRegistry(cfg);
  const ids = resolved.entries.map((e) => e.id).sort();
  assert.deepEqual(ids, ['foodlion', 'traderjoes', 'wegmans']);
  for (const id of ids) {
    assert.ok(resolved.adapters[id], `expected an adapter instance for ${id}`);
  }
});

test('KNOWN_ADAPTERS lists the shipped adapter classes', () => {
  assert.deepEqual([...KNOWN_ADAPTERS].sort(), [
    'FoodLionAdapter',
    'TraderJoesAdapter',
    'WegmansAdapter',
  ]);
});

test('loadRegistry reads the same file loadRegistryConfig reads and wires the adapters', () => {
  const resolved = loadRegistry();
  // The config file lives in this repo; every enabled source id should have
  // an adapter and every adapter id should be in the enabled list.
  for (const entry of resolved.entries) {
    assert.ok(resolved.adapters[entry.id]);
  }
  for (const id of Object.keys(resolved.adapters)) {
    assert.ok(resolved.entries.find((e) => e.id === id));
  }
});