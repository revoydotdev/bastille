/**
 * Config-driven source registry.
 *
 * Every store integration in the app is declared once in `data/registry.json`.
 * This module loads that file at boot, instantiates the named adapter class,
 * validates that every declared capability is actually implemented, and exposes
 * the resulting `adapters` map and `STORE_IDS` list. The TypeScript `StoreId`
 * union (see `price/model.ts` and `web/src/types.ts`) is regenerated from the
 * same JSON by `scripts/codegen-registry.mjs`, so a new chain that lands only
 * in the config — and an existing adapter class — appears in `/api/stores`
 * and in the web UI with no `.ts` edit.
 *
 * The `BASTILLE_REGISTRY_PATH` env var redirects the file path; tests point
 * it at a fixture to exercise the loader without touching the production
 * config. `setActiveRegistry` is the seam for tests that need a fully
 * resolved registry they built by hand.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FoodLionAdapter } from './foodlion.js';
import { TraderJoesAdapter } from './traderjoes.js';
import { WegmansAdapter } from './wegmans.js';
import type { StoreAdapter } from './types.js';

/**
 * One capability the registry declares per source. The names match the
 * adapter interface methods one-to-one except for the two flags
 * (`promotionParsing`, `clearance`), which document behaviour rather than a
 * specific method and so are accepted at any boolean value.
 */
export type Capability =
  | 'search'
  | 'fetchOffer'
  | 'enumerate'
  | 'findLocations'
  | 'zipAnchors'
  | 'warm'
  | 'stats'
  | 'beginRun'
  | 'clearance'
  | 'promotionParsing';

/** Capabilities that map to a method on the adapter instance. */
const METHOD_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'search',
  'fetchOffer',
  'enumerate',
  'findLocations',
  'zipAnchors',
  'warm',
  'stats',
  'beginRun',
]);

/** Transport requirements the source declares. Today every adapter is
 *  unauthenticated and goes direct, but the registry reserves the field so a
 *  future entry can require a residential proxy / a bound egress node. */
export interface TransportSpec {
  requiresProxy: boolean;
  requiresEgressNode: boolean;
}

export interface RegistryEntry {
  id: string;
  label: string;
  /** Concrete adapter class name to instantiate; resolved against
   *  `ADAPTER_CLASSES` below. */
  adapter: string;
  defaultLocationId: string;
  pricesVaryByLocation: boolean;
  enabled: boolean;
  capabilities: Partial<Record<Capability, boolean>>;
  transport: TransportSpec;
  /** Measured average wire bytes per upstream read; 0 until measured. */
  cost_per_read_bytes: number;
}

export interface RegistryConfig {
  sources: RegistryEntry[];
}

/** Adapter class table. Adding a new chain requires an entry here plus a new
 *  adapter file; the registry JSON only picks which of those classes the
 *  app instantiates and what it claims about them. */
const ADAPTER_CLASSES: Record<string, new () => StoreAdapter> = {
  FoodLionAdapter,
  WegmansAdapter,
  TraderJoesAdapter,
};

export class RegistryCapabilityError extends Error {
  readonly id: string;
  readonly capability: Capability;
  constructor(id: string, capability: Capability) {
    super(`registry: source "${id}" declares capability "${capability}" but does not implement it`);
    this.name = 'RegistryCapabilityError';
    this.id = id;
    this.capability = capability;
  }
}

export class RegistryDuplicateIdError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`registry: duplicate source id "${id}"`);
    this.name = 'RegistryDuplicateIdError';
    this.id = id;
  }
}

export class RegistryEmptyIdError extends Error {
  constructor() {
    super('registry: source id must be a non-empty string');
    this.name = 'RegistryEmptyIdError';
  }
}

export class RegistryUnknownAdapterError extends Error {
  readonly id: string;
  readonly adapter: string;
  constructor(id: string, adapter: string) {
    super(`registry: source "${id}" references unknown adapter "${adapter}"`);
    this.name = 'RegistryUnknownAdapterError';
    this.id = id;
    this.adapter = adapter;
  }
}

export interface ResolvedRegistry {
  entries: RegistryEntry[];
  /** Adapter instance per enabled source id. The id set here is exactly the
   *  set the codegen-emitted `StoreId` union names — that is the
   *  point of having one source of truth. */
  adapters: Record<string, StoreAdapter>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REGISTRY_PATH = resolve(HERE, '../../../data/registry.json');

/**
 * Resolve a registry path: an env-var override wins, then the package
 * default. Empty strings are treated as "not set".
 */
export function resolveRegistryPath(path?: string): string {
  const fromEnv = process.env.BASTILLE_REGISTRY_PATH?.trim();
  if (fromEnv) return resolve(fromEnv);
  if (path) return resolve(path);
  return DEFAULT_REGISTRY_PATH;
}

/** Read and parse the registry JSON without resolving adapters; the parsed
 *  shape is what tests and `loadRegistry` both operate on. */
export function loadRegistryConfig(path?: string): RegistryConfig {
  const resolved = resolveRegistryPath(path);
  let raw: string;
  try {
    raw = readFileSync(resolved, 'utf8');
  } catch (err) {
    throw new Error(`registry: cannot read ${resolved}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`registry: ${resolved} is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { sources?: unknown }).sources)) {
    throw new Error(`registry: ${resolved} must be a JSON object with a "sources" array`);
  }
  return parsed as RegistryConfig;
}

/**
 * Build the runtime registry: filter to enabled entries, validate the id,
 * resolve the adapter class, and assert every declared capability is real.
 * Returns the entries and a key-by-id map of adapter instances.
 */
export function resolveRegistry(cfg: RegistryConfig): ResolvedRegistry {
  const adapters: Record<string, StoreAdapter> = {};
  const entries: RegistryEntry[] = [];
  const seen = new Set<string>();
  for (const entry of cfg.sources) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.enabled === false) continue;
    const id = entry.id;
    if (typeof id !== 'string' || id.length === 0) throw new RegistryEmptyIdError();
    if (seen.has(id)) throw new RegistryDuplicateIdError(id);
    seen.add(id);

    const Ctor = ADAPTER_CLASSES[entry.adapter];
    if (!Ctor) throw new RegistryUnknownAdapterError(id, entry.adapter);
    const instance = new Ctor();

    for (const cap of Object.keys(entry.capabilities ?? {}) as Capability[]) {
      if (!entry.capabilities[cap]) continue;
      if (!METHOD_CAPABILITIES.has(cap)) continue;
      const method = (instance as unknown as Record<string, unknown>)[cap];
      if (typeof method !== 'function') {
        throw new RegistryCapabilityError(id, cap);
      }
    }

    adapters[id] = instance;
    entries.push(entry);
  }
  return { entries, adapters };
}

/** Convenience: load the config from disk and resolve it in one call. */
export function loadRegistry(path?: string): ResolvedRegistry {
  return resolveRegistry(loadRegistryConfig(path));
}

/** Public so tests / scripts can introspect which adapter classes ship in
 *  the binary without importing every adapter file directly. */
export const KNOWN_ADAPTERS = Object.keys(ADAPTER_CLASSES);