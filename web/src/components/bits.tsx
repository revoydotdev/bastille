import type { PriceSnapshot, PromoKind, StoreId } from '../types';
import { money } from '../lib/api';

export const STORE_COLOR: Record<StoreId, string> = {
  foodlion: 'var(--store-foodlion)',
  wegmans: 'var(--store-wegmans)',
  traderjoes: 'var(--store-traderjoes)',
};

export const STORE_LABEL: Record<StoreId, string> = {
  foodlion: 'Food Lion',
  wegmans: 'Wegmans',
  traderjoes: "Trader Joe's",
};

/** Offers whose price is a plain number the shopper pays as shown. */
const NUMERIC_KINDS: PromoKind[] = ['none', 'sale', 'loyalty', 'percent_off', 'amount_off'];

export function isQuantified(price: PriceSnapshot): boolean {
  return price.effectiveUnitCents !== null;
}

export function PromoChip({ price, label }: { price: PriceSnapshot; label: string | null }): React.ReactElement | null {
  if (price.promoKind === 'none' || !label) return null;
  const plain = NUMERIC_KINDS.includes(price.promoKind);
  return (
    <span className={`chip${plain ? ' sale' : ''}`} title={label}>
      {label}
    </span>
  );
}

/**
 * The effective unit price is the hero. When a promotion moved it, the
 * pre-promotion price is struck beneath so the saving is visible without
 * arithmetic. An offer with no derivable number shows its words instead of a
 * figure, so it can never be mistaken for a price.
 */
export function PriceBlock({ price, flash }: { price: PriceSnapshot; flash?: boolean }): React.ReactElement {
  const effective = price.effectiveUnitCents;
  const before = price.regularCents ?? price.currentCents;
  const showWas = effective !== null && before !== null && before > effective;

  return (
    <div className="priceblock">
      {effective === null ? (
        <div className="hero nonnumeric">{price.promoText ?? 'See offer'}</div>
      ) : (
        <div className={`hero${flash ? ' flash' : ''}`}>{money(effective)}</div>
      )}
      {showWas && <div className="was">{money(before)}</div>}
      {price.unitPriceText && <div className="unit">{price.unitPriceText}</div>}
    </div>
  );
}

export function Delta({ from, to }: { from: number | null; to: number | null }): React.ReactElement | null {
  if (from === null || to === null || from === to) return null;
  const down = to < from;
  const pct = from === 0 ? null : Math.round(((to - from) / from) * 1000) / 10;
  return (
    <span className={`delta ${down ? 'down' : 'up'}`}>
      {down ? '▼' : '▲'} {money(Math.abs(to - from))}
      {pct !== null && ` (${Math.abs(pct)}%)`}
    </span>
  );
}

/** Trend shape only — deliberately unlabelled, per DESIGN.md. */
export function Sparkline({ points, color }: { points: number[]; color: string }): React.ReactElement | null {
  if (points.length < 2) return null;
  const w = 120;
  const h = 40;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = h - ((p - min) / span) * (h - 6) - 3;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img"
         aria-label={`Price trend, ${money(points[0]!)} to ${money(points.at(-1)!)}`}>
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** One toggle per chain the API reports, so a new chain needs no UI edit. */
export function StoreToggles({
  ids,
  selected,
  onToggle,
}: {
  ids: StoreId[];
  selected: StoreId[];
  onToggle: (id: StoreId) => void;
}): React.ReactElement {
  return (
    <>
      {ids.map((id) => (
        <button
          key={id}
          type="button"
          className="toggle"
          data-on={selected.includes(id)}
          style={{ color: selected.includes(id) ? STORE_COLOR[id] : 'var(--text-dim)' }}
          aria-pressed={selected.includes(id)}
          onClick={() => onToggle(id)}
        >
          <span className="swatch" />
          {STORE_LABEL[id] ?? id}
        </button>
      ))}
    </>
  );
}

/**
 * WAI-ARIA tabs keyboard model: arrows move (and activate) between tabs,
 * Home/End jump to the ends. Pair with tabIndex={selected ? 0 : -1} on each tab
 * and `${prefix}-tab-${id}` element ids.
 */
export function tabKeyHandler<T extends string>(ids: T[], current: T, select: (id: T) => void, prefix: string) {
  return (e: React.KeyboardEvent): void => {
    const i = ids.indexOf(current);
    let next: number;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (i + 1) % ids.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (i - 1 + ids.length) % ids.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = ids.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    const id = ids[next]!;
    select(id);
    document.getElementById(`${prefix}-tab-${id}`)?.focus();
  };
}

/** Shown while a first fetch is in flight, so loading never reads as empty. */
export function Loading({ what }: { what: string }): React.ReactElement {
  return (
    <div className="empty" role="status" aria-busy="true">
      Loading {what}…
    </div>
  );
}
