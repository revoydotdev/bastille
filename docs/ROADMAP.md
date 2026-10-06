# Remediation & roadmap

Audit date 2026-10-06, against `fix/catalogue-coverage` at `eb910d6`.

Two halves:

1. **Audit:** what was measured, what is broken or slow, and what nobody can
   currently see. Each finding has a stable ID (`P-` performance, `C-`
   correctness, `U-` usability, `O-` observability) so it can be closed by
   commit.
2. **Read-limited sources:** how to get more out of Walmart (and anything
   like it) without changing the conduct rules in
   `WALMART-CLEARANCE-API.md`. That means no challenge solving, no identity
   rotation, and no originating from somewhere we are not.

A phased plan comes last.

## Status, 2026-10-06 (after first remediation pass)

**Done:**
- correctness: C-1, C-2, C-3, C-4, C-5
- performance: P-1, P-2, P-3, P-4, P-7, P-8
- observability: O-1, O-2, O-3, O-4
- usability: U-1 to U-7, U-9; U-8 for Deals only
- Walmart: W-0, W-1, W-8
- other sources: F-3

**Live Walmart results.** 11 reads, no refusals; log in
`docs/walmart-experiments/2026-10-06.jsonl`.

| hypothesis | result |
|---|---|
| Store choice | Walmart answered for Gordonsville #4682, not the nearer Ruckersville #4638. The egress IP decides, as documented. |
| W-3: `ps` above 40 | **Refuted.** `ps=100` comes back as 20 per page, so page size stays 40. |
| W-4: Computers ⊂ Electronics | **Refuted.** 7 of 46 Computers ids were not on the Electronics rack, so the Computers read stays. |
| W-5: newest-first sort | **Confirmed.** `sort=new` is valid and is now the sweep default. It pages without the re-ranking overlap `best_match` has (53 of 136 ids repeated). Delta mode is opt-in (`WALMART_SWEEP_DELTA=1`). It orders by listing age, not markdown date, hence the weekly full pass. |
| `aggregatedCount` as change detector | **Refuted.** It is an estimate that ranged 173–220 on one shelf. |
| W-10: CDN caching | **No.** Every response carried `cache-control: no-store`. |

**Still open:**
- the W-2 window measurement (the 30 min / 18 read window is a guess)
- W-6, W-7, W-9, W-10
- U-8 for Clearance, which needs a sweep-dates endpoint
- P-5, P-6, P-9, F-1, F-2

---

## 0. Method, and what was not checked

| | how |
|---|---|
| tests | `BASTILLE_SKIP_LIVE=1 npm test`: 92 tests, 86 pass, 0 fail, 6 skipped (live), 1.3 s |
| build | `npm run build`: 6.6 s wall |
| bundle | Vite output sizes, raw and gzip |
| API latency | server on a scratch SQLite DB, `curl -w %{time_total}` × 50 per endpoint, sandbox with no network |
| everything else | read from source, with file and line |

**Not measured:**

- No live request counts and no Lighthouse run. The server cannot boot
  without reaching Food Lion, because `index.ts:50` calls `warm()` on every
  adapter unconditionally. That is finding `O-4`.
- No live probing of Walmart. Every Walmart idea in §2 is written as a
  hypothesis plus the experiment that would settle it.
- The read-budget figures below are estimates, built from defaults and
  documented shelf sizes.

## 1. Baseline

### Measured

| metric | value |
|---|---|
| initial JS + CSS | 223 kB raw / 69.7 kB gzip (React 19 runtime is nearly all of it); tabs are lazy chunks of 1.8–9.6 kB |
| `/api/status`, `/api/alerts`, `/api/clearance`, `/api/watchlist` (empty DB) | 0.8–1.0 ms avg, under 8 ms max |
| `/api/watchlist`, 300 groups × 5 price points | **15.7 ms avg / 24.7 ms max**. Linear in group count, from the N+1 in `P-1` |
| N+1 alone, no HTTP | 18.9 ms for 300 groups |

### Estimated outbound budget per day (defaults)

