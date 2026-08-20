# grocer

Search Food Lion and Wegmans together, watch items across both, and get told
when a price moves — whether the move is a number or a "Buy 2 for $13.00".

| search | watchlist | alerts |
|---|---|---|
| ![Search results ranked by the price you actually pay](docs/screenshots/search.png) | ![Two stores compared inside one watch](docs/screenshots/watchlist.png) | ![Numeric and non-numeric alerts](docs/screenshots/alerts.png) |

## Why the effective unit price

A grocery offer is not always a number. `$3.49` compares by subtraction;
`BOGO`, `2 for $5`, `Buy 1 Get 1 50% Off`, and `$1.00 off with Shoppers Club`
do not. grocer parses each offer into a structured promotion and, where the
arithmetic is unambiguous, reduces it to an **effective unit price** — what you
pay per item once the deal is applied. That is the figure the UI ranks on, so a
BOGO on a $4.99 item sorts against a plain $2.49 correctly.

When an offer cannot honestly be reduced to a number, grocer says so: the row
shows the store's own words instead of a price and drops out of numeric
ranking. It never invents a figure.

Price changes and promotion changes are tracked separately, because they move
independently:

| change | numeric? | example |
|---|---|---|
| `price_drop` / `price_rise` | yes | $2.99 → $2.49 |
| `promo_started` | no | BOGO appears on an unchanged $4.99 |
| `promo_ended` / `promo_changed` | no | "2 for $13" replaced by "$1 off" |
| `back_in_stock` / `out_of_stock` | no | |

A promotion starting on an item whose shelf price did not move still alerts.

## Running it

```bash
npm install
npm run build
npm start          # http://127.0.0.1:5175
```

For development, run the API and the Vite dev server side by side:

```bash
npm run dev        # api on :5175, dashboard on :5174 (proxied)
```

Tests:

```bash
npm test                       # unit + live end-to-end
GROCER_SKIP_LIVE=1 npm test    # unit only, no network
```

The live suite drives the HTTP API against the real storefronts, so it needs
network access and is sensitive to the stores actually stocking the products it
looks up.

## Configuration

| variable | default | meaning |
|---|---|---|
| `PORT` / `HOST` | `5175` / `127.0.0.1` | API and dashboard bind |
| `GROCER_DB` | `data/grocer.db` | SQLite file |
| `GROCER_POLL_INTERVAL_MS` | `1800000` | how often watched prices are re-read |
| `GROCER_MIN_REQUEST_INTERVAL_MS` | `700` | floor between requests to one host |
| `WEGMANS_STORE` | `24` | default Wegmans store number |
| `FOODLION_AISLE_TTL_MS` | `1800000` | Food Lion catalogue cache lifetime |
| `FOODLION_STORES_TTL_MS` | `86400000` | Food Lion store directory cache lifetime |
| `WEGMANS_STORES_TTL_MS` | `86400000` | Wegmans store list cache lifetime |

## Picking your stores

Enter a ZIP once and both chains resolve to a real nearby store, nearest first
with distances. For ZIP 22963 that is Food Lion Palmyra (264 Turkeysag Trail)
and Wegmans Charlottesville (#127, 11.2 mi).

The two chains mean different things by "your store", and the app says which is
which rather than blurring them:

- **Wegmans prices per store**, and the spread is large — the same gallon of
  milk ran $2.49 to $5.09 across stores on one day. Changing the store changes
  the price, and the watchlist records prices per store.
- **Food Lion publishes one online catalogue price chain-wide.** Its store
  choice sets where you'd pick up; it does not change the price. Food Lion rows
  are labelled `national price`, and every reading is recorded under a single
  price scope so switching stores never forks the history or shows up as a
  price change. `docs/BACKEND-MAP.md` has the tests behind that claim and why
  no per-store Food Lion price is reachable.

ZIP resolution uses the chains' own store coordinates, not a third-party
geocoder. An exact ZIP match is used as-is; otherwise the centroid of stores
sharing the three-digit prefix is used and reported as approximate; a ZIP that
matches nothing leaves the stores unranked rather than showing made-up
distances.

## How it gets the data

Mapped with the sibling [`webmap`](../webmap) tool. The full write-up, including
what each store exposes and what it does not, is in
[docs/BACKEND-MAP.md](docs/BACKEND-MAP.md). In short:

- **Wegmans** — first-party REST at `www.wegmans.com/api/*` for stores,
  categories and per-store product detail; search runs against the storefront's
  own Algolia index using the public search-only key it ships to every browser.
- **Food Lion** — the server-rendered catalogue at `foodlion.com/groceries/`,
  which embeds the upstream Peapod product objects (price, regular price, sale
  and BOGO flags, buy-more-save-more tiers, coupons) directly in the page.
  Search is served from a local index built from the same category pages,
  because that surface publishes no search endpoint. Stores come from the open
  Yext directory at `stores.foodlion.com/index.json` — 1,149 stores with
  coordinates.

Food Lion's transactional SPA sits behind Cloudflare and DataDome. grocer does
not touch it.

### Conduct

Read-only throughout. One request at a time per host with a configurable floor
between them, backoff on 429 and 5xx, a browser `User-Agent`, and a 30-minute
cache on the Food Lion catalogue. No accounts, no carts, no checkout, no
challenge solving.

## Layout

```
server/src/
  adapters/      one module per store, all reading, behind a small contract
  geo.ts         distance + ZIP resolution from the chains' own store data
  price/         the promotion model, parser, and change detection
  jobs/poller.ts scheduled re-read of everything watched
  repo.ts        products, price history, watchlists, alerts
  routes.ts      HTTP API + SSE alert stream
web/src/         React dashboard: search, watchlist, alerts
docs/            backend map
DESIGN.md        colour, type, spacing, and what each colour is allowed to mean
```

## API

| method | path | |
|---|---|---|
| GET | `/api/search?q=&stores=&wegmansLocation=&foodlionLocation=` | both stores, cheapest comparable first |
| GET | `/api/stores?postalCode=` | both chains' nearest stores, with distances and whether the chain prices per store |
| GET/POST | `/api/watchlist` | list / add (add to an existing group to compare) |
| PATCH/DELETE | `/api/watchlist/:id` | rename, set a target price, remove |
| DELETE | `/api/watchlist/item/:itemId` | drop one store from a group |
| GET | `/api/prices/:productId` | price history |
| GET | `/api/alerts?unread=1` | alert feed |
| POST | `/api/alerts/:id/ack`, `/api/alerts/ack-all` | dismiss |
| POST | `/api/refresh` | re-read everything now |
| GET | `/api/alerts/stream` | server-sent events, pushed as polls produce them |
| GET | `/api/status` | last poll result |
