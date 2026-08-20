import type { Alert } from '../types';
import { api, money, relativeTime } from '../lib/api';
import { STORE_COLOR, STORE_LABEL } from './bits';

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

export function Alerts({ alerts, onChanged }: { alerts: Alert[]; onChanged: () => void }) {
  if (alerts.length === 0) {
    return (
      <div className="empty">
        No alerts yet. Prices are re-read on a schedule; anything that moves — a number or an offer like
        BOGO starting — shows up here.
      </div>
    );
  }
  const unread = alerts.filter((a) => !a.acknowledged).length;
  return (
    <section>
      <div className="controls">
        <h2 className="section" style={{ margin: 0 }}>
          {unread} unread of {alerts.length}
        </h2>
        <span style={{ flex: 1 }} />
        <button className="btn small ghost" disabled={unread === 0} onClick={() => void api.ackAll().then(onChanged)}>
          Mark all read
        </button>
      </div>
      {alerts.map((a) => (
        <article className="alert" key={a.id} data-tone={toneOf(a)} data-severity={a.severity} data-read={a.acknowledged}>
          <div className="body">
            <div className={`kind${a.numeric ? '' : ' nonnumeric'}`}>
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
      ))}
    </section>
  );
}