| source | reads/day | basis |
|---|---|---|
| Poller | 48 × watchlist size, **up to ×20** for Food Lion items (`P-2`, `C-1`) | 30 min interval |
| Food Lion catalogue walk | ~250 per build. Builds once for the snapshot, plus up to 4× more from search traffic (6 h TTL) | `foodlion.ts:224`, `:339` |
| Wegmans snapshot | ~239 partition reads plus the facet-count recursion | `BACKEND-MAP.md` |
| Walmart sweep | **~8–10** in practice (Electronics 190 items = 5 pages, Computers 43 = 2, Video games 1–3). The cap is 3 × 8 = **24**, above the observed ~20 ceiling. **Each refusal costs 3 reads** (`W-0`) | `clearance-sweep.ts`, `categories.ts` |

Walmart is the only source whose limit binds. Every other source is limited
by our own politeness floor.

---

## 1a. Register

### Correctness

| ID | sev | finding | evidence | fix |
|---|---|---|---|---|
| C-1 | **high** | A watched Food Lion item that lives only in a sub-aisle can never be refreshed. `fetchOffer` falls back to the 20 **top-level** aisles only, but search and the snapshot now read sub-aisles too (`cac9d65`). Every poll spends up to 20 reads (~14 s at the 700 ms floor), logs "not found", and records nothing. This is the gap the branch name refers to. | `adapters/foodlion.ts:371-390`, `jobs/poller.ts:79-82` | Resolve from the catalogue index first (which includes sub-aisles). Store the aisle slug or product URL on the product row at watch time and read that page directly. Fall back to a walk only on a miss, and never more than once per poll run. |
| C-2 | high | Walmart refusals are retried inside the HTTP client: 412 is in `RETRYABLE`, `persistedQuery` takes the default `retries: 2`, and backoff is 5 s then 10 s. Against a count-based limit, this triples the cost of every refusal and likely prolongs the block. | `adapters/http.ts:31,78`, `clearance/walmart-api.ts:133` | Pass `retries: 0` for Walmart and let the sweep's cooldown handle it. Generalised as `W-0`. |
| C-3 | med | The Walmart pacer is in-memory (`nextRequestAt`). After a restart, a manual `POST /api/clearance/sweep` goes out immediately, even if the edge refused us two minutes earlier. | `clearance/walmart-api.ts:58` | Persist the "not before" time in SQLite (part of `W-1`). |
| C-4 | med | Per-host throttle is check-then-act across an `await`, so two concurrent same-host calls can both pass. This is latent today, because nothing issues concurrent same-host calls yet. | `adapters/http.ts:21-26` | Use a per-host promise-chain queue. |
| C-5 | low | Sweep page cap (3 shelves × 8 pages = 24) sits above the observed ~20-read ceiling. A night with large racks will run out of budget partway through, and the third shelf is the one that loses. | `jobs/clearance-sweep.ts:69` | Add a per-run read budget (`W-2`) instead of a page cap. |

### Performance

