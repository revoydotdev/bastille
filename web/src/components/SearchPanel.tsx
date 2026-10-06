import { lazy, Suspense, useState } from 'react';
import type { SearchResult, StoreId, StoreSelection, StoresResponse, WatchGroup } from '../types';
import { api } from '../lib/api';
import { STORE_LABEL, StoreToggles } from './bits';
import { markWatched, ResultRow, resultKey, watchResult } from './ResultRow';

// The recipe mode is only needed once someone pastes one.
const Recipe = lazy(() => import('./Recipe').then((m) => ({ default: m.Recipe })));

interface Props {
  storeData: StoresResponse | null;
  selection: StoreSelection;
  groups: WatchGroup[];
  onWatchlistChanged: () => void;
}

export function SearchPanel({ storeData, selection, groups, onWatchlistChanged }: Props) {
  const [mode, setMode] = useState<'search' | 'recipe'>('search');
  const [query, setQuery] = useState('');
  // null means "every chain the API reports", so a newly added chain starts on.
  const [picked, setPicked] = useState<StoreId[] | null>(null);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [errors, setErrors] = useState<{ storeId: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const storeIds = (storeData?.stores ?? []).map((s) => s.id);
  const selected = picked ?? storeIds;

  /** Chains whose price is the same everywhere — labelled so the store
   *  choice is never read as having set the price. */
  const nationalPriceStores = new Set(
    (storeData?.stores ?? []).filter((s) => !s.pricesVaryByLocation).map((s) => s.id),
  );

  const toggle = (id: StoreId) =>
    setPicked(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim() || selected.length === 0) return;
    setBusy(true);
    setFailure(null);
    try {
      const res = await api.search({ q: query.trim(), stores: selected, locations: selection, limit: 20 });
      setResults(res.results);
      setErrors(res.errors);
    } catch (err) {
      setFailure((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function watch(r: SearchResult, target: number | 'new') {
    setBusy(true);
    setFailure(null);
    try {
      await watchResult(selection, r, target);
      onWatchlistChanged();
      setResults((prev) => (prev ? markWatched(prev, r) : null));
    } catch (err) {
      setFailure((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const storeNames = storeIds.map((id) => STORE_LABEL[id] ?? id);
  const storeList =
    storeNames.length > 1 ? `${storeNames.slice(0, -1).join(', ')} or ${storeNames.at(-1)}` : (storeNames[0] ?? 'any store');

  return (
    <section>
      <div className="controls" role="group" aria-label="Search mode">
        <button className="chip-toggle" data-on={mode === 'search'} aria-pressed={mode === 'search'} onClick={() => setMode('search')}>
          Search
        </button>
        <button className="chip-toggle" data-on={mode === 'recipe'} aria-pressed={mode === 'recipe'} onClick={() => setMode('recipe')}>
          Paste a recipe
        </button>
      </div>

      {mode === 'search' ? (
        <form className="controls" onSubmit={run}>
          <input
            className="field"
            placeholder="Search groceries — e.g. whole milk, bagels, olive oil"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search groceries"
          />
          <StoreToggles ids={storeIds} selected={selected} onToggle={toggle} />
          <button className="btn" disabled={busy || !query.trim() || selected.length === 0}>
            {busy ? 'Searching…' : 'Search'}
          </button>
        </form>
      ) : (
        <div className="controls">
          <span className="meta">Search in</span>
          <StoreToggles ids={storeIds} selected={selected} onToggle={toggle} />
        </div>
      )}

      {mode === 'recipe' ? (
        <Suspense fallback={<div className="meta">Loading…</div>}>
          <Recipe
            stores={selected}
            selection={selection}
            groups={groups}
            nationalPriceStores={nationalPriceStores}
            onWatchlistChanged={onWatchlistChanged}
          />
        </Suspense>
      ) : (
        <>
          {failure && <div className="error">{failure}</div>}
          {errors.map((e) => (
            <div className="error" key={e.storeId}>
              {STORE_LABEL[e.storeId as StoreId] ?? e.storeId} search failed: {e.message}
            </div>
          ))}

          {results === null ? (
            <div className="empty">
              Search {storeList}. Results are ranked by the price you actually pay — an offer like
              “2 for $13” is converted to its per-item price so it lines up against a plain shelf price.
            </div>
          ) : results.length === 0 ? (
            <div className="empty">No matches for “{query}”.</div>
          ) : (
            <div className="rows">
              {results.map((r) => (
                <ResultRow
                  key={resultKey(r)}
                  r={r}
                  groups={groups}
                  nationalPriceStores={nationalPriceStores}
                  busy={busy}
                  onWatch={(row, target) => void watch(row, target)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
