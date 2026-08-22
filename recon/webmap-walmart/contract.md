# www.walmart.com — executable typed contract

_Durable contract of record. Endpoints: `/orchestra/cartxo/graphql/MergeAndGetCart/95f34a1adfe86d93ea7bc3d4e3952bbd81f89bf48cb91cf60451c5b190100cc6`, `/swag/graphql`, `/orchestra/home/graphql/shippingCountryList/fc56a9c78c53597db122a9cdf8cb2a7d87d5df700f9e7a411bc915491c3fb6eb`, `/orchestra/home/graphql/GlobalIntentCenter/f523ec35e2c5807e29159a81f210ce5246ee2a0743408d3bfe407f4f46f2379c`, `/orchestra/home/graphql/storeFinderNearbyNodesQuery/23594c3a307d6359f419a4247d6212be409ec7b74fb8963f5402147bed22e7fb`, `/orchestra/home/graphql/getCart/51f190b5d0f51e4da475b93fc9c4416b2b63b79e534ffb5cbea2b2649d8ad154`._

## Coverage scorecard

| metric | count | % |
|---|---|---|
| operations | 10 | 100% |
| typed input schema | 5 | 50% |
| typed return schema | 8 | 80% |
| **verified — observed** (real 200 captured) | 8 | 80% |
| **verified — active** (re-executed by webmap) | 0 | 0% |

## Coverage by transport

| transport | ops | typed return | verified observed | verified active |
|---|---|---|---|---|
| graphql | 6 | 6 | 6 | 0 |
| rest | 4 | 2 | 2 | 0 |

## Drift since last contract

- added: `95f34a1adfe86d93ea7bc3d4e3952bbd81f89bf48cb91cf60451c5b190100cc6`, `AdV2DisplayDSP`, `fc56a9c78c53597db122a9cdf8cb2a7d87d5df700f9e7a411bc915491c3fb6eb`, `f523ec35e2c5807e29159a81f210ce5246ee2a0743408d3bfe407f4f46f2379c`, `23594c3a307d6359f419a4247d6212be409ec7b74fb8963f5402147bed22e7fb`, `51f190b5d0f51e4da475b93fc9c4416b2b63b79e534ffb5cbea2b2649d8ad154`, `GET /orchestra/api/ccm/v3/bootstrap`, `POST /log.gif`, `POST /~{uid}/proxytown`, `POST /si/elh9ie/obs`
- removed (not seen this run): —
- return-schema changed: —
- **breaking** (field removed or retyped): —

## Operations

| op | type | transport | status | in | return |
|---|---|---|---|---|---|
| `23594c3a307d6359f419a4247d6212be409ec7b74fb8963f5402147bed22e7fb` | unknown | graphql | 🟢 observed | ✓ | ✓ |
| `51f190b5d0f51e4da475b93fc9c4416b2b63b79e534ffb5cbea2b2649d8ad154` | unknown | graphql | 🟢 observed | ✓ | ✓ |
| `95f34a1adfe86d93ea7bc3d4e3952bbd81f89bf48cb91cf60451c5b190100cc6` | unknown | graphql | 🟢 observed | ✓ | ✓ |
| `AdV2DisplayDSP` | query | graphql | 🟢 observed | ✓ | ✓ |
| `GET /orchestra/api/ccm/v3/bootstrap` | query | rest | 🟢 observed | — | ✓ |
| `POST /log.gif` | mutation | rest | 🟡 typed | — | — |
| `POST /si/elh9ie/obs` | mutation | rest | 🟢 observed | — | ✓ |
| `POST /~{uid}/proxytown` | mutation | rest | 🟡 typed | — | — |
| `f523ec35e2c5807e29159a81f210ce5246ee2a0743408d3bfe407f4f46f2379c` | unknown | graphql | 🟢 observed | ✓ | ✓ |
| `fc56a9c78c53597db122a9cdf8cb2a7d87d5df700f9e7a411bc915491c3fb6eb` | unknown | graphql | 🟢 observed | — | ✓ |