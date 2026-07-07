# db-backup — Maturation Spec (toward v1.0)

Status: proposal, 2026-07-06. Grounded in the code as of v0.4.1 (`19381c7`).

## Current maturity

- **Version 0.4.1**, six tags shipped (v0.1.0 → v0.4.1) with a disciplined
  CHANGELOG, immutable tags, branch-protected master, and CI (test +
  verify:pack + release-guard). The release loop is the most mature part.
- **Codebase is small and testable**: ~1,230-line `src/index.js` engine +
  113-line `src/storage.js`, hand-written `src/index.d.ts`, injectable
  `runtime` seam (`now`/`execFileSync`/`commandExists`/`sleep`/`randomId`)
  used consistently by 19 unit tests (573 lines).
- **Real adopters**: bewks (pins `github:andrewpopov/db-backup#v0.4.1`,
  wraps the CLI via `scripts/tools/db-backup.js`), sano-os (drove the 0.4.0
  prune/retention surface), stoki/pantry (source of the 0.3.0 storage
  helpers). Three consumers across SQLite deployments; Postgres path has no
  known production adopter yet.
- **What's missing**: the README is stale (see Docs), the manifest helpers
  are exported but not wired into the backup path, there is no backup
  checksum/verification story beyond SQLite `PRAGMA integrity_check`, no
  concurrency locking, and no coverage measurement or Node matrix in CI.

## Testing — concrete gaps

Existing tests cover the happy paths well (SQLite raw/gzip, pg_dump args,
same-second suffixing, integrity-check failure cleanup, `--allow-missing`,
retention plan, prune, cron quoting, storage containment/manifest). Gaps:

1. **Retention edge cases.** `planRetention` is only tested with one tidy
   fixture. Untested: backups with future timestamps (negative `ageDays` —
   sorts ahead of everything and eats a daily slot); two candidates
   equidistant from an anchor target; `dailySlots > maxBackups` (clamped via
   `Math.min` but unasserted); `maxBackups` smaller than the anchor count;
   an empty directory; filenames whose timestamp fails `parseTimestampKey`
   (falls back to `mtime` — behavior exists in `listBackups` but has no test).
2. **Restore round-trip.** No test does backup → restore → compare bytes via
   the public API in one flow, and `restore --latest` selection is untested
   entirely (only `--file` is exercised). Engine-mismatch rejection
   (`sqlite` backup vs `postgres://` URL) is implemented but untested.
3. **Path containment at the restore boundary.** `resolveContainedBackupPath`
   is tested, but `restoreBackup` itself accepts any absolute `--file` path —
   containment is opt-in for callers (stoki-style admin UIs). Add tests that
   document this split, and decide (see API stability) whether the core
   restore should gate on containment when directories are configured.
4. **Locked-database retry.** The 5-attempt `database is locked` retry loop
   with backoff sleeps is untested (the seam exists: `runtime.sleep`).
5. **Env resolution.** `loadEnvironment` — `.env` vs `.env.production`
   override order, `strictProductionEnv` throw, missing `DATABASE_URL`
   message — has zero direct tests, and it mutates `process.env` (tests that
   do exist hand-manage env; an injectable env would fix both).
6. **Corruption/partial writes.** SQLite integrity-failure cleanup is tested;
   untested: a truncated `.gz` (gunzip throws mid-restore — temp file must be
   cleaned, live DB untouched), a pg_dump that exits 0 but writes 0 bytes,
   and a corrupt `backup-manifest.json` with valid JSON but wrong shape.
7. **Postgres/SQLite parity.** SQLite gets integrity verification; Postgres
   gets none (see Robustness). Whatever verification lands needs mirrored
   tests so the two engines don't drift.
8. **Large-DB behavior.** `restoreSqliteBackup` does `fs.readFileSync` +
   `zlib.gunzipSync` — the whole DB in memory, twice. Fine for the current
   fleet; add one streaming test fixture (~50 MB synthetic) before claiming
   v1.0, or document the memory bound.