| ID | sev | finding | evidence | fix |
|---|---|---|---|---|
| P-1 | **high** | Every `/api/search` rebuilds the full watchlist (N+1: product + price history per item) to mark which results are already watched. `/api/watchlist` and its mutations pay the same cost. | `routes.ts:153-159`, `repo.ts:350-383` | Use one `SELECT store_id, store_product_id, group_id FROM watch_item JOIN product` for membership, and one joined query with a window function for `groupView`. |
| P-2 | high | Same root cause as `C-1`, seen as latency: one Food Lion watch-add or refresh can serialise 20 reads. The aisle cache TTL (30 min) matches the poll interval, so the cache is often cold exactly when the poller runs. | `foodlion.ts:383` | Same fix as C-1. Also set aisle TTL above the poll interval. |
| P-3 | med | `TtlCache.wrap` does not deduplicate in-flight requests, so concurrent identical searches each go upstream. `FoodLionAdapter.load` already solves this locally. | `cache.ts:37-43`, `foodlion.ts:258` | Add an `inflight` map to `TtlCache`. |
| P-4 | med | The ~250-read Food Lion catalogue walk can fire up to 4×/day from search traffic, on top of the snapshot's build. Nothing records how many times it ran. | `foodlion.ts:339-349` | Have the snapshot's build refresh the TTL timestamp. Use conditional GET (`F-1`) so rebuilds of unchanged pages are cheap. |
| P-5 | med | The Wegmans facet partition plan (~239 leaves) is recomputed nightly, though the category tree barely moves. | `wegmans.ts:401-417` | Persist the plan and recompute weekly, or when a partition reports more than 1,000 hits. |
| P-6 | med | `daily_snapshot` stores every row every day: ~65 k rows and ~29 MB/day, 2.6 GB at steady state. Most rows repeat the previous day. | `BACKEND-MAP.md` § Retention | Store changes only (valid-from/valid-to rows). `/api/deals` reads "rows valid on date D". Expect an order-of-magnitude cut; measure the daily churn first. |
| P-7 | low | `poller.ts:63-72` resolves `getProductById` 3× per item. | | Look it up once. |
| P-8 | low | No index on `clearance_find` leads with `location_id`, which `previousSweepDate` and `seenBefore` filter on. Small table today. | `db.ts:186-190`, `clearance/repo.ts:301,370` | Add `(location_id, sweep_date DESC)`. |
| P-9 | low | Retention pruning runs only after a successful snapshot, so a long multi-adapter outage pauses it silently. | `jobs/snapshot.ts:107` | Keep the rule, but surface "days since prune" (`O-1`). |

### Usability

| ID | sev | finding | evidence | fix |
|---|---|---|---|---|
| U-1 | **critical** | **Clearance watch-term alerts have no UI.** The server has `GET /api/clearance/alerts` plus the ack endpoints. The client has no wrapper, and there is no SSE event for them. The README's headline feature ("does not depend on you opening the app") cannot be observed at all. | `clearance/routes.ts:198-214`, `web/src/lib/api.ts` | Merge into the Alerts tab with a source badge. Emit on the existing SSE stream (`ClearanceSweepJob.onAlerts` already exists). |
| U-2 | high | Trader Joe's cannot be searched or used in Deals. The toggles hard-code `['foodlion','wegmans']`, and the masthead and README ("across both") omit it. | `SearchPanel.tsx:15,91`, `Deals.tsx:69,169`, `App.tsx:145` | Drive the toggles from `/api/stores`. |
| U-3 | high | Recipe-ingredient parsing (323 lines, tested) is not imported anywhere. There is no route and no UI. | `server/src/recipes/ingredient.ts` | Add `POST /api/recipes/parse` and a "paste a recipe" mode in Search that fans each line out as a query. Otherwise, say in the README that it is a library only. |
| U-4 | med | Before the first fetch resolves, loading looks the same as empty: Watchlist, Alerts and Clearance show "nothing yet" copy. | `App.tsx:21-45`, `Clearance.tsx:75-90,254` | Add a `loading` state, and show empty copy only after a fetch. |
| U-5 | med | Clearance view switch uses `role="tab"` with `aria-pressed`. Neither tab bar has `aria-controls`/`tabpanel` or arrow-key roving. | `Clearance.tsx:307-317`, `App.tsx:158-179` | Implement the WAI-ARIA tabs pattern. |
| U-6 | med | Alerts that arrive over SSE update a badge with no `aria-live` announcement. | `App.tsx:91-106,176` | Add a visually-hidden polite live region. |
| U-7 | low-med | A failed sweep shows "last run reported problems" and discards the recorded reason (rate-limited? store mismatch?). | `Clearance.tsx:226` | Show the reason, classified: *rate-limited*, *wrong store*, *hash expired*. |
| U-8 | low | Snapshot and sweep history exist server-side (`dates[]`, `?date=`) but cannot be browsed. | `routes.ts:331,385-390` | Add a date picker on Deals and Clearance. |
| U-9 | low | Mobile watchlist `<th>` cells have no `scope`. DESIGN.md's alert-row spec ("severity dot") differs from the implementation (left border). | `styles.css:272-290`, `DESIGN.md:101` | Add `scope="col"`, and update DESIGN.md to match the implementation. |

