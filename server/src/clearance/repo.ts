/**
 * Persistence for the Walmart clearance sweep.
 *
 * Separate from `Repo` on purpose: clearance is not a price series. An item
 * appears on one store's clearance rack, at one price, until someone buys it —
 * there is nothing to diff day over day the way a shelf price is diffed. What
 * matters is *which store*, *what aisle*, and *is it new today*.
 */
import type { DB } from '../db.js';
import { setHostBudget, setNodeHostBudget, type ClearanceItem, type WalmartStore } from './walmart-api.js';
import { HostBudget } from './host-budget.js';
import { isCategoryGroup, type CategoryGroup } from './categories.js';

export interface SweptStore extends WalmartStore {
  enabled: boolean;
  discoveredZip: string | null;
  /** when a sweep last actually read this store's rack, or null */
  lastSweptAt: string | null;
  /**
   * Egress node the sweep uses to read this store. The IP Walmart sees — and
   * therefore the store Walmart answers for — comes from this node. Null means
   * the sweep falls back to the process's own egress (single-store setups,
   * the original behaviour).
   */
  egressNodeId: string | null;
}

/**
 * A residential-proxy exit point. The sweep dials the proxy URL with a per-store
 * geo suffix appended to the password to get an IP in the right metro, and the
 * host budget is keyed by (host, id) so each exit point burns its own 18-read
 * window — that's how W-9 federation scales to multiple stores per run.
 */
export interface EgressNode {
  id: string;
  label: string;
  /** Full proxy URL with embedded credentials. Treat as sensitive. */
  proxyUrl: string;
  /** Freeform region label, e.g. "fairfax,va,us". Used in logs only. */
  region: string | null;
  enabled: boolean;
  addedAt: string;
  lastUsedAt: string | null;
  /**
   * The store this exit point was last attested at, in Walmart's own wording
   * (`storeDislayName`). Null until the first canary proves one.
   */
  verifiedStore: string | null;
  /** When that attestation was taken; null until the first canary. */
  verifiedAt: string | null;
  /**
   * The canary's verdict. `drifted` and `blocked` nodes are skipped by the
   * sweep — there is no point spending a night of budget on an exit point that
   * has moved or stopped answering.
   */
  health: NodeHealth;
}

export type NodeHealth = 'ok' | 'drifted' | 'blocked' | null;

/**
 * How long a node's attestation stays fresh. The canary exists to catch an exit
 * point that has silently moved to another metro, which a proxy provider can
 * do between runs, so a day's fresh answer is treated as still true.
 */
export const CANARY_INTERVAL_MS = Number(process.env.WALMART_CANARY_INTERVAL_MS ?? 12 * 60 * 60 * 1000);

export interface ClearanceRow {
  id: number;
  sweepDate: string;
  capturedAt: string;
  locationId: string;
  storeName: string;
  storeCity: string | null;
  distanceMiles: number | null;
  itemId: string;
  categorySlug: string;
  group: CategoryGroup;
  categoryPath: string | null;
  department: string | null;
  name: string;
  brand: string | null;
  imageUrl: string | null;
  productUrl: string | null;
  nowCents: number | null;
  wasCents: number | null;
  savingsCents: number | null;
  discountPct: number | null;
  aisle: string | null;
  inStock: boolean | null;
  /** true when this (store, item) pair was not present in the previous sweep */
  isNew: boolean;
}

export interface ClearanceFilter {
  date?: string;
  locationIds?: string[];
  categorySlugs?: string[];
  groups?: CategoryGroup[];
  /** case-insensitive substring of the item name */
  q?: string;
  minDiscountPct?: number;
  maxCents?: number;
  /** only items absent from the previous sweep */
  newOnly?: boolean;
  sort?: 'discount' | 'price' | 'name';
  limit?: number;
  offset?: number;
}

/**
 * The standing "is this worth telling me about" rule. Distinct from a watch
 * term: a watch is "shout if you ever see an RTX", the monitor is "shout at
 * anything a quarter off in these aisles, whatever it turns out to be".
 */
export interface DealMonitor {
  minDiscount: number;
  groups: CategoryGroup[];
  enabled: boolean;
  updatedAt: string;
}

export interface ClearanceWatch {
  id: number;
  term: string;
  maxCents: number | null;
  minDiscount: number | null;
  createdAt: string;
}

export interface ClearanceAlertRow {
  id: number;
  createdAt: string;
  message: string;
  acknowledged: boolean;
  term: string | null;
  find: ClearanceRow;
}

/**
 * Percent off, computed only when both ends are real. A clearance sticker with
 * no "was" price is common and is left as null rather than being invented — the
 * UI shows the price alone in that case.
 */
