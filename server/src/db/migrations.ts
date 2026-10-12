/**
 * Ordered, individually-named schema migrations.
 *
 * Each entry runs once, in version order, inside one `BEGIN IMMEDIATE`
 * transaction, and the runner records `(version, name, applied_at)` afterwards.
 * A migration with a `guard` reports itself as already-applied when that
 * predicate holds, which is what lets the same entry be correct on a database
 * that `CREATE TABLE IF NOT EXISTS` in `db.ts` already built in its new shape
 * and on one that still carries the old shape — the ALTERs are what move the
 * second, and the guard is what stops them from failing the first.
 *
 * New migrations go at the end. Never renumber or delete an entry: the rows of
 * older migrations live in production databases.
 */

/** The id a read through the process's own egress is budgeted under. */
export const LOCAL_EGRESS_NODE_ID = 'local';

export interface Migration {
  /** Monotonically increasing; never reused. */
  version: number;
  /** short snake_case identifier; appears in `schema_migrations.name` */
  name: string;
  /** SQL to run inside one transaction. */
  sql: string;
  /** true when the change this entry makes is already present. */
  guard?: (db: Sqlite) => boolean;
}

/** The slice of `DatabaseSync` the runner and guards need. */
type Sqlite = {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): unknown;
  };
  exec(sql: string): void;
};

const bootstrap: Migration = {
  version: 1,
  name: 'bootstrap',
  // No DDL: the SCHEMA / EXTRA_SCHEMA blocks in db.ts already create every table
  // this entry represents. It exists to anchor the migration table at version 1.
  sql: 'SELECT 1',
};

/**
 * Byte-aware, node-aware host budget.
 *
 * `host_budget` was `host TEXT PRIMARY KEY`, so per-node ledgers could only be
 * faked by concatenating the node id into the host string (`www.walmart.com:<id>`)
 * — which is why the request log could not attribute bytes to a node either.
 * Three changes, one entry, so a database is never half-migrated:
 *
 *   1. `request_log.egress_node_id` — which exit point a read went out through.
 *   2. `host_budget.bytes_in_window` — bytes, not just reads, spent this window.
 *   3. `host_budget` rebuilt on `(host, egress_node_id)` with an FK to
 *      `egress_node(id) ON DELETE CASCADE`, so retiring a node retires its
 *      ledger. SQLite cannot ALTER a primary key, hence the rebuild.
 *
 * The rebuild maps a legacy `www.walmart.com:<nodeId>` row onto the real
 * (host, node) pair when that node still exists, and onto the process's own
 * egress otherwise — a concatenated key was all the old schema could express.
 */
const host_budget_node_key: Migration = {
  version: 9,
  name: 'host_budget_node_key',
  guard: (db) => {
    if (!hasColumn(db, 'request_log', 'egress_node_id')) return false;
    if (!hasColumn(db, 'host_budget', 'bytes_in_window')) return false;
    return primaryKeyColumns(db, 'host_budget').join(',') === 'host,egress_node_id';
  },
  sql: [
    `ALTER TABLE request_log ADD COLUMN egress_node_id TEXT`,
    `ALTER TABLE host_budget ADD COLUMN bytes_in_window INTEGER NOT NULL DEFAULT 0`,
    // The rebuilt table: composite key, byte column, and the cascade that makes
    // `DELETE FROM egress_node` retire the node's ledger with it.
    `CREATE TABLE host_budget_new (
       host            TEXT NOT NULL,
       egress_node_id  TEXT NOT NULL REFERENCES egress_node(id) ON DELETE CASCADE,
       not_before      INTEGER NOT NULL DEFAULT 0,
       window_started_at INTEGER NOT NULL DEFAULT 0,
       reads_in_window INTEGER NOT NULL DEFAULT 0,
       bytes_in_window INTEGER NOT NULL DEFAULT 0,
       last_status     INTEGER,
       updated_at      TEXT NOT NULL,
       PRIMARY KEY (host, egress_node_id)
     )`,
    `INSERT INTO host_budget_new
       (host, egress_node_id, not_before, window_started_at, reads_in_window,
        bytes_in_window, last_status, updated_at)
     SELECT
       CASE WHEN instr(b.host, ':') > 0 AND EXISTS (
              SELECT 1 FROM egress_node e
               WHERE e.id = substr(b.host, instr(b.host, ':') + 1))
            THEN substr(b.host, 1, instr(b.host, ':') - 1)
            ELSE b.host END,
       CASE WHEN instr(b.host, ':') > 0 AND EXISTS (
              SELECT 1 FROM egress_node e
               WHERE e.id = substr(b.host, instr(b.host, ':') + 1))
            THEN substr(b.host, instr(b.host, ':') + 1)
            ELSE '${LOCAL_EGRESS_NODE_ID}' END,
       b.not_before, b.window_started_at, b.reads_in_window,
       0, b.last_status, b.updated_at
     FROM host_budget b
     GROUP BY 1, 2`,
    `DROP TABLE host_budget`,
    `ALTER TABLE host_budget_new RENAME TO host_budget`,
  ].join(';\n'),
};

export const MIGRATIONS: Migration[] = [bootstrap, host_budget_node_key];

const SCHEMA_MIGRATIONS = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`;

// A duplicate-column error means this exact ALTER already happened on this
// database. SQLite has no conditional DDL, so the runner recognises it and
// records the migration rather than failing a boot over a no-op.
const ALREADY_APPLIED = /duplicate column name|already exists/i;

function hasColumn(db: Sqlite, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

/** The declared key columns, in declaration order — `[]` for a keyless table. */
function primaryKeyColumns(db: Sqlite, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[])
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
}

/** Applies every migration this database has not recorded. */
export function applyMigrations(db: Sqlite): number {
  db.exec(SCHEMA_MIGRATIONS);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  );
  const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)');
  let count = 0;
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    // The guard is the fresh-database path: db.ts has already created the new
    // shape, so there is nothing to do but write down that we looked.
    if (!m.guard || !m.guard(db)) {
      try {
        db.exec('BEGIN IMMEDIATE');
        db.exec(m.sql);
        db.exec('COMMIT');
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* the transaction never opened */
        }
        if (!ALREADY_APPLIED.test(err instanceof Error ? err.message : String(err))) throw err;
      }
    }
    record.run(m.version, m.name, new Date().toISOString());
    count++;
  }
  return count;
}
