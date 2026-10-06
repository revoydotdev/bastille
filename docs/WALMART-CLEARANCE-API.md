# Walmart in-store clearance — backend map

How bastille reads what a *particular* Walmart has on its clearance racks, with
prices and aisle numbers. Everything below was observed against the live site on
2026-08-21 from an anonymous session; nothing requires an account, and every
call is a read.

Mapped with the sibling [`webmap`](../../webmap) tool, then narrowed by hand.
Reproduce the capture with:

```
webmap scan https://www.walmart.com/cp/grocery/976759 --local \
    --operator-seed https://www.walmart.com/store/directory \
    --allowed-static-host www.walmart.com --allowed-static-host i5.walmartimages.com
webmap map  www.walmart.com --local --no-auth --no-burp \
    --recipe recon/surfaces/www.walmart.com.recipe.json
```

Raw artifacts: `recon/scan-walmart/`, `recon/webmap-walmart/`.

The committed capture in `recon/webmap-walmart/` was taken over the grocery
savings shelves; the surfaces it actually visited are listed in its own
`meta.json`. The recipe in `recon/surfaces/` has since been pointed at the
electronics clearance shelf this app reads, and at URLs verified to resolve —
Walmart's sitemap lists category chains that 404 or return an empty shelf.

---

## Verdict (read this first)

- **The HTML is closed. The XHR tier is open.** Every Walmart page —
  `/browse/…`, `/shop/savings/…`, `/ip/…` — is server-rendered behind
  PerimeterX. A plain HTTP client gets the "Robot or human?" interstitial, and
  so does a client impersonating Chrome's TLS fingerprint (`curl_cffi`). Those
  pages fire **zero** product API calls on load, so there is no XHR to watch
  instead; the whole catalogue is baked into `__NEXT_DATA__`.
- The persisted-query GraphQL tier those pages *would* call, at
  `www.walmart.com/orchestra/*`, answers an ordinary anonymous request with the
  right headers. That is what bastille uses. No cookies to mint, no challenge
  to solve, no browser in the loop.
- `robots.txt` disallows `/api/`, `/search`, `/typeahead/` and
  `/store/electrode/api/*`. It does **not** disallow `/orchestra/*`. bastille
  uses only `/orchestra/*`, and does not touch the search surface.
- **The edge rate-limits hard, and on count rather than cadence.** Roughly
  twenty reads earns a `412` carrying a PerimeterX block payload, which persists
  for tens of minutes. Spacing them further apart does not help past a point:
  the same threshold was hit at 8s spacing and at 20-32s. A full 24-store pass
  was attempted at the wider spacing — three stores completed, then four
  consecutive refusals ended the run. This is the binding constraint on the
  design, and the reason a run sweeps a rotating slice of stores rather than all
  of them.

## Operations used

Both are GET, both are persisted queries — the operation is identified by name
and a sha256 hash of the document, which the storefront's own JS bundle ships.
The hashes are pinned in `walmart-api.ts` and overridable by environment
variable, because they change whenever Walmart edits the query.

| operation | path |
|---|---|
| `storeFinderNearbyNodesQuery` | `/orchestra/home/graphql/storeFinderNearbyNodesQuery/{hash}` |
| `Browse` | `/orchestra/snb/graphql/Browse/{hash}` |

### Headers

Without these the tier answers `412`:

```
wm_mp: true
x-o-bu: WALMART-US      x-o-ccm: server        x-o-mart: B2C
x-o-platform: rweb      x-o-platform-version: main-1.0.0
x-o-segment: oaoh       x-apollo-operation-name: <operation>
wm_qos.correlation_id: <uuid>
sec-fetch-site: same-origin   referer: <a real page on the site>
```

### The tier describes itself

A missing variable comes back as a precise validation error, not a generic
400 — which is how the full variable set below was recovered rather than
guessed:

```json
{"errors":[{"message":"missing variable `$fetchDac`: for required GraphQL type `Boolean!`",
            "extensions":{"name":"fetchDac","code":"VALIDATION_INVALID_TYPE_VARIABLE"}}]}
```

