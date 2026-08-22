import { request, interceptors, getGlobalDispatcher } from 'undici';

/**
 * Shared HTTP client for store adapters.
 *
 * Both storefronts are ordinary public web surfaces; we read them the way a
 * browser tab does. Requests are rate limited per host and retried on
 * transient failures so a poll cycle cannot hammer a store.
 */

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const MIN_INTERVAL_MS = Number(process.env.BASTILLE_MIN_REQUEST_INTERVAL_MS ?? 700);
const lastRequestAt = new Map<string, number>();

// Both storefronts redirect (apex -> www, /shop -> /shop/categories), so
// redirects must be followed rather than surfaced as 3xx bodies.
const dispatcher = getGlobalDispatcher().compose(interceptors.redirect({ maxRedirections: 5 }));

async function throttle(host: string): Promise<void> {
  const previous = lastRequestAt.get(host) ?? 0;
  const wait = previous + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt.set(host, Date.now());
}

/** Statuses that mean "slow down", not "no". */
const RETRYABLE = new Set([429, 412]);

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string, body: string) {
    super(`${status} ${url} :: ${body.slice(0, 200)}`);
    this.name = 'HttpError';
  }
}

export interface FetchOptions {
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: unknown;
  retries?: number;
  timeoutMs?: number;
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const host = new URL(url).host;
  const retries = opts.retries ?? 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle(host);
    try {
      const res = await request(url, {
        dispatcher,
        method: opts.method ?? 'GET',
        headers: {
          'user-agent': UA,
          accept: 'application/json, text/html;q=0.9, */*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...opts.headers,
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        headersTimeout: opts.timeoutMs ?? 20_000,
        bodyTimeout: opts.timeoutMs ?? 20_000,
      });
      const text = await res.body.text();
      if (res.statusCode >= 400) {
        // 4xx other than the two throttling codes will not improve on retry.
        // 412 is Walmart's edge answering a burst; like 429 it clears on its
        // own, so it is backed off rather than surfaced as a hard failure.
        if (!RETRYABLE.has(res.statusCode) && res.statusCode < 500) {
          throw new HttpError(res.statusCode, url, text);
        }
        lastError = new HttpError(res.statusCode, url, text);
      } else {
        return text;
      }
    } catch (err) {
      lastError = err;
      if (err instanceof HttpError && err.status < 500 && !RETRYABLE.has(err.status)) throw err;
    }
    // A throttled edge needs longer than a flaky one: 500ms is enough to ride
    // out a transient 5xx, nowhere near enough to clear a rate limit.
    const base = lastError instanceof HttpError && RETRYABLE.has(lastError.status) ? 5_000 : 500;
    await new Promise((r) => setTimeout(r, base * 2 ** attempt));
  }
  throw lastError instanceof Error ? lastError : new Error(`request failed: ${url}`);
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const text = await fetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`expected JSON from ${url}, got ${text.slice(0, 120)}`);
  }
}
