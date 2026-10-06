import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { Alert, ClearanceAlert, StoreId, StoreSelection, StoresResponse, WatchGroup } from './types';
import { api, relativeTime } from './lib/api';
import { SearchPanel } from './components/SearchPanel';
import { StorePicker } from './components/StorePicker';
import { STORE_LABEL, tabKeyHandler } from './components/bits';

// Non-default tabs are split out of the initial bundle — they load on first
// open, keeping first paint of the Search view lean.
const Deals = lazy(() => import('./components/Deals').then((m) => ({ default: m.Deals })));
const Watchlist = lazy(() => import('./components/Watchlist').then((m) => ({ default: m.Watchlist })));
const Alerts = lazy(() => import('./components/Alerts').then((m) => ({ default: m.Alerts })));
const Clearance = lazy(() => import('./components/Clearance').then((m) => ({ default: m.Clearance })));

type Tab = 'search' | 'deals' | 'clearance' | 'watchlist' | 'alerts';
const TAB_IDS: Tab[] = ['search', 'deals', 'clearance', 'watchlist', 'alerts'];

export function App() {
  const [tab, setTab] = useState<Tab>('search');
  const [storeData, setStoreData] = useState<StoresResponse | null>(null);
  const [storeBusy, setStoreBusy] = useState(false);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [groups, setGroups] = useState<WatchGroup[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [clearanceAlerts, setClearanceAlerts] = useState<ClearanceAlert[]>([]);
  // False until the first watchlist/alerts fetch settles, so empty copy never
  // shows while the data is still on its way.
  const [loaded, setLoaded] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [selection, setSelection] = useState<StoreSelection>(() => {
    const saved = localStorage.getItem('bastille.stores');
    if (saved) {
      try {
        return JSON.parse(saved) as StoreSelection;
      } catch {
        /* fall through to the default */
      }
    }
    return { zip: '', foodlion: null, wegmans: null, traderjoes: null };
  });
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const notified = useRef(new Set<string>());
  const [snapshot, setSnapshot] = useState<{ date: string; rows: number } | null>(null);
  const [snapshotRunning, setSnapshotRunning] = useState(false);

  const loadWatchlist = useCallback(async () => {
    const [w, a, c] = await Promise.all([api.watchlist(), api.alerts(), api.clearanceAlerts()]);
    setGroups(w.groups);
    setAlerts(a.alerts);
    setClearanceAlerts(c.alerts);
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
    void loadWatchlist()
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoaded(true));
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
      const payload = JSON.parse(event.data) as
        | { type: 'alerts'; alerts: Alert[] }
        | { type: 'clearance-alerts'; alerts: ClearanceAlert[] };
      if (payload.type !== 'alerts' && payload.type !== 'clearance-alerts') return;
      void loadWatchlist();
      const fresh: string[] = [];
      for (const alert of payload.alerts) {
        const key = `${payload.type}:${alert.id}`;
        if (notified.current.has(key)) continue;
        notified.current.add(key);
        const canPush = 'Notification' in window && Notification.permission === 'granted';
        if ('productName' in alert) {
          fresh.push(`${alert.productName}: ${alert.message}`);
          // Existing rule: only urgent price alerts interrupt.
          if (alert.severity === 'urgent' && canPush) {
            new Notification(alert.productName, { body: alert.message, tag: `bastille-${alert.id}` });
          }
        } else if (!alert.acknowledged) {
          // A watch-term match is something the shopper asked to be told about.
          fresh.push(`Clearance: ${alert.message}`);
          if (canPush) {
            new Notification(`Clearance: ${alert.find.name}`, { body: alert.message, tag: `bastille-clearance-${alert.id}` });
          }
        }
      }
      if (fresh.length > 0) {
        setAnnouncement(`${fresh.length} new alert${fresh.length === 1 ? '' : 's'}. ${fresh.slice(0, 3).join('. ')}`);
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
      const [all, clearance] = await Promise.all([api.alerts(), api.clearanceAlerts()]);
      setAlerts(all.alerts);
      setClearanceAlerts(clearance.alerts);
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

  const unread = alerts.filter((a) => !a.acknowledged).length + clearanceAlerts.filter((a) => !a.acknowledged).length;
  const storeIds = (storeData?.stores ?? []).map((st) => st.id);
  const chainNames = storeIds.length ? storeIds.map((id) => STORE_LABEL[id] ?? id) : Object.values(STORE_LABEL);
  const canNotify = 'Notification' in window && Notification.permission === 'default';

  return (
    <div className="app">
      <div className="masthead">
        <h1>bastille</h1>
        <span className="sub">{chainNames.join(' · ')} price watch · Walmart clearance</span>
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

      <div className="tabs" role="tablist" aria-label="Sections">
        {(
          [
            ['search', 'Search'],
            ['deals', 'Deals'],
            ['clearance', 'Clearance'],
            ['watchlist', `Watchlist${groups.length ? ` (${groups.length})` : ''}`],
            ['alerts', 'Alerts'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            id={`main-tab-${id}`}
            role="tab"
            className="tab"
            aria-selected={tab === id}
            aria-controls={`main-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            onKeyDown={tabKeyHandler(TAB_IDS, tab, setTab, 'main')}
          >
            {label}
            {id === 'alerts' && unread > 0 && <span className="count" aria-label={`${unread} unread`}>{unread}</span>}
          </button>
        ))}
      </div>

      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>

      {error && <div className="error">{error}</div>}

      <div role="tabpanel" id={`main-panel-${tab}`} aria-labelledby={`main-tab-${tab}`}>
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
              storeIds={storeIds}
              selection={selection}
              lastSnapshot={snapshot}
              onRunSnapshot={() => void runSnapshot()}
              snapshotRunning={snapshotRunning}
            />
          )}
          {tab === 'clearance' && <Clearance />}
          {tab === 'watchlist' && <Watchlist groups={groups} loading={!loaded} onChanged={() => void loadWatchlist()} />}
          {tab === 'alerts' && (
            <Alerts alerts={alerts} clearanceAlerts={clearanceAlerts} loading={!loaded} onChanged={() => void loadWatchlist()} />
          )}
        </Suspense>
      </div>
    </div>
  );
}
