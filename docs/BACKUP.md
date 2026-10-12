# Backup and Parquet archive

Bastille takes two nightly artefacts every day at 03:00 local (overridable
via `BASTILLE_BACKUP_HOUR`):

1. **`data/backups/bastille-<UTC-ISO>.db`** — a SQLite snapshot produced
   with `VACUUM INTO`. The whole database, clean and online-restoreable.
2. **`data/archive/<YYYY-MM-DD>/`** — three Parquet files, one per source
   table: `daily_snapshot.parquet`, `product.parquet`, `price_point.parquet`.
   Each directory also has a `manifest.json` carrying the Parquet schema
   version (currently `1`) and the list of tables exported.

The Parquet library is `hyparquet-writer` (with `hyparquet` for read-side
verification) — chosen because it is pure JavaScript, ESM-only, actively
maintained, has no native dependencies, and ships a column-based write API
that fits SQLite's column-oriented tables directly.

## Rotation

`BASTILLE_BACKUP_KEEP` (default `14`) is the number of most-recent artefacts
to retain per kind. Older VACUUM files are deleted from
`data/backups/`, older `data/archive/<date>/` directories are deleted
recursively, and the corresponding rows are removed from `backup_log` so
the table and the filesystem never disagree. Each cycle also drops
`backup_log` rows whose file no longer exists (e.g. after a manual `rm`).

## Restore

A backup is a normal SQLite file — open it directly:

```
sqlite3 data/backups/bastille-2026-10-12T03-00-00-000Z.db ".schema"
```

To swap it in over a running database, stop the server, copy the file over
`data/bastille.db`, and restart. The migration runner will record the
schema and run any pending migrations from there.

## Querying the Parquet archive

The Parquet files are readable by any tool that understands the format —
DuckDB, pandas, polars, Apache Spark. For example, with DuckDB:

```
duckdb -c "SELECT snapshot_date, COUNT(*) FROM read_parquet('data/archive/2026-10-12/daily_snapshot.parquet') GROUP BY 1"
```

`data/archive/<date>/manifest.json` records the schema version, so a reader
can refuse a directory that came from a version it doesn't understand.