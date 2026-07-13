# @andrewpopov/db-backup

Backs up SQLite and PostgreSQL databases from a CLI or a Node API: timestamped
compressed dumps, retention policies, optional GPG encryption at rest, verified
off-host replication via rclone, and a freshness check that catches a cron job
which has silently stopped producing backups. Built for self-hosted apps where
the backup job has to be trustworthy without a human watching it.

## Install

```bash
npm install github:andrewpopov/db-backup#v0.11.1
```

## Retention

Three retention strategies. **Age-tier** is the default; **keep-last** and
**keep-days** are flat alternatives. The modes are mutually exclusive — pick one.

### Age-tier (default)

Tunable via `--max-backups` / `--daily-slots` or the `DB_BACKUP_MAX_BACKUPS` /
`DB_BACKUP_DAILY_SLOTS` env vars:

- Keep up to **6** backups total (`--max-backups`)
- Keep **3 recent daily** backups (`--daily-slots`)
- Always keep **1 backup from last week**
- Always keep **1 backup from last month**
- Always keep **1 backup from two months ago**

The age-tier anchors (week/month/two-months) are policy-owned; only the total
cap and daily-slot count are exposed on the CLI.

### Flat retention

| Mode | Flag | Env var | Behavior |
|---|---|---|---|
| keep-last | `--keep-last <n>` | `DB_BACKUP_KEEP_LAST` | Keep the **N most-recent** backups; rotate out the rest. `n >= 1`. |
| keep-days | `--keep-days <n>` | `DB_BACKUP_KEEP_DAYS` | Keep every backup **strictly younger than N days**. `n >= 1`. |

```bash
db-backup backup --prod --keep-last 8      # e.g. 8 weekly backups
db-backup prune  --keep-days 30            # e.g. a 30-day window
```

Notes:

- **`keep-days` always retains the single most-recent backup**, even when it is
  older than the window. A long gap between runs can never delete every backup.
- `keep-last` requires `n >= 1`, so a flat count can never mean "delete
  everything".
- A backup dated in the future (clock skew) is clamped to *now* for both
  ordering and age, so it is treated as brand new rather than as negative-age.
- **Precedence:** an explicit CLI argument always beats an env var. Combining a
  flat option with `--max-backups`/`--daily-slots` is an error, and so is passing
  both `--keep-last` and `--keep-days`. An env var selects a flat mode only when
  no retention option was passed explicitly, so a stale `DB_BACKUP_KEEP_LAST`
  cannot silently override an explicit `--max-backups`.

## Encryption at rest

```bash
db-backup backup --prod --encrypt-passphrase-file /var/lib/app/secrets/backup.pass
```

Runs `gpg --symmetric --cipher-algo AES256` and writes `<name>.db.gz.gpg`, removing
the plaintext. The passphrase is read from a **file**, never passed as an argument
(arguments are visible in the process table). If `gpg` is unavailable the backup
**fails** rather than silently writing plaintext. `restore` decrypts transparently
and refuses without the passphrase.

## Filename prefix

```bash
db-backup backup --prod --name-prefix myapp     # myapp-<ts>.db.gz.gpg
```

Defaults to `sqlite-backup` / `postgres-backup`. Set it to adopt an existing
backup history written under another name. The engine is read from the extension
(`.db` / `.dump`), not the prefix.

`list`, `prune` and `restore` are **scoped to the prefix**, so one app's job can
never prune another app's backups in a shared directory or remote bucket. With no
prefix set, only the canonical names are recognised — the default is not widened.

## Off-host replication

A backup on the same disk as the database is not a backup.

```bash
db-backup backup --prod \
  --encrypt-passphrase-file /var/lib/app/secrets/backup.pass \
  --remote offsite:backups/app --remote-keep 30 \
  --stamp-file /var/lib/app/backups/.last-success
```

Uploads with `rclone copyto`, then **re-reads the object** and compares its byte
count to the local artifact. **Nothing is pruned and no success is stamped until
that verification passes** — a failed or unverified upload leaves the previous
backups and the previous stamp untouched. An unparseable `rclone` response is a
failure, not a pass. If `rclone` is missing, the run refuses rather than silently
skipping the off-site copy.

Remote retention never deletes the object it just uploaded (a host whose clock
rolled backward would otherwise delete the only verified copy). Use
`--skip-remote` for a fast local-only run, e.g. a pre-migration deploy hook.

### Cloudflare R2 (and other S3-compatible targets)

