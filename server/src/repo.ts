/**
 * Persistence for products, price history, watchlists and alerts.
 * All SQL lives here; routes and jobs work in domain terms.
 */
import type { DB } from './db.js';
import type { Offer, PriceSnapshot, PromoDetail, PromoKind, StoreId } from './price/model.js';
import { diffSnapshots, severityOf, type PriceChange } from './price/diff.js';
import { discountPercent } from './price/model.js';

export interface DealFilter {
  /** minimum percent off the regular unit price (0 = any) */
  minDiscountPct?: number;
  /** restrict to these promo kinds (e.g. only BOGO); empty = any */
  promoKinds?: PromoKind[];
  /** only rows carrying some promotion at all */
  onSaleOnly?: boolean;
  stores?: StoreId[];
  /** 'discount' (default), 'price' (cheapest unit), 'name' */
  sort?: 'discount' | 'price' | 'name';
  limit?: number;
  offset?: number;
  /** which day's snapshot to read; defaults to the latest */
  date?: string;
}

export interface DealRow {
  storeId: StoreId;
  storeProductId: string;
  name: string;
  brand: string | null;
  size: string | null;
  category: string | null;
  imageUrl: string | null;
  productUrl: string | null;
  regularCents: number | null;
  currentCents: number | null;
  effectiveUnitCents: number | null;
  discountPct: number | null;
  promoKind: PromoKind;
  promoText: string | null;
  unitPriceText: string | null;
  inStock: boolean | null;
}

export interface SnapshotOffer {
  offer: Offer;
  locationId: string | null;
}

export interface StoredProduct {
  id: number;
  storeId: StoreId;
  storeProductId: string;
  name: string;
  brand: string | null;
  size: string | null;
  imageUrl: string | null;
  productUrl: string | null;
  category: string | null;
}

export interface WatchGroup {
  id: number;
  label: string;
  createdAt: string;
  targetCents: number | null;
  notifyPromos: boolean;
}

export interface WatchEntry {
  watchItemId: number;
  product: StoredProduct;
  locationId: string | null;
  price: PriceSnapshot | null;
  previousPrice: PriceSnapshot | null;
}

export interface WatchGroupView extends WatchGroup {
  items: WatchEntry[];
  /** cheapest effective unit price across the group's stores, if any */
  bestCents: number | null;
  bestStoreId: StoreId | null;
}

export interface AlertRow {
  id: number;
  createdAt: string;
  kind: string;
  numeric: boolean;
  severity: string;
  fromCents: number | null;
  toCents: number | null;
  deltaCents: number | null;
  deltaPercent: number | null;
  message: string;
  acknowledged: boolean;
  productName: string;
  storeId: StoreId;
  groupId: number | null;
  groupLabel: string | null;
}

interface PriceRow {
  captured_at: string;
  regular_cents: number | null;
  current_cents: number | null;
  effective_unit_cents: number | null;
  promo_kind: string;
  promo_text: string | null;
  promo_detail_json: string | null;
  unit_price_text: string | null;
  in_stock: number | null;
}

function rowToSnapshot(r: PriceRow): PriceSnapshot {
  return {
    regularCents: r.regular_cents,
    currentCents: r.current_cents,
    effectiveUnitCents: r.effective_unit_cents,
    promoKind: r.promo_kind as PromoKind,
    promoText: r.promo_text,
    promoDetail: r.promo_detail_json ? (JSON.parse(r.promo_detail_json) as PromoDetail) : null,
    unitPriceText: r.unit_price_text,
    inStock: r.in_stock === null ? null : r.in_stock === 1,
    capturedAt: r.captured_at,
  };
}

export class Repo {
  constructor(private db: DB) {}

