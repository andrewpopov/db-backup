# Changelog

## 0.18.0

Add a top-level `backupId` field to the backup job result (`runBackupJob` /
`runBackupJobAsync`) and to the CLI's `backup --json` output, equal to the
created backup's `fileName`. Downstream tooling that correlates a backup run
with its artifact — e.g. deploy-kit scraping the backup hook's stdout — was
matching only via `created.fileName`, so a rename of that nested shape would
silently break restore correlation. `backupId` is the documented, stable
contract for that use case; see the new "Machine-readable output" README
section. Additive only — all existing fields are unchanged.

**Lifecycle/freshness surfaces for admin composition (PKG-28).** Every
`BackupEntry` now carries a `state`: `'completed'` for a real on-disk
artifact (unchanged behavior), plus two new states backed by lightweight
markers so an in-flight or crashed job is representable at all:

- `'running'` — a `.inprogress` marker, written the instant a job starts and
  removed the instant it finishes successfully. Means "started and not known
  to have finished" (in flight, or the process died before its failure
  handler ran).
- `'failed'` — a `.failed` marker (the `.inprogress` marker renamed in
  place), holding `{ startedAt, failedAt, error }` with the error message
  truncated so a huge stack trace can't bloat the backup directory.

Markers are named by job identity — `<prefix>-<startedAt>-<jobId>` — never by
a predicted artifact filename (the artifact's name is unknowable up front:
lock waits cross timestamp seconds, encryption appends `.gpg`, the collision
allocator bumps sequences). Markers carry no size requirement and are always
excluded from retention **selection** (`planRetention` never sees them). A
stale `.failed` marker — older than the oldest backup the policy is still
keeping — is folded into the removal plan by
`listBackupsWithPlan`/`pruneBackupsJob` for cleanup (`retentionReason:
'stale_marker'`), with two evidence-preservation exemptions: when the plan
keeps no backups at all, no failed marker is ever stale, and the newest
failed marker is always retained regardless of age. A `.inprogress` marker is
never swept. New export `listBackupMarkers(outputDir, now?, namePrefix?)`
surfaces markers directly as `BackupEntry`-shaped rows (failed rows ranked by
`failedAt`).

New export `getOperationalStatus({ stampFile, outputDir?, maxAgeHours?, now?,
namePrefix? })` combines `checkBackupFreshness` with the lifecycle markers
into `{ tone: 'healthy' | 'warning' | 'critical', detail, stampedAt? }` — the
natural feed for admin-kit's `AdminOperationalStatus`. Precedence: any failed
marker whose `failedAt` is newer than the newest completed backup (critical —
so a run that fails after creating its artifact is never masked by that
artifact) > clock skew (warning) > stale (critical) > healthy. See the new
README "Backup lifecycle states and markers" / "Operational status (admin
surfaces)" sections.

Additive only — every existing `BackupEntry` consumer is unaffected; `state`
and `error` are new optional fields.

Also: the `__tests__` suite (previously one ~3,700-line file) is now split
into per-area files (`backup-job`, `retention`, `restore`, `cli`,
`destinations-replication`, `freshness`, `encryption`) sharing fixtures via
`__tests__/helpers.ts`. No test logic changed; same tests, same assertions,
now organized by area, plus new coverage for the surfaces above.

## 0.17.2

- Add public contribution, support, and private vulnerability-reporting policies.
- Add `npm run verify` as the authoritative local package-release gate.
- Correct the GitHub install example to the latest released tag.

## 0.17.1

Fix — a config file declaring `"mode": "prod"` was **silently ignored**. db-backup
fell back to `NODE_ENV` and resolved DEV env files while the operator believed they
were running prod. Caught on the Pi: cairn's config said `prod`, the CLI printed
`Mode: dev`.

A config key that is accepted and does nothing is worse than one that errors, so an
invalid `mode` now throws rather than being quietly dropped. Precedence is unchanged:
an explicit `--prod`/`--dev` flag still beats the config.