The `--remote` target is just an [rclone](https://rclone.org) remote, so any
backend rclone supports works — Cloudflare R2, AWS S3, Backblaze B2, or a second
local disk. To replicate to R2, define an rclone remote once:

```bash
rclone config create r2 s3 \
  provider=Cloudflare \
  access_key_id=<R2_ACCESS_KEY_ID> \
  secret_access_key=<R2_SECRET_ACCESS_KEY> \
  endpoint=https://<ACCOUNT_ID>.r2.cloudflarestorage.com \
  region=auto acl=private no_check_bucket=true
```

The access key ID and secret come from the R2 dashboard (**Manage R2 API Tokens**
→ an *S3 credential* pair — not a general Cloudflare API token, which cannot sign
S3 requests). Then point `--remote` at a bucket and prefix:

```bash
db-backup backup --prod \
  --remote r2:my-bucket/my-app --remote-keep 30 \
  --rclone-config ~/.config/rclone/rclone.conf
```

The upload, byte-verification, and remote retention described above apply
unchanged — the remote is opaque to `db-backup`.

## Backup liveness

A cron backup that silently stops producing files is invisible. `--stamp-file` is
written **only** after a fully successful run:

```bash
db-backup backup --prod --stamp-file /var/lib/app/backups/.last-success
db-backup freshness --stamp-file /var/lib/app/backups/.last-success --max-age-hours 36
```

`freshness` exits non-zero when the last success is too old **or when no backup was
ever recorded**. Pair it with `--min-bytes` so a truncated database — which passes
`PRAGMA integrity_check` — fails loudly instead of rotating out a good backup.

### Off-host dead-man's switch (remote freshness + alerts)

A local `--stamp-file` check runs *on the backup host* — so it dies with the host, and
it only exits non-zero; someone still has to watch it. To actually get told when the
backup silently stops, run `freshness --remote` **from a different host** and give it a
notification channel:

```bash
# On a persistent host that is NOT the backup host (a timer, every few hours):
db-backup freshness --remote r2:backups/app --max-age-hours 30 \
  --rclone-config /path/to/rclone.conf \
  --notify-discord https://discord.com/api/webhooks/…
```

`--remote` checks the newest object's age under the rclone remote instead of a local
stamp — verifying the *off-site copy* independently, which catches host death, a broken
timer, a failed upload, and a deleted script alike. On staleness, a missing backup, a
future timestamp (clock skew), or a check that can't run (rclone missing), it alerts:

| flag | delivery |
|---|---|
| `--notify-discord <url>` | POST `{"content": message}` to a Discord webhook |
| `--notify-webhook <url>` | POST `{"text": message}` to any webhook (Slack-style) |
| `--notify-command <cmd>` | run `cmd` with the message in `$DB_BACKUP_ALERT` (generic escape hatch) |

Notifications are **best-effort and synchronous** (POST via `curl`, or run the command) —
a failing webhook never masks or manufactures a verdict, and `freshness` still exits
non-zero on staleness. No new dependency; no `fetch` (so `runCli` stays synchronous and
consumers' `try/catch` is unaffected).

## Supported databases

- SQLite (`DATABASE_URL=file:...`)
- PostgreSQL (`DATABASE_URL=postgres://...` or `postgresql://...`)

## Usage

```bash
# Create backup + apply retention policy
db-backup backup --prod --output-dir /var/backups/myapp

# List backups and retention decisions (dry run — no DB needed)
db-backup list --output-dir /var/backups/myapp

# Apply retention now without taking a new backup (no DB needed)
db-backup prune --output-dir /var/backups/myapp --max-backups 6

# Print a copy-pasteable cron entry for daily execution
db-backup cron --hour 3 --minute 0 --prod --output-dir /var/backups/myapp

# Restore from a specific backup file
db-backup restore --prod --output-dir /var/backups/myapp --file sqlite-backup-20260219-030000Z.db.gz

# Restore from the latest backup in output-dir
db-backup restore --prod --output-dir /var/backups/myapp --latest

# Restore against a LIVE database: quiesce the app around the swap
db-backup restore --prod --output-dir /var/backups/myapp --latest \
  --stop-writers-cmd "pm2 stop myapp" --start-writers-cmd "pm2 start myapp"
```

## Adoption recipes

### SQLite app

Set `DATABASE_URL` to a Prisma-style SQLite URL and choose a directory that is
outside your source checkout when possible:

```bash
DATABASE_URL=file:./data/app.db
db-backup backup --prod --output-dir /var/backups/myapp
```

When `sqlite3` is available, backups are created with SQLite's online `.backup`
command. If `sqlite3` is not installed, the package falls back to copying the DB
file. SQLite backups are compressed with `gzip` when it is available.

Backup filenames are UTC-timestamped to the second. If another backup already
exists for the same second, the package appends a numeric suffix, such as
`sqlite-backup-20260705-150000Z-2.db.gz`, rather than overwriting the existing
file.

### PostgreSQL app

Set `DATABASE_URL` to a Postgres connection string:

```bash
DATABASE_URL=postgresql://user:password@db.example.com:5432/myapp
db-backup backup --prod --output-dir /var/backups/myapp
```

PostgreSQL backups require `pg_dump`. Restores require `pg_restore`.
Same-second PostgreSQL backups use the same numeric suffix pattern, such as
`postgres-backup-20260705-150000Z-2.dump`.

### Daily cron

Generate a copy-pasteable cron entry. `cron` reflects the flags you pass
(`--prod`, `--output-dir`, `--allow-missing`) into the emitted `backup` command
and defaults the log path to `<output-dir>/backup.log`:

```bash
db-backup cron --hour 3 --minute 0 --prod --output-dir /var/backups/myapp --allow-missing
# 0 3 * * * /usr/bin/env bash -lc 'cd "/srv/myapp" && npx db-backup backup --prod --output-dir "/var/backups/myapp" --allow-missing >> "/var/backups/myapp/backup.log" 2>&1'
```

The default command uses `npx db-backup` (resolves the locally-installed bin
under npm and pnpm). Override it entirely with `--command` (e.g. to wrap a
`pnpm exec` or an app npm script) and set the log file with `--log-path`:

```bash
db-backup cron --command 'pnpm exec db-backup backup --allow-missing' --log-path /srv/myapp/logs/backup.log
```

## Environment resolution

The package can read `DATABASE_URL` directly from the process environment, or it
can load env files relative to `cwd`.

- Base file: `.env`
- Dev file: `.env.local`
- Prod file: `.env.production`

Base env is loaded first; mode-specific env is loaded second and overrides base
values. In production mode, `DATABASE_URL` must either be exported in the shell
before the process starts or be present in `.env.production`, unless
`strictProductionEnv: false` is passed programmatically.

## Command timeouts

Every external command (`sqlite3`, `gzip`, `pg_dump`, `pg_restore`) runs with a
process timeout, so a hung binary cannot block a cron run indefinitely. The
default is 10 minutes.

```bash
db-backup backup --prod --command-timeout 120     # seconds
DB_BACKUP_COMMAND_TIMEOUT_MS=120000 db-backup backup --prod
```

Programmatically, pass `runtime: { commandTimeoutMs }`.

## SQLite engine primitives

`runBackupJob` / `restoreBackup` are the opinionated job API: they resolve env,
choose filenames, write the manifest, and apply retention. When you need your own
destination filename or manifest — an admin "back up now" route, a pre-deploy
hook — use the engine directly instead of shelling out to `sqlite3` yourself:

```js
const {
  createSqliteSnapshot,
  verifySqliteBackupIntegrity,
  restoreSqliteBackup,
  removeSqliteSidecars,
  normalizeRuntime,
} = require('@andrewpopov/db-backup');

const runtime = normalizeRuntime({ commandTimeoutMs: 30_000 });

// WAL-safe, self-contained snapshot at a path you choose. Retries on
// "database is locked", escapes the path, and integrity-checks the result.
createSqliteSnapshot({ sourcePath: '/srv/app/data/app.db', destPath, runtime });

// Atomic restore: temp -> verify -> discard destination sidecars -> rename.
restoreSqliteBackup({ databaseUrl, backupEntry: { fullPath: destPath, compressed: false }, runtime });
```

`verifySqliteBackupIntegrity` is **non-destructive**: it throws on a corrupt file
but never deletes it. Pass `{ deleteOnFailure: true }` only for a file you own —
`createSqliteSnapshot` does this to discard a snapshot it just wrote.

`createSqliteSnapshot` **throws** when `sqlite3` is unavailable, rather than fall
back to a plain byte copy. A copy of a live SQLite database is never guaranteed
consistent: in WAL mode it omits committed transactions still held in the `-wal`,
and in any mode it can tear under a concurrent writer. Checking for a `-wal`
first would not help — a writer can create one between the check and the copy.

Install `sqlite3`, or pass `allowUnsafeCopy` (CLI: `--allow-unsafe-copy`) to
accept an explicitly-inconsistent copy.

## Programmatic API

```js
const {
  runBackupJob,
  listBackupsWithPlan,
  restoreBackup,
  DEFAULT_RETENTION_POLICY,
} = require('@andrewpopov/db-backup');

const result = runBackupJob({
  mode: 'prod',
  outputDir: '/var/backups/myapp',
});

console.log(result.created.fileName);

const restored = restoreBackup({
  mode: 'prod',
  outputDir: '/var/backups/myapp',
  backupFile: 'sqlite-backup-20260219-030000Z.db.gz',
});

console.log(restored.target);
```

### Runtime injection for tests and hosted environments

Most apps should not pass `runtime`. It exists for deterministic tests and for
hosts that need to wrap command execution:

```js
runBackupJob({
  databaseUrl: 'postgresql://user:password@db.example.com/myapp',
  outputDir: '/var/backups/myapp',
  runtime: {
    now: () => new Date('2026-07-05T03:00:00.000Z'),
    commandExists: (command) => command === 'pg_dump',
    execFileSync: (command, args, options) => {
      // Run, log, sandbox, or fake command execution here.
    },
  },
});
```

The default runtime uses Node's `child_process.execFileSync`, checks commands via
`command -v`, sleeps between locked-SQLite retries, and reads the current time
from `new Date()`.

## Restore behavior

- `restore` requires `--file <name|path>` or `--latest`.
- By default, a safety backup is created before restore. Disable with
  `--no-pre-backup`.
- SQLite restore replaces the configured DB file.
- PostgreSQL restore uses `pg_restore --clean --if-exists --single-transaction`.
- PostgreSQL restore targets are redacted in return values so passwords are not
  echoed in logs.
- `restore` takes the same advisory lock (`.db-backup.lock` in `outputDir`) as
  `backup` and `prune`, so a scheduled backup can never run while a restore is
  replacing the database, and vice versa. Skipped when `outputDir` doesn't
  exist — a `--file` outside `outputDir` needs no local lock.

After restore, restart the application before serving traffic.

### SQLite restore is safe by default: it refuses rather than destroys

Since 0.14.0, restoring over a **live** SQLite database — one still open in a
running app — no longer silently eats writes made after the restore. This is
exactly the failure mode that used to hit an app like cairn, whose
`db-backup restore --prod --latest` ran against the live `cairn.db` while the
API was up: the API held an open fd, restore unlinked it out from under the
process, and every write the app made between the restore and its next
restart vanished with no error at all.

Restore now does three things, in order, whenever a live database exists at
the destination:

1. **Verifies integrity first.** The restored backup is checked with
   `PRAGMA integrity_check` on a temp path before it ever touches the live
   file. If `sqlite3` isn't installed, restore now **aborts** instead of
   silently skipping this check — pass `skipVerify` (`--skip-verify`) to
   proceed unverified anyway (unsafe).
2. **Proves writers are quiesced, or refuses.** Pass `stopWriters` /
   `startWriters` (a synchronous function, or a shell-command string — CLI:
   `--stop-writers-cmd <cmd>` / `--start-writers-cmd <cmd>`) so this package
   can quiesce your app itself. Either way, restore attempts to prove
   quiescence with a bounded `BEGIN EXCLUSIVE; COMMIT;` against the live
   database. If that can't be proven, restore **refuses** with a clear error
   — pass `allowOnlineRestore` (`--force-online`) to override at your own
   risk. `startWriters` always runs afterward (even if the restore itself
   fails), so a stopped app is never left down.
3. **Takes a rescue snapshot before touching anything.** A byte-for-byte copy
   of the live database (plus its `-wal`/`-shm`/`-journal` sidecars, if any)
   is written to `<outputDir>/.rescue/<dbname>-<ISO>.db` — always, not just
   when the pre-restore safety backup is enabled. If any later step fails,
   the live database is automatically restored from this copy instead of
   being left missing or half-swapped. `RestoreResult.rescuePath` reports
   where it landed.

```js
const { restoreBackup } = require('@andrewpopov/db-backup');

const result = restoreBackup({
  databaseUrl: 'file:./data/app.db',
  outputDir: './backups/database',
  useLatest: true,
  stopWriters: 'pm2 stop my-app',
  startWriters: 'pm2 start my-app',
});

console.log(result.rescuePath); // e.g. ./backups/database/.rescue/app-2026-07-12T...db
```

`allowOnlineRestore` and `skipVerify` are documented escape hatches, not
defaults — using either means restore can no longer prove it won't destroy
data. `backup` is unaffected by any of this; only `restore` changed.

## What stays app-specific

The package does not decide where backups should live, who can trigger them, or
how a web UI should present them. Those concerns belong in the host application —
an admin controller, a settings layer — as a thin adapter over the programmatic
API, not inside the package.
