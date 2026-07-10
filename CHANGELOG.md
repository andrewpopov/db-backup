# Changelog

All notable changes to `@andrewpopov/db-backup`. Versions are git tags
(`vX.Y.Z`); see STANDARDS.md.

## 0.10.1

**Fix — backups were written world-readable (0644).** A backup is a full copy of
the database; an unencrypted one is the database. The package relied on the
caller's umask, and `gzip` / `gpg` / `pg_dump` write through child processes that
ignore Node's `mode` argument entirely.

Every artifact is now `0600` and a backup directory the package creates is
`0700`: the snapshot, the gzip output, the `.gpg` ciphertext, the Postgres dump,
the decrypted scratch file, the **restore temp file** (a plaintext copy of the
database sitting beside the live one), `backup-manifest.json`, and the
`.last-success` stamp. A backup directory the operator already created is left
alone — the package tightens what it makes, not what it finds.

Absorbed from smarthome's `umask 077` (BWK-132), the one backup-mechanics
property it still had over this package after v0.10.0.

Pinned by a test that sets a deliberately permissive `umask 022` first, so the
package cannot pass by accident.

## 0.10.0

Off-host replication with verification — the last of the four axes on which
smarthome's `scripts/backup-db.sh` was better than this package (BWK-131).
db-backup is now a superset of it, so smarthome can migrate without regressing.

- **Feature — off-host upload with remote verification.**
  `remote: { target, keep, configFile, verify }` uploads via `rclone copyto`,
  then **re-reads the object** with `rclone lsjson --stat` and compares its byte
  count to the local artifact. A local-only backup dies with the disk it sits on
  (sano-os's docs call this the "same-SSD durability gap"; rouge pulls its
  backups to a Mac by hand).
- **The fail-closed invariant.** Nothing is pruned and no success is stamped
  until the remote object has been verified. A failed or unverified upload leaves
  the previous good backups **and** the previous stamp exactly where they were.
  An unparseable `rclone` response is a verification *failure*, not a pass. If
  `rclone` is unavailable the run **refuses** rather than silently skipping the
  off-site copy.
- **Remote retention** keeps the newest `keep` objects (default 30, never fewer
  than 1) and **never deletes the object it just uploaded** — the same
  clock-rollback protection as the local prune. A remote prune failure is a
  cleanup miss, not a data-safety issue, so it warns and carries on.
- `skipRemote` / `--skip-remote` for a fast local-only run, e.g. a pre-migration
  deploy hook that should not pay for a network round trip.
- **Fix — the `.last-success` stamp is now written atomically** (write-then-
  rename). A crash mid-write could otherwise leave a truncated stamp that a
  freshness monitor would misread.

New CLI flags: `--remote`, `--remote-keep`, `--rclone-config`, `--skip-remote`.

BWK-131 is complete: encryption at rest, size floor, success stamp + freshness,
never-prune-the-new-backup (0.9.0), and now off-host upload with verification.

## 0.9.0

Encryption at rest and backup liveness, absorbed from smarthome's
`scripts/backup-db.sh` (BWK-131). Standard 1 of the shared package standards: a
shared package must be a **superset** of the best implementation across its
consumers. smarthome's script was strictly better than this package on these
axes, so migrating it onto db-backup would have been a regression.

- **Feature — encryption at rest.** `encryption: { passphraseFile, cipher }` runs
  `gpg --symmetric --cipher-algo AES256 --passphrase-file`, producing a `.gpg`
  artifact and removing the plaintext. A passphrase **file**, never an argument —
  an argument is visible in the process table. If `gpg` is unavailable the backup
  **fails** rather than silently writing plaintext. Restore decrypts
  transparently and refuses loudly without the passphrase. Works for both SQLite
  and PostgreSQL backups.
- **Feature — `.last-success` stamp + `freshness` command.** `stampFile` is
  written only after the backup exists, passes its integrity check, clears the
  size floor, is encrypted if configured, and retention completes. Any failure
  leaves the previous stamp untouched. `db-backup freshness --stamp-file <p>
  --max-age-hours 36` exits non-zero when stale **or when no backup was ever
  recorded** — absence of evidence is not evidence of a backup. A cron that
  silently stops producing backups was previously invisible.
- **Feature — minimum size floor.** `minBytes` discards and fails a snapshot
  smaller than expected. An empty or truncated database sails through
  `PRAGMA integrity_check`.
