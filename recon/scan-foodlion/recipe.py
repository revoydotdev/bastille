"""webmap recipe for foodlion.com — SCAFFOLDED by `webmap scan`.

This recipe was generated deterministically from a source scan. SURFACES come
from the sitemap; the selectors in drive() are COMMENTED WITH EVIDENCE — the
actual attributes/values observed on the live page — not guessed. Review,
prune, and tighten against real client behavior before relying on it.

Read-only / idempotent by construction: only navigates and inspects. Do not
add cart adds, form submits, bookings, or any mutation without explicit review.
"""

BASE = "https://foodlion.com"

# SURFACES — from sitemap.xml. Each loads a distinct page + fires its on-load API.
# Buckets are path-shape classifications; prune to the surfaces you actually
# want to exercise (depth, not breadth — every surface adds capture time).
SURFACES = [
    # ---- product (23057 in sitemap, first 6 sampled) ----
    "https://foodlion.com/groceries/product/palmers-cocoa-butter-formula-cream-with-vitamin-e-3-5-oz-jar/206",
    "https://foodlion.com/groceries/product/reynolds-wrap-aluminum-foil-12-inch-wide-30-sq-ft/230",
    "https://foodlion.com/groceries/product/reynolds-wrap-aluminum-foil-12-inch-wide-75-sq-ft/231",
    "https://foodlion.com/groceries/product/reynolds-wrap-aluminum-foil-12-inch-wide-200-sq-ft/232",
    "https://foodlion.com/groceries/product/reynolds-wrap-heavy-duty-aluminum-foil-18-inch-wide-75-sq-ft/234",
    "https://foodlion.com/groceries/product/reynolds-kitchens-cut-rite-wax-paper-12-inch-wide-75-sq-ft/239",
    # ---- other (2874 in sitemap, first 12 sampled) ----
    "https://foodlion.com/groceries/browse-aisles/1-global-primary-category",
    "https://foodlion.com/groceries/browse-aisles/2-adult-beverages",
    "https://foodlion.com/groceries/browse-aisles/85-bread-bakery",
    "https://foodlion.com/groceries/browse-aisles/87-bakery-pies-desserts",
    "https://foodlion.com/groceries/browse-aisles/113-pies",
    "https://foodlion.com/groceries/browse-aisles/121-artisan-bakery-fresh-bread",
    "https://foodlion.com/groceries/browse-aisles/126-ciabatta-bakery-bread",
    "https://foodlion.com/groceries/browse-aisles/129-french-bakery-bread",
    "https://foodlion.com/groceries/browse-aisles/130-garlic-bakery-bread",
    "https://foodlion.com/groceries/browse-aisles/131-italian-bakery-bread",
    "https://foodlion.com/groceries/browse-aisles/132-more-artisan-bakery-bread",
    "https://foodlion.com/groceries/browse-aisles/134-sweet-bakery-bread",
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

    # ---- product: https://foodlion.com/groceries/product/palmers-cocoa-butter-formula-cream-with-vitamin-e-3-5-oz-jar/206 ----
    # observed same-origin anchors: [{'h': '#', 't': 'Sign in', 'same': True}, {'h': '#', 't': 'Create an Account', 'same': True}, {'h': 'https://foodlion.com/modal/guest-transfer-modal', 't': 'Sign In', 'same': True}]
    # observed data-hooks/testids: ['base accordion summary', 'button content', 'button label', 'carousel dot cta', 'carousel item 0', 'carousel item 1']
    # → try: [data-hook="base accordion summary"], [data-hook="button content"], [data-hook="button label"]
    # observed click targets (role/tag): ['button', 'tab']
    if hop(f"{BASE}/groceries/product/palmers-cocoa-butter-formula-cream-with-vitamin-e-3-5-oz-jar/206", 3.0, 1):
        for sel in ('[data-hook*="item"] a', 'a[href*="/product"]', '[role=listitem] a'):
            found = hrefs(sel, 6)
            if found:
                for h in found:
                    hop(h if h.startswith('http') else BASE + h, 2.5, 0)
                break

    # ---- other: https://foodlion.com/groceries/browse-aisles/1-global-primary-category ----
    # observed same-origin anchors: [{'h': '#', 't': 'Sign in', 'same': True}, {'h': '#', 't': 'Create an Account', 'same': True}, {'h': 'https://foodlion.com/modal/guest-transfer-modal', 't': 'Sign In', 'same': True}]
    # observed data-hooks/testids: ['base accordion summary', 'button content', 'button label', 'feature/regular divider', 'footer copy block', 'footer social nav']
    # → try: [data-hook="base accordion summary"], [data-hook="button content"], [data-hook="button label"]
    if hop(f"{BASE}/groceries/browse-aisles/1-global-primary-category", 3.0, 1):
        for sel in ('[data-hook*="item"] a', 'a[href*="/other"]', '[role=listitem] a'):
            found = hrefs(sel, 6)
            if found:
                for h in found:
                    hop(h if h.startswith('http') else BASE + h, 2.5, 0)
                break


