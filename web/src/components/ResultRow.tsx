import { useState } from 'react';
import type { SearchResult, StoreSelection, WatchGroup } from '../types';
import { api } from '../lib/api';
import { PriceBlock, PromoChip, STORE_COLOR } from './bits';

export const resultKey = (r: SearchResult) => `${r.storeId}:${r.offer.product.storeProductId}`;

/** Adds a result to a new or existing watch group. */
export function watchResult(selection: StoreSelection, r: SearchResult, target: number | 'new') {
  return api.watch({
    storeId: r.storeId,
    storeProductId: r.offer.product.storeProductId,
    locationId: selection[r.storeId],
    ...(target === 'new' ? { label: r.offer.product.name } : { groupId: target }),
  });
}

/** Marks a result as watched without making the user re-search. */
export function markWatched(rows: SearchResult[], r: SearchResult): SearchResult[] {
  return rows.map((row) =>
    resultKey(row) === resultKey(r) ? { ...row, watchedGroupIds: [...row.watchedGroupIds, -1] } : row,
  );
}

interface Props {
  r: SearchResult;
  groups: WatchGroup[];
  nationalPriceStores: Set<string>;
  busy: boolean;
  onWatch: (r: SearchResult, target: number | 'new') => void;
}

export function ResultRow({ r, groups, nationalPriceStores, busy, onWatch }: Props) {
  const [target, setTarget] = useState<number | 'new'>('new');
  const watched = r.watchedGroupIds.length > 0;
  return (
    <article className="row">
      <span className="accent" style={{ background: STORE_COLOR[r.storeId] }} aria-hidden />
      {r.offer.product.imageUrl ? (
        <img src={r.offer.product.imageUrl} alt="" loading="lazy" />
      ) : (
        <span className="noimg" aria-hidden />
      )}
      <div>
        <div className="name">
          {r.offer.product.productUrl ? (
            <a href={r.offer.product.productUrl} target="_blank" rel="noreferrer noopener" style={{ color: 'inherit' }}>
              {r.offer.product.name}
            </a>
          ) : (
            r.offer.product.name
          )}
        </div>
        <div className="meta chipcell">
          <span className="store" style={{ color: STORE_COLOR[r.storeId] }}>{r.storeLabel}</span>
          {nationalPriceStores.has(r.storeId) && (
            <span title="This chain publishes one online catalogue price chain-wide">national price</span>
          )}
          {r.offer.product.size && <span>{r.offer.product.size}</span>}
          {r.discountPct !== null && r.discountPct >= 5 && (
            <span className="deal-badge sm" title="percent off regular unit price">{Math.round(r.discountPct)}% off</span>
          )}
          <PromoChip price={r.offer.price} label={r.promoLabel} />
          {r.offer.price.inStock === false && <span className="chip oos">Out of stock</span>}
        </div>
      </div>
      <PriceBlock price={r.offer.price} />
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {groups.length > 0 && (
          <select
            className="field"
            style={{ padding: '4px 8px', fontSize: '0.8rem' }}
            aria-label="Add to which watchlist"
            value={String(target)}
            onChange={(e) => setTarget(e.target.value === 'new' ? 'new' : Number(e.target.value))}
          >
            <option value="new">New watch</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                Compare in “{g.label}”
              </option>
            ))}
          </select>
        )}
        <button className="btn small ghost" disabled={busy} onClick={() => onWatch(r, target)}>
          {watched ? 'Watching ✓' : 'Watch'}
        </button>
      </div>
    </article>
  );
}