### Observability

| ID | sev | finding | fix |
|---|---|---|---|
| O-1 | high | No metrics at all. There are no request counts per host, cache hit rates, rate-limit hits (outside the sweep), job request counts, or SSE client count. `*_run` tables hold only the last outcome per job. | Add a `request_log` table (host, op, status, ms, bytes, ts) written by `http.ts`. Expose `GET /api/metrics` (JSON, plus Prometheus text if wanted) with per-host counts, p50/p95, 4xx/5xx/412, cache hit ratio, and job durations. This table also underlies `W-1`. |
| O-2 | med | `snapshot_run` records rows written, not requests spent. | Add `requests` and `bytes` columns to every `*_run` table. |
| O-3 | med | A persisted-query hash change on Walmart's side shows up as a generic GraphQL error. | Classify `PersistedQueryNotFound` and alert on it (`W-8`). |
| O-4 | med | The server cannot start offline because `warm()` always reaches Food Lion. That blocks Lighthouse, local profiling and any CI smoke test. | Add `BASTILLE_OFFLINE=1`, which skips `warm()`, schedulers and adapters. With it, wire a Lighthouse budget (perf ≥ 90, a11y ≥ 95) into CI. |

---

## 2. Read-limited sources: Walmart and anything like it

### What the constraint actually is

From `WALMART-CLEARANCE-API.md`:

- About 20 reads earns a 412 block that lasts tens of minutes.
- Spacing reads 8 s or 20–32 s apart made no difference.
- The answering store is chosen by the egress IP.
- Each read returns up to 40 items.

The scarce resource is **reads**, not time or bandwidth. Every idea below
reduces reads spent, increases information per read, or gets the data
without making a read at all. None of them changes who we say we are.

Ordered by value ÷ risk:

#### W-0 · Stop paying for refusals *(bug fix, prerequisite)*

This is `C-2`. Walmart calls go out with `retries: 0`, and a 412 goes
straight to the sweep's cooldown. The client also stops treating 412 as
generically retryable for every host: a host can declare "a block is final
for this run".

#### W-1 · A persistent read ledger and budget

Each budgeted host gets a durable budget:

- A row in `request_log` (`O-1`) per read, with the status and, on a block,
  the PerimeterX payload's block id.
- A `host_budget` row holding `not_before`, `reads_in_window`, and the
  current estimate of `window_size` and `window_len`.

Every Walmart read asks the ledger first, so a restart, a manual sweep and
the nightly job all share one budget (fixes `C-3`). This is the
infrastructure everything below depends on.

#### W-2 · Measure the window, then plan against it

The docs establish *count, not cadence*, but only for spacing up to 32 s.
Two things are unknown, and the ledger makes both cheap to learn:

| unknown | experiment | cost |
|---|---|---|
| Is it a fixed or sliding window, and how long? | On a fresh budget, one read every 5, then 10, then 15 min across a day. If 30+ reads pass at 10-min spacing, the window is under ~3 h and a trickle schedule beats a nightly burst. | ~30–40 reads, once |
| How long does a block last? | After a 412, single probes at +10, +20, +40, +80 min, stopping at the first 200. | ≤4 reads per block, run a handful of times |

The output is a per-run read budget for the sweep, replacing the page cap
(`C-5`). Shelves are spent in priority order: Computers (the narrow,
high-value shelf), then Video games, then Electronics. When the budget runs
short, the low-value shelf is the one cut.

#### W-3 · More items per read

**Hypothesis:** `Browse` honours `ps`/`limit` above 40. The storefront uses
40, but many search backends accept 60–100. If it accepts 100,
Electronics drops from 5 reads to 2 and a full night falls from ~9 reads to
~4.

**Test:** one read at `ps=100` against a shelf whose total is known. Check
`pageItemCount` and that `aggregatedCount` is unchanged. The cost is one
read; if it fails, keep 40.

#### W-4 · Classify once, not nightly