- **Fix — retention never prunes the backup it just created.** A host whose clock
  jumped backward at boot gives the new file an older timestamp than existing
  ones, and a retention policy that trusts the ordering would delete the only
  freshly-verified backup. Absorbed from smarthome's `prune_local`.
- Filename grammar now accepts a trailing `.gpg`: a backup is snapshotted, then
  optionally gzipped, then optionally encrypted. Restore unwinds in reverse.

New CLI flags: `--encrypt-passphrase-file`, `--cipher`, `--min-bytes`,
`--stamp-file`, `--max-age-hours`. New command: `freshness`.

Still missing versus smarthome, and tracked in BWK-131: off-host upload with
remote verification (rclone), and fail-closed prune-after-verify. Do not migrate
smarthome onto this package until those land.

## 0.8.1

**Fix — the destination path is now correctly quoted for sqlite3's `.backup`
dot-command.** A snapshot to a path containing a single quote failed outright and
produced no file.

`createSqliteSnapshot` escaped the destination with `path.replace(/'/g, "''")`,
on the assumption that doubling a single quote escapes it. It does not: a sqlite3
dot-command is **not SQL**, and the shell tokenizes its arguments with shell-like
quoting rather than SQL string-literal quoting. `.backup 'o''brien/x.db'` fails
with `cannot open "brien/x.db"`.

Verified against the real `sqlite3` binary: a **double-quoted** argument works,
accepting `\"` and `\\` as escapes and handling spaces and single quotes
verbatim. Paths are now wrapped in double quotes with `\` and `"` escaped.

This was never a regression — the hand-rolled consumer code it replaced failed on
the same input — but v0.7.0's release notes and README advertised "quote escaping"
as a safety property consumers gain, which was not true. Now it is.

Covered by a unit test pinning the argv for quotes, spaces, double quotes and
backslashes, plus an integration test that snapshots through the **real** sqlite3
binary to a path containing a quote. Both fail against the old escaping.

## 0.8.0

**BREAKING (behavioral) — `verifySqliteBackupIntegrity` no longer deletes the file
it rejects, unless you ask it to.**

The exported helper ran `fs.rmSync(backupPath)` whenever `PRAGMA integrity_check`
did not return `ok`. That is correct for its one internal caller —
`createSqliteSnapshot` discards a snapshot it just wrote, because a bad backup is
worse than a loud failure — but it was exported (v0.7.0) with nothing to signal
that it mutates the filesystem. A consumer reaching for the obvious-sounding
"verify this backup file" helper on a **user-supplied path** would silently
destroy that user's backup. This was caught one review away from shipping in
savoro's admin restore route (PTRY-227).

It is deviously hard to notice: on a file `sqlite3` cannot open, `execFileSync`
throws *before* the deletion, so the file survives. Only a **parseable but
corrupt** database (`sqlite3` opens it; `integrity_check` prints e.g.
`Rowid 0 out of order`) reaches the deletion branch. A test using random bytes
cannot tell the two behaviors apart.

- `verifySqliteBackupIntegrity(path, runtime)` is now **non-destructive**.
- `verifySqliteBackupIntegrity(path, runtime, { deleteOnFailure: true })` restores
  the old behavior. `createSqliteSnapshot` passes it, because it owns `destPath`.
- Collapsed the internal `assertSqliteIntegrity` duplicate — a byte-similar,
  non-destructive copy of the same check used by the restore path — into this one
  function. The restore path's error message changes from "SQLite restore
  integrity check failed" to "SQLite backup integrity check failed".

Impact: a caller relying on the old delete-on-failure behavior of the *exported*
function must now pass `{ deleteOnFailure: true }`. No current consumer did.

`verifyPostgresBackupIntegrity` is unchanged: it is internal-only and is called
solely on a dump it just created, so its deletion is correct by ownership.

## 0.7.0

Reference implementation of the shared package standards. Additive: no existing
behavior changes except the `cp` fallback, which now refuses a case that
previously produced a silently-incomplete backup.

- **Feature — SQLite engine primitives are now exported.** The job API
  (`runBackupJob` / `restoreBackup`) owns env resolution, filenames, the manifest
  and retention. A consumer that needs its own naming or manifest, or that must
  not prune as a side effect, previously had no seam to attach to and
  reimplemented `sqlite3 .backup` itself. Now exported: `createSqliteSnapshot`,
  `verifySqliteBackupIntegrity`, `restoreSqliteBackup`, `removeSqliteSidecars`,
  `normalizeRuntime`. They carry the lock retries, quote escaping, WAL guard,
  integrity verification, atomic replace, and sidecar cleanup.
