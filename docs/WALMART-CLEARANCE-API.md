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
- **The edge rate-limits hard.** Roughly twenty reads inside a few minutes earns
  a `412` carrying a PerimeterX block payload, and it persists for tens of
  minutes. This is the binding constraint on the design: the sweep is a nightly
  job that waits seconds between reads, not a live query path.

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

## 2. Store scoping

The store is a **cookie**, not a parameter:

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

Backoff on 412/429/5xx, a browser `User-Agent`, no accounts, no cart, no
checkout, no challenge solving. The sweep runs once a night.

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
