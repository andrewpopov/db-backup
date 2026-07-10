# @andrewpopov/db-backup

## Document Status
- Status: Active package reference
- Last reviewed: 2026-07-05

## Install

```bash
npm install github:andrewpopov/db-backup#v0.8.0
```

Reusable database backup utilities with three retention strategies. **Age-tier**
is the default; **keep-last** and **keep-days** are flat alternatives. The modes
are mutually exclusive — pick one.

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
- By default, a safety backup is created before restore.
- Disable safety backup with `--no-pre-backup`.
- SQLite restore replaces the configured DB file.
- PostgreSQL restore uses `pg_restore --clean --if-exists --single-transaction`.
- PostgreSQL restore targets are redacted in return values so passwords are not
  echoed in logs.

After restore, restart the application before serving traffic.

## What stays app-specific

The package does not decide where backups should live, who can trigger them, or
how a web UI should present them. In Bewks, those concerns live in the admin
controller and settings layer; other apps should keep the same adapter boundary.
