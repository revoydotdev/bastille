import type { Alert, SearchResult, StoreInfo, WatchGroup, PriceSnapshot } from '../types';

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const api = {
  stores: (postalCode?: string) =>
    json<{ stores: StoreInfo[] }>(`/api/stores${postalCode ? `?postalCode=${encodeURIComponent(postalCode)}` : ''}`),

  search: (params: { q: string; stores: string[]; wegmansLocation?: string; limit?: number }) => {
    const qs = new URLSearchParams({ q: params.q, stores: params.stores.join(',') });
    if (params.wegmansLocation) qs.set('wegmansLocation', params.wegmansLocation);
    if (params.limit) qs.set('limit', String(params.limit));
    return json<{ query: string; results: SearchResult[]; errors: { storeId: string; message: string }[] }>(
      `/api/search?${qs}`,
    );
  },

  watchlist: () => json<{ groups: WatchGroup[] }>('/api/watchlist'),

  watch: (body: {
    storeId: string;
    storeProductId: string;
    locationId?: string | null;
    groupId?: number;
    label?: string;
  }) => json<{ group: WatchGroup }>('/api/watchlist', { method: 'POST', body: JSON.stringify(body) }),

  updateGroup: (id: number, body: { label?: string; targetCents?: number | null; notifyPromos?: boolean }) =>
    json<{ group: WatchGroup }>(`/api/watchlist/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  deleteGroup: (id: number) => json<{ ok: true }>(`/api/watchlist/${id}`, { method: 'DELETE' }),

  removeItem: (itemId: number) => json<{ ok: true }>(`/api/watchlist/item/${itemId}`, { method: 'DELETE' }),

  history: (productId: number, locationId: string | null) =>
    json<{ history: PriceSnapshot[] }>(
      `/api/prices/${productId}${locationId ? `?locationId=${encodeURIComponent(locationId)}` : ''}`,
    ),

  alerts: (unreadOnly = false) => json<{ alerts: Alert[] }>(`/api/alerts?unread=${unreadOnly ? 1 : 0}`),

  ackAlert: (id: number) => json<{ ok: true }>(`/api/alerts/${id}/ack`, { method: 'POST' }),

  ackAll: () => json<{ ok: true }>('/api/alerts/ack-all', { method: 'POST' }),

  refresh: () =>
    json<{ itemsPolled: number; errors: string[]; groups: WatchGroup[]; alerts: Alert[] }>('/api/refresh', {
      method: 'POST',
    }),
};

export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
