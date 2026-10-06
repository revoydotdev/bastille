import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DealFilters, DealRow, DealsResponse, PromoKind, StoreId, StoreSelection } from '../types';
import { api, money, relativeTime } from '../lib/api';
import { STORE_COLOR, STORE_LABEL, StoreToggles } from './bits';

/** Promo kinds worth an explicit toggle. 'sale' covers plain markdowns. */
const PROMO_TOGGLES: { kind: PromoKind; label: string }[] = [
  { kind: 'bogo', label: 'BOGO' },
  { kind: 'multibuy', label: 'Multibuy' },
  { kind: 'sale', label: 'Markdown' },
  { kind: 'amount_off', label: '$ off' },
  { kind: 'percent_off', label: '% off' },
  { kind: 'coupon', label: 'Coupon' },
];

const DISCOUNT_STEPS = [0, 10, 25, 50, 70, 90];

interface Props {
  /** chains the API reports; drives the store toggles */
  storeIds: StoreId[];
  selection: StoreSelection;
  lastSnapshot: { date: string; rows: number } | null;
  onRunSnapshot: () => void;
  snapshotRunning: boolean;
}

const DealRowView = memo(function DealRowView({ row }: { row: DealRow }) {
  const numeric = row.effectiveUnitCents !== null;
  return (
    <article className="row">
      <span className="accent" style={{ background: STORE_COLOR[row.storeId] }} aria-hidden />
      {row.imageUrl ? <img src={row.imageUrl} alt="" loading="lazy" /> : <span className="noimg" aria-hidden />}
      <div>
        <div className="name">
          {row.productUrl ? (
            <a href={row.productUrl} target="_blank" rel="noreferrer noopener" style={{ color: 'inherit' }}>
              {row.name}
            </a>
          ) : (
            row.name
          )}
        </div>
        <div className="meta chipcell">
          <span className="store" style={{ color: STORE_COLOR[row.storeId] }}>{STORE_LABEL[row.storeId]}</span>
          {row.size && <span>{row.size}</span>}
          {row.promoText && <span className="chip" title={row.promoText}>{row.promoText}</span>}
          {row.inStock === false && <span className="chip oos">Out of stock</span>}
        </div>
      </div>
      {row.discountPct !== null && row.discountPct > 0 && (
        <span className="deal-badge" title="percent off regular unit price">
          {Math.round(row.discountPct)}% off
        </span>
      )}
      <div className="priceblock">
        {numeric ? <div className="hero">{money(row.effectiveUnitCents)}</div> : <div className="hero nonnumeric">{row.promoText ?? 'See offer'}</div>}
        {row.regularCents !== null && numeric && row.regularCents > row.effectiveUnitCents! && (
          <div className="was">{money(row.regularCents)}</div>
        )}
        {row.unitPriceText && <div className="unit">{row.unitPriceText}</div>}
      </div>
    </article>
  );
});

