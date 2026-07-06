# @bewks/db-backup-manager

## Document Status
- Status: Active package reference
- Last reviewed: 2026-07-05

Reusable database backup utilities with an age-tiered retention strategy
(defaults, tunable via `--max-backups` / `--daily-slots` or the
`DB_BACKUP_MAX_BACKUPS` / `DB_BACKUP_DAILY_SLOTS` env vars):

- Keep up to **6** backups total (`--max-backups`)
- Keep **3 recent daily** backups (`--daily-slots`)
- Always keep **1 backup from last week**
- Always keep **1 backup from last month**
- Always keep **1 backup from two months ago**

The age-tier anchors (week/month/two-months) are policy-owned; only the total
cap and daily-slot count are exposed on the CLI.

## Supported databases

- SQLite (`DATABASE_URL=file:...`)
- PostgreSQL (`DATABASE_URL=postgres://...` or `postgresql://...`)

## Usage

```bash
# Create backup + apply retention policy
db-backup-manager backup --prod --output-dir /var/backups/myapp

# List backups and retention decisions (dry run — no DB needed)
db-backup-manager list --output-dir /var/backups/myapp

# Apply retention now without taking a new backup (no DB needed)
db-backup-manager prune --output-dir /var/backups/myapp --max-backups 6

# Print a copy-pasteable cron entry for daily execution
db-backup-manager cron --hour 3 --minute 0 --prod --output-dir /var/backups/myapp

# Restore from a specific backup file
db-backup-manager restore --prod --output-dir /var/backups/myapp --file sqlite-backup-20260219-030000Z.db.gz

# Restore from the latest backup in output-dir
db-backup-manager restore --prod --output-dir /var/backups/myapp --latest
```

## Adoption recipes

### SQLite app

Set `DATABASE_URL` to a Prisma-style SQLite URL and choose a directory that is
outside your source checkout when possible:

```bash
DATABASE_URL=file:./data/app.db
db-backup-manager backup --prod --output-dir /var/backups/myapp
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
db-backup-manager backup --prod --output-dir /var/backups/myapp
```

PostgreSQL backups require `pg_dump`. Restores require `pg_restore`.
Same-second PostgreSQL backups use the same numeric suffix pattern, such as
`postgres-backup-20260705-150000Z-2.dump`.

### Daily cron

Generate a copy-pasteable cron entry. `cron` reflects the flags you pass
(`--prod`, `--output-dir`, `--allow-missing`) into the emitted `backup` command
and defaults the log path to `<output-dir>/backup.log`:

```bash
db-backup-manager cron --hour 3 --minute 0 --prod --output-dir /var/backups/myapp --allow-missing
# 0 3 * * * /usr/bin/env bash -lc 'cd "/srv/myapp" && npx db-backup backup --prod --output-dir "/var/backups/myapp" --allow-missing >> "/var/backups/myapp/backup.log" 2>&1'
```

The default command uses `npx db-backup` (resolves the locally-installed bin
under npm and pnpm). Override it entirely with `--command` (e.g. to wrap a
`pnpm exec` or an app npm script) and set the log file with `--log-path`:

```bash
db-backup-manager cron --command 'pnpm exec db-backup backup --allow-missing' --log-path /srv/myapp/logs/backup.log
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

## Programmatic API

```js
const {
  runBackupJob,
  listBackupsWithPlan,
  restoreBackup,
  DEFAULT_RETENTION_POLICY,
} = require('@bewks/db-backup-manager');

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
