/**
 * Outbound request accounting. `http.ts` reports every upstream read here; a
 * sink (installed once the database is open) persists it to `request_log`, and
 * an AsyncLocalStorage scope lets a job count the reads it caused without the
 * HTTP client knowing which job is calling.
 *
 * Only the host, the path (never the query string), the status, the latency
 * and the body size are kept. Headers, cookies and request bodies are not
 * visible to this module at all.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DB } from './db.js';
import { LOCAL_EGRESS_NODE_ID } from './db/migrations.js';

export interface RequestRecord {
  host: string;
  /** URL path only: query strings can carry a ZIP or a search term. */
  op: string;
  /** HTTP status, or 0 when no response arrived (timeout, DNS, reset). */
  status: number;
  ms: number;
  bytes: number;
  /**
   * Which egress node the read went out through — the HTTP client's
   * `identityKey`. Null for a read made through the process's own egress,
   * which is what every request looked like before federation existed and all
   * it can say is "somebody read this host".
   */
  egressNodeId?: string | null;
}

type Sink = (r: RequestRecord) => void;
let sink: Sink | null = null;

interface Tally {
  requests: number;
  bytes: number;
}
const scope = new AsyncLocalStorage<Tally>();

/** Runs `fn` and reports how many upstream reads (and bytes) it caused. */
export async function tallyRequests<T>(fn: () => Promise<T>): Promise<{ value: T; requests: number; bytes: number }> {
  const tally: Tally = { requests: 0, bytes: 0 };
  const value = await scope.run(tally, fn);
  return { value, requests: tally.requests, bytes: tally.bytes };
}

export function recordRequest(r: RequestRecord): void {
  const tally = scope.getStore();
  if (tally) {
    tally.requests++;
    tally.bytes += r.bytes;
  }
  try {
    sink?.(r);
  } catch {
    // Accounting must never turn a successful read into a failure.
  }
}

/** Rows kept, whichever bound is hit first. */
const RETENTION_DAYS = Number(process.env.BASTILLE_REQUEST_LOG_RETENTION_DAYS ?? 14);
const MAX_ROWS = Number(process.env.BASTILLE_REQUEST_LOG_MAX_ROWS ?? 200_000);
const PRUNE_EVERY = 500;

/** Persists request records to `request_log`; returns an uninstall function. */
export function installRequestLog(db: DB): () => void {
  const insert = db.prepare(
    'INSERT INTO request_log (ts, host, op, status, ms, bytes, egress_node_id) VALUES (?,?,?,?,?,?,?)',
  );
  let sinceLastPrune = 0;
  pruneRequestLog(db);
  const mine: Sink = (r) => {
    insert.run(new Date().toISOString(), r.host, r.op, r.status, Math.round(r.ms), r.bytes, r.egressNodeId ?? null);
    if (++sinceLastPrune >= PRUNE_EVERY) {
      sinceLastPrune = 0;
      pruneRequestLog(db);
    }
  };
  sink = mine;
  return () => {
    if (sink === mine) sink = null;
  };
}

export function pruneRequestLog(db: DB, now = new Date()): number {
  let removed = 0;
  if (RETENTION_DAYS > 0) {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000).toISOString();
    removed += Number(db.prepare('DELETE FROM request_log WHERE ts < ?').run(cutoff).changes);
  }
  if (MAX_ROWS > 0) {
    removed += Number(
      db
        .prepare('DELETE FROM request_log WHERE id <= (SELECT MAX(id) FROM request_log) - ?')
        .run(MAX_ROWS).changes,
    );
  }
  return removed;
}

export interface HostMetrics {
  requests: number;
  bytes: number;
  p50Ms: number | null;
  p95Ms: number | null;
  /** responses by class; `errors` counts reads that got no response at all */
  status: { '2xx': number; '3xx': number; '4xx': number; '5xx': number; errors: number };
  /** the two throttling answers, also counted inside 4xx */
  throttled: { '412': number; '429': number };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

export interface HostMetricsOptions {
  /**
   * Split each host by the egress node the read went out through. Off by
   * default: the dashboard wants "what did this host cost us", and a federated
   * run is still one host. The budget is the opposite question, which is why it
   * keys on `(host, egress_node_id)` and why `request_log` had to learn to
   * answer it.
   */
  byNode?: boolean;
}

/** Per-host aggregates over the last `hours` of the request log. */
export function hostMetrics(
  db: DB,
  hours = 24,
  now = new Date(),
  opts: HostMetricsOptions = {},
): Record<string, HostMetrics> {
  const since = new Date(now.getTime() - hours * 3_600_000).toISOString();
  const rows = db
    .prepare('SELECT host, egress_node_id, status, ms, bytes FROM request_log WHERE ts >= ? ORDER BY host')
    .all(since) as unknown as { host: string; egress_node_id: string | null; status: number; ms: number; bytes: number }[];

  const latencies = new Map<string, number[]>();
  const out: Record<string, HostMetrics> = {};
  for (const r of rows) {
    const key = opts.byNode ? `${r.host}|${r.egress_node_id ?? LOCAL_EGRESS_NODE_ID}` : r.host;
    const m = (out[key] ??= {
      requests: 0,
      bytes: 0,
      p50Ms: null,
      p95Ms: null,
      status: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, errors: 0 },
      throttled: { '412': 0, '429': 0 },
    });
    m.requests++;
    m.bytes += r.bytes;
    if (r.status === 0) m.status.errors++;
    else if (r.status >= 500) m.status['5xx']++;
    else if (r.status >= 400) m.status['4xx']++;
    else if (r.status >= 300) m.status['3xx']++;
    else m.status['2xx']++;
    if (r.status === 412) m.throttled['412']++;
    if (r.status === 429) m.throttled['429']++;
    const list = latencies.get(key) ?? [];
    list.push(r.ms);
    latencies.set(key, list);
  }
  for (const [host, list] of latencies) {
    list.sort((a, b) => a - b);
    out[host]!.p50Ms = percentile(list, 0.5);
    out[host]!.p95Ms = percentile(list, 0.95);
  }
  return out;
}
