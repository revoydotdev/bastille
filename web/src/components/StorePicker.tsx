import { useState } from 'react';
import type { StoreId, StoreSelection, StoresResponse } from '../types';
import { STORE_COLOR } from './bits';

interface Props {
  data: StoresResponse | null;
  selection: StoreSelection;
  loading: boolean;
  error: string | null;
  onZipSubmit: (zip: string) => void;
  onPick: (storeId: StoreId, locationId: string) => void;
}

function distanceLabel(miles: number | null | undefined): string {
  if (miles === null || miles === undefined) return '';
  if (miles < 0.1) return ' · here';
  return ` · ${miles} mi`;
}

/**
 * One ZIP drives both chains. Each chain says plainly what its store choice
 * buys you: for Wegmans it is the price, for Food Lion it is the pickup
 * location only — the catalogue price is national, and pretending otherwise
 * would be the "fake precision" DESIGN.md forbids.
 */
export function StorePicker({ data, selection, loading, error, onZipSubmit, onPick }: Props) {
  const [zip, setZip] = useState(selection.zip);

  return (
    <section className="picker">
      <form
        className="picker-zip"
        onSubmit={(e) => {
          e.preventDefault();
          onZipSubmit(zip.trim());
        }}
      >
        <label htmlFor="zip">Your stores</label>
        <input
          id="zip"
          className="field"
          inputMode="numeric"
          maxLength={10}
          placeholder="ZIP"
          value={zip}
          onChange={(e) => setZip(e.target.value)}
        />
        <button className="btn small ghost" disabled={loading || zip.trim().length < 5}>
          {loading ? 'Finding…' : 'Find stores'}
        </button>
        {data?.zipPrecision === 'approximate' && (
          <span className="picker-note">
            No store sits in {data.zip} — showing what is nearest that ZIP's area.
          </span>
        )}
      </form>

      {error && <div className="error">{error}</div>}

      <div className="picker-stores">
        {(data?.stores ?? []).map((store) => {
          const value = selection[store.id] ?? store.defaultLocationId;
          return (
            <div className="picker-store" key={store.id}>
              <span className="picker-label" style={{ color: STORE_COLOR[store.id] }}>
                {store.label}
              </span>
              {store.error ? (
                <span className="picker-note">store list unavailable — {store.error}</span>
              ) : (
                <select
                  className="field"
                  aria-label={`${store.label} store`}
                  value={value}
                  onChange={(e) => onPick(store.id, e.target.value)}
                >
                  {store.locations.map((l) => (
                    <option key={l.locationId} value={l.locationId}>
                      {l.name}
                      {l.address ? ` — ${l.address}` : ''}
                      {distanceLabel(l.distanceMiles)}
                    </option>
                  ))}
                </select>
              )}
              <span className={`picker-scope${store.pricesVaryByLocation ? '' : ' national'}`}>
                {store.pricesVaryByLocation ? 'prices for this store' : 'pickup only · price is national'}
              </span>
            </div>
          );
        })}
      </div>

      {data?.stores.some((s) => !s.pricesVaryByLocation) && (
        <p className="picker-explain">
          Food Lion publishes one online catalogue price for the whole chain, so choosing a store sets
          where you'd pick up — it does not change the price shown. Wegmans prices each store
          separately, and the difference is often large.
        </p>
      )}
    </section>
  );
}