## 0.17.0

**Configurable grandfather-father-son (GFS) retention, applied identically to
every destination — plus a `destinations`/`retention` split that decouples
WHERE backups go from HOW MANY/WHICH survive, a `db-backup.config.json`
declarative config file, and `--dry-run`.**

The gap: only 6 backups total were ever kept (3 daily slots + 3 hardcoded
age-tier anchors), a consumer had no way to say WHICH backups survive or
WHEN they age out, and — worse — LOCAL and REMOTE retention were governed by
two completely independent configs (`--keep-last`/age-tier locally,
`--remote-keep` flat-count remotely), so a backup could exist on disk and
already be gone from S3, or vice versa.

- **GFS retention (`mode: 'gfs'`).** `{ daily: 7, weekly: 4, monthly: 12,
  yearly: 2 }` keeps the 7 most-recent backups as literal daily slots, then
  one backup per week for 4 weeks, one per month for 12 months, one per year
  for 2 years. A backup survives if it is the newest in ANY bucket it
  qualifies for; it is never double-counted or double-kept.

  **Not a parallel retention system.** GFS is expressed in the exact same
  "slots + anchors" vocabulary the legacy age-tier policy already used:
  `daily` is mechanically identical to the legacy `dailySlots` (the N
  most-recent backups, no age math), and `weekly`/`monthly`/`yearly` are
  generated as `RetentionAnchor`s — one per bucket, with `targetAgeDays`
  pinned to the bucket's `minAgeDays` so the existing closest-to-target
  anchor search degenerates into "the newest backup in this bucket". Both
  modes now share one selection function (`selectSlotsAndAnchors`); GFS just
  feeds it a different slot count and a differently-generated anchor list
  (`buildGfsAnchors`, also exported). For full custom control beyond what
  weekly/monthly/yearly counts can express, a GFS policy accepts its own
  `anchors` array directly — the same escape hatch `--retention-policy`
  (a JSON file) uses.

- **CLI:** `--retain-daily N --retain-weekly N --retain-monthly N
  --retain-yearly N`, and `--retention-policy <file.json>` for a fully custom
  policy object (including hand-written anchors). Programmatically, the same
  policy object (`{ mode: 'gfs', daily, weekly, monthly, yearly }`, or any
  custom shape) is accepted as `policy` by `runBackupJob`/`runBackupJobAsync`/
  `planRetention`, exactly like every other policy shape always was.
  **Combining a GFS flag with a legacy retention flag (`--keep-last`,
  `--daily-slots`, `--keep-days`, `--max-backups`) is an ERROR**, not a
  silent pick — `resolveRetentionPolicy` throws.

