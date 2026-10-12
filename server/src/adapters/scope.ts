/**
 * The upstream-scoped ingestion contract.
 *
 * Pairs with `adapters/types.ts` StoreAdapter — one covers caller-scoped
 * sources (Wegmans, Food Lion: the caller names the store and the source
 * answers for it) and this covers upstream-scoped sources (Walmart's
 * orchestra tier: the upstream picks the store from the requesting egress and
 * attests which one it answered for in `pageMetadata.storeSelectionHeader`).
 *
 * Both must share one transport, one budget, and one logging path (todo 5,
 * 11, 12). The abstraction here is *not* a duplicate of StoreAdapter; it is
 * the other shape of the same kind.
 */
import type { ClearanceItem } from '../clearance/walmart-api.js';

/**
 * The attestation returned by `resolveScope`. `answeredBy` is the store name
 * the upstream echoed back, verbatim — it is the assertion every later
 * `enumerateShelves` page is checked against. `provenance` tells a caller how
 * the proof was obtained, so a future `static` or `list-call` source does not
 * silently drift into a different trust model than a `persisted-query` one.
 */
export interface ScopeProof {
  requested: { locationId?: string; postalCode?: string };
  /** the echoed store name (e.g. `pageMetadata.storeSelectionHeader.storeDislayName`); null when the response carried none */
  answeredBy: string | null;
  provenance: 'persisted-query' | 'list-call' | 'static';
}

/**
 * Raised when the upstream's echo disagrees with the `ScopeProof` returned
 * by `resolveScope`. Thrown BEFORE any item is surfaced, so a caller can
 * never record an unscoped shelf. Concrete typed error (not a bare
 * `Error`) so the DAG engine can route it to the `wrong-store` terminal
 * state in `server/src/dag/types.ts` without string-matching the message.
 */
export class ScopeMismatchError extends Error {
  override readonly name = 'ScopeMismatchError';
  constructor(
    readonly expected: string | null,
    readonly got: string | null,
    readonly proofProvenance: ScopeProof['provenance'],
  ) {
    super(
      `scope mismatch: expected=${expected ?? '(none)'} ` +
      `got=${got ?? '(none)'} provenance=${proofProvenance}`,
    );
  }
}

export interface AttestedScopeSource {
  /**
   * Asserts what store the upstream will answer for under the given target,
   * returning a `ScopeProof` whose `answeredBy` is the echoed name. The
   * implementation performs one minimal (canary) read — distinct from a
   * paging read so `answeredBy` is established before any shelf is captured.
   */
  resolveScope(target: { locationId?: string; postalCode?: string }): Promise<ScopeProof>;

  /**
   * One page of items, scoped to a previously-asserted `ScopeProof`. Each
   * page's echo is checked against the proof; a mismatch throws
   * `ScopeMismatchError` before returning items.
   *
   * `complete: false` is reserved for upstream-truncated reads (budget ran
   * out, edge refused mid-shelf). A genuine last page sets `complete: true`
   * and `cursor: null`. Both flavours are part of the contract — todo 15
   * will tighten them.
   */
  enumerateShelves(
    scope: ScopeProof,
    cursor: { page: number; pageSize: number } | null,
  ): Promise<{
    page: number;
    cursor: { nextPage: number } | null;
    complete: boolean;
    items: ClearanceItem[];
  }>;
}