export function discountPercentOf(nowCents: number | null, wasCents: number | null): number | null {
  if (nowCents === null || wasCents === null || wasCents <= 0) return null;
  if (nowCents >= wasCents) return 0;
  return Math.round(((wasCents - nowCents) / wasCents) * 1000) / 10;
}

/**
 * `is_new` is computed here rather than stored: "new" means "this store had not
 * had this item on clearance before this sweep", which is a fact about the rows
 * around it, not about the row. Storing it would go stale the moment an earlier
 * sweep was backfilled or re-run.
 */
/** One line describing a find, as an alert reads it. */
function describeFind(row: ClearanceRow): string {
  const price = row.nowCents === null ? 'price unlisted' : `$${(row.nowCents / 100).toFixed(2)}`;
  const off = row.discountPct === null ? '' : ` (${row.discountPct}% off)`;
  const aisle = row.aisle ? ` · aisle ${row.aisle}` : '';
  return `${row.name} — ${price}${off} at ${row.storeName}${aisle}`;
}

const ROW_SELECT = `
  SELECT f.*, s.name AS store_name, s.city AS store_city, s.distance_miles AS store_distance,
         NOT EXISTS (
           SELECT 1 FROM clearance_find p
           WHERE p.location_id = f.location_id AND p.item_id = f.item_id
             AND p.sweep_date < f.sweep_date
         ) AS is_new
  FROM clearance_find f
  JOIN walmart_store s ON s.location_id = f.location_id`;

/** One aisle of the rack, rolled up. A view of what a sweep already recorded. */
export interface ShelfMapEntry {
  aisle: string;
  categorySlug: string;
  group: CategoryGroup;
  items: number;
  newItems: number;
  minCents: number | null;
  maxCents: number | null;
  /** the deepest markdown here, which is not always the cheapest item */
  bestDiscountPct: number | null;
}

/** The stored value is whatever SQLite held; anything else is treated as unknown. */
function toNodeHealth(value: unknown): NodeHealth {
  return value === 'ok' || value === 'drifted' || value === 'blocked' ? value : null;
}

export class ClearanceRepo {
  private readonly budget: HostBudget;

  constructor(private db: DB) {
    // Every Walmart read in this process answers to one durable ledger, whether
    // it comes from the nightly job, a manual sweep or a store lookup.
    this.budget = new HostBudget(db);
    setHostBudget(this.budget);
  }

  /** Exposed so a caller can price a read before spending one. */
  hostBudget(): HostBudget {
    return this.budget;
  }

  /**
   * One HostBudget per egress node, keyed by node id. Idempotent: safe to call
   * every run. Each node's budget is independent of the default one, so a
   * 412 against the Charlottesville proxy does not block a read through the
   * Powhatan one. The budgets live in the same SQLite file (host_budget table)
   * keyed by host = `www.walmart.com:<nodeId>` so they share the durable
   * ledger across restarts.
   */
  installEgressBudgets(): void {
    for (const n of this.listEgressNodes().filter((n) => n.enabled)) {
      setNodeHostBudget(n.id, new HostBudget(this.db, `www.walmart.com:${n.id}`));
    }
  }

  // ---- stores -----------------------------------------------------------