## Docs & DX

- **The README is wrong about the package's own name.** It is titled
  `@bewks/db-backup-manager`, every CLI example invokes `db-backup-manager`,
  and the programmatic example requires `@bewks/db-backup-manager` — but the
  package is `@andrewpopov/db-backup` and the bin is `db-backup`. A new
  adopter copy-pasting the README gets `command not found`. Fix first (P0).
- **No install section.** README never shows
  `npm install github:andrewpopov/db-backup#v0.4.1`; that lives only in
  STANDARDS.md.
- **No options reference.** CLI flags are documented in `--help` and scattered
  prose; the programmatic `BackupOptions` (cwd, mode, envFiles,
  strictProductionEnv, requireDatabaseUrl, policy, runtime…) exist only in
  `index.d.ts`. Add one table for CLI flags + env vars and one for
  `BackupOptions`.
- **No restore runbook.** The restore section describes flags, not procedure.
  Write the 3 AM version: stop app → `list` → pick file → `restore --prod
  --file … ` → verify → restart, with the SQLite vs Postgres differences and
  what the safety pre-backup does/doesn't protect against.
- **No per-adopter examples.** Document the two real integration shapes:
  bewks' thin npm-script wrapper (`scripts/tools/db-backup.js`) and the
  stoki/pantry admin-UI shape that uses `resolveBackupDirectories` +
  `resolveContainedBackupPath` + manifest. The "What stays app-specific"
  section gestures at this; make it concrete with code.

## API stability & v1.0 criteria

The public surface (17 exports: 9 engine + 8 storage helpers, plus 5 CLI
commands and 2 env vars) is already semver-tagged and CHANGELOG'd. To call it
1.0:

- **Freeze and document the public surface** — everything in
  `module.exports` + CLI flags + `DB_BACKUP_*` env vars + backup filename
  format. The filename regexes (`sqlite-backup-<ts>[-n].db[.gz]`,
  `postgres-backup-<ts>[-n].dump`) are load-bearing for retention and must be
  explicitly declared stable — renaming breaks pruning of old fleets.
- **Resolve the two known seams before freezing**, since fixing them later is
  breaking: (a) should `restoreBackup` enforce containment natively when
  given `directories`, or stay opt-in; (b) should `runBackupJob` append to
  the manifest (today the manifest is a parallel, caller-maintained system —
  backups made by the CLI are invisible to it).
- **Deprecation policy**: one minor of overlap with a documented alias, then
  removal in the next major; note it in STANDARDS.md.
- **Exit criteria**: README correct + options reference + runbook; the P0/P1
  test gaps closed; manifest/containment decisions shipped; ≥2 adopters on
  the same tag for 30 days with zero backup-related incidents.

## Release/CI hardening

Already strong: single `test` job (npm ci → vitest → verify:pack with CJS +
ESM smokes), `release-guard` asserting tag == package.json version + CHANGELOG
entry, protected master, committed plain-JS source (no dist to drift). Gaps:

- **Node matrix.** CI runs only the Node 20 floor. Adopters run newer
  runtimes; add 20/22/24 with the `ci-success` aggregation job the workflow
  comment already prescribes (a bare matrix silently breaks the required
  `test` context).
- **Types smoke.** `index.d.ts` is hand-written against 1,300 lines of JS and
  nothing checks it. Add a `tsc --noEmit` step compiling a tiny consumer
  `.ts` file against the packed tarball inside verify-pack — catches export
  drift like the 0.3.1 ESM-lexer bug, but for types.
- **Coverage signal.** Add `vitest run --coverage` in CI with a soft
  threshold (start ~80% lines on `src/`), so the untested regions above stay
  visible.
- **Lint.** No linter at all; a minimal eslint (or `node --check` + a style
  pass) keeps drive-by PRs consistent.

## Robustness & features — concrete gaps