  upsertProduct(offer: Offer): StoredProduct {
    const p = offer.product;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO product (store_id, store_product_id, name, brand, size, image_url, product_url, category, first_seen_at, last_seen_at)
         VALUES (@store_id, @store_product_id, @name, @brand, @size, @image_url, @product_url, @category, @now, @now)
         ON CONFLICT (store_id, store_product_id) DO UPDATE SET
           name = excluded.name, brand = excluded.brand, size = excluded.size,
           image_url = excluded.image_url, product_url = excluded.product_url,
           category = excluded.category, last_seen_at = excluded.last_seen_at`,
      )
      .run({
        store_id: p.storeId,
        store_product_id: p.storeProductId,
        name: p.name,
        brand: p.brand,
        size: p.size,
        image_url: p.imageUrl,
        product_url: p.productUrl,
        category: p.category,
        now,
      });
    return this.getProduct(p.storeId, p.storeProductId)!;
  }

  getProduct(storeId: StoreId, storeProductId: string): StoredProduct | null {
    const r = this.db
      .prepare('SELECT * FROM product WHERE store_id = ? AND store_product_id = ?')
      .get(storeId, storeProductId) as Record<string, unknown> | undefined;
    return r ? this.mapProduct(r) : null;
  }

  getProductById(id: number): StoredProduct | null {
    const r = this.db.prepare('SELECT * FROM product WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.mapProduct(r) : null;
  }

  private mapProduct(r: Record<string, unknown>): StoredProduct {
    return {
      id: r['id'] as number,
      storeId: r['store_id'] as StoreId,
      storeProductId: r['store_product_id'] as string,
      name: r['name'] as string,
      brand: (r['brand'] as string | null) ?? null,
      size: (r['size'] as string | null) ?? null,
      imageUrl: (r['image_url'] as string | null) ?? null,
      productUrl: (r['product_url'] as string | null) ?? null,
      category: (r['category'] as string | null) ?? null,
    };
  }

  latestPrice(productId: number, locationId: string | null): PriceSnapshot | null {
    const r = this.db
      .prepare(
        `SELECT * FROM price_point WHERE product_id = ? AND (location_id IS ? OR location_id = ?)
         ORDER BY captured_at DESC, id DESC LIMIT 1`,
      )
      .get(productId, locationId, locationId) as unknown as PriceRow | undefined;
    return r ? rowToSnapshot(r) : null;
  }

  priceHistory(productId: number, locationId: string | null, limit = 200): PriceSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM price_point WHERE product_id = ? AND (location_id IS ? OR location_id = ?)
         ORDER BY captured_at DESC, id DESC LIMIT ?`,
      )
      .all(productId, locationId, locationId, limit) as unknown as PriceRow[];
    return rows.map(rowToSnapshot).reverse();
  }

  insertPrice(productId: number, locationId: string | null, price: PriceSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO price_point (product_id, location_id, captured_at, regular_cents, current_cents,
            effective_unit_cents, promo_kind, promo_text, promo_detail_json, unit_price_text, in_stock)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        productId,
        locationId,
        price.capturedAt,
        price.regularCents,
        price.currentCents,
        price.effectiveUnitCents,
        price.promoKind,
        price.promoText,
        price.promoDetail ? JSON.stringify(price.promoDetail) : null,
        price.unitPriceText,
        price.inStock === null ? null : price.inStock ? 1 : 0,
      );
  }

  /**
   * Records a fresh reading and returns whatever changed since the previous
   * one. The first reading for a product never alerts — there is nothing to
   * compare it against.
   */
  recordPrice(productId: number, locationId: string | null, price: PriceSnapshot): PriceChange[] {
    const previous = this.latestPrice(productId, locationId);
    this.insertPrice(productId, locationId, price);
    if (!previous) return [];
    const changes = diffSnapshots(previous, price);
    for (const change of changes) {
      const groups = this.db
        .prepare(
          `SELECT wg.id AS gid, wg.target_cents, wg.notify_promos FROM watch_item wi
             JOIN watch_group wg ON wg.id = wi.group_id
            WHERE wi.product_id = ?`,
        )
        .all(productId) as unknown as { gid: number; target_cents: number | null; notify_promos: number }[];
      const severity = severityOf(change);
      if (groups.length === 0) {
        this.insertAlert(productId, null, change, severity);
        continue;
      }
      for (const g of groups) {
        if (!change.numeric && g.notify_promos === 0) continue;
        // A target price turns any drop that reaches it into an urgent alert.
        const hitsTarget =
          g.target_cents != null && change.toCents != null && change.toCents <= g.target_cents;
        this.insertAlert(productId, g.gid, change, hitsTarget ? 'urgent' : severity);
      }
    }
    return changes;
  }

  private insertAlert(productId: number, groupId: number | null, c: PriceChange, severity: string): void {
    this.db
      .prepare(
        `INSERT INTO alert (product_id, group_id, created_at, kind, numeric_change, severity,
            from_cents, to_cents, delta_cents, delta_percent, message)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        productId,
        groupId,
        new Date().toISOString(),
        c.kind,
        c.numeric ? 1 : 0,
        severity,
        c.fromCents,
        c.toCents,
        c.deltaCents,
        c.deltaPercent,
        c.message,
      );
  }

  createGroup(label: string, targetCents: number | null, notifyPromos: boolean): WatchGroup {
    const info = this.db
      .prepare('INSERT INTO watch_group (label, created_at, target_cents, notify_promos) VALUES (?,?,?,?)')
      .run(label, new Date().toISOString(), targetCents, notifyPromos ? 1 : 0);
    return this.getGroup(Number(info.lastInsertRowid))!;
  }

  updateGroup(id: number, patch: { label?: string; targetCents?: number | null; notifyPromos?: boolean }): WatchGroup | null {
    const current = this.getGroup(id);
    if (!current) return null;
    this.db
      .prepare('UPDATE watch_group SET label = ?, target_cents = ?, notify_promos = ? WHERE id = ?')
      .run(
        patch.label ?? current.label,
        patch.targetCents === undefined ? current.targetCents : patch.targetCents,
        (patch.notifyPromos ?? current.notifyPromos) ? 1 : 0,
        id,
      );
    return this.getGroup(id);
  }

  getGroup(id: number): WatchGroup | null {
    const r = this.db.prepare('SELECT * FROM watch_group WHERE id = ?').get(id) as unknown as
      | { id: number; label: string; created_at: string; target_cents: number | null; notify_promos: number }
      | undefined;
    if (!r) return null;
    return {
      id: r.id,
      label: r.label,
      createdAt: r.created_at,
      targetCents: r.target_cents,
      notifyPromos: r.notify_promos === 1,
    };
  }

  deleteGroup(id: number): void {
    this.db.prepare('DELETE FROM watch_group WHERE id = ?').run(id);
  }

  addToGroup(groupId: number, productId: number, locationId: string | null): number {
    const info = this.db
      .prepare(
        `INSERT INTO watch_item (group_id, product_id, location_id, added_at) VALUES (?,?,?,?)
         ON CONFLICT (group_id, product_id) DO UPDATE SET location_id = excluded.location_id`,
      )
      .run(groupId, productId, locationId, new Date().toISOString());
    return Number(info.lastInsertRowid);
  }

  removeWatchItem(watchItemId: number): void {
    this.db.prepare('DELETE FROM watch_item WHERE id = ?').run(watchItemId);
  }

  listWatchItems(): { id: number; productId: number; locationId: string | null }[] {
    return this.db.prepare('SELECT id, product_id AS productId, location_id AS locationId FROM watch_item').all() as unknown as {
      id: number;
      productId: number;
      locationId: string | null;
    }[];
  }

  listGroups(): WatchGroupView[] {
    const groups = this.db.prepare('SELECT id FROM watch_group ORDER BY created_at DESC').all() as unknown as { id: number }[];
    return groups.map((g) => this.groupView(g.id)!).filter(Boolean);
  }

  groupView(groupId: number): WatchGroupView | null {
    const group = this.getGroup(groupId);
    if (!group) return null;
    const rows = this.db
      .prepare('SELECT id, product_id, location_id FROM watch_item WHERE group_id = ? ORDER BY id')
      .all(groupId) as unknown as { id: number; product_id: number; location_id: string | null }[];

    const items: WatchEntry[] = rows.map((r) => {
      const history = this.priceHistory(r.product_id, r.location_id, 2);
      return {
        watchItemId: r.id,
        product: this.getProductById(r.product_id)!,
        locationId: r.location_id,
        price: history.at(-1) ?? null,
        previousPrice: history.length > 1 ? history.at(-2)! : null,
      };
    });

    let bestCents: number | null = null;
    let bestStoreId: StoreId | null = null;
    for (const item of items) {
      const c = item.price?.effectiveUnitCents;
      if (c != null && (bestCents === null || c < bestCents)) {
        bestCents = c;
        bestStoreId = item.product.storeId;
      }
    }
    return { ...group, items, bestCents, bestStoreId };
  }

  listAlerts(opts: { limit?: number; unacknowledgedOnly?: boolean } = {}): AlertRow[] {
    const rows = this.db
      .prepare(
        `SELECT a.*, p.name AS product_name, p.store_id, wg.label AS group_label
           FROM alert a
           JOIN product p ON p.id = a.product_id
           LEFT JOIN watch_group wg ON wg.id = a.group_id
          WHERE (? = 0 OR a.acknowledged = 0)
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT ?`,
      )
      .all(opts.unacknowledgedOnly ? 1 : 0, opts.limit ?? 100) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r['id'] as number,
      createdAt: r['created_at'] as string,
      kind: r['kind'] as string,
      numeric: r['numeric_change'] === 1,
      severity: r['severity'] as string,
      fromCents: (r['from_cents'] as number | null) ?? null,
      toCents: (r['to_cents'] as number | null) ?? null,
      deltaCents: (r['delta_cents'] as number | null) ?? null,
      deltaPercent: (r['delta_percent'] as number | null) ?? null,
      message: r['message'] as string,
      acknowledged: r['acknowledged'] === 1,
      productName: r['product_name'] as string,
      storeId: r['store_id'] as StoreId,
      groupId: (r['group_id'] as number | null) ?? null,
      groupLabel: (r['group_label'] as string | null) ?? null,
    }));
  }

  acknowledgeAlert(id: number): void {
    this.db.prepare('UPDATE alert SET acknowledged = 1 WHERE id = ?').run(id);
  }

  acknowledgeAll(): void {
    this.db.prepare('UPDATE alert SET acknowledged = 1 WHERE acknowledged = 0').run();
  }

  startPollRun(storeId: string | null): number {
    const info = this.db
      .prepare('INSERT INTO poll_run (started_at, store_id) VALUES (?,?)')
      .run(new Date().toISOString(), storeId);
    return Number(info.lastInsertRowid);
  }

  finishPollRun(id: number, itemsPolled: number, changes: number, error: string | null): void {
    this.db
      .prepare('UPDATE poll_run SET finished_at = ?, items_polled = ?, changes = ?, error = ? WHERE id = ?')
      .run(new Date().toISOString(), itemsPolled, changes, error, id);
  }

  lastPollRun(): { startedAt: string; finishedAt: string | null; itemsPolled: number; changes: number; error: string | null } | null {
    const r = this.db.prepare('SELECT * FROM poll_run ORDER BY id DESC LIMIT 1').get() as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      startedAt: r['started_at'] as string,
      finishedAt: (r['finished_at'] as string | null) ?? null,
      itemsPolled: r['items_polled'] as number,
      changes: r['changes'] as number,
      error: (r['error'] as string | null) ?? null,
    };
  }

  // ---- daily snapshot / deals -------------------------------------------

  startSnapshotRun(date: string, stores: string): number {
    const info = this.db
      .prepare('INSERT INTO snapshot_run (snapshot_date, started_at, stores) VALUES (?,?,?)')
      .run(date, new Date().toISOString(), stores);
    return Number(info.lastInsertRowid);
  }

  finishSnapshotRun(id: number, rows: number, error: string | null): void {
    this.db
      .prepare('UPDATE snapshot_run SET finished_at = ?, rows_written = ?, error = ? WHERE id = ?')
      .run(new Date().toISOString(), rows, error, id);
  }

  /**
   * Writes a batch of offers as one day's snapshot rows in a single
   * transaction. Idempotent per (date, store, location, product): re-running a
   * day overwrites rather than duplicating, so a retried job is safe.
   */
  recordSnapshot(date: string, offers: SnapshotOffer[]): number {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO daily_snapshot (snapshot_date, captured_at, store_id, location_id, store_product_id,
          name, brand, size, category, image_url, product_url, regular_cents, current_cents,
          effective_unit_cents, discount_pct, promo_kind, promo_text, unit_price_text, in_stock)
       VALUES (@date,@now,@store_id,@location_id,@store_product_id,@name,@brand,@size,@category,
          @image_url,@product_url,@regular_cents,@current_cents,@effective_unit_cents,@discount_pct,
          @promo_kind,@promo_text,@unit_price_text,@in_stock)
       ON CONFLICT (snapshot_date, store_id, location_id, store_product_id) DO UPDATE SET
          captured_at=excluded.captured_at, name=excluded.name, brand=excluded.brand, size=excluded.size,
          category=excluded.category, image_url=excluded.image_url, product_url=excluded.product_url,
          regular_cents=excluded.regular_cents, current_cents=excluded.current_cents,
          effective_unit_cents=excluded.effective_unit_cents, discount_pct=excluded.discount_pct,
          promo_kind=excluded.promo_kind, promo_text=excluded.promo_text,
          unit_price_text=excluded.unit_price_text, in_stock=excluded.in_stock`,
    );
    let n = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const { offer, locationId } of offers) {
        const p = offer.price;
        stmt.run({
          date,
          now,
          store_id: offer.product.storeId,
          location_id: locationId,
          store_product_id: offer.product.storeProductId,
          name: offer.product.name,
          brand: offer.product.brand,
          size: offer.product.size,
          category: offer.product.category,
          image_url: offer.product.imageUrl,
          product_url: offer.product.productUrl,
          regular_cents: p.regularCents,
          current_cents: p.currentCents,
          effective_unit_cents: p.effectiveUnitCents,
          discount_pct: discountPercent(p),
          promo_kind: p.promoKind,
          promo_text: p.promoText,
          unit_price_text: p.unitPriceText,
          in_stock: p.inStock === null ? null : p.inStock ? 1 : 0,
        });
        n++;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return n;
  }

  latestSnapshotDate(): string | null {
    const r = this.db.prepare('SELECT MAX(snapshot_date) AS d FROM daily_snapshot').get() as
      | { d: string | null }
      | undefined;
    return r?.d ?? null;
  }

  snapshotDates(limit = 60): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT snapshot_date FROM daily_snapshot ORDER BY snapshot_date DESC LIMIT ?')
      .all(limit) as unknown as { snapshot_date: string }[];
    return rows.map((r) => r.snapshot_date);
  }

  lastSnapshotRun(): { date: string; startedAt: string; finishedAt: string | null; rows: number; error: string | null } | null {
    const r = this.db.prepare('SELECT * FROM snapshot_run ORDER BY id DESC LIMIT 1').get() as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return {
      date: r['snapshot_date'] as string,
      startedAt: r['started_at'] as string,
      finishedAt: (r['finished_at'] as string | null) ?? null,
      rows: r['rows_written'] as number,
      error: (r['error'] as string | null) ?? null,
    };
  }

  /** Filter one day's snapshot by discount / promo / store — the deals feed. */
  queryDeals(filter: DealFilter): { date: string | null; total: number; rows: DealRow[] } {
    const date = filter.date ?? this.latestSnapshotDate();
    if (!date) return { date: null, total: 0, rows: [] };

    const where: string[] = ['snapshot_date = ?'];
    const params: (string | number)[] = [date];

    if (filter.stores && filter.stores.length > 0) {
      where.push(`store_id IN (${filter.stores.map(() => '?').join(',')})`);
      params.push(...filter.stores);
    }
    if (filter.onSaleOnly) where.push("promo_kind != 'none'");
    if (filter.minDiscountPct && filter.minDiscountPct > 0) {
      where.push('discount_pct IS NOT NULL AND discount_pct >= ?');
      params.push(filter.minDiscountPct);
    }
    if (filter.promoKinds && filter.promoKinds.length > 0) {
      where.push(`promo_kind IN (${filter.promoKinds.map(() => '?').join(',')})`);
      params.push(...filter.promoKinds);
    }

    const order =
      filter.sort === 'price'
        ? 'effective_unit_cents IS NULL, effective_unit_cents ASC'
        : filter.sort === 'name'
          ? 'name ASC'
          : 'discount_pct IS NULL, discount_pct DESC, effective_unit_cents ASC';

    const whereSql = where.join(' AND ');
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM daily_snapshot WHERE ${whereSql}`).get(...params) as { c: number }).c;

    const limit = Math.min(Math.max(filter.limit ?? 60, 1), 500);
    const offset = Math.max(filter.offset ?? 0, 0);
    const rows = this.db
      .prepare(`SELECT * FROM daily_snapshot WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as Record<string, unknown>[];

    return {
      date,
      total,
      rows: rows.map((r) => ({
        storeId: r['store_id'] as StoreId,
        storeProductId: r['store_product_id'] as string,
        name: r['name'] as string,
        brand: (r['brand'] as string | null) ?? null,
        size: (r['size'] as string | null) ?? null,
        category: (r['category'] as string | null) ?? null,
        imageUrl: (r['image_url'] as string | null) ?? null,
        productUrl: (r['product_url'] as string | null) ?? null,
        regularCents: (r['regular_cents'] as number | null) ?? null,
        currentCents: (r['current_cents'] as number | null) ?? null,
        effectiveUnitCents: (r['effective_unit_cents'] as number | null) ?? null,
        discountPct: (r['discount_pct'] as number | null) ?? null,
        promoKind: r['promo_kind'] as PromoKind,
        promoText: (r['promo_text'] as string | null) ?? null,
        unitPriceText: (r['unit_price_text'] as string | null) ?? null,
        inStock: r['in_stock'] === null ? null : r['in_stock'] === 1,
      })),
    };
  }
}