- **Fix — every external command is now bounded by a timeout.** No `execFileSync`
  call passed a process timeout; the only `timeout` in the package was sqlite's
  `.timeout 5000` *lock* pragma. A hung `sqlite3`, `gzip`, `pg_dump` or
  `pg_restore` could block a nightly cron indefinitely. The bound is injected once
  at the `normalizeRuntime` choke point (default 10 minutes, `killSignal:
  'SIGKILL'`), configurable via `runtime.commandTimeoutMs`, the
  `DB_BACKUP_COMMAND_TIMEOUT_MS` env var, or `--command-timeout <seconds>`. An
  explicit per-call option still wins.
- **BREAKING — the silent `cp` fallback is gone.** When `sqlite3` was
  unavailable the package fell back to `fs.copyFileSync`, which in WAL mode omits
  committed transactions held in the `-wal` (demonstrated: a database whose live
  read returns `{x, in-wal}` yields `{x}` through a plain copy), and which can
  tear under a concurrent writer in any mode. There is no "safe copy" to detect —
  inspecting the sidecars first would race a writer creating one. Taking a backup
  without `sqlite3` now **throws**. Pass `allowUnsafeCopy` (CLI:
  `--allow-unsafe-copy`) to accept an explicitly-inconsistent copy.

  Impact: none for consumers on a host with `sqlite3` installed, which is every
  current one. Closes BWK-119.
- **Types**: `BackupRuntime` (injectable, all-optional) is now distinct from
  `ResolvedBackupRuntime` (returned by `normalizeRuntime`, every command bounded).
  The engine primitives and the timeout config are exercised by the
  `verify:types` consumer contract, and `verify:pack` asserts the packaged
  tarball exports them through both CJS and ESM.

## 0.6.1

**Fix — SQLite restore silently resurrected pre-restore data.** `restoreSqliteBackup`
replaced the live database file but left its `-wal` / `-shm` sidecars on disk. Those
journals describe the database being *replaced*, so if the app had crashed (or was
still running) with un-checkpointed WAL frames, SQLite replayed those frames onto the
restored file on the next open — reviving rows that were never in the backup, while
`PRAGMA integrity_check` still reported `ok`. The package's own integrity assertion
did not catch it, because it validates the temp file *before* the rename.

Restoring now discards the destination's `-wal`, `-shm`, and `-journal` sidecars
before the replacement file is moved into place. Covered by a regression test that
plants stale sidecars and asserts they do not survive a restore.

## 0.6.0

Flat retention modes. Additive — the age-tier default is unchanged, including
the serialized shape of `plan.policy` (no `mode` field is added to
`DEFAULT_RETENTION_POLICY`; an absent mode means age-tier).

- **Feature — `keep-last` retention**: `--keep-last <n>` (env
  `DB_BACKUP_KEEP_LAST`) keeps the N most-recent backups and rotates out the
  rest. Requires `n >= 1`, so a flat count can never mean "delete everything".
- **Feature — `keep-days` retention**: `--keep-days <n>` (env
  `DB_BACKUP_KEEP_DAYS`) keeps backups strictly younger than N days. It
  **always retains the single most-recent backup** even when it is older than
  the window, so a long gap between runs can never delete every backup.
- The retention modes are mutually exclusive. Passing both `--keep-last` and
  `--keep-days`, or combining either with `--max-backups`/`--daily-slots`, is an
  error.
- **Precedence**: an explicit argument always beats an env var. An env var
  selects a flat mode only when no retention option was passed explicitly, so a
  stale `DB_BACKUP_KEEP_LAST` cannot silently override an explicit
  `--max-backups`.
- The clock-skew clamp (`min(createdAt, now)`) is now shared between the
  newest-first sort and the `keep-days` age math, so a future-dated backup reads
  as brand new rather than negative-age in every mode.
- **Types**: `RetentionPolicy` is now a discriminated union
  (`AgeTierRetentionPolicy | KeepLastRetentionPolicy | KeepDaysRetentionPolicy`).
  `DEFAULT_RETENTION_POLICY` is typed `AgeTierRetentionPolicy`, and
  `resolveRetentionPolicy` gains overloads that narrow on a `number`
  discriminator, so existing consumers reading `.maxBackups` still compile.

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
