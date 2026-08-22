import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ClearanceGroup,
  ClearanceGroupOption,
  ClearanceFilters,
  SweepProgress,
  ClearanceRow,
  ClearanceStore,
  ClearanceWatch,
  SweepRun,
} from '../types';
import { api, money, relativeTime } from '../lib/api';

/**
 * Walmart in-store clearance, across several nearby stores at once.
 *
 * The premise is that clearance is local: the same chain marks different things
 * down in different stores, and the useful answer is "which store, and which
 * aisle". So the store is a first-class column, not a setting, and the aisle
 * travels with every row.
 */

const DEFAULT_FILTERS: ClearanceFilters = {
  stores: [],
  groups: [],
  q: '',
  minDiscount: 0,
  maxPrice: null,
  maxDistance: null,
  newOnly: false,
  sort: 'discount',
};

const PAGE_SIZE = 60;

function loadFilters(): ClearanceFilters {
  const saved = localStorage.getItem('bastille.clearance.filters');
  if (!saved) return DEFAULT_FILTERS;
  try {
    return { ...DEFAULT_FILTERS, ...(JSON.parse(saved) as Partial<ClearanceFilters>) };
  } catch {
    return DEFAULT_FILTERS;
  }
}

export function Clearance() {
  const [filters, setFilters] = useState<ClearanceFilters>(loadFilters);
  const [rows, setRows] = useState<ClearanceRow[]>([]);
  const [total, setTotal] = useState(0);
  const [date, setDate] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [stores, setStores] = useState<ClearanceStore[]>([]);
  const [groups, setGroups] = useState<ClearanceGroupOption[]>([]);
  const [watches, setWatches] = useState<ClearanceWatch[]>([]);
  const [lastSweep, setLastSweep] = useState<SweepRun | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [progress, setProgress] = useState<SweepProgress | null>(null);

  const [zip, setZip] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [showStores, setShowStores] = useState(false);
  const [newTerm, setNewTerm] = useState('');

  useEffect(() => {
    localStorage.setItem('bastille.clearance.filters', JSON.stringify(filters));
  }, [filters]);

  const loadSetup = useCallback(async () => {
    const [s, c, w] = await Promise.all([
      api.clearanceStores(),
      api.clearanceCategories(),
      api.clearanceWatches(),
    ]);
    setStores(s.stores);
    setLastSweep(s.lastSweep);
    setSweeping(s.sweeping);
    setProgress(s.progress);
    setGroups(c.groups);
    setWatches(w.watches);
    // Nothing to sweep yet: open the store panel rather than showing an empty
    // feed with no explanation of why it is empty.
    if (s.stores.length === 0) setShowStores(true);
  }, []);

  const loadRows = useCallback(
    async (nextOffset: number) => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.clearance({ ...filters, limit: PAGE_SIZE, offset: nextOffset });
        setDate(res.date);
        setTotal(res.total);
        setRows((prev) => (nextOffset === 0 ? res.rows : [...prev, ...res.rows]));
        setOffset(nextOffset);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [filters],
  );

  useEffect(() => {
    void loadSetup().catch((e) => setError((e as Error).message));
  }, [loadSetup]);

  useEffect(() => {
    void loadRows(0);
  }, [loadRows]);

  // While a sweep is in flight, follow it. The interval is slack on purpose:
  // the run itself is paced in tens of seconds, so polling faster would only
  // show the same answer again.
  useEffect(() => {
    if (!sweeping) return;
    const tick = async () => {
      const st = await api.clearanceStatus();
      setProgress(st.progress);
      if (!st.sweeping) {
        setSweeping(false);
        setLastSweep(st.lastSweep);
        await loadRows(0);
      }
    };
    const id = setInterval(() => void tick().catch(() => undefined), 10_000);
    return () => clearInterval(id);
  }, [sweeping, loadRows]);

  const enabledCount = useMemo(() => stores.filter((s) => s.enabled).length, [stores]);

  async function discover() {
    if (!zip.trim()) return;
    setDiscovering(true);
    setError(null);
    try {
      const res = await api.discoverClearanceStores(zip.trim());
      setStores(res.stores);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDiscovering(false);
    }
  }

  async function toggleStore(store: ClearanceStore) {
    const next = !store.enabled;
    setStores((prev) => prev.map((s) => (s.locationId === store.locationId ? { ...s, enabled: next } : s)));
    try {
      await api.setClearanceStore(store.locationId, next);
    } catch (e) {
      setStores((prev) => prev.map((s) => (s.locationId === store.locationId ? { ...s, enabled: !next } : s)));
      setError((e as Error).message);
    }
  }

  /**
   * A full sweep runs for the better part of an hour, so the request only
   * starts it; where it has got to comes from polling.
   */
  async function sweepNow() {
    setError(null);
    try {
      await api.startSweep();
      setSweeping(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function addWatch() {
    const term = newTerm.trim();
    if (!term) return;
    try {
      await api.addClearanceWatch({ term });
      setNewTerm('');
      setWatches((await api.clearanceWatches()).watches);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function removeWatch(id: number) {
    try {
      await api.removeClearanceWatch(id);
      setWatches((prev) => prev.filter((w) => w.id !== id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const toggleGroup = (id: ClearanceGroup) =>
    setFilters((f) => ({
      ...f,
      groups: f.groups.includes(id) ? f.groups.filter((g) => g !== id) : [...f.groups, id],
    }));

  const toggleStoreFilter = (locationId: string) =>
    setFilters((f) => ({
      ...f,
      stores: f.stores.includes(locationId)
        ? f.stores.filter((s) => s !== locationId)
        : [...f.stores, locationId],
    }));

  return (
    <section className="clearance">
      <header className="clearance-head">
        <div>
          <h2 className="section-heading">Walmart in-store clearance</h2>
          <p className="meta">
            {date ? `latest sweep ${date}` : 'never swept'} · {enabledCount} of {stores.length} stores enabled
            {enabledCount > 0 && `, ${stores.filter((s) => s.enabled && s.lastSweptAt).length} read at least once`}
            {lastSweep?.finishedAt && ` · last run ${relativeTime(lastSweep.finishedAt)}`}
            {lastSweep?.error && ' · last run reported problems'}
          </p>
        </div>
        <span className="spacer" />
        <button className="btn small ghost" onClick={() => setShowStores((v) => !v)}>
          {showStores ? 'Hide stores' : 'Stores'}
        </button>
        <button className="btn small" onClick={() => void sweepNow()} disabled={sweeping || enabledCount === 0}>
          {sweeping ? 'Sweeping…' : 'Sweep now'}
        </button>
      </header>

      {sweeping && progress && (
        <p className="meta sweep-progress" role="status">
          Store {Math.min(progress.storesDone + 1, progress.storesTotal)} of {progress.storesTotal}
          {progress.currentStore && ` — ${progress.currentStore}`}
          {progress.currentCategory && ` · ${progress.currentCategory}`}
          {' · '}
          {progress.finds} recorded
          {progress.rateLimited > 0 && ` · backed off ${progress.rateLimited}×`}
        </p>
      )}

      {error && <div className="error">{error}</div>}

      {showStores && (
        <div className="card store-panel">
          <div className="zip-row">
            <label htmlFor="clearance-zip">Find Walmarts near</label>
            <input
              id="clearance-zip"
              className="input"
              value={zip}
              onChange={(e) => setZip(e.target.value)}
              placeholder="ZIP code"
              inputMode="numeric"
            />
            <button className="btn small" onClick={() => void discover()} disabled={discovering || !zip.trim()}>
              {discovering ? 'Looking…' : 'Find stores'}
            </button>
          </div>
          <p className="meta">
            Newly found stores start switched off. Walmart stops answering after roughly twenty
            reads however far apart they are spaced, so one run covers only the few stores whose
            racks are stalest — enable as many as you like and they come round over several nights.
            Each row says when its rack was last actually read.
          </p>
          <ul className="store-list">
            {stores.map((s) => (
              <li key={s.locationId}>
                <label className="check">
                  <input type="checkbox" checked={s.enabled} onChange={() => void toggleStore(s)} />
                  <span className="store-name">{s.name}</span>
                  <span className="meta">
                    {s.city}, {s.state}
                    {s.distanceMiles != null && ` · ${s.distanceMiles.toFixed(1)} mi`}
                    {' · '}
                    {s.lastSweptAt ? `swept ${relativeTime(s.lastSweptAt)}` : 'never swept'}
                  </span>
                </label>
              </li>
            ))}
            {stores.length === 0 && <li className="meta">No stores yet — search a ZIP above.</li>}
          </ul>
        </div>
      )}

      <div className="card watch-panel">
        <h3 className="section-heading">Tell me when these turn up</h3>
        <div className="zip-row">
          <input
            className="input"
            value={newTerm}
            onChange={(e) => setNewTerm(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void addWatch()}
            placeholder="e.g. rtx, nvme, ryzen"
            aria-label="Term to watch for on clearance"
          />
          <button className="btn small" onClick={() => void addWatch()} disabled={!newTerm.trim()}>
            Add
          </button>
        </div>
        <ul className="chip-list">
          {watches.map((w) => (
            <li key={w.id}>
              <span className="chip">
                {w.term}
                <button className="chip-x" onClick={() => void removeWatch(w.id)} aria-label={`Stop watching ${w.term}`}>
                  ×
                </button>
              </span>
            </li>
          ))}
          {watches.length === 0 && <li className="meta">Nothing watched yet.</li>}
        </ul>
      </div>

      <div className="filters">
        <input
          className="input"
          value={filters.q}
          onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
          placeholder="Filter by name — e.g. ssd"
          aria-label="Filter clearance by name"
        />
        <label className="check">
          <input
            type="checkbox"
            checked={filters.newOnly}
            onChange={(e) => setFilters((f) => ({ ...f, newOnly: e.target.checked }))}
          />
          New today
        </label>
        <label>
          Min % off
          <input
            className="input narrow"
            type="number"
            min={0}
            max={99}
            value={filters.minDiscount || ''}
            onChange={(e) => setFilters((f) => ({ ...f, minDiscount: Number(e.target.value) || 0 }))}
          />
        </label>
        <label>
          Max $
          <input
            className="input narrow"
            type="number"
            min={0}
            value={filters.maxPrice ?? ''}
            onChange={(e) =>
              setFilters((f) => ({ ...f, maxPrice: e.target.value === '' ? null : Number(e.target.value) }))
            }
          />
        </label>
        <label>
          Within mi
          <input
            className="input narrow"
            type="number"
            min={0}
            value={filters.maxDistance ?? ''}
            onChange={(e) =>
              setFilters((f) => ({ ...f, maxDistance: e.target.value === '' ? null : Number(e.target.value) }))
            }
          />
        </label>
        <label>
          Sort
          <select
            className="input"
            value={filters.sort}
            onChange={(e) => setFilters((f) => ({ ...f, sort: e.target.value as ClearanceFilters['sort'] }))}
          >
            <option value="discount">Biggest markdown</option>
            <option value="price">Cheapest</option>
            <option value="distance">Nearest store</option>
            <option value="name">Name</option>
          </select>
        </label>
      </div>

      <div className="chip-filters">
        {groups.map((g) => (
          <button
            key={g.id}
            className="chip toggle"
            aria-pressed={filters.groups.includes(g.id)}
            onClick={() => toggleGroup(g.id)}
          >
            {g.label}
          </button>
        ))}
      </div>

      {stores.length > 1 && (
        <div className="chip-filters">
          {stores.filter((s) => s.enabled).map((s) => (
            <button
              key={s.locationId}
              className="chip toggle"
              aria-pressed={filters.stores.includes(s.locationId)}
              onClick={() => toggleStoreFilter(s.locationId)}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      <p className="meta">
        {loading && rows.length === 0 ? 'Loading…' : `${total} item${total === 1 ? '' : 's'}`}
      </p>

      <ul className="clearance-rows">
        {rows.map((row) => (
          <li key={`${row.locationId}:${row.itemId}`} className="clearance-row">
            <span className="store-bar" aria-hidden="true" />
            <div className="body">
              <div className="title">
                {row.productUrl ? (
                  <a href={row.productUrl} target="_blank" rel="noreferrer noopener">
                    {row.name}
                  </a>
                ) : (
                  row.name
                )}
                {row.isNew && <span className="badge new">new</span>}
              </div>
              <div className="meta">
                {row.storeName}
                {row.distanceMiles != null && ` · ${row.distanceMiles.toFixed(1)} mi`}
                {row.aisle && (
                  <>
                    {' · '}
                    <span className="aisle">aisle {row.aisle}</span>
                  </>
                )}
                {row.brand && ` · ${row.brand}`}
              </div>
            </div>
            <div className="price">
              <span className="hero">{money(row.nowCents)}</span>
              {row.wasCents !== null && row.nowCents !== null && row.wasCents > row.nowCents && (
                <span className="was">{money(row.wasCents)}</span>
              )}
              {row.discountPct !== null && row.discountPct > 0 && (
                <span className="off">↓ {row.discountPct}% off</span>
              )}
            </div>
          </li>
        ))}
      </ul>

      {rows.length === 0 && !loading && (
        <p className="meta empty">
          {stores.length === 0
            ? 'No stores yet. Find the Walmarts near a ZIP, enable the ones worth driving to, then sweep.'
            : enabledCount === 0
              ? 'No stores enabled. Turn on at least one under Stores.'
              : date === null
                ? 'Nothing swept yet — run a sweep.'
                : 'Nothing on clearance matched these filters.'}
        </p>
      )}

      {rows.length < total && (
        <button className="btn ghost" onClick={() => void loadRows(offset + PAGE_SIZE)} disabled={loading}>
          {loading ? 'Loading…' : `Show more (${total - rows.length} left)`}
        </button>
      )}
    </section>
  );
}
