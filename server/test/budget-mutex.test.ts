/**
 * Concurrent ledger writes must not lose an update, and concurrent reads on one
 * egress node must not share a pacing slot.
 *
 * The failure these guard is one-directional: a lost read count leaves the
 * window looking unspent, so the ceiling is under-enforced rather than over-
 * enforced. Nothing here leaves the machine — `pace()` is called directly, with
 * no HTTP.
 *
 * Environment is set before the modules load: the pacer reads its interval at
 * import time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REQUEST_INTERVAL_MS = 25;
process.env.WALMART_REQUEST_INTERVAL_MS = String(REQUEST_INTERVAL_MS);
process.env.WALMART_REQUEST_JITTER_MS = '0';
process.env.BASTILLE_MIN_REQUEST_INTERVAL_MS = '0';

const { openDb } = await import('../src/db.js');
const { HostBudget } = await import('../src/clearance/host-budget.js');
const { pace, setHostBudget, forgetNodePacer } = await import('../src/clearance/walmart-api.js');

test('100 concurrent recordRead calls on one host count exactly 100', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bastille-mutex-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const budget = new HostBudget(openDb(join(dir, 'concurrent.db')), 'h', {
    windowMs: 600_000,
    windowLimit: 0,
  });

  return Promise.all(
    Array.from({ length: 100 }, async () => {
      budget.recordRead();
    }),
  ).then(() => {
    assert.equal(budget.state().readsInWindow, 100);
  });
});

test('the ledger is never half-applied: a blocked write leaves the row untouched', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bastille-mutex-rollback-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const db = openDb(join(dir, 'rollback.db'));
  const budget = new HostBudget(db, 'h', { windowMs: 600_000, windowLimit: 0 });
  budget.recordRead();

  // A closed database makes the write itself fail; the rollback must leave the
  // transaction closed so the next caller is not wedged by a dangling BEGIN.
  db.close();
  assert.throws(() => budget.recordRead());

  const reopened = new HostBudget(openDb(join(dir, 'rollback.db')), 'h', {
    windowMs: 600_000,
    windowLimit: 0,
  });
  assert.equal(reopened.state().readsInWindow, 1);
});

test('20 concurrent pace calls on one node are spaced by REQUEST_INTERVAL_MS', async (t) => {
  t.after(() => forgetNodePacer('node-a'));

  setHostBudget(null);
  forgetNodePacer('node-a');

  // Pin the jitter — the only nondeterministic input — so every interval has
  // the same exact floor and the assertion needs no tolerance. `Date.now` stays
  // real deliberately: the reservation is wall-clock arithmetic, so a frozen
  // clock makes all 20 callers compute one wait and fire together.
  const realRandom = Math.random;
  Math.random = () => 0.5;
  t.after(() => {
    Math.random = realRandom;
  });

  const grants: number[] = [];
  const start = performance.now();
  await Promise.all(
    Array.from({ length: 20 }, async () => {
      await pace({ egressNodeId: 'node-a' });
      grants.push(performance.now() - start);
    }),
  );

  grants.sort((a, b) => a - b);
  // setTimeout is allowed to fire a millisecond early; that is a timer
  // artefact, not a gap in the slot, so the floor carries a 2ms tolerance.
  const TOLERANCE_MS = 2;
  for (let i = 1; i < grants.length; i += 1) {
    assert.ok(
      grants[i] - grants[i - 1] >= REQUEST_INTERVAL_MS - TOLERANCE_MS,
      `call ${i} went out ${Math.round(grants[i] - grants[i - 1])}ms after its predecessor, ` +
        `below the ${REQUEST_INTERVAL_MS}ms floor (grants: ${grants.map(Math.round).join(', ')})`,
    );
  }
  assert.ok(
    grants[grants.length - 1] - grants[0] >= (grants.length - 1) * (REQUEST_INTERVAL_MS - TOLERANCE_MS),
  );
});

test('separate nodes pace independently', async (t) => {
  t.after(() => {
    forgetNodePacer('node-b');
    forgetNodePacer('node-c');
  });
  setHostBudget(null);
  forgetNodePacer('node-b');
  forgetNodePacer('node-c');

  // Both start cold; without a per-node slot the second would wait out the
  // first's interval.
  const start = performance.now();
  await Promise.all([pace({ egressNodeId: 'node-b' }), pace({ egressNodeId: 'node-c' })]);
  assert.ok(performance.now() - start < REQUEST_INTERVAL_MS);
});