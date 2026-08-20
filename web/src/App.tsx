import { useCallback, useEffect, useRef, useState } from 'react';
import type { Alert, StoreInfo, WatchGroup } from './types';
import { api, relativeTime } from './lib/api';
import { SearchPanel } from './components/SearchPanel';
import { Watchlist } from './components/Watchlist';
import { Alerts } from './components/Alerts';

type Tab = 'search' | 'watchlist' | 'alerts';

export function App() {
  const [tab, setTab] = useState<Tab>('search');
  const [stores, setStores] = useState<StoreInfo[]>([]);
  const [groups, setGroups] = useState<WatchGroup[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [wegmansStore, setWegmansStore] = useState(localStorage.getItem('grocer.wegmansStore') ?? '24');
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const notified = useRef(new Set<number>());

  const loadWatchlist = useCallback(async () => {
    const [w, a] = await Promise.all([api.watchlist(), api.alerts()]);
    setGroups(w.groups);
    setAlerts(a.alerts);
  }, []);

  useEffect(() => {
    void api.stores().then((r) => setStores(r.stores)).catch(() => undefined);
    void loadWatchlist().catch((e) => setError((e as Error).message));
  }, [loadWatchlist]);

  useEffect(() => {
    localStorage.setItem('grocer.wegmansStore', wegmansStore);
  }, [wegmansStore]);

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
          new Notification(`${alert.productName}`, { body: alert.message, tag: `grocer-${alert.id}` });
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

  const unread = alerts.filter((a) => !a.acknowledged).length;
  const canNotify = 'Notification' in window && Notification.permission === 'default';

  return (
    <div className="app">
      <div className="masthead">
        <h1>grocer</h1>
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
        <SearchPanel
          stores={stores}
          groups={groups}
          wegmansStore={wegmansStore}
          onWegmansStoreChange={setWegmansStore}
          onWatchlistChanged={() => void loadWatchlist()}
        />
      )}
      {tab === 'watchlist' && <Watchlist groups={groups} onChanged={() => void loadWatchlist()} />}
      {tab === 'alerts' && <Alerts alerts={alerts} onChanged={() => void loadWatchlist()} />}
    </div>
  );
}
