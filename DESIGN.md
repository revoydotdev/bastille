# grocer — design system

A price-watching dashboard is read at a glance, usually while deciding whether
to go to one store or the other. Every decision below serves that: the number
you are comparing should be the most legible thing on the screen, and an offer
that is *not* a number should never be mistaken for one.

## Principles

1. **The comparable number is the hero.** Effective unit price — the figure
   that already accounts for BOGO and multibuy — is set larger and heavier than
   anything else in a row.
2. **Never fake precision.** An offer that cannot be reduced to a number shows
   its own words and is visibly excluded from numeric ranking. No invented
   averages, no "approx".
3. **Store identity is a colour, not a logo.** Food Lion and Wegmans are
   distinguished by a single accent so a row's origin is readable peripherally.
4. **Alerts are calm by default.** Only an urgent alert gets saturated colour.
   A price rise is information, not an emergency.

## Colour

Semantic tokens, defined once on `:root` and re-pointed for dark mode. Never
hard-code a hex outside the token block.

| token | light | dark | use |
|---|---|---|---|
| `--bg` | `#f7f7f5` | `#131315` | page |
| `--surface` | `#ffffff` | `#1c1c1f` | cards, rows |
| `--surface-2` | `#f0f0ed` | `#252529` | inset, table header |
| `--border` | `#e2e2dd` | `#2f2f34` | hairlines |
| `--text` | `#1a1a1c` | `#ececeb` | body |
| `--text-dim` | `#6b6b70` | `#9a9aa1` | labels, metadata |
| `--accent` | `#2f6f4e` | `#5aa87c` | primary action |
| `--drop` | `#1f7a4d` | `#4fbc84` | price fell |
| `--rise` | `#a1462d` | `#e08163` | price rose |
| `--promo` | `#7a4fa8` | `#b28ce0` | non-numeric offer |
| `--urgent` | `#b03030` | `#e06a6a` | urgent alert |

Store accents: Food Lion `#0053a0`, Wegmans `#ce3f24` — both taken from the
stores' own marks so the mapping is learned instantly.

Green means *the price went down*, red means *it went up*. That is the only
meaning either colour carries; do not reuse them for success/error states.

Purple is reserved for offers that are not plain numbers. It is the one visual
cue that says "read the words, not just the figure".

## Type

System stack — this is a utility, not a brand exercise:
`ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`.

Prices use `font-variant-numeric: tabular-nums` everywhere so columns of
figures align and a changing digit does not shift the row.

| role | size | weight |
|---|---|---|
| page title | 1.35rem | 600 |
| section heading | 0.8rem, uppercase, 0.08em tracking | 600 |
| hero price | 1.5rem | 650 |
| body | 0.9rem | 400 |
| metadata | 0.78rem | 400, `--text-dim` |

## Space

4px base. Use `4 8 12 16 24 32 48` only. Card padding 16px, row gap 12px,
section gap 24px.

## Shape and depth

Radius 8px on cards and controls, 4px on chips and badges. One elevation:
`0 1px 2px rgb(0 0 0 / 0.06)`. No layered shadows, no gradients on surfaces.

## Motion

120ms `ease-out` on hover and colour transitions. A price that changes during a
refresh flashes its new value once over 600ms. Nothing else animates — a
dashboard that moves is a dashboard you cannot scan.

## Components

- **Offer row** — store accent bar on the left edge, product name and size,
  then the promotion chip, then the hero price with the struck regular price
  beneath it when the two differ.
- **Promo chip** — purple outline, the store's own words verbatim, truncated
  with a `title` rather than reworded.
- **Watch group card** — one card per thing you are watching, one row per store
  inside it. The cheapest row is marked "best"; the difference from the best is
  shown on the others.
- **Sparkline** — 40px tall, effective unit price over time, no axes. Its job
  is trend shape, not values.
- **Alert row** — severity dot, message, relative time, dismiss. Non-numeric
  alerts carry the promo colour.

## Accessibility

All text meets 4.5:1 against its surface in both themes. Colour is never the
only signal: a price drop shows an arrow as well as green, and a non-numeric
offer shows the chip as well as purple. Every interactive control has a visible
focus ring (`2px solid var(--accent)`, 2px offset) and an accessible name.