- **Checksums.** No backup has a recorded checksum. Write
  `sha256` per backup (natural home: the manifest entry, which already has
  `sizeBytes`), verify on restore before touching the live DB. Cheap, and
  it's the only way to detect bit-rot on the Pi's SD-card storage.
- **Postgres verification parity.** SQLite snapshots get
  `PRAGMA integrity_check`; a pg_dump that "succeeded" is trusted blindly.
  Run `pg_restore --list <file>` post-dump (reads the TOC, no DB needed) and
  delete + throw on failure — the exact analog of the SQLite check.
- **Concurrent-backup locking.** Nothing prevents two `backup` runs (cron +
  manual) racing: `buildUniqueBackupPath` is check-then-act (`existsSync`
  then create), and two concurrent prunes can double-delete. Add an advisory
  lockfile (`.db-backup.lock` with pid + O_EXCL, stale after N minutes) in
  the output dir around backup/prune.
- **Retention under clock skew.** `ageDays` comes from the filename's UTC
  timestamp vs `runtime.now()`. A host with a skewed clock (Pi without NTP
  after power loss) can mint future-dated backups that permanently occupy
  daily slots, or age everything past the anchors in one jump. Minimum: clamp
  negative ages to 0 and warn; test it (Testing #1).
- **Restore validation.** After a SQLite restore, run the same
  `PRAGMA integrity_check` against the restored file before declaring
  success; after Postgres restore, at least verify the connection accepts a
  trivial query. Today "restore completed" means "commands exited 0".
- **Remote/offsite targets (S3/R2).** All backups live on the same disk as
  the database — one dead SD card loses both. Keep the core policy-free:
  ship a post-backup hook (`onBackupCreated(entry)`) or a documented
  rclone/rsync recipe in the cron command, rather than an AWS SDK dep (would
  violate the near-zero-deps rule in STANDARDS.md). Decide before 1.0 so the
  hook shape is in the frozen API.
- **Scheduling** is adequately solved by `cron` + the emitted entry; systemd
  timer output could be a minor-version nicety, not a 1.0 blocker.

## Adoption

- **Adopters today**: bewks (`#v0.4.1`, npm-script wrapper), sano-os (drove
  0.4.0), stoki/pantry (drove 0.3.0 storage helpers). All SQLite in prod.
- **Friction**: the stale README is the biggest onboarding tax; second is
  that the "admin UI" integration (directories + containment + manifest)
  requires reading stoki source to understand — there's no reference example.
- **What would make it trivial**: a correct 5-line install + cron quickstart
  at the top of the README, an `examples/` dir with the two integration
  shapes, and manifest auto-population so `list` and any UI agree on what
  exists without app glue.

## Prioritized next actions

**P0 — correctness of what's already shipped**
1. Fix README: package name, bin name (`db-backup`), install line with the
   `github:#vX.Y.Z` ref, programmatic require path. (docs-only patch)
2. Add restore round-trip + `--latest` + engine-mismatch tests; add truncated
   `.gz` partial-write test asserting live DB is untouched.
3. Add retention edge-case tests: future timestamps, `dailySlots >
   maxBackups`, mtime-fallback filenames; clamp negative `ageDays`.

**P1 — parity and safety**
4. Postgres dump verification via `pg_restore --list`; mirrored test.
5. Advisory lockfile around backup/prune; concurrent-run test via runtime seam.
6. sha256 in manifest entries + wire `runBackupJob` to append manifest
   entries; verify checksum on restore.
7. CI: Node 20/22/24 matrix behind a `ci-success` aggregate job; coverage
   report; `tsc --noEmit` types smoke in verify-pack.

**P2 — 1.0 shaping**
8. Options reference + restore runbook + `examples/` (bewks wrapper,
   stoki admin shape).
9. Decide containment-in-core and `onBackupCreated` hook shape; document
   deprecation policy; declare the filename format stable.
10. Tag v1.0.0 once ≥2 adopters have run one tag for 30 incident-free days.
