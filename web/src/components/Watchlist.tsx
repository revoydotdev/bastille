import { useEffect, useState } from 'react';
import type { PriceSnapshot, WatchGroup } from '../types';
import { api, money, relativeTime } from '../lib/api';
import { Delta, PromoChip, Sparkline, STORE_COLOR, STORE_LABEL } from './bits';

interface Props {
  groups: WatchGroup[];
  onChanged: () => void;
}

function promoLabelOf(price: PriceSnapshot | null): string | null {
  if (!price || price.promoKind === 'none') return null;
  if (price.promoText) return price.promoText;
  const d = price.promoDetail;
  switch (price.promoKind) {
    case 'bogo': return `Buy ${d?.buyQty ?? 1} get ${d?.getQty ?? 1} free`;
    case 'bxgy': return `Buy ${d?.buyQty ?? 1} get ${d?.getQty ?? 1}`;
    case 'multibuy': return `${d?.buyQty} for ${money(d?.bundleCents ?? null)}`;
    case 'percent_off': return `${d?.percentOff}% off`;
    case 'amount_off': return `${money(d?.amountOffCents ?? null)} off`;
    default: return price.promoKind;
  }
}

function GroupCard({ group, onChanged }: { group: WatchGroup; onChanged: () => void }) {
  const [history, setHistory] = useState<Record<number, number[]>>({});
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(group.label);
  const [target, setTarget] = useState(group.targetCents === null ? '' : (group.targetCents / 100).toFixed(2));

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      group.items.map(async (item) => {
        const res = await api.history(item.product.id, item.locationId);
        return [
          item.product.id,
          res.history.map((h) => h.effectiveUnitCents).filter((c): c is number => c !== null),
        ] as const;
      }),
    ).then((entries) => {
      if (!cancelled) setHistory(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [group]);

  async function save() {
    const cents = target.trim() === '' ? null : Math.round(Number(target) * 100);
    await api.updateGroup(group.id, { label: label.trim() || group.label, targetCents: Number.isFinite(cents!) ? cents : null });
    setEditing(false);
    onChanged();
  }

  const targetHit = group.targetCents !== null && group.bestCents !== null && group.bestCents <= group.targetCents;

  return (
    <article className="card">
      <header>
        {editing ? (
          <>
            <input className="field" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Watch name" />
            <input
              className="field"
              style={{ width: 130 }}
              placeholder="Target $"
              inputMode="decimal"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              aria-label="Target price in dollars"
            />
            <button className="btn small" onClick={() => void save()}>Save</button>
            <button className="btn small ghost" onClick={() => setEditing(false)}>Cancel</button>
          </>
        ) : (
          <>
            <h3>{group.label}</h3>
            {group.targetCents !== null && (
              <span className="meta" style={{ color: targetHit ? 'var(--drop)' : 'var(--text-dim)', fontSize: '0.78rem' }}>
                target {money(group.targetCents)} {targetHit ? '— met' : ''}
              </span>
            )}
            <label className="meta" style={{ fontSize: '0.78rem', display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={group.notifyPromos}
                onChange={(e) => void api.updateGroup(group.id, { notifyPromos: e.target.checked }).then(onChanged)}
              />
              Alert on offers
            </label>
            <span className="spacer" />
            <button className="btn small ghost" onClick={() => setEditing(true)}>Edit</button>
            <button className="btn small ghost" onClick={() => void api.deleteGroup(group.id).then(onChanged)}>
              Remove
            </button>
          </>
        )}
      </header>

      <div className="compare-scroll">
      <table className="compare">
        <thead>
          <tr>
            <th>Store</th>
            <th>Item</th>
            <th>Offer</th>
            <th className="num">You pay</th>
            <th className="num">Since last check</th>
            <th>Trend</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {group.items.map((item) => {
            const price = item.price;
            const isBest = price?.effectiveUnitCents != null && price.effectiveUnitCents === group.bestCents;
            const gap =
              price?.effectiveUnitCents != null && group.bestCents !== null && !isBest
                ? price.effectiveUnitCents - group.bestCents
                : null;
            return (
              <tr key={item.watchItemId}>
                <td data-label="Store" style={{ color: STORE_COLOR[item.product.storeId], fontWeight: 600, whiteSpace: 'nowrap' }}>
                  {STORE_LABEL[item.product.storeId]}
                </td>
                <td data-label="Item">
                  {item.product.productUrl ? (
                    <a href={item.product.productUrl} target="_blank" rel="noreferrer noopener" style={{ color: 'inherit' }}>
                      {item.product.name}
                    </a>
                  ) : (
                    item.product.name
                  )}
                  {item.product.size && <span className="meta"> · {item.product.size}</span>}
                </td>
                <td data-label="Offer">{price && <PromoChip price={price} label={promoLabelOf(price)} />}</td>
                <td data-label="You pay" className={`num${isBest ? ' best' : ''}`}>
                  {price?.effectiveUnitCents == null ? (
                    <span style={{ color: 'var(--promo)' }}>{price?.promoText ?? '—'}</span>
                  ) : (
                    <>
                      {money(price.effectiveUnitCents)} {isBest && <span className="badge-best">best</span>}
                      {gap !== null && <div className="gap">+{money(gap)}</div>}
                    </>
                  )}
                </td>
                <td data-label="Since last check" className="num">
                  <Delta
                    from={item.previousPrice?.effectiveUnitCents ?? null}
                    to={price?.effectiveUnitCents ?? null}
                  />
                </td>
                <td data-label="Trend" className="trendcell">
                  <Sparkline points={history[item.product.id] ?? []} color={STORE_COLOR[item.product.storeId]} />
                </td>
                <td className="rmcell">
                  <button
                    className="btn small ghost"
                    aria-label={`Stop watching at ${STORE_LABEL[item.product.storeId]}`}
                    onClick={() => void api.removeItem(item.watchItemId).then(onChanged)}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      {group.items[0]?.price && (
        <div className="meta" style={{ marginTop: 8 }}>Last read {relativeTime(group.items[0].price.capturedAt)}</div>
      )}
    </article>
  );
}

export function Watchlist({ groups, onChanged }: Props) {
  if (groups.length === 0) {
    return (
      <div className="empty">
        Nothing watched yet. Search for an item and add it — add the same item from both stores to one watch
        and they will be compared side by side.
      </div>
    );
  }
  return (
    <section>
      {groups.map((g) => (
        <GroupCard key={g.id} group={g} onChanged={onChanged} />
      ))}
    </section>
  );
}