  /** Every store on record, the live one first, then nearest. */
  listStores(): SweptStore[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM walmart_store
         ORDER BY enabled DESC, last_swept_at DESC, distance_miles IS NULL, distance_miles ASC`,
      )
      .all() as unknown as Record<string, unknown>[];
    return rows.map((r) => this.toStore(r));
  }

  /** An aggregate over `clearance_find` alone, so it spends no Walmart read. */
  shelfMap(date?: string): { date: string | null; aisles: ShelfMapEntry[] } {
    const day = date ?? this.latestSweepDate();
    if (!day) return { date: null, aisles: [] };

    const rows = this.db
      .prepare(
        `SELECT f.aisle, f.category_slug, f.item_group,
                COUNT(*) AS items,
                SUM(CASE WHEN NOT EXISTS (
                      SELECT 1 FROM clearance_find p
                      WHERE p.location_id = f.location_id AND p.item_id = f.item_id
                        AND p.sweep_date < f.sweep_date) THEN 1 ELSE 0 END) AS new_items,
                MIN(f.now_cents) AS min_cents,
                MAX(f.now_cents) AS max_cents,
                MAX(f.discount_pct) AS best_discount_pct
         FROM clearance_find f
         WHERE f.sweep_date = ? AND f.aisle IS NOT NULL AND f.aisle <> ''
         GROUP BY f.aisle, f.category_slug, f.item_group
         ORDER BY f.aisle ASC, f.category_slug ASC`,
      )
      .all(day) as unknown as {
      aisle: string;
      category_slug: string;
      item_group: CategoryGroup;
      items: number;
      new_items: number;
      min_cents: number | null;
      max_cents: number | null;
      best_discount_pct: number | null;
    }[];

    return {
      date: day,
      aisles: rows.map((r) => ({
        aisle: r.aisle,
        categorySlug: r.category_slug,
        group: r.item_group,
        items: r.items,
        newItems: r.new_items,
        minCents: r.min_cents,
        maxCents: r.max_cents,
        bestDiscountPct: r.best_discount_pct,
      })),
    };
  }

  /** Kept for the store lookup that enriches the local store with an address. */
  upsertStores(stores: WalmartStore[], zip: string, enableNew: boolean): void {
    const stmt = this.db.prepare(
      `INSERT INTO walmart_store (location_id, name, address, city, state, postal_code,
          lat, lng, distance_miles, discovered_zip, enabled, added_at)
       VALUES (@location_id,@name,@address,@city,@state,@postal_code,@lat,@lng,
          @distance_miles,@discovered_zip,@enabled,@added_at)
       ON CONFLICT (location_id) DO UPDATE SET
          name=excluded.name, address=excluded.address, city=excluded.city, state=excluded.state,
          postal_code=excluded.postal_code, lat=excluded.lat, lng=excluded.lng,
          distance_miles=excluded.distance_miles, discovered_zip=excluded.discovered_zip`,
    );
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const s of stores) {
        stmt.run({
          location_id: s.locationId,
          name: s.name,
          address: s.address,
          city: s.city,
          state: s.state,
          postal_code: s.postalCode,
          lat: s.point.lat,
          lng: s.point.lng,
          distance_miles: s.distanceMiles,
          discovered_zip: zip,
          enabled: enableNew ? 1 : 0,
          added_at: now,
        });
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * The store this connection actually reads. Walmart picks it from the
   * requesting IP — there is no choosing it — so it is recorded as something
   * discovered rather than configured.
   */
  localStore(): SweptStore | null {
    const r = this.db
      .prepare('SELECT * FROM walmart_store WHERE enabled = 1 ORDER BY last_swept_at DESC LIMIT 1')
      .get() as Record<string, unknown> | undefined;
    return r ? this.toStore(r) : null;
  }

  /**
   * Records the store Walmart answered for as the local one, and demotes any
   * other. `name` is Walmart's own wording from the shelf response, so it is
   * what the sweep's guard will later be comparing against.
   */
  setLocalStore(name: string, detail: WalmartStore | null): SweptStore {
    const locationId = detail?.locationId ?? name;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE walmart_store SET enabled = 0').run();
      this.db
        .prepare(
          `INSERT INTO walmart_store (location_id, name, address, city, state, postal_code,
              lat, lng, distance_miles, discovered_zip, enabled, added_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,1,?)
           ON CONFLICT (location_id) DO UPDATE SET
              name=excluded.name, address=excluded.address, city=excluded.city, state=excluded.state,
              postal_code=excluded.postal_code, lat=excluded.lat, lng=excluded.lng,
              distance_miles=excluded.distance_miles, enabled=1`,
        )
        .run(
          locationId,
          name,
          detail?.address ?? null,
          detail?.city ?? null,
          detail?.state ?? null,
          detail?.postalCode ?? null,
          detail?.point.lat ?? null,
          detail?.point.lng ?? null,
          detail?.distanceMiles ?? null,
          detail?.postalCode ?? null,
          new Date().toISOString(),
        );
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.localStore()!;
  }

  markSwept(locationId: string): void {
    this.db
      .prepare('UPDATE walmart_store SET last_swept_at = ? WHERE location_id = ?')
      .run(new Date().toISOString(), locationId);
  }

  private toStore(r: Record<string, unknown>): SweptStore {
    return {
      locationId: r['location_id'] as string,
      name: r['name'] as string,
      address: (r['address'] as string | null) ?? '',
      city: (r['city'] as string | null) ?? '',
      state: (r['state'] as string | null) ?? '',
      postalCode: (r['postal_code'] as string | null) ?? '',
      point: { lat: (r['lat'] as number | null) ?? 0, lng: (r['lng'] as number | null) ?? 0 },
      distanceMiles: (r['distance_miles'] as number | null) ?? null,
      enabled: r['enabled'] === 1,
      discoveredZip: (r['discovered_zip'] as string | null) ?? null,
      lastSweptAt: (r['last_swept_at'] as string | null) ?? null,
      egressNodeId: (r['egress_node_id'] as string | null) ?? null,
    };
  }

  // ---- egress_node CRUD ---------------------------------------------------

  listEgressNodes(opts: { enabledOnly?: boolean } = {}): EgressNode[] {
    const sql = opts.enabledOnly
      ? 'SELECT * FROM egress_node WHERE enabled = 1 ORDER BY id'
      : 'SELECT * FROM egress_node ORDER BY id';
    const rows = this.db.prepare(sql).all() as Record<string, unknown>[];
    return rows.map((r) => this.toEgressNode(r));
  }

  getEgressNode(id: string): EgressNode | null {
    const r = this.db
      .prepare('SELECT * FROM egress_node WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return r ? this.toEgressNode(r) : null;
  }

  /** An operator creates a node; the canary attests it. The canary columns are
   *  deliberately not writable here — only `setNodeHealth` may claim a store. */
  upsertEgressNode(
    node: Omit<EgressNode, 'addedAt' | 'lastUsedAt' | 'verifiedStore' | 'verifiedAt' | 'health'> & {
      addedAt?: string;
    },
  ): EgressNode {
    const addedAt = node.addedAt ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO egress_node (id, label, proxy_url, region, enabled, added_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT (id) DO UPDATE SET
           label=excluded.label, proxy_url=excluded.proxy_url, region=excluded.region,
           enabled=excluded.enabled`,
      )
      .run(node.id, node.label, node.proxyUrl, node.region, node.enabled ? 1 : 0, addedAt);
    return this.getEgressNode(node.id)!;
  }

  deleteEgressNode(id: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE walmart_store SET egress_node_id = NULL WHERE egress_node_id = ?').run(id);
      this.db.prepare('DELETE FROM egress_node WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Binds a store to an egress node. The sweep uses the node's proxy URL to
   * read this store. Stores without a node fall back to the process's own
   * egress (the original behaviour, still useful for single-store setups).
   */
  setStoreEgressNode(locationId: string, egressNodeId: string | null): void {
    this.db
      .prepare('UPDATE walmart_store SET egress_node_id = ? WHERE location_id = ?')
      .run(egressNodeId, locationId);
  }

  /**
   * Bumps the node's last_used_at when the sweep picks it. Cheap; one row
   * update per store per sweep.
   */
  touchEgressNode(id: string, at = new Date().toISOString()): void {
    this.db.prepare('UPDATE egress_node SET last_used_at = ? WHERE id = ?').run(at, id);
  }

  private toEgressNode(r: Record<string, unknown>): EgressNode {
    return {
      id: r['id'] as string,
      label: r['label'] as string,
      proxyUrl: r['proxy_url'] as string,
      region: (r['region'] as string | null) ?? null,
      enabled: r['enabled'] === 1,
      addedAt: r['added_at'] as string,
      lastUsedAt: (r['last_used_at'] as string | null) ?? null,
      verifiedStore: (r['verified_store'] as string | null) ?? null,
      verifiedAt: (r['verified_at'] as string | null) ?? null,
      health: toNodeHealth(r['health']),
    };
  }

  /**
   * Records a canary's verdict and when it was taken.
   *
   * `verifiedStore` is only written when it is non-null, and callers pass the
   * answered store exactly when the canary succeeded — so the first successful
   * canary attests the node and a later *failed* one leaves the previous
   * attestation standing. Overwriting it with the drifted store would turn a
   * detectable mismatch into a self-fulfilling "always ok".
   */
  setNodeHealth(
    nodeId: string,
    health: NodeHealth,
    verifiedStore: string | null,
    at = new Date().toISOString(),
  ): void {
    if (verifiedStore) {
      this.db
        .prepare('UPDATE egress_node SET health = ?, verified_store = ?, verified_at = ? WHERE id = ?')
        .run(health, verifiedStore, at, nodeId);
      return;
    }
    this.db
      .prepare('UPDATE egress_node SET health = ?, verified_at = ? WHERE id = ?')
      .run(health, at, nodeId);
  }

  /**
   * Enabled nodes whose attestation is missing or stale. One place decides what
   * "stale" means so the sweep and any future caller cannot disagree.
   */
  getEgressNodesDueForCanary(now = Date.now()): EgressNode[] {
    const cutoff = new Date(now - CANARY_INTERVAL_MS).toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM egress_node
         WHERE enabled = 1 AND (verified_at IS NULL OR verified_at < ?)
         ORDER BY id`,
      )
      .all(cutoff) as Record<string, unknown>[];
    return rows.map((r) => this.toEgressNode(r));
  }

  // ---- delta sweeps -----------------------------------------------------

  /** Every item id ever recorded at a store, for "is this one familiar". */
  knownItemIds(locationId: string): Set<string> {
    const rows = this.db
      .prepare('SELECT DISTINCT item_id FROM clearance_find WHERE location_id = ?')
      .all(locationId) as unknown as { item_id: string }[];
    return new Set(rows.map((r) => r.item_id));
  }

  lastFullSweepDate(locationId: string): string | null {
    const r = this.db
      .prepare('SELECT last_full_date AS d FROM walmart_sweep_state WHERE location_id = ?')
      .get(locationId) as { d: string } | undefined;
    return r?.d ?? null;
  }

  markFullSweep(locationId: string, date: string): void {
    this.db
      .prepare(
        `INSERT INTO walmart_sweep_state (location_id, last_full_date) VALUES (?,?)
         ON CONFLICT (location_id) DO UPDATE SET last_full_date = excluded.last_full_date`,
      )
      .run(locationId, date);
  }

  /**
   * A delta sweep reads only the newest end of each shelf, so it records only
   * part of the rack. Rows from the previous sweep that were not re-read are
   * copied onto `date` with their original `captured_at`, so the day's feed is
   * complete and honest about how old each row is. Returns how many were copied.
   */
  carryForward(date: string, locationId: string): number {
    const prev = this.previousSweepDate(date, locationId);
    if (!prev) return 0;
    const info = this.db
      .prepare(
        `INSERT INTO clearance_find (sweep_date, captured_at, location_id, item_id, category_slug,
            item_group, category_path, department, name, brand, image_url, product_url,
            now_cents, was_cents, savings_cents, discount_pct, aisle, in_stock)
         SELECT ?, captured_at, location_id, item_id, category_slug, item_group, category_path,
            department, name, brand, image_url, product_url, now_cents, was_cents,
            savings_cents, discount_pct, aisle, in_stock
         FROM clearance_find p
         WHERE p.sweep_date = ? AND p.location_id = ?
           AND NOT EXISTS (SELECT 1 FROM clearance_find t
                           WHERE t.sweep_date = ? AND t.location_id = p.location_id AND t.item_id = p.item_id)`,
      )
      .run(date, prev, locationId, date);
    return Number(info.changes);
  }

  // ---- sweep runs -------------------------------------------------------

  startSweep(date: string): number {
    const info = this.db
      .prepare('INSERT INTO sweep_run (sweep_date, started_at) VALUES (?,?)')
      .run(date, new Date().toISOString());
    return Number(info.lastInsertRowid);
  }

  finishSweep(id: number, storesSwept: number, finds: number, error: string | null): void {
    this.db
      .prepare('UPDATE sweep_run SET finished_at=?, stores_swept=?, finds_written=?, error=? WHERE id=?')
      .run(new Date().toISOString(), storesSwept, finds, error, id);
  }

  lastSweep(): {
    date: string;
    startedAt: string;
    finishedAt: string | null;
    storesSwept: number;
    finds: number;
    error: string | null;
  } | null {
    const r = this.db.prepare('SELECT * FROM sweep_run ORDER BY id DESC LIMIT 1').get() as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return {
      date: r['sweep_date'] as string,
      startedAt: r['started_at'] as string,
      finishedAt: (r['finished_at'] as string | null) ?? null,
      storesSwept: r['stores_swept'] as number,
      finds: r['finds_written'] as number,
      error: (r['error'] as string | null) ?? null,
    };
  }

  // ---- finds ------------------------------------------------------------

  /**
   * Writes one store's finds for one category. Returns the rows that are new
   * to this store — i.e. absent from that store's previous sweep — which is
   * what the watch terms alert on.
   */
  recordFinds(
    date: string,
    locationId: string,
    categorySlug: string,
    group: CategoryGroup,
    items: ClearanceItem[],
  ): { written: number; newItemIds: string[] } {
    if (items.length === 0) return { written: 0, newItemIds: [] };
    const previousDate = this.previousSweepDate(date, locationId);
    const seenBefore = new Set<string>(
      previousDate
        ? (
            this.db
              .prepare('SELECT item_id FROM clearance_find WHERE sweep_date = ? AND location_id = ?')
              .all(previousDate, locationId) as unknown as { item_id: string }[]
          ).map((r) => r.item_id)
        : [],
    );

    const stmt = this.db.prepare(
      `INSERT INTO clearance_find (sweep_date, captured_at, location_id, item_id, category_slug,
          item_group, category_path, department, name, brand, image_url, product_url,
          now_cents, was_cents, savings_cents, discount_pct, aisle, in_stock)
       VALUES (@sweep_date,@captured_at,@location_id,@item_id,@category_slug,@item_group,
          @category_path,@department,@name,@brand,@image_url,@product_url,
          @now_cents,@was_cents,@savings_cents,@discount_pct,@aisle,@in_stock)
       ON CONFLICT (sweep_date, location_id, item_id) DO UPDATE SET
          captured_at=excluded.captured_at, name=excluded.name, brand=excluded.brand,
          -- An item on several shelves takes the narrowest, whichever order
          -- they were swept in. Precedence mirrors narrowerGroup().
          item_group=CASE
            WHEN excluded.item_group = 'pc-parts' OR clearance_find.item_group = 'pc-parts' THEN 'pc-parts'
            WHEN excluded.item_group = 'video-games' OR clearance_find.item_group = 'video-games' THEN 'video-games'
            ELSE clearance_find.item_group END,
          category_path=excluded.category_path,
          department=excluded.department, image_url=excluded.image_url, product_url=excluded.product_url,
          now_cents=excluded.now_cents, was_cents=excluded.was_cents,
          savings_cents=excluded.savings_cents, discount_pct=excluded.discount_pct,
          aisle=excluded.aisle, in_stock=excluded.in_stock`,
    );

    const now = new Date().toISOString();
    const newItemIds: string[] = [];
    let written = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of items) {
        stmt.run({
          sweep_date: date,
          captured_at: now,
          location_id: locationId,
          item_id: item.itemId,
          category_slug: categorySlug,
          item_group: group,
          category_path: item.categoryPathId,
          department: item.department,
          name: item.name,
          brand: item.brand,
          image_url: item.imageUrl,
          product_url: item.productUrl,
          now_cents: item.nowCents,
          was_cents: item.wasCents,
          savings_cents: item.savingsCents,
          discount_pct: discountPercentOf(item.nowCents, item.wasCents),
          aisle: item.aisle,
          in_stock: item.inStock === null ? null : item.inStock ? 1 : 0,
        });
        written++;
        // With no previous sweep for this store, everything is "first seen"
        // rather than "new" — flagging the whole first run as new would bury
        // the user in alerts on day one.
        if (previousDate && !seenBefore.has(item.itemId)) newItemIds.push(item.itemId);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { written, newItemIds };
  }

  private previousSweepDate(date: string, locationId: string): string | null {
    const r = this.db
      .prepare(
        'SELECT MAX(sweep_date) AS d FROM clearance_find WHERE location_id = ? AND sweep_date < ?',
      )
      .get(locationId, date) as { d: string | null } | undefined;
    return r?.d ?? null;
  }

  /**
   * Distinct finds recorded for a date. `recordFinds` returns how many rows it
   * *wrote*, and an item Walmart lists on both the Electronics and the
   * Computers shelf is written twice and stored once — so counting writes
   * overstates the haul. This is the figure worth reporting.
   */
  countFinds(date: string, locationIds?: string[]): number {
    if (locationIds && locationIds.length === 0) return 0;
    const where = locationIds
      ? `sweep_date = ? AND location_id IN (${locationIds.map(() => '?').join(',')})`
      : 'sweep_date = ?';
    const params = locationIds ? [date, ...locationIds] : [date];
    return (
      this.db.prepare(`SELECT COUNT(*) AS c FROM clearance_find WHERE ${where}`).get(...params) as { c: number }
    ).c;
  }

  latestSweepDate(): string | null {
    const r = this.db.prepare('SELECT MAX(sweep_date) AS d FROM clearance_find').get() as
      | { d: string | null }
      | undefined;
    return r?.d ?? null;
  }

  query(filter: ClearanceFilter): { date: string | null; total: number; rows: ClearanceRow[] } {
    const date = filter.date ?? this.latestSweepDate();
    if (!date) return { date: null, total: 0, rows: [] };

    const where: string[] = ['f.sweep_date = ?'];
    const params: (string | number)[] = [date];

    if (filter.locationIds && filter.locationIds.length > 0) {
      where.push(`f.location_id IN (${filter.locationIds.map(() => '?').join(',')})`);
      params.push(...filter.locationIds);
    }
    if (filter.categorySlugs && filter.categorySlugs.length > 0) {
      where.push(`f.category_slug IN (${filter.categorySlugs.map(() => '?').join(',')})`);
      params.push(...filter.categorySlugs);
    }
    if (filter.groups && filter.groups.length > 0) {
      where.push(`f.item_group IN (${filter.groups.map(() => '?').join(',')})`);
      params.push(...filter.groups);
    }
    if (filter.q && filter.q.trim() !== '') {
      where.push('LOWER(f.name) LIKE ?');
      params.push(`%${filter.q.trim().toLowerCase()}%`);
    }
    if (filter.minDiscountPct && filter.minDiscountPct > 0) {
      where.push('f.discount_pct IS NOT NULL AND f.discount_pct >= ?');
      params.push(filter.minDiscountPct);
    }
    if (filter.maxCents != null) {
      where.push('f.now_cents IS NOT NULL AND f.now_cents <= ?');
      params.push(filter.maxCents);
    }
    if (filter.newOnly) {
      where.push(`NOT EXISTS (
        SELECT 1 FROM clearance_find p
        WHERE p.location_id = f.location_id AND p.item_id = f.item_id AND p.sweep_date < f.sweep_date)`);
    }

    const whereSql = where.join(' AND ');
    const order =
      filter.sort === 'price'
        ? 'f.now_cents IS NULL, f.now_cents ASC'
        : filter.sort === 'name'
          ? 'f.name ASC'
          : 'f.discount_pct IS NULL, f.discount_pct DESC, f.now_cents ASC';

    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM clearance_find f
           JOIN walmart_store s ON s.location_id = f.location_id WHERE ${whereSql}`,
        )
        .get(...params) as { c: number }
    ).c;

    const limit = Math.min(Math.max(filter.limit ?? 60, 1), 500);
    const offset = Math.max(filter.offset ?? 0, 0);
    const rows = this.db
      .prepare(`${ROW_SELECT} WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as Record<string, unknown>[];

    return { date, total, rows: rows.map((r) => this.toRow(r)) };
  }

  private toRow(r: Record<string, unknown>): ClearanceRow {
    return {
      id: r['id'] as number,
      sweepDate: r['sweep_date'] as string,
      capturedAt: r['captured_at'] as string,
      locationId: r['location_id'] as string,
      storeName: (r['store_name'] as string | null) ?? (r['location_id'] as string),
      storeCity: (r['store_city'] as string | null) ?? null,
      distanceMiles: (r['store_distance'] as number | null) ?? null,
      itemId: r['item_id'] as string,
      categorySlug: r['category_slug'] as string,
      group: r['item_group'] as CategoryGroup,
      categoryPath: (r['category_path'] as string | null) ?? null,
      department: (r['department'] as string | null) ?? null,
      name: r['name'] as string,
      brand: (r['brand'] as string | null) ?? null,
      imageUrl: (r['image_url'] as string | null) ?? null,
      productUrl: (r['product_url'] as string | null) ?? null,
      nowCents: (r['now_cents'] as number | null) ?? null,
      wasCents: (r['was_cents'] as number | null) ?? null,
      savingsCents: (r['savings_cents'] as number | null) ?? null,
      discountPct: (r['discount_pct'] as number | null) ?? null,
      aisle: (r['aisle'] as string | null) ?? null,
      inStock: r['in_stock'] === null || r['in_stock'] === undefined ? null : r['in_stock'] === 1,
      isNew: r['is_new'] === 1,
    };
  }

  // ---- the deal monitor --------------------------------------------------

  getMonitor(): DealMonitor {
    const r = this.db.prepare('SELECT * FROM deal_monitor WHERE id = 1').get() as Record<string, unknown>;
    return {
      minDiscount: r['min_discount'] as number,
      groups: String(r['groups'] ?? '')
        .split(',')
        .map((g) => g.trim())
        .filter(isCategoryGroup),
      enabled: r['enabled'] === 1,
      updatedAt: r['updated_at'] as string,
    };
  }

  setMonitor(patch: { minDiscount?: number; groups?: CategoryGroup[]; enabled?: boolean }): DealMonitor {
    const current = this.getMonitor();
    const next = {
      minDiscount: patch.minDiscount ?? current.minDiscount,
      groups: patch.groups ?? current.groups,
      enabled: patch.enabled ?? current.enabled,
    };
    this.db
      .prepare('UPDATE deal_monitor SET min_discount = ?, groups = ?, enabled = ?, updated_at = ? WHERE id = 1')
      .run(next.minDiscount, next.groups.join(','), next.enabled ? 1 : 0, new Date().toISOString());
    return this.getMonitor();
  }

  // ---- watches & alerts --------------------------------------------------

  listWatches(): ClearanceWatch[] {
    const rows = this.db
      .prepare('SELECT * FROM clearance_watch ORDER BY created_at DESC')
      .all() as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r['id'] as number,
      term: r['term'] as string,
      maxCents: (r['max_cents'] as number | null) ?? null,
      minDiscount: (r['min_discount'] as number | null) ?? null,
      createdAt: r['created_at'] as string,
    }));
  }

  addWatch(term: string, maxCents: number | null, minDiscount: number | null): ClearanceWatch {
    const normalized = term.trim().toLowerCase();
    if (normalized === '') throw new Error('watch term cannot be empty');
    this.db
      .prepare(
        `INSERT INTO clearance_watch (term, max_cents, min_discount, created_at) VALUES (?,?,?,?)
         ON CONFLICT (term) DO UPDATE SET max_cents=excluded.max_cents, min_discount=excluded.min_discount`,
      )
      .run(normalized, maxCents, minDiscount, new Date().toISOString());
    const row = this.db.prepare('SELECT * FROM clearance_watch WHERE term = ?').get(normalized) as
      Record<string, unknown>;
    return {
      id: row['id'] as number,
      term: row['term'] as string,
      maxCents: (row['max_cents'] as number | null) ?? null,
      minDiscount: (row['min_discount'] as number | null) ?? null,
      createdAt: row['created_at'] as string,
    };
  }

  removeWatch(id: number): boolean {
    return this.db.prepare('DELETE FROM clearance_watch WHERE id = ?').run(id).changes > 0;
  }

  /**
   * Matches one store's newly-appeared finds against every watch term and
   * records an alert per (watch, find). The UNIQUE constraint makes this
   * idempotent, so a resumed sweep cannot alert twice for the same find.
   */
  alertOnNewFinds(date: string, locationId: string, newItemIds: string[]): number {
    if (newItemIds.length === 0) return 0;
    const watches = this.listWatches();
    const monitor = this.getMonitor();
    if (watches.length === 0 && !monitor.enabled) return 0;

    const placeholders = newItemIds.map(() => '?').join(',');
    const finds = this.db
      .prepare(
        `${ROW_SELECT} WHERE f.sweep_date = ? AND f.location_id = ? AND f.item_id IN (${placeholders})`,
      )
      .all(date, locationId, ...newItemIds) as unknown as Record<string, unknown>[];

    const insert = this.db.prepare(
      `INSERT INTO clearance_alert (watch_id, find_id, created_at, message) VALUES (?,?,?,?)
       ON CONFLICT DO NOTHING`,
    );
    const now = new Date().toISOString();
    let created = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const raw of finds) {
        const row = this.toRow(raw);
        const haystack = `${row.name} ${row.brand ?? ''}`.toLowerCase();

        // The monitor fires on the shape of the deal, not on what it is.
        if (
          monitor.enabled &&
          row.discountPct !== null &&
          row.discountPct >= monitor.minDiscount &&
          (monitor.groups.length === 0 || monitor.groups.includes(row.group))
        ) {
          insert.run(null, row.id, now, describeFind(row));
          created++;
        }

        for (const watch of watches) {
          if (!haystack.includes(watch.term)) continue;
          if (watch.maxCents != null && (row.nowCents === null || row.nowCents > watch.maxCents)) continue;
          if (watch.minDiscount != null && (row.discountPct === null || row.discountPct < watch.minDiscount)) continue;
          insert.run(watch.id, row.id, now, describeFind(row));
          created++;
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return created;
  }

  listAlerts(opts: { unacknowledgedOnly?: boolean; limit?: number } = {}): ClearanceAlertRow[] {
    const where = opts.unacknowledgedOnly ? 'WHERE a.acknowledged = 0' : '';
    const rows = this.db
      .prepare(
        `SELECT a.id AS alert_id, a.created_at AS alert_created_at, a.message, a.acknowledged,
                w.term, f.*, s.name AS store_name, s.city AS store_city, s.distance_miles AS store_distance
         FROM clearance_alert a
         JOIN clearance_find f ON f.id = a.find_id
         JOIN walmart_store s ON s.location_id = f.location_id
         LEFT JOIN clearance_watch w ON w.id = a.watch_id
         ${where}
         ORDER BY a.created_at DESC LIMIT ?`,
      )
      .all(Math.min(Math.max(opts.limit ?? 50, 1), 200)) as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r['alert_id'] as number,
      createdAt: r['alert_created_at'] as string,
      message: r['message'] as string,
      acknowledged: r['acknowledged'] === 1,
      term: (r['term'] as string | null) ?? null,
      find: this.toRow(r),
    }));
  }

  acknowledgeAlert(id: number): boolean {
    return this.db.prepare('UPDATE clearance_alert SET acknowledged = 1 WHERE id = ?').run(id).changes > 0;
  }

  acknowledgeAllAlerts(): number {
    const info = this.db.prepare('UPDATE clearance_alert SET acknowledged = 1 WHERE acknowledged = 0').run();
    return Number(info.changes);
  }
}