- **Destinations vs. retention — two orthogonal configs, one engine.**
  Retention coupled to LOCATION was the actual bug (`--keep-last` only ever
  governed local; `--remote-keep` only ever governed remote — two configs
  that could drift). This release separates them:
  - **`destinations`** (new): an explicit, non-empty list of WHERE backups
    go — `[{ type: 'local', path }, { type: 's3', bucket, prefix }, { type:
    'rclone', target }]`. `local` is not a privileged default; a caller may
    configure `s3`-only. Zero destinations aborts ("you must choose where
    backups go" — the same fail-closed spirit as the 0.15.0 offsite guard,
    generalized). CLI: `--dest local:/path`, `--dest s3:bucket/prefix`,
    `--dest rclone:remote:path` (repeatable).
  - **`policy`** (unchanged field, extended meaning): ONE retention plan.
    Once a GFS policy is configured, the SAME `planRetention` result is
    applied at every configured destination — local, rclone, and S3 alike —
    via `resolveDestinationPolicy`. Local and remote can no longer drift
    apart under a GFS policy: they are pruned by the identical plan.
  - **Legacy flags are fully preserved, mapped onto the same engine, not a
    second one.** `--output-dir`, `--remote`, `--s3-bucket`, `--keep-last`,
    `--daily-slots`, `--keep-days`, `--max-backups`, `--remote-keep`,
    `--skip-remote` behave EXACTLY as before: `resolveDestinations` maps them
    onto the same `destinations` shape (local always included, matching
    today's always-stage-locally-first behavior), and — absent a GFS
    policy — each remote destination keeps its own independent flat
    `--remote-keep` count (default 30), unchanged. `pruneRemoteBackups` and
    `pruneS3Backups` always run through `planRetention` now (the flat count
    becomes a synthesized `{ mode: 'keep-last', keepLast: N }` policy), so
    there is one retention engine underneath both the legacy and new
    behavior, never two. **Mixing `destinations`/`--dest` with the legacy
    `remote`/`s3`/`skipRemote`/`--remote`/`--s3-bucket`/`--skip-remote`
    options is an ERROR.**

- **`db-backup.config.json`.** An app declares its whole backup setup
  declaratively — `destinations`, `retention`, `encryptPassphraseFile`,
  `minBytes`, `commandTimeoutSeconds`, `stampFile`, `stopWritersCmd`,
  `startWritersCmd`, `databaseUrl` — instead of re-typing the same ~10 flags
  in a per-app bash script. Resolution: `--config <path>` >
  `db-backup.config.json` in the cwd > none. CLI flags always override a
  config value; a config value always overrides the built-in default.
  **Credentials are rejected outright if present in the file** (or on a
  destination within it) — they remain environment-only
  (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, or the `S3_*` aliases), never
  a flag or a config value. An `encryptPassphraseFile` that exists but isn't
  readable now aborts BEFORE any backup work runs, regardless of whether it
  came from the config or `--encrypt-passphrase-file` — previously this was
  only caught after a wasted snapshot, at gpg-invocation time.

- **`--dry-run` (command: `prune`).** Prints exactly what would be kept and
  deleted — with the reason each survivor is kept ("Daily slot 1", "Weekly
  slot 2", "Newest backup (safety guard)", ...) — and deletes nothing.

- **Destructive-operation safety, now enforced inside `planRetention` itself
  (so it applies uniformly to every caller — backup, prune, list, and every
  destination, local or remote):**
  - The newest backup is now NEVER pruned, whatever the policy computes —
    even a policy whose own anchor windows exclude it is overridden by a
    hard safety guard.
  - A policy whose own selection keeps NOTHING (while backups exist) now
    THROWS rather than silently emptying the backup directory. This is a
    genuine behavior change for a badly-misconfigured legacy policy too
    (e.g. `dailySlots: 0` with no anchors matching) — previously this
    silently deleted every backup; it now refuses.
  - Determinism is unchanged (still takes `now` as an injectable parameter);
    `planRetention` is still exported and pure — bewks continues to import
    it directly with no filesystem access.

- **Worked example.** Policy `{ daily: 7, weekly: 4, monthly: 12, yearly: 2 }`
  against a database backed up nightly for 14 months keeps: the 7 most
  recent nightly backups; the newest backup from each of the 4 weeks before
  that; the newest backup from each of the 12 months before that (a 30-day
  window per bucket); nothing from `yearly` yet (the set is younger than a
  year) — total kept count varies with cadence, but never exceeds
  `daily + weekly + monthly + yearly` (23 here), and the newest backup always
  survives regardless.

**Back-compat:** all 125 pre-existing tests pass unchanged. `runBackupJob`/
`runBackupJobAsync` gain a `destinationResults` field (per-destination
upload/prune detail); `uploaded`/`removedRemote` continue to mirror the
first non-local destination, exactly as before this release supported more
than one remote. Runtime dependencies unchanged (`dotenv` only).

## 0.16.1

Fix — the S3 remote ignored `AWS_REGION` / `AWS_DEFAULT_REGION` and defaulted to
`us-east-1`, so a bucket in any other region was unreachable: AWS answers with
`301 PermanentRedirect`. The first real backup on the Pi (a us-west-2 bucket) hit
exactly this. It failed CLOSED — exit 1, no false success — but it failed.

Region now resolves as: explicit `--s3-region` > `AWS_REGION` > `AWS_DEFAULT_REGION`
> fallback, and it reads from the INJECTED env bag (the way credentials and timeouts
already did) rather than `process.env` directly, so it is both correct and testable.

A code comment asserted that us-east-1 was the region every AWS account could reach
every bucket through. That was false; prod disproved it on the first attempt.

## 0.16.0

**Native S3-compatible off-host remote — AWS S3 and Cloudflare R2, no `rclone`
binary required — uploaded asynchronously so it can never block an in-process
caller's event loop.**

`uploadBackupToRemote` shelled out to `rclone` and hard-failed if the binary
was absent. Three apps (cairn, savoro, sano-os) have no off-host backups at
all today because none of them wanted to install and configure `rclone`. R2
speaks the S3 API, so one native implementation covers both AWS and R2.

An earlier iteration of this feature made the S3 upload "synchronous" by
blocking the calling thread on a `worker_threads` + `Atomics.wait` bridge
around `fetch`. That is fine for the CLI (a one-shot batch process) but wrong
for this package's other real consumer: `bewks` imports `runBackupJob` and
calls it in-process from a Next.js API route
(`src/controllers/admin.controller.ts`). `Atomics.wait` blocks the **entire
Node event loop**, not just the calling logical thread — an admin-triggered
backup with S3 configured would have frozen the whole server (every request,
every health check) for the duration of the upload. That design shipped
without ever landing in a release and is fully replaced below; nothing above
describes what actually ships.

- **Two backup-job entry points, split by whether S3 can block anything:**
  - **`runBackupJobAsync(options)`** (new) — `await` it. Supports `remote`
    (rclone), `s3` (native AWS S3/R2), and local-only (`skipRemote`) backups.
    The S3 upload runs on the real, `await`ed `fetch` — no worker thread, no
    `Atomics.wait`, nothing in the call chain can block the event loop. This
    is the correct entry point for any in-process/library caller (e.g.
    bewks's admin route) and is what the CLI now awaits internally for every
    `backup` invocation.
  - **`runBackupJob(options)`** (unchanged for its existing use cases) —
    synchronous. Supports `remote` (rclone) and local-only (`skipRemote`)
    backups exactly as every current consumer (bewks in-process, and
    cairn/savoro/mizen via CLI) already uses it — zero breakage. **It now
    THROWS if `s3` is configured**, naming `runBackupJobAsync` and the CLI as
    the alternatives, rather than either blocking the event loop or silently
    falling back to some other behavior.
- **`src/sync-fetch.js` (the worker-thread/`Atomics.wait` bridge) is deleted.**
  There is exactly one S3 HTTP call chain left (`s3-remote.js`), and it is
  fully async top to bottom; no code path in this package can block the event
  loop on a network call.
- **`--s3-bucket <name>`** (and `s3: { bucket }` programmatically) configures
  a second, independent remote type alongside `--remote` (rclone) — the two
  are mutually exclusive (configuring both is a hard error, CLI and both job
  functions). `--s3-prefix`, `--s3-endpoint` (omit for AWS, set to e.g.
  `https://<account>.r2.cloudflarestorage.com` for R2), `--s3-region`
  (default: `auto` when `--s3-endpoint` is set — R2's own convention —
  otherwise `us-east-1`), `--s3-timeout <s>` (env: `DB_BACKUP_S3_TIMEOUT_MS`,
  default 300s) round out the config. `--remote-keep` is shared between both
  remote types.
- **Credentials come from the environment ONLY**: `AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY` (or the `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`
  aliases). There is no CLI flag or config field for a secret — a flag would
  leak into `ps` output and shell history. Absent credentials fail with a
  message naming the exact env vars, and no error message (S3 error response,
  network failure) ever contains the access key or secret key.
- **Signing:** AWS Signature Version 4, implemented with `node:crypto` — no
  new runtime dependency, matching the zero-dep standard this package already
  holds itself to (still just `dotenv`). The payload hash is a real SHA-256 of
  the file (not `UNSIGNED-PAYLOAD`) since the file is already being read for
  the upload.
- **Fail-closed, same invariant as the rclone remote:** `uploadBackupToS3`
  (now `async`) PUTs the object, then HEADs it and compares Content-Length
  (and, for a single-part PUT, the ETag against the file's MD5) before
  resolving. A mismatch, a non-2xx response, or missing credentials all
  THROW/reject — nothing is pruned and no `--stamp-file` is written on an
  unverified upload.
- **Upload is a buffered single-part PUT** — the whole file is read into
  memory and sent as one request. Appropriate for SQLite/`pg_dump`-sized
  backups, not arbitrarily large ones. S3 itself caps a single-part PUT at
  5 GiB (`S3_SINGLE_PART_LIMIT_BYTES`); above that, `uploadBackupToS3` throws
  *before* reading the file rather than attempting an upload S3 would reject.
  Multipart upload is not implemented (out of scope — a materially larger,
  stateful protocol).
- **Remote retention**: `pruneS3Backups` (now `async`) lists the bucket/prefix
  (paginated `list-type=2`) and deletes the oldest objects beyond
  `--remote-keep` (default 30), same best-effort semantics as
  `pruneRemoteBackups` — a listing/delete failure warns rather than fails the
  run, and the object just uploaded and verified is never a deletion
  candidate.
- **The v0.15.0 no-remote fail-closed guard recognizes S3**: a backup with
  `--s3-bucket`/`s3` configured does not abort as "local-only" — the guard
  checks `remote OR s3`, not `remote` alone. This applies to both job
  functions.
- **rclone path is completely unaffected and untouched** — same
  `uploadBackupToRemote`/`pruneRemoteBackups`, same behavior, in both
  `runBackupJob` and `runBackupJobAsync`.
- New exports: `runBackupJobAsync`, `uploadBackupToS3` (now async),
  `verifyS3Object` (now async), `pruneS3Backups` (now async), `signS3Request`,
  `resolveS3Credentials`, `S3_SINGLE_PART_LIMIT_BYTES`, `DEFAULT_S3_KEEP`,
  `DEFAULT_S3_TIMEOUT_MS`.
- `runCli` is now `async` (`Promise<void>`); the CLI bin entry (`src/cli.js`)
  awaits it. Every other command (`list`, `prune`, `cron`, `restore`,
  `freshness`) behaves exactly as before — only `backup`'s upload step is
  actually asynchronous.

## 0.15.0

**Data-loss fix — `backup` with no offsite remote configured and no explicit
`--skip-remote` now ABORTS instead of silently producing a same-disk-only
"backup".**

`runBackupJob` only uploaded off-host when `remote` was configured; if it
wasn't, the run just quietly finished as a local-only success — no error, no
warning, nothing distinguishing it from a real, replicated backup. Consumer
side, cairn's `package.json` passes `--skip-remote` **unconditionally**, so
its only backups have always sat on the same disk as its prod database: one
disk failure loses both the database and every "backup" of it. rouge already
guards against exactly this in `deploy/backup-rouge-db.sh` — the wrapper
fails closed unless `ROUGE_BACKUP_REMOTE` is set or the operator opts in with
`ROUGE_BACKUP_ALLOW_LOCAL_ONLY=1` — and that logic is now baked into the
package itself so every consumer gets it for free, not just the one that
happened to hand-roll it.

- **`backup` refuses to run** (CLI and `runBackupJob`) when neither `--remote`
  / `remote` nor `--skip-remote` / `skipRemote: true` is set. The error names
  both escape hatches: configure `--remote <dest>` for offsite replication, or
  pass `--skip-remote` (`skipRemote: true`) to explicitly accept the
  same-disk risk. Nothing is written — no backup file, no output directory —
  before this check runs.
- `--skip-remote` / `skipRemote: true` remains a fully valid, explicit
  opt-out (this is how cairn and local dev already run) — it is not removed
  or restricted, only required to be a deliberate choice instead of an
  implicit default.
- `BackupJobResult` gained `localOnly: boolean`. When `true`, the CLI and a
  `console.warn` both surface a visible warning that the run has no offsite
  copy.
- `restore` / `prune` / `list` are unaffected — they don't produce new backup
  artifacts, so there is no silent-local-only failure mode for them to guard
  against.

No new runtime dependencies; freshness/dead-man's-switch support
(`--stamp-file`, `--max-age-hours`, `checkBackupFreshness`,
`checkRemoteFreshness`) already existed from earlier releases and needed no
changes for this fix.

## 0.14.0

**Data-loss fix — `restore` against a LIVE, running database now ABORTS
instead of silently eating writes.**

`restoreSqliteBackup` unlinked the destination file with no check that any
writer had been stopped. Consumer-side, cairn's
`db-backup restore --prod --latest` runs against the live
`/srv/cairn/packages/api/prisma/cairn.db` while the API is up: the API holds
an open fd, restore unlinks it, the app keeps writing to the now-unlinked
inode, and on restart it opens the restored file — every write made between
the restore and the restart is gone, silently (and on SQLite this can also
corrupt via stale `-wal` interplay). There was no error, no log line, nothing
— the only symptom is data that used to be there isn't anymore.

Three independent changes, all restore-only (`backup` is unaffected):

- **Rescue snapshot, always.** Before the live database is ever unlinked, a
  byte-for-byte copy of it (plus any `-wal`/`-shm`/`-journal` sidecars) is
  written to `<outputDir>/.rescue/<dbname>-<ISO>.db`. If anything fails after
  that point, the live database is automatically restored from this copy
  instead of being left missing — `RestoreResult.rescuePath` reports where it
  landed. This is not gated behind `--no-pre-backup`; it always runs.
- **Writer quiescence, refuse unless proven safe.** New `stopWriters` /
  `startWriters` options (a synchronous function or a shell-command string;
  CLI: `--stop-writers-cmd`, `--start-writers-cmd`) let a consumer quiesce its
  own app. Either way, restore then attempts to PROVE quiescence with a
  bounded `BEGIN EXCLUSIVE; COMMIT;` against the live database. If that
  cannot be proven — no `stopWriters` was given, or it ran but a writer is
  still active — restore **refuses** with a clear error, unless the caller
  passes the explicit, loudly-documented-as-unsafe override
  `allowOnlineRestore` (CLI: `--force-online`). `startWriters` runs in a
  `finally`, so it also fires on the failure path if `stopWriters` ran.
- **`sqlite3` absence is no longer a silent skip.** Restore previously
  skipped `verifySqliteBackupIntegrity` outright (fail-open) when `sqlite3`
  wasn't installed. It now **aborts** in that case, unless the caller passes
  `skipVerify` (CLI: `--skip-verify`) — logged loudly as unsafe. `backup`
  keeps its existing leniency; this only tightens `restore`.

`RestoreResult` gained `rescuePath: string | null`. Backward compatible
otherwise — but a `restore` run against a live SQLite database that used to
silently succeed (and silently lose data) will now throw unless one of the
above options is set. That is the point of this release: it is correct for
`restore` to fail loudly on a live DB rather than eat writes quietly.

## 0.13.1

**A corrupt snapshot survived the check that rejected it — and got listed as a
real backup.**

`verifySqliteBackupIntegrity`'s `deleteOnFailure` only fired when `sqlite3`
*returned* a "not ok" verdict. But sqlite3 reports corruption two ways, and the
realistic one — a valid header with torn interior pages, i.e. what failing storage
actually produces — makes it **exit non-zero** (`database disk image is
malformed`), so `execFileSync` **throws** and the deletion branch never ran.

The source comment even asserted the opposite ("only a *parseable but corrupt*
database reaches the deletion branch"). A parseable-but-corrupt database takes the
throwing path too. So `deleteOnFailure` was dead exactly when it mattered.

Consequence: `createSqliteSnapshot` rejected the backup and exited non-zero (the
gate was sound), but left the corrupt file in the output dir under a valid backup
name. It then **occupied a retention slot — evicting a good backup** — and `list`
ranked it `KEEP | Daily slot 1`. A `--latest` restore selector would have picked
it.

Both failure shapes now delete when the caller owns the file. The v0.8.0
non-destructive default is preserved and pinned by its own test: a consumer
vetting a *user-supplied* path still keeps its file on the throwing path.

Found while bumping bewks and sano-os. Not introduced by v0.13.0 — verified
against v0.12.0, which leaks identically.

All notable changes to `@andrewpopov/db-backup`. Versions are git tags
(`vX.Y.Z`); see STANDARDS.md.

## 0.13.0

**Fix — `restore` did not take the advisory lock, so a scheduled backup/prune
could race a restore.** `withBackupLock` (the `.db-backup.lock` O_EXCL lock in
`outputDir`) has guarded `runBackupJob` and `pruneBackupsJob` against each
other since 0.5.0, but `restoreBackup` never acquired it. Nothing stopped a
cron-driven `backup` (or a standalone `prune`) from running concurrently with
a `restore` that is mid-way through discarding the live database's sidecars
and renaming a new file into place — a narrow but real window for a scheduled
job to observe or interleave with a database being replaced.

This was not hypothetical: smarthome's `scripts/backup-db.sh` /
`scripts/restore-db.sh` hand-roll their own separate OS-level `flock`
specifically to cover this gap, with the lock-sharing comment spelling out
why — "db-backup takes its own lock on the output directory, which would not
exclude a restore, so keep this one."

> **Correction (added after the v0.13.0 release).** The original wording implied
> smarthome's `flock` is now redundant. **It is not — do not delete it.**
> smarthome's `restore-db.sh` never calls `restoreBackup()`; it is bespoke shell
> (gpg decrypt → pm2 quiescence → rescue snapshot → staged migrate → atomic
> install → auto-rollback). This package's lock is taken *inside* `restoreBackup`,
> so it cannot exclude a restore path that never enters that function. smarthome's
> `flock` remains the only thing serializing its restore against its
> package-driven backup, and its comment is still accurate for that repo.
>
> The fix below is real and worth having — but it only makes a local lock
> redundant for consumers whose **restore actually goes through `restoreBackup()`**
> (e.g. cairn's `backup:restore`, rouge's `db:backup:restore`, both via the CLI).
> Those restores now take the lock and can newly throw `Another db-backup run
> holds the lock` when they collide with a scheduled backup/prune — an intended
> new failure mode requiring no code change.

`restoreBackup` now wraps its full body (checksum verification, the
pre-restore safety backup, and the restore itself) in the same
`withBackupLock` used by `backup`/`prune`, so all three mutually exclude on a
shared `outputDir`. As with `pruneBackupsJob`, a `restoreBackup` call whose
`outputDir` does not exist on disk skips locking entirely and behaves exactly
as before — an absolute `--file` path can legitimately live outside
`outputDir`, and there is nothing local to protect in that case. `createBackup`
(used internally for the pre-restore safety backup) still never acquires the
lock itself, so there is no self-deadlock.

Impact: a `restore` that previously ran unguarded now throws "Another
db-backup run holds the lock" if it collides with a concurrent `backup` or
`prune` on the same `outputDir`, the same failure mode those two already have
against each other. No API or return-shape change.

## 0.12.0

**Feature — an off-host dead-man's switch: remote freshness + alerts on `freshness`.**

The local `--stamp-file` check runs on the backup host, so it can't detect the host
itself dying, and it only exits non-zero — someone still has to watch it. Two additions
close that gap, both on the existing `freshness` command (no new command, no breaking
change):

- **`--remote <rclone-dest>`** — check the newest object's age under the rclone remote
  instead of a local stamp. Run from a *different* host, it verifies the off-site copy
  directly, catching host death, a broken timer, a failed upload, and a deleted script
  alike. New `checkRemoteFreshness(...)` returns the same `BackupFreshness` shape as
  `checkBackupFreshness`; an unlistable/unavailable remote is an error (alertable), never
  a silent "fresh". Reuses the upload path's rclone env + object-path helpers.
- **`--notify-discord` / `--notify-webhook` / `--notify-command`** — on staleness, a
  missing backup, clock skew, or a check that can't run, deliver an alert. Best-effort and
  **synchronous** (POST via `curl`, or run a command with the message in
  `$DB_BACKUP_ALERT`): no new dependency, no `fetch`, so `runCli` stays synchronous and
  every consumer's `try { runCli() } catch` is unaffected. A failing webhook can neither
  mask nor manufacture a verdict; the exit code is still driven purely by freshness.

New exports: `checkRemoteFreshness`, `notifyAlert`. `freshness` now accepts `--remote` in
place of `--stamp-file` (either is required). Absorbed the "who watches the backup, and
how do they find out" gap that every consumer (rogue/bewks/smarthome/sano-os) had wired
by hand.

## 0.11.1

**Fix — a future-dated `.last-success` stamp reported the backup as fresh, forever.**

`checkBackupFreshness` computed `ageHours = now - stampedAt` and returned fresh
when that was under the threshold. A stamp dated in the **future** yields a
negative age, which is always under the threshold — so the monitor reported fresh
even with backups stopped entirely.

Not hypothetical: it is the same clock-rollback failure mode this package already
guards against in retention (never prune the backup you just created, because a
host whose clock jumped backward gives the new file an older timestamp). A host
whose clock jumps *forward* once stamps a future date and blinds the monitor
permanently.

A future stamp is now **never fresh**, and is reported distinctly as
`clockSkew: true` so an operator can tell a clock problem from a stale backup.
The CLI says `CLOCK PROBLEM: .last-success is dated in the future` and exits
non-zero.

Absorbed from smarthome's `check-backup-freshness.sh`, found while migrating it
onto the package (SMH-157) — migrating without this would have been a regression.

## 0.11.0

- **Feature — configurable filename prefix.** `namePrefix` (CLI `--name-prefix`)
  lets a consumer keep its own backup naming, so a project with an existing
  backup history can adopt the package instead of orphaning it. smarthome writes
  `smarthome-<ts>.db.gpg`; without this it would have had to abandon 7 local and
  30 remote backups to migrate.

  The engine is now read from the **extension** (`.db` → sqlite, `.dump` →
  postgres) rather than inferred from the prefix, which is unambiguous.

- **`list` / `prune` / `restore` are scoped to the prefix.** One app's backup job
  can never see or prune another app's backups sharing a directory or a remote
  bucket.

- **The default is deliberately not widened.** With no `namePrefix`, only the
  canonical `sqlite-backup` / `postgres-backup` prefixes parse — exactly today's
  behaviour. Accepting any prefix by default would make an unrelated `.db` file
  in the backup directory a prune candidate.

`parseBackupFileName(fileName, namePrefix?)` is now exported.

Note: the timestamp grammar is unchanged (`YYYYMMDD-HHMMSSZ`). A consumer whose
history uses a different timestamp format should rename losslessly at migration
time rather than have the package carry two grammars.

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
