import { FoodLionAdapter } from './foodlion.js';
import { TraderJoesAdapter } from './traderjoes.js';
import { WegmansAdapter } from './wegmans.js';
import type { StoreAdapter } from './types.js';
import type { StoreId } from '../price/model.js';

export const adapters: Record<StoreId, StoreAdapter> = {
  foodlion: new FoodLionAdapter(),
  traderjoes: new TraderJoesAdapter(),
  wegmans: new WegmansAdapter(),
};

export const STORE_IDS: StoreId[] = ['foodlion', 'wegmans', 'traderjoes'];

export function isStoreId(value: string): value is StoreId {
  return (STORE_IDS as string[]).includes(value);
}

export function adapterFor(id: StoreId): StoreAdapter {
  return adapters[id];
}

export type { StoreAdapter };
