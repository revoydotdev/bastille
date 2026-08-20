import { useState } from 'react';
import type { SearchResult, StoreId, StoreInfo, WatchGroup } from '../types';
import { api } from '../lib/api';
import { PriceBlock, PromoChip, STORE_COLOR, STORE_LABEL } from './bits';

interface Props {
  stores: StoreInfo[];
  groups: WatchGroup[];
  wegmansStore: string;
  onWegmansStoreChange: (id: string) => void;
  onWatchlistChanged: () => void;
}

export function SearchPanel({ stores, groups, wegmansStore, onWegmansStoreChange, onWatchlistChanged }: Props) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<StoreId[]>(['foodlion', 'wegmans']);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [errors, setErrors] = useState<{ storeId: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [addTarget, setAddTarget] = useState<Record<string, number | 'new'>>({});

  const toggle = (id: StoreId) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim() || selected.length === 0) return;
    setBusy(true);
    setFailure(null);
    try {
      const res = await api.search({ q: query.trim(), stores: selected, wegmansLocation: wegmansStore, limit: 20 });
      setResults(res.results);
      setErrors(res.errors);
    } catch (err) {
      setFailure((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function watch(r: SearchResult) {
    const key = `${r.storeId}:${r.offer.product.storeProductId}`;
    const target = addTarget[key] ?? 'new';
    setBusy(true);
    setFailure(null);
    try {
      await api.watch({
        storeId: r.storeId,
        storeProductId: r.offer.product.storeProductId,
        locationId: r.storeId === 'wegmans' ? wegmansStore : null,
        ...(target === 'new' ? { label: r.offer.product.name } : { groupId: target }),
      });
      onWatchlistChanged();
      // Reflect membership immediately rather than making the user re-search.
      setResults((prev) =>
        prev?.map((row) =>
          row.storeId === r.storeId && row.offer.product.storeProductId === r.offer.product.storeProductId
            ? { ...row, watchedGroupIds: [...row.watchedGroupIds, -1] }
            : row,
        ) ?? null,
      );
    } catch (err) {
      setFailure((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const wegmans = stores.find((s) => s.id === 'wegmans');

  return (
    <section>
      <form className="controls" onSubmit={run}>
        <input
          className="field"
          placeholder="Search groceries — e.g. whole milk, bagels, olive oil"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search groceries"
        />
        {(['foodlion', 'wegmans'] as StoreId[]).map((id) => (
          <button
            key={id}
            type="button"
            className="toggle"
            data-on={selected.includes(id)}
            style={{ color: selected.includes(id) ? STORE_COLOR[id] : 'var(--text-dim)' }}
            aria-pressed={selected.includes(id)}
            onClick={() => toggle(id)}
          >
            <span className="swatch" />
            {STORE_LABEL[id]}
          </button>
        ))}
        <button className="btn" disabled={busy || !query.trim() || selected.length === 0}>
          {busy ? 'Searching…' : 'Search'}
        </button>
      </form>

      {wegmans && wegmans.locations.length > 0 && selected.includes('wegmans') && (
        <div className="controls">
          <label className="meta" htmlFor="weg-store" style={{ color: 'var(--text-dim)', fontSize: '0.78rem' }}>
            Wegmans prices for
          </label>
          <select
            id="weg-store"
            className="field"
            value={wegmansStore}
            onChange={(e) => onWegmansStoreChange(e.target.value)}
          >
            {wegmans.locations.map((l) => (
              <option key={l.locationId} value={l.locationId}>
                {l.name}
                {l.address ? ` — ${l.address}` : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {failure && <div className="error">{failure}</div>}
      {errors.map((e) => (
        <div className="error" key={e.storeId}>
          {STORE_LABEL[e.storeId as StoreId] ?? e.storeId} search failed: {e.message}
        </div>
      ))}

      {results === null ? (
        <div className="empty">
          Search either store or both. Results are ranked by the price you actually pay — an offer like
          “2 for $13” is converted to its per-item price so it lines up against a plain shelf price.
        </div>
      ) : results.length === 0 ? (
        <div className="empty">No matches for “{query}”.</div>
      ) : (
        <div className="rows">
          {results.map((r) => {
            const key = `${r.storeId}:${r.offer.product.storeProductId}`;
            const watched = r.watchedGroupIds.length > 0;
            return (
              <article className="row" key={key}>
                <span className="accent" style={{ background: STORE_COLOR[r.storeId] }} aria-hidden />
                {r.offer.product.imageUrl ? (
                  <img src={r.offer.product.imageUrl} alt="" loading="lazy" />
                ) : (
                  <span className="noimg" aria-hidden />
                )}
                <div>
                  <div className="name">
                    {r.offer.product.productUrl ? (
                      <a href={r.offer.product.productUrl} target="_blank" rel="noreferrer noopener"
                         style={{ color: 'inherit' }}>
                        {r.offer.product.name}
                      </a>
                    ) : (
                      r.offer.product.name
                    )}
                  </div>
                  <div className="meta chipcell">
                    <span className="store" style={{ color: STORE_COLOR[r.storeId] }}>{r.storeLabel}</span>
                    {r.offer.product.size && <span>{r.offer.product.size}</span>}
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
                      value={String(addTarget[key] ?? 'new')}
                      onChange={(e) =>
                        setAddTarget((prev) => ({
                          ...prev,
                          [key]: e.target.value === 'new' ? 'new' : Number(e.target.value),
                        }))
                      }
                    >
                      <option value="new">New watch</option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id}>
                          Compare in “{g.label}”
                        </option>
                      ))}
                    </select>
                  )}
                  <button className="btn small ghost" disabled={busy} onClick={() => void watch(r)}>
                    {watched ? 'Watching ✓' : 'Watch'}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
