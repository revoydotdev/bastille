import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { Alert, StoreId, StoreSelection, StoresResponse, WatchGroup } from './types';
import { api, relativeTime } from './lib/api';
import { SearchPanel } from './components/SearchPanel';
import { StorePicker } from './components/StorePicker';

// Non-default tabs are split out of the initial bundle — they load on first
// open, keeping first paint of the Search view lean.
const Deals = lazy(() => import('./components/Deals').then((m) => ({ default: m.Deals })));
const Watchlist = lazy(() => import('./components/Watchlist').then((m) => ({ default: m.Watchlist })));
const Alerts = lazy(() => import('./components/Alerts').then((m) => ({ default: m.Alerts })));

type Tab = 'search' | 'deals' | 'watchlist' | 'alerts';

export function App() {
  const [tab, setTab] = useState<Tab>('search');
  const [storeData, setStoreData] = useState<StoresResponse | null>(null);
  const [storeBusy, setStoreBusy] = useState(false);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [groups, setGroups] = useState<WatchGroup[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [selection, setSelection] = useState<StoreSelection>(() => {
    const saved = localStorage.getItem('bastille.stores');
    if (saved) {
      try {
        return JSON.parse(saved) as StoreSelection;
      } catch {
        /* fall through to the default */
      }
    }
    return { zip: '', foodlion: null, wegmans: null };
  });
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const notified = useRef(new Set<number>());
  const [snapshot, setSnapshot] = useState<{ date: string; rows: number } | null>(null);
  const [snapshotRunning, setSnapshotRunning] = useState(false);

  const loadWatchlist = useCallback(async () => {
    const [w, a] = await Promise.all([api.watchlist(), api.alerts()]);
    setGroups(w.groups);
    setAlerts(a.alerts);
  }, []);

  /**
   * Looks up both chains for a ZIP. Any store the shopper has already chosen
   * is kept if the new ZIP still offers it; otherwise it falls to the nearest.
   */
  const findStores = useCallback(async (zip: string) => {
    setStoreBusy(true);
    setStoreError(null);
    try {
      const data = await api.stores(zip || undefined);
      setStoreData(data);
      setSelection((prev) => {
        const next: StoreSelection = { ...prev, zip };
        for (const store of data.stores) {
          const current = prev[store.id];
          const stillListed = current && store.locations.some((l) => l.locationId === current);
          if (!stillListed) next[store.id] = store.locations[0]?.locationId ?? store.defaultLocationId;
        }
        return next;
      });
    } catch (e) {
      setStoreError((e as Error).message);
    } finally {
      setStoreBusy(false);
    }
  }, []);

  useEffect(() => {
    void findStores(selection.zip);
    void loadWatchlist().catch((e) => setError((e as Error).message));
    void api.snapshotStatus().then((st) => {
      if (st.lastRun?.finishedAt) setSnapshot({ date: st.lastRun.date, rows: st.lastRun.rows });
    }).catch(() => undefined);
    // Runs once: later lookups are driven by the ZIP form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localStorage.setItem('bastille.stores', JSON.stringify(selection));
  }, [selection]);

  /**
   * The server pushes alerts the moment a scheduled poll produces them, so the
   * dashboard does not have to sit in a polling loop of its own.
   */
  useEffect(() => {
    const source = new EventSource('/api/alerts/stream');
    source.onmessage = (event) => {
      const payload = JSON.parse(event.data) as { type: string; alerts: Alert[] };
      if (payload.type !== 'alerts') return;
      void loadWatchlist();
      for (const alert of payload.alerts) {
        if (notified.current.has(alert.id)) continue;
        notified.current.add(alert.id);
        if (alert.severity === 'urgent' && 'Notification' in window && Notification.permission === 'granted') {
          new Notification(`${alert.productName}`, { body: alert.message, tag: `bastille-${alert.id}` });
        }
      }
    };
    return () => source.close();
  }, [loadWatchlist]);

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      const res = await api.refresh();
      setGroups(res.groups);
      const all = await api.alerts();
      setAlerts(all.alerts);
      setLastRefresh(new Date().toISOString());
      if (res.errors.length > 0) setError(res.errors.join('; '));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  const runSnapshot = useCallback(async () => {
    setSnapshotRunning(true);
    try {
      const r = await api.runSnapshot();
      setSnapshot({ date: r.date, rows: r.rows });
      if (r.errors.length) setError(r.errors.join('; '));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSnapshotRunning(false);
    }
  }, []);

  const unread = alerts.filter((a) => !a.acknowledged).length;
  const canNotify = 'Notification' in window && Notification.permission === 'default';

  return (
    <div className="app">
      <div className="masthead">
        <h1>bastille</h1>
        <span className="sub">Food Lion · Wegmans price watch</span>
        <span className="spacer" />
        {lastRefresh && <span className="sub">checked {relativeTime(lastRefresh)}</span>}
        {canNotify && (
          <button className="btn small ghost" onClick={() => void Notification.requestPermission()}>
            Enable push alerts
          </button>
        )}
        <button className="btn small" onClick={() => void refresh()} disabled={refreshing || groups.length === 0}>
          {refreshing ? 'Checking prices…' : 'Check prices now'}
        </button>
      </div>

      <div className="tabs" role="tablist">
        {(
          [
            ['search', 'Search'],
            ['deals', 'Deals'],
            ['watchlist', `Watchlist${groups.length ? ` (${groups.length})` : ''}`],
            ['alerts', 'Alerts'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            className="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
            {id === 'alerts' && unread > 0 && <span className="count">{unread}</span>}
          </button>
        ))}
      </div>

      {error && <div className="error">{error}</div>}

      {tab === 'search' && (
        <>
          <StorePicker
            data={storeData}
            selection={selection}
            loading={storeBusy}
            error={storeError}
            onZipSubmit={(zip) => void findStores(zip)}
            onPick={(storeId: StoreId, locationId: string) =>
              setSelection((prev) => ({ ...prev, [storeId]: locationId }))
            }
          />
          <SearchPanel
            storeData={storeData}
            selection={selection}
            groups={groups}
            onWatchlistChanged={() => void loadWatchlist()}
          />
        </>
      )}
      <Suspense fallback={<div className="meta" style={{ padding: 24 }}>Loading…</div>}>
      {tab === 'deals' && (
        <Deals
          selection={selection}
          lastSnapshot={snapshot}
          onRunSnapshot={() => void runSnapshot()}
          snapshotRunning={snapshotRunning}
        />
      )}
      {tab === 'watchlist' && <Watchlist groups={groups} onChanged={() => void loadWatchlist()} />}
      {tab === 'alerts' && <Alerts alerts={alerts} onChanged={() => void loadWatchlist()} />}
      </Suspense>
    </div>
  );
}
