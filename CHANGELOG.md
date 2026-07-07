# Changelog

All notable changes to `@andrewpopov/db-backup`. Versions are git tags
(`vX.Y.Z`); see STANDARDS.md.

## 0.5.0

Maturation pass: hardens integrity/consistency around backup and restore, and
fixes lingering `@bewks`/`db-backup-manager` references left over from the
BWK-85 extraction. Additive — all existing `backup`/`restore`/`list`/`prune`
behavior and defaults are unchanged.

- **Fix**: README title, Usage/recipes/cron examples, the programmatic
  `require(...)` snippet, and the CLI's own `--help` usage line all still said
  `@bewks/db-backup-manager` / `db-backup-manager`. Replaced everywhere with
  `@andrewpopov/db-backup` / `db-backup`. Added an `## Install` section
  (`npm install github:andrewpopov/db-backup#v0.5.0`).
- **Fix — clock-skew retention safety**: a future-dated backup filename (clock
  skew) could sort as "newest" and starve a real daily slot. `listBackups` /
  `getBackupEntryFromPath` now clamp the derived `ageDays` to a minimum of 0
  (display-only; `createdAt` stays truthful), and `planRetention` now sorts by
  an *effective* time (`Math.min(createdAt, now)`) so a future-dated backup
  can no longer out-rank the actual newest backup for daily slot 1.
  `chooseAnchorCandidate`'s recomputed `ageDays` is clamped the same way.
- **Postgres backup verification**: after `pg_dump`, `pg_restore --list` reads
  the archive's table of contents (no database touched) as a structural sanity
  check, mirroring the existing SQLite `PRAGMA integrity_check`. On failure the
  dump is deleted and the backup throws. Skipped (dump kept) when `pg_restore`
  isn't installed, matching the SQLite cp-fallback's skip behavior.
- **Advisory lock around `backup` and `prune`**: a `.db-backup.lock` file
  (atomic `O_EXCL` create) in `outputDir` prevents two concurrent db-backup
  runs from racing each other. A live lock throws `Another db-backup run holds
  the lock`; a stale lock (default: older than 30 minutes) is safely stolen.
  `prune` still no-ops without locking when `outputDir` doesn't exist yet.
- **sha256 + manifest wiring**: `runBackupJob`'s created backup now carries a
  `sha256` (new optional field on `BackupEntry`/`BackupManifestEntry`), and a
  manifest entry is appended best-effort (a manifest write failure is logged
  via `console.warn` and never fails the backup itself). Pre-restore safety
  backups are intentionally NOT manifested — they're transient.
  `restoreBackup` now verifies the selected backup's bytes against its
  manifest checksum (read from the backup file's own directory, so an
  absolute `--file` outside `outputDir` is still checked) before touching the
  live database, throwing `Backup checksum mismatch` on a mismatch. Backups
  with no manifest entry, or an entry with no `sha256` (older backups), skip
  the check.
- **SQLite restore validation**: before a restore overwrites the live
  database, the restored bytes are integrity-checked (`PRAGMA
  integrity_check`) on the TEMP file — never on the live destination — using a
  new, non-deleting `assertSqliteIntegrity`. A failure cleans up only the temp
  file and throws; the live database is never touched, even with
  `--no-pre-backup`. Skipped when `sqlite3` isn't installed. (Postgres restores
  get no equivalent check in this release — it would require a live database
  connection.)
- CI: added a non-required `compat` matrix job (Node 22/24) and a `ci-success`
  aggregation job, plus a `verify:types` step/script backed by a new
  `tsconfig.types.json` + `scripts/types-consumer.ts` type contract test
  against `src/index.d.ts` (new `typescript` devDependency).
- Expanded test coverage: restore round-trip via the cp-fallback path,
  `--latest` restore selection, engine-mismatch restore, a truncated `.gz`
  backup leaving the live DB untouched, `planRetention` edge cases (dailySlots
  exceeding maxBackups, an empty backup list, the future-dated starvation
  case), the sqlite3 locked-database retry path, and `loadEnvironment`'s
  prod-mode env-file precedence and strict-production-env guard.
## 0.4.1

- Renamed package scope `@andrewvpopov/*` -> `@andrewpopov/*` after consolidating the GitHub org into the `andrewpopov` user. No runtime or API change; update imports and the `github:` install path to `andrewpopov/db-backup`.

## 0.4.0

Operational retention/cleanup surface (requested by sano-os). Additive — all
existing `backup`/`restore`/`list` behavior and defaults are unchanged.

- **Configurable retention** from the CLI/env instead of a hard-coded policy:
  `--max-backups <n>` / `--daily-slots <n>`, or `DB_BACKUP_MAX_BACKUPS` /
  `DB_BACKUP_DAILY_SLOTS`. Precedence: flag > env > default. The age-tier
  anchors stay policy-owned. New export `resolveRetentionPolicy()`.
- **`prune` command**: apply the retention policy to an existing backup
  directory without creating a new snapshot — a standalone cleanup pass. New
  export `pruneBackupsJob()`.
- **Fix**: `list` (and the new `prune`) no longer require `DATABASE_URL`. They
  operate purely on the backup directory and never open the database;
  previously `list` failed with `DATABASE_URL is missing`. Programmatic callers
  can pass `requireDatabaseUrl: false` on any `BackupOptions`.
- **`cron` emits a usable entry**: it now reflects `--output-dir`, `--prod`, and
  `--allow-missing` into a `npx db-backup backup ...` command (resolves the
  local bin under npm and pnpm) and defaults the log path to
  `<output-dir>/backup.log`. Override the whole command with `--command` and the
  log with `--log-path`. Previously it hard-coded `npm run db:backup -- --prod`.
- Hardening: retention counts are strictly validated (fractional/suffixed values
  like `1.5`/`3x` are rejected, not silently truncated), and `buildDailyCronEntry`
  single-quote-escapes its payload so a quote in a command/path can't malform the
  emitted cron line.

## 0.3.1

- Fix ESM named imports of the storage helpers: export them as shorthand
  identifiers so Node's cjs-module-lexer detects them. `key: storage.fn` was
  invisible to `import { fn } from "@andrewpopov/db-backup"` (hit by stoki/sano,
  which run ESM). No API change.
- verify-pack now also runs an ESM `import { ... }` smoke to catch this class.

## 0.3.0

Generalizes stoki/pantry's admin backup-storage subsystem into shared,
policy-free helpers (BWK-85), so any consumer gets multi-directory backups,
restore path-safety, and manifest tracking. Purely additive — existing
`runBackupJob`/`restoreBackup`/`listBackupsWithPlan` behavior is unchanged.

New exports (`src/storage.js`):
- `resolveBackupDirectories({ env, envVar, candidates, home })` — merge a CSV
  env var (default `BACKUP_DIRS`) with a caller-supplied candidate list, expand
  `~/`, de-dup. The caller owns the directory policy.
- `getBackupFallbackDirectory({ cwd })` — default write target.
- `resolveContainedBackupPath(candidate, { directories, home })` — resolve a
  user-supplied restore path and confirm it's contained within an allowed
  directory; returns `null` on traversal/arbitrary-file access. Callers MUST
  gate restore on this.
- `readBackupManifest(dir)` / `appendBackupManifestEntry(dir, entry)` — a
  per-directory `backup-manifest.json` tracking labels + source.
- `isContainedWithin`, `expandHome`, `MANIFEST_FILENAME` helpers.

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
