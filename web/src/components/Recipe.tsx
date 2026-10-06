import { useRef, useState } from 'react';
import type { ParsedIngredient, SearchResult, StoreId, StoreSelection, WatchGroup } from '../types';
import { api } from '../lib/api';
import { markWatched, ResultRow, watchResult } from './ResultRow';

interface Props {
  stores: StoreId[];
  selection: StoreSelection;
  groups: WatchGroup[];
  nationalPriceStores: Set<string>;
  onWatchlistChanged: () => void;
}

interface Line extends ParsedIngredient {
  /** index into `queries` of the query currently shown */
  qi: number;
  status: 'idle' | 'loading' | 'done' | 'error';
  results: SearchResult[];
  failure: string | null;
  /** a pantry line the shopper chose to search anyway */
  forced: boolean;
}

const CONCURRENCY = 2;
const PER_LINE = 5;

/**
 * Paste a recipe, get one search per ingredient. Pantry staples (salt, water…)
 * are listed dimmed and skipped; every other line runs its first query, and the
 * shopper can switch to an alternate wording if the first one misses.
 */
export function Recipe({ stores, selection, groups, nationalPriceStores, onWatchlistChanged }: Props) {
  const [text, setText] = useState('');
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [watchBusy, setWatchBusy] = useState(false);
  const [watchError, setWatchError] = useState<string | null>(null);
  const generation = useRef(0);

  const patch = (i: number, p: Partial<Line>) =>
    setLines((prev) => prev?.map((l, idx) => (idx === i ? { ...l, ...p } : l)) ?? null);

  async function search(gen: number, i: number, q: string) {
    patch(i, { status: 'loading', failure: null });
    try {
      const res = await api.search({ q, stores, locations: selection, limit: PER_LINE });
      if (gen !== generation.current) return;
      patch(i, {
        status: 'done',
        results: res.results,
        failure: res.errors.length ? res.errors.map((e) => `${e.storeId}: ${e.message}`).join('; ') : null,
      });
    } catch (e) {
      if (gen !== generation.current) return;
      patch(i, { status: 'error', results: [], failure: (e as Error).message });
    }
  }

  /** Runs the given lines with a small fixed concurrency. */
  async function runAll(gen: number, jobs: { i: number; q: string }[]) {
    const queue = [...jobs];
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        if (gen !== generation.current) return;
        await search(gen, job.i, job.q);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  }

  async function parse(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || stores.length === 0) return;
    const gen = ++generation.current;
    setParsing(true);
    setParseError(null);
    setLines(null);
    try {
      const { ingredients } = await api.parseRecipe(text);
      if (gen !== generation.current) return;
      setLines(
        ingredients.map((ing) => ({ ...ing, qi: 0, status: 'idle', results: [], failure: null, forced: false })),
      );
      setParsing(false);
      await runAll(
        gen,
        ingredients.flatMap((ing, i) => (!ing.pantry && ing.queries[0] ? [{ i, q: ing.queries[0] }] : [])),
      );
    } catch (err) {
      if (gen === generation.current) setParseError((err as Error).message);
    } finally {
      if (gen === generation.current) setParsing(false);
    }
  }

  function pick(i: number, line: Line, qi: number) {
    patch(i, { qi });
    void search(generation.current, i, line.queries[qi]!);
  }

  async function onWatch(r: SearchResult, target: number | 'new') {
    setWatchBusy(true);
    setWatchError(null);
    try {
      await watchResult(selection, r, target);
      onWatchlistChanged();
      setLines((prev) => prev?.map((l) => ({ ...l, results: markWatched(l.results, r) })) ?? null);
    } catch (err) {
      setWatchError((err as Error).message);
    } finally {
      setWatchBusy(false);
    }
  }

  return (
    <div className="recipe">
      <form onSubmit={parse} className="recipe-form">
        <textarea
          className="field"
          rows={6}
          placeholder={'Paste ingredients, one per line\n2 cups all-purpose flour\n1 lb boneless chicken thighs\nsalt'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Recipe ingredients"
        />
        <div>
          <button className="btn" disabled={parsing || !text.trim() || stores.length === 0}>
            {parsing ? 'Reading…' : 'Find ingredients'}
          </button>
        </div>
      </form>

      {parseError && <div className="error">{parseError}</div>}
      {watchError && <div className="error">{watchError}</div>}

      {lines && lines.length === 0 && <div className="empty">No ingredient lines found in that text.</div>}

      {lines?.map((line, i) => {
        const skipped = line.pantry && !line.forced;
        return (
          <section className="recipe-line" key={i} data-skipped={skipped} aria-busy={line.status === 'loading'}>
            <header>
              <span className="raw">{line.raw}</span>
              {skipped ? (
                <>
                  <span className="meta">pantry — skipped</span>
                  {line.queries[0] && (
                    <button
                      className="btn small ghost"
                      onClick={() => {
                        patch(i, { forced: true });
                        void search(generation.current, i, line.queries[0]!);
                      }}
                    >
                      Search anyway
                    </button>
                  )}
                </>
              ) : (
                <>
                  {line.queries.length > 1 && (
                    <span className="alts" role="group" aria-label={`Search wording for ${line.raw}`}>
                      {line.queries.map((q, qi) => (
                        <button
                          key={q}
                          type="button"
                          className="chip-toggle"
                          data-on={qi === line.qi}
                          aria-pressed={qi === line.qi}
                          disabled={line.status === 'loading'}
                          onClick={() => pick(i, line, qi)}
                        >
                          {q}
                        </button>
                      ))}
                    </span>
                  )}
                  {line.queries.length === 1 && <span className="meta">“{line.queries[0]}”</span>}
                  {line.status === 'loading' && <span className="meta" role="status">Searching…</span>}
                </>
              )}
            </header>
            {line.failure && <div className="error">{line.failure}</div>}
            {!skipped && line.status === 'done' && line.results.length === 0 && (
              <div className="meta">No matches{line.queries.length > 1 ? ' — try another wording' : ''}.</div>
            )}
            {!skipped && line.results.length > 0 && (
              <div className="rows">
                {line.results.map((r) => (
                  <ResultRow
                    key={`${r.storeId}:${r.offer.product.storeProductId}`}
                    r={r}
                    groups={groups}
                    nationalPriceStores={nationalPriceStores}
                    busy={watchBusy}
                    onWatch={(row, target) => void onWatch(row, target)}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
