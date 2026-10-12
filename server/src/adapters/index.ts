/**
 * Source registry surface.
 *
 * The map of storeId → adapter instance, the list of enabled store ids, and
 * the runtime type guards all come from `registry.ts`, which loads them from
 * `data/registry.json` at boot. The TypeScript `StoreId` union is generated
 * from the same JSON by `scripts/codegen-registry.mjs`, so the two sides
 * stay in lockstep: a new id in the registry is a new id in TS and a new
 * row in `/api/stores`, with no `.ts` edit to this file.
 */
import type { StoreId } from '../price/model.js';
import type { StoreAdapter } from './types.js';
import { loadRegistry } from './registry.js';

const resolved = loadRegistry();

export const adapters: Record<StoreId, StoreAdapter> = resolved.adapters as Record<
  StoreId,
  StoreAdapter
>;

export const STORE_IDS: StoreId[] = resolved.entries.map((e) => e.id) as StoreId[];

export function isStoreId(value: string): value is StoreId {
  return (STORE_IDS as string[]).includes(value);
}

export function adapterFor(id: StoreId): StoreAdapter {
  const a = adapters[id];
  if (!a) throw new Error(`no adapter registered for storeId "${id}"`);
  return a;
}

export type { StoreAdapter };