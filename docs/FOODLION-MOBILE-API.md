# Food Lion mobile API — reverse-engineering findings

Goal: find a source of **per-store** Food Lion prices (the public web catalogue
at `foodlion.com/groceries/` is national — see `BACKEND-MAP.md`). The Android
app is the obvious candidate. This documents what the app's API actually is,
proven against the app's own traffic, and the concrete reason it is **not
usable from a server today**.

Tooling: `apkeep` (APKPure) → JADX → Waydroid + Frida + mitmproxy → cloakbrowser.
App analysed: `com.foodlion.mobile` **9.2.1** (versionCode 26070114).

## Verdict (read this first)

- The app talks to a **real per-store GraphQL API** whose price data is exactly
  what we want, keyed by `serviceLocationId` (the store). The full contract is
  below and is verified.
- The endpoint is gated by **DataDome's mobile anti-bot** (not the web
  Cloudflare/DataDome we already handle). Reproducing a valid request from our
  server is **not currently viable**:
  - A browser-solved DataDome cookie (cloakbrowser, residential IP, real
    Chromium) does **not** clear the endpoint — tested, it loops the
    interstitial. The mobile DataDome config expects the app SDK's signed
    `X-DD-B` device-signal payload, which a browser cannot produce.
  - Capturing from the app itself requires the app to first pass DataDome. On
    this workstation the Waydroid container is a **fail-closed VPN killswitch**
    (egress only via a Surfshark datacenter IP), and DataDome penalises
    datacenter IPs + emulator signals hardest; through mitmproxy the app was
    hard-blocked ("You have been blocked"). Even a captured `datadome` cookie
    is IP- and fingerprint-bound and short-lived, so it would not power a
    server-side poller without continuously re-minting it on a real, unblocked
    device.
- **Recommendation:** keep shipping the national Food Lion price with the store
  picker as pickup-location context (current behaviour). Treat this document as
  a ready-to-implement spec if the economics ever justify a real-device cookie
  farm, or if Food Lion relaxes the mobile gate.

## Endpoint

```
POST https://core.pdl.foodlion.com/prod/apollo/graphql
```

Hardcoded in `EnvironmentConfigHelper.awaitGraphqlUrl()`. Apollo Kotlin client
(`com.apollographql.apollo`), OkHttp engine, **no certificate pinning** in the
app. Backend is Peapod Digital Labs (`com.peapoddigitallabs.squishedpea`) — the
same platform behind the web catalogue.

## Request headers (verified via mitm capture of the app)

Built in `GraphqlInterceptor.getHeaders()` / `RequestHeaders`:

| header | value | notes |
|---|---|---|
| `User-Agent` | `fdln/26070114 Platform/Android AppVersion/9.2.1 App/PNA` | from RemoteConfig |
| `Authorization` | *(empty for anonymous)* | first calls are anonymous; login only for account features |
| `opco` | `FDLN` | banner (Ahold Delhaize opco) |
| `env` | `prod` | |
| `service-location-id` | *the store* | **the per-store key** |
| `basket-id` | *(empty ok)* | |
| `current-order-id` | *(empty ok)* | |
| `GQL-Platform-Origin` | `android` | |
| `X-Correlation-Id` | random hex | |
| `X-Device-Token` | *(empty ok)* | |
| `X-Datadog-Session-ID` | *(empty ok)* | |
| `apollographql-client-name` | `com.foodlion.mobile-apollo-android` | |
| `apollographql-client-version` | `9.2.1-26070114` | |

Anonymous browsing is supported: the app's first calls are `RefreshToken` and
`serviceLocationsV2` with an empty `Authorization`.

The one missing ingredient is a valid **`datadome` cookie** (`Cookie:
datadome=…`) that the DataDome SDK obtains and refreshes; without it the
endpoint returns `403` + a `geo.captcha-delivery.com` challenge.

## The store-id chain (zip → serviceLocationId → prices)

All operation documents were extracted verbatim from the Apollo-generated
classes in the APK.

**1. Zip → store + `serviceLocationId`** (`GetServiceLocationsQuery`):

```graphql
query getServiceLocations($zip: String!, $customerType: ShortCustomerType!, $serviceType: ServiceType!) {
  serviceLocationsV2(zip: $zip, customerType: $customerType, serviceType: $serviceType) {
    locations { location {
      id            # <- this is the serviceLocationId, e.g. "PRO-777-028-004"
      name pickupLocationId address city state zip site active serviceType
      storeNumber priceZone ecommStoreId shipMethod deliveryPartner substitutionType
    } distance }
  }
}
```