Computers is a strict subset of Electronics. Its shelf is read every night
only to learn which Electronics items are PC parts. That label belongs to
the *item*, not the night.

- Persist `item_id → group` the first time an item is seen on a narrow
  shelf.
- On later nights, read Electronics plus Video games, and read Computers
  only when Electronics returned an item id with no stored group.

On a quiet night this saves ~2 reads (~20–25% of the sweep). It loses
nothing, because classification was already "by shelf membership" and that
does not change for a given item.

#### W-5 · Delta reads: newest first, stop at the familiar

**Hypothesis:** `sort` accepts a newest-first value (the storefront offers
"New" as a sort option) and it holds under the clearance facet.

- If it does, a nightly sweep reads page 1 and stops at the first page with
  no unseen ids. Typical cost is 1 read per shelf instead of the full
  shelf.
- Delta reads cannot see items that *left* the rack, so run a full sweep
  weekly, or when `aggregatedCount` moved by more than the number of new
  ids.
- `aggregatedCount` arrives on page 1 for free and is a strong change
  detector: if count and page-1 ids both match yesterday, the shelf is very
  likely unchanged.

**Test:** two reads, `best_match` against the new-first sort, comparing
ordering and totals.

W-3, W-4 and W-5 together could cut a nightly sweep from ~9 reads to 3–4.
That leaves headroom for **on-demand checks** ("is that RTX card still
there?"), which today would compete with the nightly job.

#### W-6 · Priority classes in the budget

Once reads are counted, spend them deliberately. Reserve, per window:

- nightly sweep
- user-initiated checks
- one canary read (hash validity, store identity)
- experiments (W-2, W-3, W-5)

A user click never starts a refusal that ruins the night's run.

#### W-7 · Zero-read ingestion: capture what the user already loaded

This is the largest lever, and it costs Walmart nothing. When the user
browses walmart.com in their own browser, the page they load already
carries the full shelf in `__NEXT_DATA__`, or in the `orchestra` responses
it made itself. A small **userscript or browser extension** (or HAR upload,
which the local `astrolabe import_har` tooling already handles) forwards
those payloads to a local `POST /api/clearance/ingest`:

- **No extra requests.** The user's normal browsing is the read.
- **Solves the per-store problem legitimately.** The user's browser is
  where the user is. A shelf viewed in another town while travelling is
  that town's real rack, recorded with the store Walmart echoed. The
  existing "store name must match" check still applies.
- **Provenance.** Rows carry `source = passive | sweep`, so analysis can
  separate "observed while browsing" from "systematic nightly read".
- **Work needed.** A second parser for the `__NEXT_DATA__` shape. The doc
  already notes it differs from the orchestra shape: money is display
  strings rather than numbers. Plus fixture tests built from saved pages.

The extension only reads pages the user chose to open. It does not fetch,
prefetch or crawl on their behalf. That keeps it an observation tool, not a
proxy for the sweep.

#### W-8 · Self-diagnosing hash rot

Persisted-query hashes change whenever Walmart edits the query.

- **Today:** a hash change surfaces as a generic error and probably burns
  the night.
- **Proposed:** the canary read (W-6) classifies `PersistedQueryNotFound`
  or validation errors, stops the sweep before it spends budget, and raises
  a distinct alert: "Walmart query hash expired; update
  `WALMART_BROWSE_HASH`".
- **Optional:** if W-7 is built, a passive capture carries the current hash
  in the request URL the page itself made. The ingest endpoint can then
  *propose* the new hash automatically, for the operator to confirm.

#### W-9 · Federation instead of relocation

Per-store comparison is out of reach because one connection sees one store,
and originating elsewhere is ruled out.

The honest alternative: **several bastille instances, each in its own town,
each sweeping its own local store within its own budget**, publishing their
nightly rack to a small shared feed (signed JSON over HTTPS or a git repo).

- Each instance stays a single local reader making the same few reads.
- Coverage scales with participants, not with request volume.
- Requires: a feed schema (store id, date, items, instance key), a merge
  view in the Clearance tab, and trust rules (sign per instance; never
  overwrite local observations with remote ones).

#### W-10 · Official and third-party channels

| channel | status |
|---|---|
| Walmart.io affiliate API | Item lookup with national price for approved affiliates. Does not give store-level clearance or aisle, but could enrich item metadata. Worth applying for; not on the critical path. |
| Third-party clearance trackers (BrickSeek-style) | Rejected. They resell data gathered against the same controls, with terms that forbid this use. |
| CDN behaviour | Unknown. Record `cache-control`, `age` and `x-cache` on orchestra responses in the ledger. If identical persisted GETs are edge-cached, an unchanged shelf may cost less than assumed. Observe only; do not design around it until the ledger shows it. |

### Applying the same pattern to the other sources

These are not budget-bound today, but the cheapest read is still the one
not made.

- **F-1 · Conditional GET for Food Lion.** The `/groceries/` SEO pages are
  static Astro output. Record `ETag`/`Last-Modified` per aisle page and send
  `If-None-Match`; a 304 means no parse and no write. The sitemap's
  `<lastmod>` can skip unchanged aisles outright. Verify the headers first
  with one request.
- **F-2 · One budget abstraction.** Move the per-host throttle, the
  Walmart pacer and the ledger into one `BudgetedHost` (floor, jitter,
  window budget, block-is-final flag, in-flight dedupe). Food Lion, Wegmans,
  Trader Joe's, Brandify and Walmart become configuration, not separate
  code paths.
- **F-3 · Food Lion product pages for watched items.** Store the product
  URL at watch time (`C-1`). A refresh then costs exactly one read.

---

## 3. Phased plan

Each phase has exit criteria that can be checked. IDs refer to the
register above.

### Phase 0: see it (≈1–2 days)

`O-1`, `O-2`, `O-4`, `W-0`/`C-2`, `W-1`, `C-3`

**Exit:**

- `/api/metrics` reports per-host reads and statuses for 7 days.
- The server boots with `BASTILLE_OFFLINE=1`.
- A Walmart refusal costs exactly one read.

### Phase 1: fix what is wrong (≈2–3 days)

`C-1`/`P-2`/`F-3`, `U-1`, `U-2`, `P-1`, `P-3`, `C-4`

**Exit:**

- A sub-aisle Food Lion item refreshes in one read.
- A clearance watch term fires and is visible in the Alerts tab within one
  SSE tick.
- Trader Joe's is searchable.
- `/api/watchlist` at 300 groups is under 3 ms.

### Phase 2: spend Walmart reads deliberately (≈3–4 days, much of it waiting on experiments)

`W-2` experiments, `W-3`, `W-5` tests, `W-4`, `W-6`, `W-8`, `C-5`

**Exit:**

- Ledger shows median nightly sweep at 4 reads or fewer.
- Zero 412s across 14 nights.
- On-demand check available in the UI with its reserved budget shown.

### Phase 3: usability debt (≈2 days, can run alongside Phase 2)

`U-3` through `U-9`

**Exit:**

- Lighthouse a11y ≥ 95 in CI via `O-4`.
- No empty-state flash.
- Sweep failures show their classified reason.

### Phase 4: storage and crawl efficiency (≈2–3 days)

`P-6` (measure churn first), `P-4`/`F-1`, `P-5`, `P-8`, `P-9`

**Exit:**

- Snapshot disk growth per day cut by at least 5×, with `/api/deals`
  results identical on a replayed day.
- Food Lion rebuild reads mostly 304s.

### Phase 5: beyond one store (open-ended)

`W-7` passive ingestion first, because it is useful to a single user on day
one. Then `W-9` federation if anyone else runs bastille. `W-10` affiliate
application in the background.

---

## 4. Explicitly not on the roadmap

These match the existing judgement in `WALMART-CLEARANCE-API.md` and
`FOODLION-MOBILE-API.md`:

- solving PerimeterX, DataDome or Cloudflare challenges in the runtime
- rotating IPs, user agents or fingerprints to stay under a limit
- sweeping a store we are not near
- a real-device cookie farm for the Food Lion mobile API
