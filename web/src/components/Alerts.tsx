import type { Alert, ClearanceAlert } from '../types';
import { api, money, relativeTime } from '../lib/api';
import { Loading, STORE_COLOR, STORE_LABEL } from './bits';

const KIND_LABEL: Record<string, string> = {
  price_drop: 'price drop',
  price_rise: 'price rise',
  promo_started: 'new offer',
  promo_ended: 'offer ended',
  promo_changed: 'offer changed',
  back_in_stock: 'back in stock',
  out_of_stock: 'out of stock',
};

/** One colour, one meaning — see DESIGN.md. */
function toneOf(a: Alert): 'drop' | 'rise' | 'promo' | 'stock' {
  if (!a.numeric) return a.kind === 'back_in_stock' || a.kind === 'out_of_stock' ? 'stock' : 'promo';
  return a.kind === 'price_drop' ? 'drop' : 'rise';
}

type Item =
  | { source: 'grocery'; at: string; read: boolean; alert: Alert }
  | { source: 'clearance'; at: string; read: boolean; alert: ClearanceAlert };

interface Props {
  alerts: Alert[];
  clearanceAlerts: ClearanceAlert[];
  loading: boolean;
  onChanged: () => void;
}

function ClearanceBody({ a }: { a: ClearanceAlert }) {
  const f = a.find;
  return (
    <div className="body">
      <div className="kind">
        <span className="source-badge" data-source="clearance">Walmart clearance</span>
        {a.term && ` · watching “${a.term}”`}
      </div>
      <div className="msg">{a.message}</div>
      <div className="who">
        {f.storeName}
        {f.aisle && ` · aisle ${f.aisle}`}
        {' · '}
        {f.name}
        {' · '}
        {relativeTime(a.createdAt)}
        {f.nowCents !== null && ` · ${money(f.nowCents)}`}
        {f.wasCents !== null && f.nowCents !== null && f.wasCents > f.nowCents && ` (was ${money(f.wasCents)})`}
      </div>
    </div>
  );
}

export function Alerts({ alerts, clearanceAlerts, loading, onChanged }: Props) {
  if (loading) return <Loading what="alerts" />;

  const items: Item[] = [
    ...alerts.map((alert): Item => ({ source: 'grocery', at: alert.createdAt, read: alert.acknowledged, alert })),
    ...clearanceAlerts.map((alert): Item => ({ source: 'clearance', at: alert.createdAt, read: alert.acknowledged, alert })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  if (items.length === 0) {
    return (
      <div className="empty">
        No alerts yet. Prices are re-read on a schedule; anything that moves — a number or an offer like
        BOGO starting — shows up here, along with clearance finds that match your watch terms.
      </div>
    );
  }
  const unread = items.filter((i) => !i.read).length;
  const ackAll = () => void Promise.all([api.ackAll(), api.ackAllClearanceAlerts()]).then(onChanged);
  return (
    <section>
      <div className="controls">
        <h2 className="section" style={{ margin: 0 }}>
          {unread} unread of {items.length}
        </h2>
        <span style={{ flex: 1 }} />
        <button className="btn small ghost" disabled={unread === 0} onClick={ackAll}>
          Mark all read
        </button>
      </div>
      {items.map((item) =>
        item.source === 'clearance' ? (
          <article
            className="alert"
            key={`c${item.alert.id}`}
            data-tone="drop"
            data-severity="notable"
            data-read={item.read}
          >
            <ClearanceBody a={item.alert} />
            {!item.read && (
              <button
                className="btn small ghost"
                onClick={() => void api.ackClearanceAlert(item.alert.id).then(onChanged)}
              >
                Dismiss
              </button>
            )}
          </article>
        ) : (
          <GroceryAlert key={`g${item.alert.id}`} a={item.alert} onChanged={onChanged} />
        ),
      )}
    </section>
  );
}

function GroceryAlert({ a, onChanged }: { a: Alert; onChanged: () => void }) {
  return (
    <article className="alert" data-tone={toneOf(a)} data-severity={a.severity} data-read={a.acknowledged}>
      <div className="body">
        <div className={`kind${a.numeric ? '' : ' nonnumeric'}`}>
          <span className="source-badge" data-source="grocery">Price watch</span>
          {' · '}
          {KIND_LABEL[a.kind] ?? a.kind}
          {!a.numeric && ' · not a plain price'}
        </div>
        <div className="msg">{a.message}</div>
        <div className="who">
          <span style={{ color: STORE_COLOR[a.storeId], fontWeight: 600 }}>{STORE_LABEL[a.storeId]}</span>
          {' · '}
          {a.productName}
          {a.groupLabel && ` · in “${a.groupLabel}”`}
          {' · '}
          {relativeTime(a.createdAt)}
          {a.fromCents !== null && a.toCents !== null && ` · ${money(a.fromCents)} → ${money(a.toCents)}`}
        </div>
      </div>
      {!a.acknowledged && (
        <button className="btn small ghost" onClick={() => void api.ackAlert(a.id).then(onChanged)}>
          Dismiss
        </button>
      )}
    </article>
  );
}
