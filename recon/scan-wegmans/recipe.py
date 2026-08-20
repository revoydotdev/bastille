"""webmap recipe for www.wegmans.com — SCAFFOLDED by `webmap scan`.

This recipe was generated deterministically from a source scan. SURFACES come
from the sitemap; the selectors in drive() are COMMENTED WITH EVIDENCE — the
actual attributes/values observed on the live page — not guessed. Review,
prune, and tighten against real client behavior before relying on it.

Read-only / idempotent by construction: only navigates and inspects. Do not
add cart adds, form submits, bookings, or any mutation without explicit review.
"""

BASE = "https://www.wegmans.com"

# SURFACES — from sitemap.xml. Each loads a distinct page + fires its on-load API.
# Buckets are path-shape classifications; prune to the surfaces you actually
# want to exercise (depth, not breadth — every surface adds capture time).
SURFACES = [
    # ---- root (3 in sitemap, first 1 sampled) ----
    "https://www.wegmans.com/",
    # ---- product (231 in sitemap, first 6 sampled) ----
    "https://www.wegmans.com/shop/discovery/hot-zone",
    "https://www.wegmans.com/shop/discovery/gold-pan-meals",
    "https://www.wegmans.com/shop/discovery/steak",
    "https://www.wegmans.com/shop/discovery/active-nutrition",
    "https://www.wegmans.com/shop/discovery/fall-meals",
    "https://www.wegmans.com/https://www.wegmans.com/shop/categories/7063252",
    # ---- event (40 in sitemap, first 4 sampled) ----
    "https://www.wegmans.com/service/mobile-app",
    "https://www.wegmans.com/service/specialized-services-at-wegmans",
    "https://www.wegmans.com/service/my-wegmans-online",
    "https://www.wegmans.com/service/shoppers-club",
    # ---- other (2048 in sitemap, first 12 sampled) ----
    "https://www.wegmans.com/events/hatch-chile-fest",
    "https://www.wegmans.com/gift-cards",
    "https://www.wegmans.com/values-in-action/feel-your-best/meet-our-nutritionists",
    "https://www.wegmans.com/values-in-action/feel-your-best/meal-inspiration/dinner-timesavers",
    "https://www.wegmans.com/events",
    "https://www.wegmans.com/events/lobster-fest",
    "https://www.wegmans.com/QA-Events-Main",
    "https://www.wegmans.com/events/weekends-at-wegmans-near-our-stores-event",
    "https://www.wegmans.com/news-media/photo-logo-gallery",
    "https://www.wegmans.com/values-in-action/feel-your-best/meal-inspiration",
    "https://www.wegmans.com/events/wegmans-sushi-fest",
    "https://www.wegmans.com/values-in-action/feel-your-best/gluten-free-diets",
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

    # ---- product: https://www.wegmans.com/shop/discovery/hot-zone ----
    # observed same-origin anchors: [{'h': '/', 't': '', 'same': True}, {'h': '/my-list', 't': '0', 'same': True}, {'h': '/stores', 't': 'Stores', 'same': True}]
    # observed data-hooks/testids: ['-baseHeading', 'AddIcon', 'ArrowDropDownIcon', 'CloseIcon', 'FavoriteBorderIcon', 'IconChevronLeft']
    # → try: [data-hook="-baseHeading"], [data-hook="AddIcon"], [data-hook="ArrowDropDownIcon"]
    # observed click targets (role/tag): ['button']
    if hop(f"{BASE}/shop/discovery/hot-zone", 3.0, 1):
        for sel in ('[data-hook*="item"] a', 'a[href*="/product"]', '[role=listitem] a'):
            found = hrefs(sel, 6)
            if found:
                for h in found:
                    hop(h if h.startswith('http') else BASE + h, 2.5, 0)
                break

    # ---- event: https://www.wegmans.com/service/mobile-app ----
    # observed same-origin anchors: [{'h': '/', 't': '', 'same': True}, {'h': '/my-list', 't': '0', 'same': True}, {'h': '/stores', 't': 'Stores', 'same': True}]
    # observed data-hooks/testids: ['-baseHeading', 'ArrowDropDownIcon', 'CloseIcon', 'IconListOutlined', 'IconMenu', 'IconSearch']
    # → try: [data-hook="-baseHeading"], [data-hook="ArrowDropDownIcon"], [data-hook="CloseIcon"]
    # observed click targets (role/tag): ['button']
    if hop(f"{BASE}/service/mobile-app", 3.0, 1):
        for sel in ('[data-hook*="item"] a', 'a[href*="/event"]', '[role=listitem] a'):
            found = hrefs(sel, 6)
            if found:
                for h in found:
                    hop(h if h.startswith('http') else BASE + h, 2.5, 0)
                break

    # ---- other: https://www.wegmans.com/events/hatch-chile-fest ----
    # observed same-origin anchors: [{'h': '/', 't': '', 'same': True}, {'h': '/my-list', 't': '0', 'same': True}, {'h': '/stores', 't': 'Stores', 'same': True}]
    # observed data-hooks/testids: ['-baseHeading', 'ArrowDropDownIcon', 'CloseIcon', 'IconListOutlined', 'IconMenu', 'IconSearch']
    # → try: [data-hook="-baseHeading"], [data-hook="ArrowDropDownIcon"], [data-hook="CloseIcon"]
    # observed click targets (role/tag): ['button']
    if hop(f"{BASE}/events/hatch-chile-fest", 3.0, 1):
        for sel in ('[data-hook*="item"] a', 'a[href*="/other"]', '[role=listitem] a'):
            found = hrefs(sel, 6)
            if found:
                for h in found:
                    hop(h if h.startswith('http') else BASE + h, 2.5, 0)
                break