`storesV2` (`GetStoresQuery`, by `query`/coordinates/radius) and
`storeByNumber` (`GetStoreByNumberQuery`) are alternative store lookups.

**2. `serviceLocationId` → per-store product price** (`GetProductByIdQuery`):

```graphql
query GetProductById($id: String!, $serviceLocationId: ID!, $includeSubstitute: Boolean!,
                     $includeExtendedInfo: Boolean!, $includeFlags: Boolean!,
                     $includeNutrition: Boolean!, $itemMasterInfo: Boolean!) {
  productByIds(productIds: [$id], serviceLocationId: $serviceLocationId,
               includeSubstitute: $includeSubstitute, includeExtendedInfo: $includeExtendedInfo,
               includeFlags: $includeFlags, includeNutrition: $includeNutrition,
               itemMasterInfo: $itemMasterInfo) {
    products { ...product }
  }
}
```

**3. Store specials / sales** (`ProductSpecialsQuery`):

```graphql
query ProductSpecials($serviceLocationId: ID!, $filter: String, $pagination: PaginationInput) {
  productSpecials(serviceLocationId: $serviceLocationId, filter: $filter, pagination: $pagination) {
    products { ...product }
    simpleFacets { count id }
    pagination { size start total isEndOfList }
  }
}
```

Other useful operations present: `GetProductByUPCQuery`, `GetFilteredProductsQuery`
(category listing), `GetSearchListQuery` (search), `GetProductSpecialsQuery`,
`serviceLocationDryRunV2` (bulk cart pricing), `GetBmsmDetail*` (buy-more-save-more).

### The `product` fragment — the price fields

Byte-for-byte the same shape our `FoodLionAdapter` already parses from the web
catalogue, but returned **per store**:

```graphql
fragment product on Product {
  prodId name brand size upc rootCatName
  price regularPrice weightedRegularPrice
  unitPrice unitMeasure
  flags { active bogo sale lowPriceEveryday outOfStock longTermOutOfStock
          organic privateLabel preferredItem ... }
  bmsm bmsmTiers { description discount discountedPrice type units }
  hasCoupon coupon { title description clippingRequired promotionType multiQty
                     maxDiscount targeted startDate endDate }
  availableDisplayCoupons { ... }
  image { small medium large xlarge }
}
```

So if the DataDome gate were solved, the existing promo model
(`server/src/price/*`) and the Food Lion adapter's `toPrice()` would consume
this response essentially unchanged — only the transport and the
`serviceLocationId` header would be new.

## Why the two automated paths fail (evidence)

| path | result |
|---|---|
| Browser cookie via cloakbrowser (residential IP, real Chromium, mobile UA), navigate the endpoint to let DataDome JS auto-solve, then POST | `datadome` cookie **is** set on `.foodlion.com`, but the POST still `403`s and the interstitial loops across 4 reloads. The API's DataDome config (site 36030 / 45296) does not accept a browser-solved cookie. |
| App in Waydroid + mitmproxy (CA trusted, no app pinning) | Captured the exact request contract (headers above), but every call `403` → `geo.captcha-delivery.com` → "You have been blocked". mitmproxy's upstream TLS replaces the app's fingerprint and the DataDome WebView carries a `WayDroid x86_64` UA — instant bot score. |
| App in Waydroid, net-of-mitm, Frida in-process capture | Blocked by environment: the container egresses only through a fail-closed VPN netns (Surfshark datacenter IP); DataDome penalises that. No app pinning and OkHttp is hookable (`RealInterceptorChain.a(Request)`), so capture is technically ready — it is the **network egress + DataDome device scoring**, not instrumentation, that blocks a clean 200. |

## Reproduce the static map

```
apkeep -a com.foodlion.mobile ~/apkwork/foodlion/input      # 9.2.1 xapk
jadx -q --no-res --no-debug-info -d ~/apkwork/foodlion/src <base>.apk
# endpoint:
grep -r 'core.pdl.foodlion.com/prod/apollo/graphql' ~/apkwork/foodlion/src
# headers:  application/network/GraphqlInterceptor.java , RequestHeaders.java
# queries:  com/peapoddigitallabs/squishedpea/*Query.java  (OPERATION_DOCUMENT)
```
