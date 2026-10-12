/**
 * Walmart-backed `AttestedScopeSource`.
 *
 * The persistedQuery, parseShelf, isPrimaryStack, and browseVariables logic
 * already lives in `walmart-api.ts`, where it has been measured against real
 * responses (the canary work in todo 8 and the "answered for the wrong store"
 * test in `clearance.test.ts` exercise it end to end). The rule here is
 * *lift, not rewrite*: this file does not re-implement any of that. It calls
 * the proven `clearanceShelf` boundary and adds two things:
 *
 *   1. The scope assertion (`resolveScope`) — one minimal canary read whose
 *      only job is to capture the echoed `storeDislayName`.
 *   2. The wrong-store check that used to live at the call site
 *      (`server/src/jobs/clearance-sweep.ts`, the old 437-446 region; now the
 *      same logic at the loop in `sweepCategory`). Hoisted here so callers
 *      cannot opt out of it.
 *
 * Hoisted checks always throw `ScopeMismatchError`, never a bare `Error`, so
 * the DAG engine in `server/src/dag/types.ts` can route it to the
 * `wrong-store` terminal state without string-matching.
 */
import { clearanceShelf, type ClearanceItem } from './walmart-api.js';
import {
  type AttestedScopeSource,
  type ScopeProof,
  ScopeMismatchError,
} from '../adapters/scope.js';

export interface WalmartAttestedScopeOptions {
  /** Walmart category id (e.g. '3944' for Electronics root). */
  categoryId: string;
  /** Walmart's sort token. Defaults to `best_match` upstream. */
  sort?: string;
  /** Residential-proxy URL the canary and shelf reads dial through. */
  proxyUrl?: string;
  /** Stable id of the egress node — scopes the host budget to this node. */
  egressNodeId?: string;
}

function normalize(s: string | null): string {
  return (s ?? '').trim().toLowerCase();
}

export class WalmartAttestedScopeSource implements AttestedScopeSource {
  constructor(private readonly opts: WalmartAttestedScopeOptions) {}

  /**
   * One minimal Browse read (`ps=1`) so the canary costs one shelf page.
   * `pageMetadata.storeSelectionHeader.storeDislayName` is the source's own
   * attestation of which store the request was answered for; it carries over
   * verbatim into the `ScopeProof` so every later `enumerateShelves` page is
   * checked against the same string.
   */
  async resolveScope(target: { locationId?: string; postalCode?: string }): Promise<ScopeProof> {
    const page = await clearanceShelf({
      locationId: target.locationId,
      postalCode: target.postalCode,
      categoryId: this.opts.categoryId,
      page: 1,
      pageSize: 1,
      sort: this.opts.sort,
      proxyUrl: this.opts.proxyUrl,
      egressNodeId: this.opts.egressNodeId,
    });
    return {
      requested: { locationId: target.locationId, postalCode: target.postalCode },
      answeredBy: page.storeName,
      provenance: 'persisted-query',
    };
  }

  /**
   * One shelf page, scope-checked. The page's `storeName` is compared to
   * `scope.answeredBy`; a mismatch throws `ScopeMismatchError` BEFORE any
   * item is surfaced, so a caller can never record an unscoped shelf.
   *
   * `complete` and `cursor` mirror what the underlying parser already
   * computes (`maxPage`, `pageItemCount`). `complete: false` is left as the
   * honest answer when the parser cannot tell — todo 15 will tighten it.
   */
  async enumerateShelves(
    scope: ScopeProof,
    cursor: { page: number; pageSize: number } | null,
  ): Promise<{
    page: number;
    cursor: { nextPage: number } | null;
    complete: boolean;
    items: ClearanceItem[];
  }> {
    const c = cursor ?? { page: 1, pageSize: 40 };
    const page = await clearanceShelf({
      locationId: scope.requested.locationId,
      postalCode: scope.requested.postalCode,
      categoryId: this.opts.categoryId,
      page: c.page,
      pageSize: c.pageSize,
      sort: this.opts.sort,
      proxyUrl: this.opts.proxyUrl,
      egressNodeId: this.opts.egressNodeId,
    });
    if (normalize(page.storeName) !== normalize(scope.answeredBy)) {
      throw new ScopeMismatchError(scope.answeredBy, page.storeName, scope.provenance);
    }
    if (page.pageItemCount === 0) {
      return { page: c.page, cursor: null, complete: true, items: [] };
    }
    if (page.maxPage != null) {
      const complete = c.page >= page.maxPage;
      return {
        page: c.page,
        cursor: complete ? null : { nextPage: c.page + 1 },
        complete,
        items: page.items,
      };
    }
    // `maxPage` and `pageItemCount === 0` are the only signals the parser
    // exposes. Without either, the honest answer is "more pages exist".
    return {
      page: c.page,
      cursor: { nextPage: c.page + 1 },
      complete: false,
      items: page.items,
    };
  }
}
