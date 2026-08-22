"""webmap recipe for www.walmart.com — SCAFFOLDED by `webmap scan`.

This recipe was generated deterministically from a source scan. SURFACES come
from the sitemap; the selectors in drive() are COMMENTED WITH EVIDENCE — the
actual attributes/values observed on the live page — not guessed. Review,
prune, and tighten against real client behavior before relying on it.

Read-only / idempotent by construction: only navigates and inspects. Do not
add cart adds, form submits, bookings, or any mutation without explicit review.
"""

BASE = "https://www.walmart.com"

# SURFACES — from sitemap.xml. Each loads a distinct page + fires its on-load API.
# Buckets are path-shape classifications; prune to the surfaces you actually
# want to exercise (depth, not breadth — every surface adds capture time).
SURFACES = [
    # ---- product (10960 in sitemap, first 6 sampled) ----
    "https://www.walmart.com/shop/deals",
    "https://www.walmart.com/shop/deals/all-home/bath",
    "https://www.walmart.com/shop/deals/all-home/appliances",
    "https://www.walmart.com/shop/deals/all-home/arts-crafts-and-sewing",
    "https://www.walmart.com/shop/deals/all-home/floor-care",
    "https://www.walmart.com/shop/deals/all-home/entryway",
    # ---- post (182 in sitemap, first 4 sampled) ----
    "https://www.walmart.com/help/article/track-your-order/143cf6e1d8cb48e6a1ed840409881235",
    "https://www.walmart.com/help/article/edit-or-cancel-an-order/2c7e3d99812044f8aaa65aee0eae3d1c",
    "https://www.walmart.com/help/article/substitutions-for-store-pickup-and-delivery-items/c8dd3973509b42488da66a362af4666d",
    "https://www.walmart.com/help/article/canceled-orders/8f8dc075d900475a990d4dede6215f0f",
    # ---- profile (41228 in sitemap, first 3 sampled) ----
    "https://www.walmart.com/c/author/michael-bhaskar",
    "https://www.walmart.com/c/author/rick-halpern",
    "https://www.walmart.com/c/author/mark-halperin",
    # ---- other (627932 in sitemap, first 12 sampled) ----
    "https://www.walmart.com/cp/16-value-meals/7325246",
    "https://www.walmart.com/cp/agco-ignition-parts/4394062",
    "https://www.walmart.com/cp/checkout-promise/1228977",
    "https://www.walmart.com/cp/clos-du-bois/2373175",
    "https://www.walmart.com/cp/email/126883",
    "https://www.walmart.com/cp/harley-davidson-parts-accessories/3836903",
    "https://www.walmart.com/cp/individual-family-insurance/5075911",
    "https://www.walmart.com/cp/mathematics-teen-young-adult-books/3135019",
    "https://www.walmart.com/cp/mens-pants/6041621",
    "https://www.walmart.com/cp/ncaa-game-of-the-week/5571627",
    "https://www.walmart.com/cp/personal-care-by-brand/9157053",
    "https://www.walmart.com/cp/premium-big-boys-clothing-8-20/3817041",
]

# Latent API endpoints mined from JS bundles (LinkFinder-style). These are
# paths the client KNOWS about; some fire on the surfaces above, others are
# dormant. Cross-reference with a capture to find the uncalled surface.
JS_ENDPOINTS = [
    # //… (240 paths)
    "http://msds.walmartstores.com/",
    "http://www.walmart.com/store/finder",
    "https://allswellhome.com/",
    "https://api.bazaarvoice.com/data/uploadphoto.json",
    "https://apps.apple.com/us/app/cashi-m%C3%A1s-que-efectivo/id1383306099",
    "https://apps.apple.com/us/app/me-walmart/id1459898418",
    "https://asset-bff.prod.walmart.com",
    "https://auth-qa.syf.com/v3/oauth2/authorize",
    # //api/… (1 paths)
    "/api",
    # /api/… (3 paths)
    "/api/",
    "/api/v2/collector",
    "/api/v2/collector/clientError?r=",
]

def drive(page, log):
    def hop(url, wait=3.0, scrolls=0):
        try:
            page.goto(url, wait_until='domcontentloaded')
            page.wait_for_timeout(int(wait * 1000))
            for _ in range(scrolls):
                page.mouse.wheel(0, 2500); page.wait_for_timeout(1200)
            return True
        except Exception as e:
            log(f'[drive] {url} skip ({str(e)[:60]})'); return False

    def hrefs(sel, limit=8):
        try:
            return page.eval_on_selector_all(
                sel, "els => [...new Set(els.map(e => e.getAttribute('href')).filter(Boolean))]")[:limit]
        except Exception:
            return []

    # ---- product: https://www.walmart.com/shop/deals ----
    # observed same-origin anchors: [{'h': '#maincontent', 't': 'Skip to Main Content', 'same': True}, {'h': '/', 't': '', 'same': True}, {'h': '/', 't': '', 'same': True}]
    # observed data-hooks/testids: ['Clock-icon', 'FilterSettings-icon', 'Menu', 'MoneyCircle-icon', 'NextPage', 'Store-icon']
    # → try: [data-hook="Clock-icon"], [data-hook="FilterSettings-icon"], [data-hook="Menu"]
    # observed click targets (role/tag): ['button', 'switch']
    if hop(f"{BASE}/shop/deals", 3.0, 1):
        for sel in ('[data-hook*="item"] a', 'a[href*="/product"]', '[role=listitem] a'):
            found = hrefs(sel, 6)
            if found:
                for h in found:
                    hop(h if h.startswith('http') else BASE + h, 2.5, 0)
                break

    # ---- post: https://www.walmart.com/help/article/track-your-order/143cf6e1d8cb48e6a1ed840409881235 ----
    # observed same-origin anchors: [{'h': '#maincontent', 't': 'Skip to Main Content', 'same': True}, {'h': '/', 't': '', 'same': True}, {'h': '/', 't': '', 'same': True}]
    # observed data-hooks/testids: ['Menu', 'account-flyout', 'departments-flyout', 'global-header', 'hearder-navigation', 'language-selection-callout-dweb']
    # → try: [data-hook="Menu"], [data-hook="account-flyout"], [data-hook="departments-flyout"]
    # observed click targets (role/tag): ['button']
    if hop(f"{BASE}/help/article/track-your-order/143cf6e1d8cb48e6a1ed840409881235", 3.0, 1):
        for sel in ('[data-hook*="item"] a', 'a[href*="/post"]', '[role=listitem] a'):
            found = hrefs(sel, 6)
            if found:
                for h in found:
                    hop(h if h.startswith('http') else BASE + h, 2.5, 0)
                break