export function Deals({ storeIds, selection, lastSnapshot, onRunSnapshot, snapshotRunning }: Props) {
  const [filters, setFilters] = useState<DealFilters>({
    minDiscount: 50,
    promoKinds: [],
    onSale: true,
    stores: [],
    sort: 'discount',
  });
  // null = every chain the API reports, so a chain added later starts enabled.
  const [pickedStores, setPickedStores] = useState<StoreId[] | null>(null);
  const [dates, setDates] = useState<string[]>([]);
  // '' = latest snapshot (or a live scan when there is none).
  const [date, setDate] = useState('');
  const stores = pickedStores ?? storeIds;
  const [data, setData] = useState<DealsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  const load = useCallback(
    async (f: DealFilters, forDate: string) => {
      const id = ++reqId.current;
      setBusy(true);
      setError(null);
      try {
        const res = await api.deals({
          ...f,
          locations: selection,
          date: forDate || null,
          limit: 200,
        });
        if (id === reqId.current) setData(res);
      } catch (e) {
        if (id === reqId.current) setError((e as Error).message);
      } finally {
        if (id === reqId.current) setBusy(false);
      }
    },
    [selection],
  );

  // Debounce filter changes so dragging the slider does not spam the server.
  useEffect(() => {
    if (stores.length === 0) return; // wait for the store list
    const t = setTimeout(() => void load({ ...filters, stores }, date), 250);
    return () => clearTimeout(t);
    // `stores` is rebuilt each render; its contents are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, load, date, stores.join(',')]);

  useEffect(() => {
    void api.snapshotStatus().then((st) => setDates(st.dates)).catch(() => undefined);
  }, [lastSnapshot]);

  const toggleStore = (id: StoreId) =>
    setPickedStores(stores.includes(id) ? stores.filter((s) => s !== id) : [...stores, id]);

  const togglePromo = (kind: PromoKind) =>
    setFilters((f) => ({
      ...f,
      promoKinds: f.promoKinds.includes(kind) ? f.promoKinds.filter((k) => k !== kind) : [...f.promoKinds, kind],
    }));

  const summary = useMemo(() => {
    if (!data) return '';
    const scope =
      data.source === 'snapshot'
        ? `from the ${data.date} snapshot`
        : 'from a live scan (no snapshot yet — run one for faster, historical deals)';
    return `${data.total.toLocaleString()} matching · showing ${data.rows.length} ${scope}`;
  }, [data]);

  return (
    <section>
      <div className="deal-controls">
        <div className="deal-row">
          <span className="deal-label">At least</span>
          <div className="deal-steps" role="group" aria-label="Minimum discount">
            {DISCOUNT_STEPS.map((step) => (
              <button
                key={step}
                className="chip-toggle"
                data-on={filters.minDiscount === step}
                onClick={() => setFilters((f) => ({ ...f, minDiscount: step, onSale: step > 0 ? true : f.onSale }))}
              >
                {step === 0 ? 'any' : `${step}%`}
              </button>
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={95}
            step={5}
            value={filters.minDiscount}
            onChange={(e) => setFilters((f) => ({ ...f, minDiscount: Number(e.target.value) }))}
            aria-label="Minimum percent off"
          />
          <span className="deal-value">{filters.minDiscount > 0 ? `${filters.minDiscount}% off+` : 'any'}</span>
        </div>

        <div className="deal-row">
          <span className="deal-label">Offer type</span>
          {PROMO_TOGGLES.map(({ kind, label }) => (
            <button key={kind} className="chip-toggle promo" data-on={filters.promoKinds.includes(kind)} onClick={() => togglePromo(kind)}>
              {label}
            </button>
          ))}
          <label className="deal-check">
            <input type="checkbox" checked={filters.onSale} onChange={(e) => setFilters((f) => ({ ...f, onSale: e.target.checked }))} />
            on sale only
          </label>
        </div>

        <div className="deal-row">
          <StoreToggles ids={storeIds} selected={stores} onToggle={toggleStore} />
          <select className="field" value={filters.sort} onChange={(e) => setFilters((f) => ({ ...f, sort: e.target.value as DealFilters['sort'] }))} aria-label="Sort deals">
            <option value="discount">Biggest % off</option>
            <option value="price">Cheapest unit</option>
            <option value="name">Name</option>
          </select>
          {dates.length > 0 && (
            <select className="field" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Snapshot date">
              <option value="">Latest snapshot</option>
              {dates.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          )}
          <span className="spacer" style={{ flex: 1 }} />
          <button className="btn small ghost" onClick={onRunSnapshot} disabled={snapshotRunning} title="Snapshot every catalogue now for analysis + faster deals">
            {snapshotRunning ? 'Snapshotting…' : 'Snapshot now'}
          </button>
        </div>
      </div>

      {lastSnapshot && (
        <p className="meta" style={{ margin: '0 0 12px' }}>
          Last daily snapshot: {lastSnapshot.rows.toLocaleString()} products on {lastSnapshot.date}
        </p>
      )}
      {error && <div className="error">{error}</div>}
      <p className="meta" style={{ margin: '0 0 12px' }}>{busy ? 'Loading…' : summary}</p>

      {data && data.rows.length === 0 && !busy ? (
        <div className="empty">Nothing matches these filters right now. Loosen the discount or add a store.</div>
      ) : (
        <div className="rows">
          {(data?.rows ?? []).map((row) => (
            <DealRowView key={`${row.storeId}:${row.storeProductId}`} row={row} />
          ))}
        </div>
      )}
    </section>
  );
}