A GraphQL error arrives as **HTTP 200 with `data: null`**. Unchecked, that reads
downstream as "this store has nothing on clearance", so `persistedQuery()`
raises on any `errors[]` rather than returning an empty shelf.

## 1. ZIP → stores

```
GET /orchestra/home/graphql/storeFinderNearbyNodesQuery/{hash}
    ?variables={"input":{"postalCode":"22963","nodeTypes":["STORE"],
                         "accessTypes":["PICKUP_INSTORE"],"radius":50}}
```

Returns every store in the radius, nearest first, with Walmart's own distance
calculation — so no third-party geocoder is needed. For ZIP 22963 that is 24
stores, the nearest being Gordonsville Supercenter (#4682, 7.73 mi).

```
nearByNodes.nodes[]
  id                "4682"                  <- the key everything else is scoped by
  displayName       "Gordonsville Supercenter"
  address           { addressLineOne, city, state, postalCode }
  nodeDistance      { value: 7.73, unitOfMeasure: "MI" }
  geoPoint          { latitude, longitude }
  operationalHours[], services[]
```

## 2. Store scoping — does not work anonymously

**Superseded finding, 2026-08-22.** The cookie below is accepted and the
response echoes the store back, which is what made it look like it worked. It
does not. Asking for store 2612 (El Paso, Texas) from a Virginia address
returned a rack echoing *Gordonsville Supercenter*, 92% identical to the local
store's. Across three Virginia stores swept separately, 101 of 111 items were
common to all three with **zero** variation in price and **zero** in aisle —
because all three responses were the same store.

**It is geolocation on the requesting IP.** The same request, with a cookie
explicitly naming store 4682 and ZIP 22963, answers differently depending only
on where it comes from:

| egress | store answered for |
|---|---|
| residential, Virginia | Gordonsville Supercenter |
| Surfshark exit, Amsterdam | Sacramento Supercenter |

The cookie is a **gate, not a selector**: without it the tier returns `412`, and
with it the contents are ignored — `nodeId` for a Texas store, a Texas ZIP, or
no `nodeId` at all all return the store local to the caller.

So this tier yields exactly one store's rack: whichever is local to the egress
address. Per-store comparison is not reachable from a single connection, and
the only way to read a specific store would be to originate near it — which is
an infrastructure problem, not a protocol one, and is deliberately not
attempted here.

The sweep now refuses to record a shelf whose echoed store name does not match
the store that was asked for, so this fails loudly instead of quietly
mislabelling one shop's clearance as another's.

The mechanism as originally documented:

```
Cookie: locGuestData={"intent":"PICKUP","storeIntent":"PICKUP","mergeFlag":true,
                      "isExplicitIntent":true,
                      "pickup":{"nodeId":"4682","timestamp":…},
                      "postalCode":{"base":"22963","timestamp":…}}
```

The response echoes the store it actually answered for, at
`searchResult.pageMetadata.storeSelectionHeader.storeDislayName` (Walmart's
typo, not ours). The sweep **refuses to record a shelf that comes back without
it** — recording an unscoped shelf under a store id would attribute one store's
clearance to another, which is the most expensive way to be wrong here.

## 3. Store → clearance shelf

```
GET /orchestra/snb/graphql/Browse/{hash}?variables={…}
```

The shelf identity is `catId` plus `facet`, and both must be repeated in the
nested `searchArgs`, `searchParams` and `fitmentSearchParams` copies the
storefront sends — leaving any of them on a different category returns the
wrong shelf.

```
catId  "3944"                                              # Electronics
facet  "special_offers:Clearance||fulfillment_method:In-store"
page   1     ps 40     limit 40     sort "best_match"
```

Both halves of the facet matter. `special_offers:Clearance` alone returns online
marketplace markdowns, which are identical at every store and are not what a
store run is for. Adding `fulfillment_method:In-store` is what produces a real
rack, with aisle numbers.

### Category ids

`catId` genuinely filters, and the ids are hierarchical
(`3944` Electronics ⊃ `3944_1089430` Computers). Measured at store 4682:

| catId | shelf | items on clearance |
|---|---|---|
| `3944` | Electronics | 190 |
| `3944_1089430` | Computers | 43 |
| `4044` | Home | 2,464 |

**Walmart's own browse sitemap is not a usable source for these.**
`sitemap_browse_fst.xml` still lists chains like `3944_3951_1073804` that the
Browse operation now rejects with `INVALID_CAT_ID`. Every id bastille ships was
exercised against the live endpoint.

bastille sweeps both `3944` and `3944_1089430` — one extra read per store — and
takes shelf membership as the classification. That is not redundancy: Walmart
reports a **different `categoryPathId` for the same item depending on which
shelf you asked**. A 32-inch monitor comes back as `0:3944:1089430:132959:4483`
from the Computers shelf and as `0:6163033:2795380:4874644` from the Electronics
one, so the path cannot be trusted to say what a thing *is*. Which shelf Walmart
files it on can be. An item on both is recorded as a PC part regardless of the
order the shelves were swept in.

### Two stacks, and only one of them is a rack

A shelf comes back as `itemStacks[]`, and they do not mean the same thing:

| stack | `meta.beacon` interpretation | title | aisles |
|---|---|---|---|
| 0 | `primary` / `primary` | Results for "electronics" | yes |
| 1 | `secondary_stack` / `inStoreShipFul` | **Available for shipping** | none |

The second stack is what Walmart will post to you, not what is on the rack. Its
items carry no `productLocation`, and being national, they come back identical at
every store — so merging them buries the local finds this exists for under noise
that is the same everywhere. bastille records the primary stack only, decided on
the beacon's `interpretations[].type` rather than the display title. A stack
whose beacon cannot be parsed is treated as *not* primary: inventing shelf
presence is the failure worth avoiding.

The pager still counts every item the page served, or a page that is mostly
shipping-only would look like the end of the shelf.

### What an item carries

Items arrive under `itemStacks[].itemsV2` (the older `items` is also read).
Money is a **dollar number**, not a display string — the `__NEXT_DATA__` shape
baked into the HTML differs from this one, which is worth knowing if you ever
compare the two.

```
usItemId                      "13665765059"
name, brand, departmentName
category.categoryPathId       "0:3944:1089430:132959:4483"
canonicalUrl                  "/ip/…"
priceInfo.currentPrice.price  149        <- the marked-down price, in dollars
priceInfo.listPrice.price     199        <- the pre-markdown price
priceInfo.wasPrice.price                 <- used instead on a rollback
priceInfo.savingsAmount       { amount: 50, priceString: "SAVE $50.00" }
productLocation[0].displayValue "K14"    <- the aisle
                 .aisle        { zone: "K", aisle: 14 }
availabilityStatusV2.value    "IN_STOCK"
fulfillmentType               "STORE"
searchResult.aggregatedCount  190        <- total across pages
```

`listPrice` is absent on most clearance tags — a sticker that just says $15.88
with no "was" is the common case. bastille records the price and leaves the
discount null rather than inventing a baseline.

## Conduct

Read-only throughout. One request at a time, with a floor of
`WALMART_REQUEST_INTERVAL_MS` (default 20s) plus up to `WALMART_REQUEST_JITTER_MS`
(default 12s) of spread — two orders of magnitude slower than the grocery
adapters, because this edge asks for it. The jitter is there to spread load off
a fixed cadence, not to disguise anything: the client's identity, headers and
fingerprint are the same on every request, and it says who it is.

On a refusal the sweep stands down for `WALMART_RATE_LIMIT_COOLDOWN_MS`
(default 5 minutes) and abandons the run after
`WALMART_MAX_CONSECUTIVE_RATE_LIMITS` (default 4) in a row — a job that cannot
get an answer should stop asking.

No retries on a refusal (a 412/429 goes to the cooldown and the persisted
ledger, see the 2026-10-06 section), a browser `User-Agent`, no accounts, no
cart, no checkout, no challenge solving. The sweep runs once a night, on a
per-run read budget.

## What was tried and rejected

- **Reading the HTML directly.** PerimeterX blocks it, with or without a
  matching TLS fingerprint. Getting past that is an explicit anti-automation
  control, and the same judgement was made for Food Lion's SPA in
  `BACKEND-MAP.md`.
- **Driving a stealth browser (byparr/cloakbrowser) in the poller.** It does
  fetch the pages — that is how the `__NEXT_DATA__` shape above was first read —
  but it keeps one browser profile, so the store cookie is sticky and two stores
  come back with identical racks. It is also a challenge-solving dependency this
  app does not want in its runtime. Used for reconnaissance only.
- **The Walmart affiliate / IO API.** Localised price and availability is
  offered to approved affiliates only; there is no public product-price API. A
  real option if you have credentials, and out of reach without them.

## 2026-10-06 experiments

Eleven live reads of the `/orchestra` tier from the local residential
connection, ZIP 22968 (Ruckersville, VA), electronics and PC parts. The
budget for the session was 14 reads, at least 25 s apart (actual spacing 27 s);
**three were left unspent**. Every read returned 200; there was no 412 or 429,
so the experiment phase ended on budget, not on a refusal. Each read is logged,
without cookies, in `walmart-experiments/2026-10-06.jsonl`. No proxy, VPN,
challenge solving, header variation or second identity was involved.

### The reads

| # | read | status | result |
|---|---|---|---|
| 1 | store finder, ZIP 22968, radius 50 | 200 | 18 stores. Nearest: **Ruckersville Supercenter #4638 (1.77 mi)**, Charlottesville #1780 (11.5), Gordonsville #4682 (21.6) |
| 2 | Electronics `3944`, p1, ps 40, `best_match` | 200 | **answered for Gordonsville Supercenter (#4682)**, not Ruckersville. `aggregatedCount` 185, `maxPage` 5; primary stack 48 entries, shipping stack 10 |
| 3 | Electronics p1, **ps 100** | 200 | `aggregatedCount` **220**, `maxPage` 11, primary stack 29 entries. Walmart echoed `ps: "20"` |
| 4 | Electronics p1, ps 40, **sort `new`** | 200 | accepted, echoed `sort: new`; `aggregatedCount` 173; 38 distinct ids, only 10 shared with `best_match` p1 |
| 5 | Computers `3944_1089430`, p1, ps 40 | 200 | `aggregatedCount` 56, `maxPage` 2, 43 entries |
| 6-9 | Electronics p2..p5, ps 40, `best_match` | 200 | 44, 42, 34, 22 entries; `aggregatedCount` 214, 176, 204, 192; `maxPage` 6, 5, 6, 6 |
| 10 | Computers p2, ps 40 | 200 | 16 entries; `aggregatedCount` 55 |
| 11 | Electronics p2, ps 40, sort `new` | 200 | 30 entries; zero ids shared with page 1 of the same sort |

### Which store answered

**Walmart served Gordonsville Supercenter (#4682) on every shelf read**, not the
Ruckersville store that is 1.8 miles from the ZIP. This is the egress-IP
geolocation described in section 2, and it was again not something to work
around: the ZIP, the store finder's nearest result and the cookie all pointed
at #4638 and were ignored. If the Ruckersville rack is what you want, this
connection cannot read it. `pageProperties.stores` in the response says `4682`.

### Hypotheses

| id | hypothesis | verdict |
|---|---|---|
| W-3 | `ps` above 40 is honoured | **Refuted.** `ps=100` is answered as `ps=20`: more pages (`maxPage` 11), smaller ones, and a *different* `aggregatedCount`. The cap stays 40. Whether anything between 40 and 100 works was not probed. |
| W-5 | a newest-first sort exists under the clearance facet | **Confirmed, with a caveat.** `sort=new` is a valid token. Page 1 is skewed to recent item ids (median 19.8e9 against 16.9e9 for `best_match`; 20 of 38 above 19e9 against 9 of 44), page 2 is far older (median 10.3e9, 1 of 29 above 19e9), and the two pages share no ids. The caveat: that is ordering by *item* age. An old listing newly marked down will not surface on page 1, so a delta read misses it until the next full pass. |
| W-4 | Computers is a strict subset of Electronics | **Not confirmed; the data point the other way.** 39 of 46 distinct Computers ids appeared in the paged Electronics rack; 7 did not (a keyboard, a router, chargers, ink, a kids' tablet). Electronics itself yielded only 127 distinct ids from 190 entries, so part of the gap is incomplete paging, but none of it can be assumed away. Because the label cannot be derived from Electronics alone, skipping the Computers read could silently lose items. Not implemented. |
| W-10 | 200s carry CDN cache headers | **No.** Every 200 had `cache-control: max-age=0, no-cache, no-store` and no `age`, `x-cache` or `cf-cache-status`. Nothing here is served from a shared cache; each read is a read of the origin. |

### Findings that were not on the list

- **`best_match` paging is unstable.** The ranking is re-run per page
  (`ms_triggered: true`), so 53 of the 136 distinct ids on pages 2-5 had
  already appeared on an earlier page. Five pages yielded 127 distinct ids of a
  claimed 173-214. A sort with a fixed order (`new`) did not do this across the
  two pages read, which is why the sweep now reads with it.
- **Pages are not 40 items.** 48, 44, 42, 34, 22 entries, each including one
  `AdPlaceholder` with no item id, and in-page repeats. The old pager treated a
  page shorter than 40 as the end of the shelf, which would have stopped at
  page 4 of 5 in this very run and dropped the tail. The pager now stops on an
  empty page or on `paginationV2.maxPage`.
- **`aggregatedCount` is an estimate.** It ranged from 173 to 220 across nine
  reads of the Electronics shelf at one store within five minutes, and tracks
  `maxPage x ps`, not an exact count. It is no use as a change detector, which
  was the roadmap's proposed use.
- **The roadmap's rack sizes are about right:** Electronics roughly 190
  entries over 5-6 pages, Computers 55-56 over 2.

### What changed in the code, from this

- Walmart reads go out with `retries: 0`; a 412/429 is not knocked on again
  (W-0 / C-2).
- A durable ledger (`host_budget` table, `clearance/host-budget.ts`) holds a
  not-before time and a per-window read count. The pacer consults it before
  every read, a refusal writes it, and a cooldown longer than 90 s is raised
  (`WalmartCooldownError`) rather than slept through. A manual sweep or a
  restart now inherits the nightly job's refusal (W-1 / C-3, scoped to
  Walmart). Window defaults are `WALMART_BUDGET_WINDOW_MS` = 30 min and
  `WALMART_WINDOW_READ_LIMIT` = 18, both guesses against "about twenty reads";
  the real window is still unmeasured.
- The page cap (`WALMART_SWEEP_MAX_PAGES`) is gone. A run spends
  `WALMART_SWEEP_READ_BUDGET` reads (default 12; refused reads count) in the
  order Computers, Electronics, Video games, and says in `[budget]` which
  shelves it did not finish (W-2 / C-5).
- Page size stays 40 (W-3 refuted); no `WALMART_PAGE_SIZE` knob was added.
- Sweep reads use `sort=new` (`WALMART_SWEEP_SORT` overrides it), for the
  stable paging above.
- Optional delta mode, `WALMART_SWEEP_DELTA=1`: read newest-first and stop at
  the first page of items the store has already recorded; unread rows are
  carried forward from the previous day with their original `captured_at`; a
  full pass is forced when the last one is older than `WALMART_FULL_SWEEP_DAYS`
  (default 7). Off by default because of the item-age caveat, and because
  carried rows are up to a week stale. Items that left the rack stay in the feed
  until the next full pass (W-5).
- Persisted-query rot (`PersistedQueryNotFound`, `VALIDATION_*`, "missing
  variable") is its own error, `HashExpiredError`. The sweep stops before
  spending more budget, as it also does on a wrong store (W-8 / O-3).
- Every error string a run records starts with a token the dashboard can show:
  `[rate-limited]`, `[wrong-store]`, `[hash-expired]`, `[error]`, plus
  `[budget]` when the read budget ran out.

### Still unknown

- The shape of the rate-limit window (fixed or sliding, and its length). The
  eleven reads here ran 27 s apart and drew no refusal, which fits "about
  twenty reads" but does not test it.
- Whether a `ps` between 41 and 99 is honoured.
- Whether `sort=new` follows listing date or when the clearance tag was
  applied; the evidence fits the former.
- `http.ts` still sleeps its backoff once after the final failed attempt even
  with `retries: 0`, so a 412 returns about 5 s late. Harmless to the budget;
  it belongs to the HTTP client, not this tier.
