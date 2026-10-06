import type { Offer, Product, StoreId } from '../price/model.js';
import type { Point, ZipAnchor } from '../geo.js';

export interface StoreLocation {
  storeId: StoreId;
  locationId: string;
  name: string;
  address: string | null;
  postalCode: string | null;
  /** miles from the searched ZIP, when one was given */
  distanceMiles?: number | null;
}

/** What the poller remembers about a watched product between runs. */
export interface OfferHint {
  productUrl?: string | null;
}

export interface SearchOptions {
  query: string;
  locationId?: string;
  limit?: number;
}

/**
 * The contract every store integration implements. Deliberately narrow: this
 * app only ever reads. Nothing here can add to a cart, place an order, or
 * touch an account.
 */
export interface StoreAdapter {
  readonly id: StoreId;
  readonly label: string;
  /** Store number used when the caller does not pick one. */
  readonly defaultLocationId: string;
  /**
   * Whether prices differ between this chain's stores. Wegmans prices per
   * store; Food Lion's public catalogue publishes one national set, so its
   * store choice is pickup context and must not be presented as affecting
   * the price.
   */
  readonly pricesVaryByLocation: boolean;

  /**
   * The id a price should be *recorded* under for a given store choice.
   * For a chain with one national price this collapses to a single scope, so
   * changing your store does not fragment price history into per-store series
   * that all contain the same number.
   */
  pricingLocationId(selectedLocationId?: string | null): string | null;

  search(opts: SearchOptions): Promise<Offer[]>;
  /**
   * Re-reads one product's current price. Used by the poller. `hint` is what
   * was stored the last time this product was seen, so an adapter can go
   * straight to it instead of searching.
   */
  fetchOffer(storeProductId: string, locationId?: string, hint?: OfferHint): Promise<Offer | null>;
  /** Called by the poller before each run, so an adapter can budget per run. */
  beginRun?(): void;
  /** Adapter-specific counters surfaced in `/api/metrics`. */
  stats?(): Record<string, number>;
  /**
   * Store finder. `near` is the ZIP resolved against every chain's store data
   * at once, so a ZIP one chain has never heard of still ranks its stores
   * correctly when the other chain knows the area.
   */
  findLocations(postalCode: string, near?: Point | null): Promise<StoreLocation[]>;

  /** ZIP reference points this chain contributes to that shared lookup. */
  zipAnchors(): Promise<ZipAnchor[]>;

  /**
   * Optional: start building whatever local index this adapter serves reads
   * from, without waiting for it. Called once at boot so the first user
   * request is not the one that pays to build it. An adapter whose upstream
   * answers queries directly does not implement this.
   */
  warm?(): void;

  /**
   * A bounded, broad set of current offers for the daily snapshot corpus.
   * Deliberately capped so the daily job stays low-resource; breadth over
   * completeness. `locationId` scopes per-store pricing where the chain
   * supports it.
   */
  enumerate(opts: { locationId?: string | null; maxProducts?: number }): Promise<Offer[]>;
}

export type { Offer, Product, StoreId };
