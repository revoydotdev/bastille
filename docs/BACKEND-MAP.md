# Backend surface map — Food Lion & Wegmans

Produced with the sibling `webmap` tool (`~/Dev/revelri/webmap`) plus targeted
follow-up probing. Everything below was observed against the live sites on
2026-08-20 from an anonymous session; nothing here requires an account, and
every call is a read.

Reproduce with:

```
webmap scan  https://foodlion.com/groceries/  --local --allowed-static-host foodlion.com
webmap map   foodlion.com   --local --no-auth --no-burp --recipe recon/surfaces/foodlion.com.recipe.json
webmap scan  https://www.wegmans.com/         --local --allowed-static-host www.wegmans.com
webmap map   www.wegmans.com --local --no-auth --no-burp --recipe recon/surfaces/www.wegmans.com.recipe.json
```

Raw artifacts: `recon/webmap-foodlion/`, `recon/webmap-wegmans.partial/`
(`map.md`, `endpoints.json`, `contract.json`, `capture.jsonl`).

---

## Wegmans — REST + hosted Algolia

`webmap map` captured 67 first-party calls. The storefront is a Next.js app on
`www.wegmans.com` with its own `/api` tier; **search is not first-party** — it
is delegated to Algolia, which `webmap` reported as off-base traffic to
`qgppr19v8v-dsn.algolia.net`. That pointer is what made the rest findable.

### First-party REST (`https://www.wegmans.com`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/stores` | every store: number, name, address, zip, lat/long, hours |
| GET | `/api/stores/store-number/{n}` | one store |
| GET | `/api/products/{storeNumber}/{productId}` | full product incl. store-scoped price |
| GET | `/api/categories/v3/{shoppingMethod}/{storeNumber}[/{categoryKey}]` | category tree |
| GET | `/api/content/{contentType}/{id}` | CMS (Contentstack) blocks |
| GET | `/api/v2/user/context` | session context (authenticated; unused here) |

`shoppingMethod` is `instore` / `delivery` / `pickup`. The path template came
out of the client bundle: `buildCategoriesApiUrl({apiVersion, shoppingMethod,
storeNumber, categoryKey})`.

Product response carries the price model directly:

```
price_inStore          { amount, unitPrice, priceInCents, formattedAmount }
price_delivery         { … }
price_inStoreLoyalty   { … }   // populated only while a card deal runs
price_deliveryLoyalty  { … }
loyaltyInstoreDiscount / loyaltyDeliveryDiscount
discountType
digitalCouponsOffers[]
isAvailable, isBuyable, isSoldAtStore
```

### Search — Algolia

```
POST https://QGPPR19V8V-dsn.algolia.net/1/indexes/*/queries
     x-algolia-application-id: QGPPR19V8V
     x-algolia-api-key:        9a10b1401634e9a6e55161c3a60c200d
```

App ID and the **search-only** key are public client credentials, shipped in
`/_next/static/chunks/17rdf3ejza~dp.js` alongside the index names:

| index | contents |
|---|---|
| `products_v2` | current product index (`products` is the older one) |
| `pages`, `discovery_pages`, `pages_date_desc` | editorial |
| `collections`, `curated_query_suggestions` | merchandising |
| `suggested_term_with_images_v2` | typeahead |

A `products_v2` hit is store-sharded, which is what makes per-store price
tracking possible without an account:

```
objectID / productID     "94427"
productName, packSize, consumerBrandName, images[]
priceInStore             { "<storeNumber>": { amt: 2.99, utp: "$2.99/gallon" } }
priceDelivery            { … }
priceInStoreLoyalty      { … }                        // card price
loyaltyDiscountInStore   { "<storeNumber>": [ { nm, sav, exp } ] }
digitalCouponOfferIds[]  hasOffers  soldAtStores[]  availableStores[]
```

`loyaltyDiscountInStore[].nm` is the promotion, and it is **not always a
number**. Observed vocabulary over a 1000-hit sample: `DollarOff` (paired with
a numeric `sav`), `Buy 2 for $13.00`, `Buy 2 for $6.00`. `exp` is a unix
expiry. This is the field the app parses for non-numeric offers.

## Food Lion — server-rendered Peapod payload

Food Lion runs two separate surfaces, and only one is usable:

1. **`www.foodlion.com/product-search/…`** — the transactional SPA over the
   Peapod/ADUSA platform. Fronted by Cloudflare *and* DataDome
   (`geo.captcha-delivery.com`). `webmap map` hit the challenge, byparr
   obtained `cf_clearance`, and the retry still captured **0 API calls**
   because DataDome held the page. Defeating that is an explicit
   anti-automation control, so this surface is treated as closed and is
   not used.

2. **`foodlion.com/groceries/…`** — the SEO catalog, an Astro app, no bot
   protection, served to anyone. `webmap map` captured 7 calls, all HTML: the
   pages are fully server-rendered, so there is no XHR API to map. The
   contract lives in the markup instead, in two forms:

   * `<script type="application/ld+json">` — schema.org `Product` with
     `offers.price`, `priceCurrency`, `availability`.
   * `<astro-island props="…">` — the **complete upstream Peapod product
     object**, one array per category page, ~520 products per page.

The island payload is the richer of the two and is what the adapter reads:

```
prodId, name, brand, size, upc, image{}
price, regularPrice, weightedRegularPrice
unitPrice, unitMeasure
flags { sale, bogo, lowPriceEveryday, outOfStock, active, … }
bmsm, bmsmTiers[]            // buy-more-save-more tiers
coupon { title, description, clippingRequired, startDate, endDate,
         maxDiscount, multiQty, promotionType }
availableDisplayCoupons[]
advertiseOnSale, saleExpiration, hideStrikeThrough
```

Over a 3,120-product sample across five aisles: 1,377 on `flags.sale`, 286
carrying a `coupon`. `flags.bogo` and `bmsmTiers` are present in the schema and
handled, though none were live in that sample.

### Discovery surfaces

```
https://foodlion.com/groceries/sitemap.xml
  ├── sitemaps/products-{0,1,2}.xml     23,057 product URLs
  ├── sitemaps/categories-0.xml          2,872 category URLs
  └── sitemaps/content.xml
```

Category pages: `/groceries/browse-aisles/{treeId}-{slug}`
Product pages:  `/groceries/product/{slug}/{prodId}`

### Consequence for search

The SEO surface publishes no search endpoint — the header form navigates to the
DataDome-protected SPA. So Food Lion search is served from a **local catalog
index** built by reading the same category pages the adapter already reads for
prices. Prices come from the store, ranking is done here.

---

## Prices are per-store

Wegmans prices are keyed by store number and vary widely — Vitamin D Whole Milk
was $2.49 to $5.09 per gallon across stores on the same day. Food Lion's
`/groceries/` surface serves one national price set. Any comparison that
ignores the store number is comparing the wrong numbers, so the store selection
is part of the watchlist, not a display preference.

## Conduct

Read-only. One request at a time per host with a floor between requests
(`GROCER_MIN_REQUEST_INTERVAL_MS`, default 700 ms), backoff on 429/5xx, browser
`User-Agent`. No account, no cart, no checkout, no DataDome or Cloudflare
challenge solving. The Algolia key is used exactly as the storefront uses it,
with its own rate limits intact.
