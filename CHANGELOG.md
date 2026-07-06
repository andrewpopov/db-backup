# Changelog

All notable changes to `@andrewvpopov/db-backup`. Versions are git tags
(`vX.Y.Z`); see STANDARDS.md.

## 0.2.0

Ports the genuinely-better features from sano-os `@sano/sqlite-backup` into the
consolidated package (BWK-85), so the whole estate shares them.

- **SQLite integrity verification**: after `.backup`, run `PRAGMA
  integrity_check` on the snapshot (when sqlite3 is available) and delete +
  throw if it isn't `ok` — a corrupt backup is worse than a loud failure.
- **`--allow-missing`**: a scheduled/deploy backup no-ops instead of failing
  when the SQLite database file doesn't exist yet (fresh installs).

## 0.1.0

Initial extraction from bewks `packages/db-backup-manager` (BWK-85), the base
for consolidating the two backup packages across the estate (bewks +
sano-os `@sano/sqlite-backup`).

- Age-tier retention policy (`DEFAULT_RETENTION_POLICY`, `planRetention`).
- SQLite online backup via `sqlite3 .backup`, optional gzip compression.
- Postgres backup via `pg_dump --format=custom`.
- Restore (SQLite + Postgres) with optional pre-restore backup.
- `runBackupJob`, `listBackupsWithPlan`, `restoreBackup`, `buildDailyCronEntry`,
  `runCli` CLI, and injectable `runtime` seams for testing.
- Ships the shared-package release loop (CI, `verify:pack`, STANDARDS) from the
  prisma-tools pilot.

Deferred to 0.2.0: port sano's `PRAGMA integrity_check` verification,
`--allow-missing` flag, and backup-prefix validation, then adopt in sano-os.
