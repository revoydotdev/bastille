import type { Offer, Product, StoreId } from '../price/model.js';

export interface StoreLocation {
  storeId: StoreId;
  locationId: string;
  name: string;
  address: string | null;
  postalCode: string | null;
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

  search(opts: SearchOptions): Promise<Offer[]>;
  /** Re-reads one product's current price. Used by the poller. */
  fetchOffer(storeProductId: string, locationId?: string): Promise<Offer | null>;
  /** Store finder, so the user can pin prices to their own store. */
  findLocations(postalCode: string): Promise<StoreLocation[]>;
}

export type { Offer, Product, StoreId };
