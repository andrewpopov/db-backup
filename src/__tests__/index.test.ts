import { createRequire } from 'module';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  DEFAULT_RETENTION_POLICY,
  listBackupsWithPlan,
  pruneBackupsJob,
  resolveRetentionPolicy,
  planRetention,
  restoreBackup,
  runBackupJob,
  runCli,
  readBackupManifest,
  appendBackupManifestEntry,
  createSqliteSnapshot,
  verifySqliteBackupIntegrity,
  parseBackupFileName,
  checkBackupFreshness,
  checkRemoteFreshness,
  notifyAlert,
  writeSuccessStamp,
  normalizeRuntime,
  DEFAULT_COMMAND_TIMEOUT_MS,
} = require('../index.js') as typeof import('../index');

const fixedNow = new Date('2026-07-05T15:00:00.000Z');
const tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-backup-'));
  tempDirs.push(dir);
  return dir;
}

function makeRuntime(overrides: Partial<{
  commandExists: (command: string) => boolean;
  execFileSync: (command: string, args: string[], options?: unknown) => void;
  sleep: (ms: number) => void;
  now: () => Date;
  randomId: () => string;
}> = {}) {
  return {
    commandExists: () => false,
    execFileSync: () => undefined,
    sleep: () => undefined,
    now: () => fixedNow,
    randomId: () => 'fixed-restore-id',
    ...overrides,
  };
}

function backupEntry(fileName: string, ageDays: number) {
  const createdAt = new Date(fixedNow.getTime() - ageDays * 24 * 60 * 60 * 1000).toISOString();

  return {
    fileName,
    fullPath: `/backups/${fileName}`,
    engine: 'sqlite' as const,
    compressed: true,
    createdAt,
    sizeBytes: 128,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('@andrewpopov/db-backup', () => {
  it('creates a SQLite backup from a URL-encoded relative file path without external binaries', () => {
    const cwd = makeTempDir();
    const sourcePath = path.join(cwd, 'db with spaces.db');
    const outputDir = path.join(cwd, 'backups');
    fs.writeFileSync(sourcePath, 'sqlite bytes');

    const result = runBackupJob({
      cwd,
      databaseUrl: 'file:./db%20with%20spaces.db?connection_limit=1',
      outputDir,
      runtime: makeRuntime(),
      allowUnsafeCopy: true,
    });

    expect(result.created).toMatchObject({
      fileName: 'sqlite-backup-20260705-150000Z.db',
      engine: 'sqlite',
      compressed: false,
      createdAt: fixedNow.toISOString(),
    });
    expect(fs.readFileSync(result.created.fullPath, 'utf8')).toBe('sqlite bytes');
    expect(result.kept.map((entry) => entry.fileName)).toContain(result.created.fileName);
  });

  it('does not overwrite a same-second SQLite backup', () => {
    const cwd = makeTempDir();
    const sourcePath = path.join(cwd, 'app.db');
    const outputDir = path.join(cwd, 'backups');
    fs.writeFileSync(sourcePath, 'sqlite bytes');

    const first = runBackupJob({
      cwd,
      databaseUrl: 'file:./app.db',
      outputDir,
      runtime: makeRuntime(),
      allowUnsafeCopy: true,
    });
    fs.writeFileSync(sourcePath, 'new sqlite bytes');
    const second = runBackupJob({
      cwd,
      databaseUrl: 'file:./app.db',
      outputDir,
      runtime: makeRuntime(),
      allowUnsafeCopy: true,
    });

    expect(first.created.fileName).toBe('sqlite-backup-20260705-150000Z.db');
    expect(second.created.fileName).toBe('sqlite-backup-20260705-150000Z-2.db');
    expect(fs.readFileSync(first.created.fullPath, 'utf8')).toBe('sqlite bytes');
    expect(fs.readFileSync(second.created.fullPath, 'utf8')).toBe('new sqlite bytes');
  });

  it('uses sqlite3 .backup and gzip when those commands are available', () => {
    const cwd = makeTempDir();
    const sourcePath = path.join(cwd, 'dev.db');
    const outputDir = path.join(cwd, 'backups');
    const calls: Array<{ command: string; args: string[] }> = [];
    fs.writeFileSync(sourcePath, 'source should not be copied directly');

    const runtime = makeRuntime({
      commandExists: (command) => command === 'sqlite3' || command === 'gzip',
      execFileSync: (command, args) => {
        calls.push({ command, args });
        if (command === 'sqlite3' && args[1] === 'PRAGMA integrity_check;') {
          return Buffer.from('ok\n');
        }
        if (command === 'sqlite3') {
          const backupCommand = args[3];
          const match = backupCommand.match(/^\.backup "(.+)"$/);
          if (!match) throw new Error(`Unexpected sqlite backup command: ${backupCommand}`);
          fs.writeFileSync(match[1].replace(/''/g, "'"), 'sqlite backup from command');
        }
        if (command === 'gzip') {
          fs.renameSync(args[1], `${args[1]}.gz`);
        }
        return undefined;
      },
    });

    const rawPath = path.join(outputDir, 'sqlite-backup-20260705-150000Z.db');
    const result = runBackupJob({
      allowUnsafeCopy: true,
      cwd,
      databaseUrl: 'file:./dev.db',
      outputDir,
      runtime: runtime,
    });

    expect(result.created.fileName).toBe('sqlite-backup-20260705-150000Z.db.gz');
    expect(result.created.compressed).toBe(true);
    expect(calls).toEqual([
      {
        command: 'sqlite3',
        args: ['-cmd', '.timeout 5000', sourcePath, `.backup "${rawPath}"`],
      },
      {
        command: 'sqlite3',
        args: [rawPath, 'PRAGMA integrity_check;'],
      },
      {
        command: 'gzip',
        args: ['-f', rawPath],
      },
    ]);
  });

  it('deletes the backup and throws when the SQLite integrity check fails', () => {
    const cwd = makeTempDir();
    const sourcePath = path.join(cwd, 'dev.db');
    const outputDir = path.join(cwd, 'backups');
    fs.writeFileSync(sourcePath, 'source');

    const runtime = makeRuntime({
      commandExists: (command) => command === 'sqlite3',
      execFileSync: (command, args) => {
        if (command === 'sqlite3' && args[1] === 'PRAGMA integrity_check;') {
          return Buffer.from('*** in database main ***\nrow 1 missing from index idx');
        }
        if (command === 'sqlite3') {
          const match = String(args[3]).match(/^\.backup "(.+)"$/);
          fs.writeFileSync(match![1].replace(/''/g, "'"), 'corrupt backup');
        }
        return undefined;
      },
    });

    expect(() =>
      runBackupJob({ cwd, databaseUrl: 'file:./dev.db', outputDir, compressSqlite: false, runtime }),
    ).toThrow(/integrity check failed/i);
    // The corrupt snapshot must not be left behind.
    expect(fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : []).toEqual([]);
  });

  it('skips the backup when the database is missing and --allow-missing is set', () => {
    const outputDir = makeTempDir();
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    const originalUrl = process.env.DATABASE_URL;
    const originalNodeEnv = process.env.NODE_ENV;
    try {
      process.env.DATABASE_URL = 'file:./does-not-exist-δ.db';
      process.env.NODE_ENV = 'development';
      expect(() => runCli(['backup', '--allow-missing', '--output-dir', outputDir])).not.toThrow();
      expect(logs.some((line) => /skipping backup/.test(line))).toBe(true);
      // Nothing should have been written.
      expect(fs.readdirSync(outputDir)).toEqual([]);
    } finally {
      console.log = originalLog;
      if (originalUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalUrl;
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('uses pg_dump custom format for PostgreSQL backups', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    const calls: Array<{ command: string; args: string[] }> = [];
    const databaseUrl = 'postgresql://user:secret@db.example/app';

    const runtime = makeRuntime({
      commandExists: (command) => command === 'pg_dump',
      execFileSync: (command, args) => {
        calls.push({ command, args });
        const outputArg = args.find((arg) => arg.startsWith('--file='));
        if (!outputArg) throw new Error('pg_dump call missing --file argument');
        fs.writeFileSync(outputArg.slice('--file='.length), 'postgres dump');
      },
    });

    const result = runBackupJob({
      allowUnsafeCopy: true,
      cwd,
      databaseUrl,
      outputDir,
      runtime: runtime,
    });

    const expectedPath = path.join(outputDir, 'postgres-backup-20260705-150000Z.dump');
    expect(result.created).toMatchObject({
      fileName: 'postgres-backup-20260705-150000Z.dump',
      fullPath: expectedPath,
      engine: 'postgres',
      compressed: false,
    });
    expect(calls).toEqual([
      {
        command: 'pg_dump',
        args: ['--format=custom', `--file=${expectedPath}`, databaseUrl],
      },
    ]);
  });

  it('does not overwrite a same-second PostgreSQL backup', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    const calls: Array<{ command: string; args: string[] }> = [];
    const databaseUrl = 'postgresql://user:secret@db.example/app';

    const runtime = makeRuntime({
      commandExists: (command) => command === 'pg_dump',
      execFileSync: (command, args) => {
        calls.push({ command, args });
        const outputArg = args.find((arg) => arg.startsWith('--file='));
        if (!outputArg) throw new Error('pg_dump call missing --file argument');
        fs.writeFileSync(outputArg.slice('--file='.length), `postgres dump ${calls.length}`);
      },
    });

    const first = runBackupJob({ cwd, databaseUrl, outputDir, runtime });
    const second = runBackupJob({ cwd, databaseUrl, outputDir, runtime });

    expect(first.created.fileName).toBe('postgres-backup-20260705-150000Z.dump');
    expect(second.created.fileName).toBe('postgres-backup-20260705-150000Z-2.dump');
    expect(fs.readFileSync(first.created.fullPath, 'utf8')).toBe('postgres dump 1');
    expect(fs.readFileSync(second.created.fullPath, 'utf8')).toBe('postgres dump 2');
  });

  it('restores PostgreSQL dumps with clean transactional pg_restore and redacts the target URL', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    const backupPath = path.join(outputDir, 'postgres-backup-20260705-150000Z.dump');
    const calls: Array<{ command: string; args: string[] }> = [];
    const databaseUrl = 'postgresql://user:secret@db.example/app';
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(backupPath, 'postgres dump');

    const result = restoreBackup({
      cwd,
      databaseUrl,
      outputDir,
      backupFile: path.basename(backupPath),
      createPreRestoreBackup: false,
      runtime: makeRuntime({
        commandExists: (command) => command === 'pg_restore',
        execFileSync: (command, args) => calls.push({ command, args }),
      }),
    });

    expect(calls).toEqual([
      {
        command: 'pg_restore',
        args: [
          '--clean',
          '--if-exists',
          '--no-owner',
          '--no-privileges',
          '--single-transaction',
          '--dbname',
          databaseUrl,
          backupPath,
        ],
      },
    ]);
    expect(result.target).toBe('postgresql://user:***@db.example/app');
  });

  it('restores compressed SQLite backups atomically through a temp file', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    const dbPath = path.join(cwd, 'data', 'app.db');
    const backupPath = path.join(outputDir, 'sqlite-backup-20260705-150000Z.db.gz');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(dbPath, 'old database');
    fs.writeFileSync(backupPath, zlib.gzipSync(Buffer.from('restored database')));

    const result = restoreBackup({
      cwd,
      databaseUrl: 'file:./data/app.db',
      outputDir,
      backupFile: path.basename(backupPath),
      createPreRestoreBackup: false,
      runtime: makeRuntime(),
      allowUnsafeCopy: true,
    });

    expect(result.target).toBe(dbPath);
    expect(fs.readFileSync(dbPath, 'utf8')).toBe('restored database');
    expect(fs.existsSync(path.join(path.dirname(dbPath), '.restore-fixed-restore-id.db'))).toBe(false);
  });

  it('restore discards the old database’s -wal/-shm/-journal sidecars', () => {
    // Regression (BWK-118): the sidecars describe the database being REPLACED.
    // Left on disk, SQLite replays the old WAL's frames onto the restored file
    // on next open — silently resurrecting pre-restore rows, while
    // `PRAGMA integrity_check` still reports "ok".
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    const dbPath = path.join(cwd, 'data', 'app.db');
    const backupPath = path.join(outputDir, 'sqlite-backup-20260705-150000Z.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(dbPath, 'old database');
    fs.writeFileSync(backupPath, 'restored database');

    // Sidecars from the pre-restore database, as a crashed writer would leave.
    const sidecars = ['-wal', '-shm', '-journal'].map((suffix) => `${dbPath}${suffix}`);
    sidecars.forEach((file) => fs.writeFileSync(file, 'stale frames from the OLD database'));

    restoreBackup({
      cwd,
      databaseUrl: 'file:./data/app.db',
      outputDir,
      backupFile: path.basename(backupPath),
      createPreRestoreBackup: false,
      runtime: makeRuntime(),
      allowUnsafeCopy: true,
    });

    expect(fs.readFileSync(dbPath, 'utf8')).toBe('restored database');
    for (const file of sidecars) {
      expect(fs.existsSync(file), `${path.basename(file)} must not survive a restore`).toBe(false);
    }
  });

  it('restore succeeds when the database has no sidecars to remove', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    const dbPath = path.join(cwd, 'data', 'app.db');
    const backupPath = path.join(outputDir, 'sqlite-backup-20260705-150000Z.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(backupPath, 'restored database');
    // No pre-existing database file at all — removal must be a no-op, not a throw.

    const result = restoreBackup({
      cwd,
      databaseUrl: 'file:./data/app.db',
      outputDir,
      backupFile: path.basename(backupPath),
      createPreRestoreBackup: false,
      allowMissing: true,
      runtime: makeRuntime(),
      allowUnsafeCopy: true,
    });

    expect(result.target).toBe(dbPath);
    expect(fs.readFileSync(dbPath, 'utf8')).toBe('restored database');
  });

  it('plans retention with recent daily slots plus anchor backups', () => {
    const backups = [
      backupEntry('day-0.db.gz', 0),
      backupEntry('day-1.db.gz', 1),
      backupEntry('day-2.db.gz', 2),
      backupEntry('day-8.db.gz', 8),
      backupEntry('day-31.db.gz', 31),
      backupEntry('day-61.db.gz', 61),
      backupEntry('day-90.db.gz', 90),
    ];

    const plan = planRetention(backups, DEFAULT_RETENTION_POLICY, fixedNow);

    expect(plan.keep.map((entry) => [entry.fileName, entry.retentionReason])).toEqual([
      ['day-0.db.gz', 'daily'],
      ['day-1.db.gz', 'daily'],
      ['day-2.db.gz', 'daily'],
      ['day-8.db.gz', 'last_week'],
      ['day-31.db.gz', 'last_month'],
      ['day-61.db.gz', 'two_months_ago'],
    ]);
    expect(plan.remove.map((entry) => entry.fileName)).toEqual(['day-90.db.gz']);
  });

  it('age-tier plan is unchanged when the policy carries an explicit mode', () => {
    // Golden guard: a policy with mode:'age-tier' must produce the identical
    // keep/remove split (order, reasons, labels) as the mode-less default.
    const backups = [
      backupEntry('day-0.db.gz', 0),
      backupEntry('day-1.db.gz', 1),
      backupEntry('day-2.db.gz', 2),
      backupEntry('day-8.db.gz', 8),
      backupEntry('day-31.db.gz', 31),
      backupEntry('day-61.db.gz', 61),
      backupEntry('day-90.db.gz', 90),
    ];

    const base = planRetention(backups, DEFAULT_RETENTION_POLICY, fixedNow);
    const explicit = planRetention(
      backups,
      { ...DEFAULT_RETENTION_POLICY, mode: 'age-tier' },
      fixedNow,
    );

    expect(explicit.keep.map((e) => [e.fileName, e.retentionReason, e.retentionLabel])).toEqual(
      base.keep.map((e) => [e.fileName, e.retentionReason, e.retentionLabel]),
    );
    expect(explicit.remove.map((e) => [e.fileName, e.retentionReason])).toEqual(
      base.remove.map((e) => [e.fileName, e.retentionReason]),
    );
  });

  it('the default policy keeps its exact shape — no `mode` key leaks into plan.policy', () => {
    // Hard compat requirement: consumers serialize plan.policy, so adding a
    // `mode` field to DEFAULT_RETENTION_POLICY would change their JSON output.
    expect(Object.keys(DEFAULT_RETENTION_POLICY).sort()).toEqual([
      'anchors',
      'dailySlots',
      'maxBackups',
    ]);
    expect('mode' in DEFAULT_RETENTION_POLICY).toBe(false);

    const plan = planRetention([backupEntry('day-0.db', 0)], DEFAULT_RETENTION_POLICY, fixedNow);
    expect(plan.policy).toBe(DEFAULT_RETENTION_POLICY);
    expect(JSON.parse(JSON.stringify(plan.policy))).not.toHaveProperty('mode');

    // resolveRetentionPolicy with no overrides returns the shared default object.
    expect(resolveRetentionPolicy()).toBe(DEFAULT_RETENTION_POLICY);
  });

  it('an empty-string retention option means "absent" (pre-existing contract)', () => {
    // readInt() has always treated '' as not-provided, because callers pass raw
    // env values through. Pinned here because it decides which mode is selected.
    expect(resolveRetentionPolicy({ maxBackups: '' })).toBe(DEFAULT_RETENTION_POLICY);
    expect(resolveRetentionPolicy({ keepLast: '' })).toBe(DEFAULT_RETENTION_POLICY);

    // An absent explicit option therefore lets a flat-mode env var win — which is
    // why the typed overloads only narrow on a `number` discriminator.
    expect(resolveRetentionPolicy({ maxBackups: '', env: { DB_BACKUP_KEEP_LAST: '8' } })).toEqual({
      mode: 'keep-last',
      keepLast: 8,
    });
    expect(resolveRetentionPolicy({ keepLast: '', env: { DB_BACKUP_MAX_BACKUPS: '99' } })).toMatchObject(
      { maxBackups: 99 },
    );
  });

  it('keep-last retains the N most-recent backups', () => {
    const backups = [
      backupEntry('day-0.db', 0),
      backupEntry('day-1.db', 1),
      backupEntry('day-9.db', 9),
      backupEntry('day-40.db', 40),
      backupEntry('day-99.db', 99),
    ];

    const plan = planRetention(backups, { mode: 'keep-last', keepLast: 2 }, fixedNow);

    expect(plan.keep.map((e) => [e.fileName, e.retentionReason])).toEqual([
      ['day-0.db', 'keep_last'],
      ['day-1.db', 'keep_last'],
    ]);
    expect(plan.remove.map((e) => e.fileName)).toEqual(['day-9.db', 'day-40.db', 'day-99.db']);
  });

  it('keep-days retains backups younger than the window', () => {
    const backups = [
      backupEntry('day-0.db', 0),
      backupEntry('day-6.db', 6),
      backupEntry('day-7.db', 7),
      backupEntry('day-20.db', 20),
    ];

    const plan = planRetention(backups, { mode: 'keep-days', keepDays: 7 }, fixedNow);

    // Strictly younger than 7 days: day-0 and day-6 stay; day-7 (exactly at the
    // boundary) and day-20 rotate out.
    expect(plan.keep.map((e) => e.fileName)).toEqual(['day-0.db', 'day-6.db']);
    expect(plan.keep.every((e) => e.retentionReason === 'keep_days')).toBe(true);
    expect(plan.remove.map((e) => e.fileName)).toEqual(['day-7.db', 'day-20.db']);
  });

  it('keep-days always keeps the most-recent backup even past the window (age guard)', () => {
    const backups = [backupEntry('old-30.db', 30), backupEntry('old-45.db', 45)];

    const plan = planRetention(backups, { mode: 'keep-days', keepDays: 7 }, fixedNow);

    expect(plan.keep.map((e) => [e.fileName, e.retentionReason])).toEqual([['old-30.db', 'newest']]);
    expect(plan.remove.map((e) => e.fileName)).toEqual(['old-45.db']);
  });

  it('flat modes handle an empty backup list without error', () => {
    expect(planRetention([], { mode: 'keep-last', keepLast: 3 }, fixedNow)).toMatchObject({
      keep: [],
      remove: [],
    });
    expect(planRetention([], { mode: 'keep-days', keepDays: 5 }, fixedNow)).toMatchObject({
      keep: [],
      remove: [],
    });
  });

  it('keep-days clamps a future-dated backup to now (no negative age)', () => {
    const backups = [
      backupEntry('future.db', -5), // 5 days in the future (clock skew)
      backupEntry('day-2.db', 2),
      backupEntry('day-10.db', 10),
    ];

    const plan = planRetention(backups, { mode: 'keep-days', keepDays: 7 }, fixedNow);

    // future.db clamps to age 0 (kept); day-2 kept; day-10 rotates out.
    expect(plan.keep.map((e) => e.fileName).sort()).toEqual(['day-2.db', 'future.db']);
    expect(plan.remove.map((e) => e.fileName)).toEqual(['day-10.db']);
  });

  it('resolveRetentionPolicy selects flat modes from args and env', () => {
    expect(resolveRetentionPolicy({ keepLast: 5 })).toEqual({ mode: 'keep-last', keepLast: 5 });
    expect(resolveRetentionPolicy({ keepDays: 14 })).toEqual({ mode: 'keep-days', keepDays: 14 });
    expect(resolveRetentionPolicy({ env: { DB_BACKUP_KEEP_LAST: '8' } })).toEqual({
      mode: 'keep-last',
      keepLast: 8,
    });
    // Explicit arg wins over env of either mode.
    expect(resolveRetentionPolicy({ keepDays: 3, env: { DB_BACKUP_KEEP_LAST: '8' } })).toEqual({
      mode: 'keep-days',
      keepDays: 3,
    });
  });

  it('an explicit age-tier arg beats a stale flat-mode env var', () => {
    // Regression: a stale DB_BACKUP_KEEP_LAST must not silently override an
    // explicit --max-backups and switch the whole policy to keep-last.
    const policy = resolveRetentionPolicy({
      maxBackups: 9,
      env: { DB_BACKUP_KEEP_LAST: '8' },
    });

    expect(policy).toMatchObject({ maxBackups: 9 });
    expect('mode' in policy && policy.mode).not.toBe('keep-last');
  });

  it('an explicit flat arg beats a stale age-tier env var', () => {
    const policy = resolveRetentionPolicy({
      keepDays: 3,
      env: { DB_BACKUP_MAX_BACKUPS: '99', DB_BACKUP_DAILY_SLOTS: '9' },
    });

    expect(policy).toEqual({ mode: 'keep-days', keepDays: 3 });
  });

  it('resolveRetentionPolicy rejects invalid or conflicting flat options', () => {
    expect(() => resolveRetentionPolicy({ keepLast: 0 })).toThrow(/keepLast/);
    expect(() => resolveRetentionPolicy({ keepDays: 0 })).toThrow(/keepDays/);
    expect(() => resolveRetentionPolicy({ keepLast: 2, keepDays: 2 })).toThrow(/mutually exclusive/);
    expect(() =>
      resolveRetentionPolicy({ env: { DB_BACKUP_KEEP_LAST: '2', DB_BACKUP_KEEP_DAYS: '2' } }),
    ).toThrow(/mutually exclusive/);
    expect(() => resolveRetentionPolicy({ keepLast: 2, maxBackups: 4 })).toThrow(
      /cannot be combined/,
    );
  });


  it('bounds every external command with a timeout (standard 3)', () => {
    // An unbounded execFileSync lets a hung sqlite3/pg_dump block a nightly cron
    // forever. The bound is injected once at the runtime choke point.
    const calls: Array<{ command: string; options: Record<string, unknown> }> = [];
    const runtime = normalizeRuntime({
      execFileSync: ((command: string, _args: string[], options: Record<string, unknown>) => {
        calls.push({ command, options });
        return Buffer.from('ok');
      }) as never,
      commandExists: () => true,
    });

    runtime.execFileSync('sqlite3', ['x', 'PRAGMA integrity_check;'], { stdio: 'pipe' });

    expect(calls).toHaveLength(1);
    expect(calls[0].options.timeout).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
    expect(calls[0].options.killSignal).toBe('SIGKILL');
    // The per-call option survives alongside the injected bound.
    expect(calls[0].options.stdio).toBe('pipe');
  });

  it('command timeout is configurable via runtime and env, explicit wins', () => {
    const seen: number[] = [];
    const capture = ((_c: string, _a: string[], o: Record<string, unknown>) =>
      void seen.push(o.timeout as number)) as never;

    normalizeRuntime({ execFileSync: capture, commandTimeoutMs: 1234 }).execFileSync('x', []);
    expect(seen.at(-1)).toBe(1234);

    const originalEnv = process.env.DB_BACKUP_COMMAND_TIMEOUT_MS;
    try {
      process.env.DB_BACKUP_COMMAND_TIMEOUT_MS = '5555';
      normalizeRuntime({ execFileSync: capture }).execFileSync('x', []);
      expect(seen.at(-1)).toBe(5555);

      // Explicit runtime value beats the env var.
      normalizeRuntime({ execFileSync: capture, commandTimeoutMs: 77 }).execFileSync('x', []);
      expect(seen.at(-1)).toBe(77);
    } finally {
      if (originalEnv === undefined) delete process.env.DB_BACKUP_COMMAND_TIMEOUT_MS;
      else process.env.DB_BACKUP_COMMAND_TIMEOUT_MS = originalEnv;
    }

    expect(() => normalizeRuntime({ commandTimeoutMs: 0 })).toThrow(/commandTimeoutMs/);
  });

  it('createSqliteSnapshot refuses to copy when sqlite3 is absent (standards 5 + 6)', () => {
    // Without sqlite3 there is no consistent snapshot: a byte copy omits
    // committed transactions held in the -wal and can tear under a concurrent
    // writer. There is no "safe cp" to detect — checking for a -wal first would
    // race a writer creating one. Refuse; a bad backup is worse than a failure.
    const dir = makeTempDir();
    const sourcePath = path.join(dir, 'app.db');
    fs.writeFileSync(sourcePath, 'database');

    expect(() =>
      createSqliteSnapshot({
        sourcePath,
        destPath: path.join(dir, 'snap.db'),
        runtime: makeRuntime({ commandExists: () => false }),
      }),
    ).toThrow(/sqlite3.*unavailable|allowUnsafeCopy/s);

    expect(fs.existsSync(path.join(dir, 'snap.db'))).toBe(false);
  });

  it('createSqliteSnapshot copies only when the caller opts in to an inconsistent copy', () => {
    const dir = makeTempDir();
    const sourcePath = path.join(dir, 'app.db');
    const destPath = path.join(dir, 'snap.db');
    fs.writeFileSync(sourcePath, 'self-contained database');

    createSqliteSnapshot({
      sourcePath,
      destPath,
      runtime: makeRuntime({ commandExists: () => false }),
      allowUnsafeCopy: true,
    });

    expect(fs.readFileSync(destPath, 'utf8')).toBe('self-contained database');
  });

  it('runBackupJob refuses the cp path unless allowUnsafeCopy is set', () => {
    const cwd = makeTempDir();
    const dbPath = path.join(cwd, 'app.db');
    fs.writeFileSync(dbPath, 'database');

    expect(() =>
      runBackupJob({
        cwd,
        databaseUrl: 'file:./app.db',
        outputDir: path.join(cwd, 'backups'),
        compressSqlite: false,
        runtime: makeRuntime({ commandExists: () => false }),
      }),
    ).toThrow(/sqlite3.*unavailable|allowUnsafeCopy/s);
  });

  it('createSqliteSnapshot really writes to a path containing a quote, via real sqlite3 (BWK-130)', () => {
    // The unit test above pins the argv we build; this one proves the real
    // sqlite3 binary accepts it. The old `''` escaping failed here with
    // `cannot open "brien/snap.db"` and produced no file at all.
    const dir = makeTempDir();
    const sourcePath = path.join(dir, 'app.db');
    const quotedDir = path.join(dir, "o'brien dir");
    const destPath = path.join(quotedDir, 'snap.db');
    fs.mkdirSync(quotedDir, { recursive: true });

    const realRuntime = normalizeRuntime();
    if (!realRuntime.commandExists('sqlite3')) return; // sqlite3 unavailable

    realRuntime.execFileSync('sqlite3', [sourcePath, "CREATE TABLE t(v); INSERT INTO t VALUES('x');"], { stdio: 'pipe' });

    createSqliteSnapshot({ sourcePath, destPath, runtime: realRuntime });

    expect(fs.existsSync(destPath), 'snapshot must exist at the quoted path').toBe(true);
    const rows = realRuntime
      .execFileSync('sqlite3', [destPath, 'SELECT group_concat(v) FROM t;'], { stdio: ['ignore', 'pipe', 'pipe'] })
      .toString()
      .trim();
    expect(rows).toBe('x');
  });

  it('createSqliteSnapshot quotes the destination path for the sqlite3 dot-command (BWK-130)', () => {
    // A dot-command is NOT SQL: sqlite3 tokenizes its arguments with shell-like
    // quoting. Doubling a single quote (the SQL escape) does not work here and
    // silently truncates the path. Verified against sqlite3: double-quote the
    // argument and backslash-escape `\` and `"`.
    const dir = makeTempDir();
    const sourcePath = path.join(dir, 'app.db');
    fs.writeFileSync(sourcePath, 'db');

    const cases: Array<[string, string]> = [
      ["/tmp/o'brien/snap.db", '.backup "/tmp/o\'brien/snap.db"'],
      ['/tmp/with space/snap.db', '.backup "/tmp/with space/snap.db"'],
      ['/tmp/say"hi/snap.db', '.backup "/tmp/say\\"hi/snap.db"'],
      ['/tmp/back\\slash/snap.db', '.backup "/tmp/back\\\\slash/snap.db"'],
    ];

    for (const [destPath, expected] of cases) {
      const captured: string[][] = [];
      createSqliteSnapshot({
        sourcePath,
        destPath,
        runtime: makeRuntime({
          commandExists: () => true,
          execFileSync: ((_c: string, args: string[]) => {
            captured.push(args);
            return Buffer.from('ok');
          }) as never,
        }),
      });
      const backupArg = captured[0].find((a) => a.startsWith('.backup'));
      expect(backupArg, `destPath ${destPath}`).toBe(expected);
    }
  });


  it('verifySqliteBackupIntegrity does NOT delete the file it rejects (BWK-129)', () => {
    // The exported default must be non-destructive: a consumer vetting a
    // user-supplied backup path must never have that file deleted underneath it.
    const dir = makeTempDir();
    const filePath = path.join(dir, 'corrupt.db');
    fs.writeFileSync(filePath, 'db bytes');

    // A *parseable but corrupt* database: sqlite3 opens it and integrity_check
    // prints a failure. (On garbage, execFileSync throws first and nothing is
    // deleted regardless — which is what makes an unsafe default hard to notice.)
    const runtime = makeRuntime({
      commandExists: () => true,
      execFileSync: (() => Buffer.from('*** in database main ***\nRowid 0 out of order')) as never,
    });

    expect(() => verifySqliteBackupIntegrity(filePath, runtime)).toThrow(/integrity check failed/i);
    expect(fs.existsSync(filePath), 'the caller\u2019s file must survive').toBe(true);
  });

  it('verifySqliteBackupIntegrity deletes only when the caller opts in', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'own-snapshot.db');
    fs.writeFileSync(filePath, 'db bytes');

    const runtime = makeRuntime({
      commandExists: () => true,
      execFileSync: (() => Buffer.from('Rowid 0 out of order')) as never,
    });

    expect(() =>
      verifySqliteBackupIntegrity(filePath, runtime, { deleteOnFailure: true }),
    ).toThrow(/integrity check failed/i);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('createSqliteSnapshot discards its own corrupt snapshot', () => {
    // The one legitimate destructive case: the snapshot is a file the package
    // just wrote, so a bad backup is worse than a loud failure.
    const dir = makeTempDir();
    const sourcePath = path.join(dir, 'app.db');
    const destPath = path.join(dir, 'snap.db');
    fs.writeFileSync(sourcePath, 'db');

    const runtime = makeRuntime({
      commandExists: () => true,
      execFileSync: ((_c: string, args: string[]) => {
        const isBackup = args.some((a) => String(a).startsWith('.backup'));
        if (isBackup) {
          fs.writeFileSync(destPath, 'corrupt snapshot');
          return Buffer.from('');
        }
        return Buffer.from('Rowid 0 out of order'); // integrity_check
      }) as never,
    });

    expect(() => createSqliteSnapshot({ sourcePath, destPath, runtime })).toThrow(
      /integrity check failed/i,
    );
    expect(fs.existsSync(destPath), 'a corrupt snapshot must not be kept').toBe(false);
    expect(fs.existsSync(sourcePath), 'the source database is never touched').toBe(true);
  });


  it('never prunes the backup it just created, even when the clock jumped backward (BWK-131)', () => {
    // A host whose clock jumps backward at boot gives the NEW file an older
    // timestamp than existing ones. A retention policy that trusts the ordering
    // would then delete the only backup that was just verified. Absorbed from
    // smarthome's prune_local, which protects `$final` explicitly.
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'app.db'), 'db');

    // Two existing backups, both NEWER than the one about to be created.
    for (const stamp of ['20260706-120000Z', '20260707-120000Z']) {
      fs.writeFileSync(path.join(outputDir, `sqlite-backup-${stamp}.db`), 'old');
    }

    // fixedNow is 2026-07-05 — earlier than both, i.e. the clock went backward.
    const result = runBackupJob({
      allowUnsafeCopy: true,
      cwd,
      databaseUrl: 'file:./app.db',
      outputDir,
      compressSqlite: false,
      policy: { mode: 'keep-last', keepLast: 1 },
      runtime: makeRuntime(),
    });

    expect(fs.existsSync(result.created.fullPath), 'the new backup must survive retention').toBe(true);
    expect(result.removed.map((e) => e.fileName)).not.toContain(result.created.fileName);
  });

  it('a snapshot below the minimum size is discarded, not kept (BWK-131)', () => {
    // An empty or truncated database sails through PRAGMA integrity_check.
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'app.db'), 'x');

    expect(() =>
      runBackupJob({
        allowUnsafeCopy: true,
        cwd,
        databaseUrl: 'file:./app.db',
        outputDir,
        compressSqlite: false,
        minBytes: 32768,
        runtime: makeRuntime(),
      }),
    ).toThrow(/below the 32768-byte minimum/);

    const leftovers = fs.readdirSync(outputDir).filter((f) => f.startsWith('sqlite-backup-'));
    expect(leftovers, 'the undersized snapshot must not be kept').toEqual([]);
  });

  it('the .last-success stamp is written only after a fully successful run (BWK-131)', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    const stampFile = path.join(outputDir, '.last-success');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'app.db'), 'x');

    // A run that fails the size floor must leave no stamp behind.
    expect(() =>
      runBackupJob({
        allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir,
        compressSqlite: false, minBytes: 32768, stampFile, runtime: makeRuntime(),
      }),
    ).toThrow();
    expect(fs.existsSync(stampFile), 'a failed run must not stamp success').toBe(false);

    // A clean run stamps.
    runBackupJob({
      allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir,
      compressSqlite: false, stampFile, runtime: makeRuntime(),
    });
    expect(fs.readFileSync(stampFile, 'utf8').trim()).toBe(fixedNow.toISOString());
  });

  it('checkBackupFreshness treats a missing or stale stamp as not fresh', () => {
    const dir = makeTempDir();
    const stampFile = path.join(dir, '.last-success');

    // Absence of evidence is not evidence of a backup.
    expect(checkBackupFreshness({ stampFile, maxAgeHours: 36, now: fixedNow })).toMatchObject({
      fresh: false,
      stampedAt: null,
    });

    writeSuccessStamp(stampFile, new Date(fixedNow.getTime() - 2 * 60 * 60 * 1000));
    expect(checkBackupFreshness({ stampFile, maxAgeHours: 36, now: fixedNow }).fresh).toBe(true);

    writeSuccessStamp(stampFile, new Date(fixedNow.getTime() - 48 * 60 * 60 * 1000));
    const stale = checkBackupFreshness({ stampFile, maxAgeHours: 36, now: fixedNow });
    expect(stale.fresh).toBe(false);
    expect(Math.round(stale.ageHours!)).toBe(48);

    fs.writeFileSync(stampFile, 'not a date');
    expect(checkBackupFreshness({ stampFile, maxAgeHours: 36, now: fixedNow }).fresh).toBe(false);
  });

  it('a future-dated stamp is a clock problem, not a fresh backup (BWK-135)', () => {
    // Negative age would otherwise always sit under the threshold, so a host
    // whose clock jumped forward once would report "fresh" forever — even with
    // backups stopped. Same clock-skew failure mode the retention guard covers.
    const dir = makeTempDir();
    const stampFile = path.join(dir, '.last-success');

    writeSuccessStamp(stampFile, new Date(fixedNow.getTime() + 6 * 60 * 60 * 1000));
    const status = checkBackupFreshness({ stampFile, maxAgeHours: 36, now: fixedNow });

    expect(status.fresh, 'a future stamp must never read as fresh').toBe(false);
    expect(status.clockSkew, 'and must be reported as a clock problem').toBe(true);
    expect(status.ageHours).toBeLessThan(0);

    // A normal stamp is not a clock problem.
    writeSuccessStamp(stampFile, new Date(fixedNow.getTime() - 60 * 60 * 1000));
    expect(checkBackupFreshness({ stampFile, maxAgeHours: 36, now: fixedNow })).toMatchObject({
      fresh: true,
      clockSkew: false,
    });
  });

  it('encryption refuses rather than writing an unencrypted backup when gpg is missing', () => {
    const dir = makeTempDir();
    const passphraseFile = path.join(dir, 'pass');
    fs.writeFileSync(passphraseFile, 'secret');
    const entry = { fileName: 'x.db', fullPath: path.join(dir, 'x.db'), sizeBytes: 3 } as never;
    fs.writeFileSync(path.join(dir, 'x.db'), 'db');

    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (require('../index.js') as any).encryptBackupEntry(
        entry,
        { passphraseFile },
        makeRuntime({ commandExists: () => false }),
      ),
    ).toThrow(/gpg.*unavailable/i);
  });

  it('restoring an encrypted backup without a passphrase fails loudly', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(path.join(cwd, 'data'), { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'sqlite-backup-20260705-150000Z.db.gpg'), 'ciphertext');

    expect(() =>
      restoreBackup({
        cwd,
        databaseUrl: 'file:./data/app.db',
        outputDir,
        backupFile: 'sqlite-backup-20260705-150000Z.db.gpg',
        createPreRestoreBackup: false,
        runtime: makeRuntime(),
      }),
    ).toThrow(/encrypted; encryption.passphraseFile is required/);
  });


  it('uploads off-host and verifies the remote object before pruning or stamping (BWK-131)', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    const stampFile = path.join(outputDir, '.last-success');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'app.db'), 'database bytes');

    const calls: string[][] = [];
    const runtime = makeRuntime({
      commandExists: (c: string) => c === 'rclone',
      execFileSync: ((cmd: string, args: string[]) => {
        calls.push([cmd, ...args]);
        if (args[0] === 'lsjson') {
          // Report the real local size so verification passes.
          const local = fs.statSync(path.join(outputDir, fs.readdirSync(outputDir).find((f) => f.startsWith('sqlite-backup-'))!)).size;
          return Buffer.from(JSON.stringify({ Size: local }));
        }
        if (args[0] === 'lsf') return Buffer.from('');
        return Buffer.from('');
      }) as never,
    });

    const result = runBackupJob({
      allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir,
      compressSqlite: false, stampFile, runtime,
      remote: { target: 'offsite:backups/app' },
    });

    const verbs = calls.map((c) => c[1]);
    expect(verbs).toContain('copyto');
    expect(verbs).toContain('lsjson');
    // Upload+verify must precede any pruning.
    expect(verbs.indexOf('lsjson')).toBeLessThan(verbs.indexOf('lsf') === -1 ? Infinity : verbs.indexOf('lsf'));
    expect(result.uploaded).toMatchObject({ target: `offsite:backups/app/${result.created.fileName}` });
    expect(fs.existsSync(stampFile)).toBe(true);
  });

  it('a remote size mismatch prunes nothing and stamps nothing (fail-closed)', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    const stampFile = path.join(outputDir, '.last-success');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'app.db'), 'database bytes');
    fs.writeFileSync(path.join(outputDir, 'sqlite-backup-20260701-120000Z.db'), 'old');
    fs.writeFileSync(stampFile, '2026-07-01T00:00:00.000Z\n');

    const runtime = makeRuntime({
      commandExists: (c: string) => c === 'rclone',
      execFileSync: ((_c: string, args: string[]) =>
        args[0] === 'lsjson' ? Buffer.from(JSON.stringify({ Size: 1 })) : Buffer.from('')) as never,
    });

    expect(() =>
      runBackupJob({
        allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir,
        compressSqlite: false, stampFile, runtime,
        policy: { mode: 'keep-last', keepLast: 1 },
        remote: { target: 'offsite:backups/app' },
      }),
    ).toThrow(/Remote size mismatch/);

    expect(fs.existsSync(path.join(outputDir, 'sqlite-backup-20260701-120000Z.db')), 'old backup must survive').toBe(true);
    expect(fs.readFileSync(stampFile, 'utf8').trim()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('an unparseable rclone response is a verification failure, not a pass', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'app.db'), 'db');

    const runtime = makeRuntime({
      commandExists: (c: string) => c === 'rclone',
      execFileSync: ((_c: string, args: string[]) =>
        args[0] === 'lsjson' ? Buffer.from('not json at all') : Buffer.from('')) as never,
    });

    expect(() =>
      runBackupJob({
        allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir,
        compressSqlite: false, runtime, remote: { target: 'offsite:x' },
      }),
    ).toThrow(/Could not determine remote object size/);
  });

  it('refuses to report success when rclone is unavailable', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'app.db'), 'db');

    expect(() =>
      runBackupJob({
        allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir,
        compressSqlite: false, runtime: makeRuntime({ commandExists: () => false }),
        remote: { target: 'offsite:x' },
      }),
    ).toThrow(/rclone.*unavailable/i);
  });

  it('--skip-remote runs local-only without touching rclone', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'app.db'), 'db');
    const calls: string[] = [];

    const result = runBackupJob({
      allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir, compressSqlite: false,
      remote: { target: 'offsite:x' }, skipRemote: true,
      runtime: makeRuntime({ execFileSync: ((c: string) => { calls.push(c); return Buffer.from(''); }) as never }),
    });

    expect(calls).not.toContain('rclone');
    expect(result.uploaded).toBeNull();
  });

  it('remote prune never deletes the object it just uploaded', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'app.db'), 'db');
    const deleted: string[] = [];

    const runtime = makeRuntime({
      commandExists: (c: string) => c === 'rclone',
      execFileSync: ((_c: string, args: string[]) => {
        if (args[0] === 'lsjson') {
          const f = fs.readdirSync(outputDir).find((n) => n.startsWith('sqlite-backup-'))!;
          return Buffer.from(JSON.stringify({ Size: fs.statSync(path.join(outputDir, f)).size }));
        }
        if (args[0] === 'lsf') {
          // The just-uploaded object sorts OLDEST here (clock rolled backward).
          return Buffer.from(
            ['sqlite-backup-20260709-120000Z.db', 'sqlite-backup-20260708-120000Z.db', 'sqlite-backup-20260705-150000Z.db'].join('\n'),
          );
        }
        if (args[0] === 'deletefile') deleted.push(String(args[1]));
        return Buffer.from('');
      }) as never,
    });

    const result = runBackupJob({
      allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir, compressSqlite: false,
      runtime, remote: { target: 'offsite:x', keep: 1 },
    });

    expect(deleted.some((d) => d.endsWith(result.created.fileName)), 'must never delete the object it just verified').toBe(false);
    expect(deleted.length).toBeGreaterThan(0);
  });


  it('writes backups, manifest and stamp with restrictive permissions (BWK-132)', () => {
    // A backup is a full copy of the database. The package must not rely on the
    // caller's umask: gzip/gpg/pg_dump write through child processes that ignore
    // Node's mode argument entirely. smarthome got this right with `umask 077`.
    if (process.platform === 'win32') return;
    const previousUmask = process.umask(0o022); // deliberately permissive
    try {
      const cwd = makeTempDir();
      const outputDir = path.join(cwd, 'backups');
      const stampFile = path.join(outputDir, '.last-success');
      fs.writeFileSync(path.join(cwd, 'app.db'), 'database bytes');

      const result = runBackupJob({
        allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir,
        compressSqlite: false, stampFile, runtime: makeRuntime(),
      });

      const mode = (p: string) => fs.statSync(p).mode & 0o777;
      expect(mode(result.created.fullPath), 'backup artifact').toBe(0o600);
      expect(mode(path.join(outputDir, 'backup-manifest.json')), 'manifest').toBe(0o600);
      expect(mode(stampFile), 'success stamp').toBe(0o600);
      expect(mode(outputDir), 'backup directory').toBe(0o700);
    } finally {
      process.umask(previousUmask);
    }
  });

  it('does not re-mode a backup directory the operator already created', () => {
    if (process.platform === 'win32') return;
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.chmodSync(outputDir, 0o750); // operator's choice, e.g. group-readable
    fs.writeFileSync(path.join(cwd, 'app.db'), 'db');

    runBackupJob({
      allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir,
      compressSqlite: false, runtime: makeRuntime(),
    });

    expect(fs.statSync(outputDir).mode & 0o777, 'existing dir mode preserved').toBe(0o750);
  });


  it('a custom namePrefix names, lists, prunes and restores its own backups (BWK-133)', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'app.db'), 'db');

    const result = runBackupJob({
      allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir,
      compressSqlite: false, namePrefix: 'smarthome', runtime: makeRuntime(),
    });

    expect(result.created.fileName).toBe('smarthome-20260705-150000Z.db');
    // Engine still resolves — it comes from the `.db` extension, not the prefix.
    expect(result.created.engine).toBe('sqlite');

    const listed = listBackupsWithPlan({ cwd, outputDir, namePrefix: 'smarthome', runtime: makeRuntime() });
    expect(listed.backups.map((b) => b.fileName)).toEqual(['smarthome-20260705-150000Z.db']);
  });

  it('prefix scoping: a job never sees or prunes another app\u2019s backups (BWK-133)', () => {
    // A shared backup directory (or remote bucket) must not let app A prune app B.
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'app.db'), 'db');
    fs.writeFileSync(path.join(outputDir, 'otherapp-20260101-000000Z.db'), 'foreign');
    fs.writeFileSync(path.join(outputDir, 'sqlite-backup-20260101-000000Z.db'), 'canonical');
    fs.writeFileSync(path.join(outputDir, 'notes.db'), 'not a backup');

    // keep-last:1 would prune everything it can see.
    runBackupJob({
      allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir,
      compressSqlite: false, namePrefix: 'smarthome',
      policy: { mode: 'keep-last', keepLast: 1 }, runtime: makeRuntime(),
    });

    for (const survivor of ['otherapp-20260101-000000Z.db', 'sqlite-backup-20260101-000000Z.db', 'notes.db']) {
      expect(fs.existsSync(path.join(outputDir, survivor)), `${survivor} must survive`).toBe(true);
    }
  });

  it('without namePrefix, only the canonical prefixes are recognised (no widening)', () => {
    expect(parseBackupFileName('sqlite-backup-20260705-150000Z.db')).toMatchObject({ engine: 'sqlite' });
    expect(parseBackupFileName('postgres-backup-20260705-150000Z.dump')).toMatchObject({ engine: 'postgres' });
    // A foreign prefix must NOT parse by default.
    expect(parseBackupFileName('smarthome-20260705-150000Z.db')).toBeNull();
    expect(parseBackupFileName('otherapp-20260705-150000Z.db')).toBeNull();
    // ...but does with the prefix supplied.
    expect(parseBackupFileName('smarthome-20260705-150000Z.db', 'smarthome')).toMatchObject({
      engine: 'sqlite', prefix: 'smarthome',
    });
    // Engine comes from the extension.
    expect(parseBackupFileName('smarthome-20260705-150000Z.dump', 'smarthome')).toMatchObject({ engine: 'postgres' });
    // And the canonical prefix must not parse when a different one is expected.
    expect(parseBackupFileName('sqlite-backup-20260705-150000Z.db', 'smarthome')).toBeNull();
  });

  it('remote prune is scoped to the configured prefix', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'app.db'), 'db');
    const deleted: string[] = [];

    const runtime = makeRuntime({
      commandExists: (c: string) => c === 'rclone',
      execFileSync: ((_c: string, args: string[]) => {
        if (args[0] === 'lsjson') {
          const f = fs.readdirSync(outputDir).find((n) => n.startsWith('smarthome-'))!;
          return Buffer.from(JSON.stringify({ Size: fs.statSync(path.join(outputDir, f)).size }));
        }
        if (args[0] === 'lsf') {
          // A shared bucket holding two apps' backups.
          return Buffer.from(
            ['smarthome-20260101-000000Z.db', 'smarthome-20260102-000000Z.db', 'otherapp-20260101-000000Z.db'].join('\n'),
          );
        }
        if (args[0] === 'deletefile') deleted.push(String(args[1]));
        return Buffer.from('');
      }) as never,
    });

    runBackupJob({
      allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir, compressSqlite: false,
      namePrefix: 'smarthome', runtime, remote: { target: 'offsite:shared', keep: 1 },
    });

    expect(deleted.some((d) => d.includes('otherapp')), 'must never prune another app').toBe(false);
    expect(deleted.some((d) => d.includes('smarthome-2026010'))).toBe(true);
  });

  it('lists only supported backup filenames and annotates retention decisions', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'sqlite-backup-20260705-150000Z.db'), 'sqlite');
    fs.writeFileSync(path.join(outputDir, 'sqlite-backup-20260705-150000Z-2.db'), 'sqlite again');
    fs.writeFileSync(path.join(outputDir, 'notes.txt'), 'ignore me');

    const result = listBackupsWithPlan({
      cwd,
      databaseUrl: 'file:./app.db',
      outputDir,
      runtime: makeRuntime(),
      allowUnsafeCopy: true,
    });

    expect(result.backups).toHaveLength(2);
    expect(result.backups[0]).toMatchObject({
      fileName: 'sqlite-backup-20260705-150000Z-2.db',
      keep: true,
      retentionReason: 'daily',
    });
    expect(result.backups[1]).toMatchObject({
      fileName: 'sqlite-backup-20260705-150000Z.db',
      keep: true,
      retentionReason: 'daily',
    });
  });

  it('lists backups without a DATABASE_URL (list never opens the database)', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'sqlite-backup-20260705-150000Z.db'), 'sqlite');

    const originalUrl = process.env.DATABASE_URL;
    try {
      delete process.env.DATABASE_URL;
      const result = listBackupsWithPlan({ cwd, outputDir, runtime: makeRuntime() });
      expect(result.backups).toHaveLength(1);
    } finally {
      if (originalUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalUrl;
    }
  });

  it('resolveRetentionPolicy prefers CLI args over env, and env over the default', () => {
    expect(resolveRetentionPolicy()).toBe(DEFAULT_RETENTION_POLICY);

    const fromEnv = resolveRetentionPolicy({
      env: { DB_BACKUP_MAX_BACKUPS: '4', DB_BACKUP_DAILY_SLOTS: '1' },
    });
    expect(fromEnv.maxBackups).toBe(4);
    expect(fromEnv.dailySlots).toBe(1);
    expect(fromEnv.anchors).toEqual(DEFAULT_RETENTION_POLICY.anchors);

    const argsWin = resolveRetentionPolicy({
      maxBackups: 9,
      env: { DB_BACKUP_MAX_BACKUPS: '4', DB_BACKUP_DAILY_SLOTS: '1' },
    });
    expect(argsWin.maxBackups).toBe(9);
    expect(argsWin.dailySlots).toBe(1);

    expect(() => resolveRetentionPolicy({ maxBackups: 0 })).toThrow(/maxBackups/);
    expect(() => resolveRetentionPolicy({ env: { DB_BACKUP_MAX_BACKUPS: 'x' } })).toThrow(
      /DB_BACKUP_MAX_BACKUPS/,
    );
    // Strict: fractional/suffixed strings are rejected, not silently truncated.
    expect(() => resolveRetentionPolicy({ maxBackups: '1.5' })).toThrow(/maxBackups/);
    expect(() => resolveRetentionPolicy({ env: { DB_BACKUP_DAILY_SLOTS: '3x' } })).toThrow(
      /DB_BACKUP_DAILY_SLOTS/,
    );
  });

  it('rejects fractional/suffixed --max-backups on the CLI instead of truncating', () => {
    const outputDir = makeTempDir();
    expect(() => runCli(['list', '--output-dir', outputDir, '--max-backups', '2x'])).toThrow(
      /--max-backups/,
    );
  });

  it('pruneBackupsJob deletes overflow backups to the policy without creating one', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    // Four consecutive daily snapshots, newest first.
    const files = [
      'sqlite-backup-20260705-150000Z.db',
      'sqlite-backup-20260704-150000Z.db',
      'sqlite-backup-20260703-150000Z.db',
      'sqlite-backup-20260702-150000Z.db',
    ];
    for (const name of files) {
      fs.writeFileSync(path.join(outputDir, name), 'sqlite');
    }

    const originalUrl = process.env.DATABASE_URL;
    try {
      delete process.env.DATABASE_URL; // prune must not require it
      const result = pruneBackupsJob({
        cwd,
        outputDir,
        runtime: makeRuntime(),
      allowUnsafeCopy: true,
        policy: resolveRetentionPolicy({ maxBackups: 2, dailySlots: 2 }),
      });

      expect(result.kept.map((entry) => entry.fileName)).toEqual([
        'sqlite-backup-20260705-150000Z.db',
        'sqlite-backup-20260704-150000Z.db',
      ]);
      expect(result.removed.map((entry) => entry.fileName)).toEqual([
        'sqlite-backup-20260703-150000Z.db',
        'sqlite-backup-20260702-150000Z.db',
      ]);
      // The overflow files are actually gone from disk; the kept ones remain.
      expect(fs.readdirSync(outputDir).sort()).toEqual([
        'sqlite-backup-20260704-150000Z.db',
        'sqlite-backup-20260705-150000Z.db',
      ]);
    } finally {
      if (originalUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalUrl;
    }
  });

  it('cron output reflects --output-dir/--prod/--allow-missing and honors --command', () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    try {
      runCli(['cron', '--hour', '4', '--minute', '30', '--prod', '--output-dir', '/var/backups/app', '--allow-missing']);
      expect(logs[0]).toMatch(/^30 4 \* \* \* /);
      expect(logs[0]).toContain('npx db-backup backup --prod --output-dir "/var/backups/app" --allow-missing');
      expect(logs[0]).toContain('/var/backups/app/backup.log');

      logs.length = 0;
      runCli(['cron', '--command', 'pnpm exec db-backup backup', '--log-path', '/tmp/b.log']);
      expect(logs[0]).toContain("bash -lc 'pnpm exec db-backup backup >> \"/tmp/b.log\" 2>&1'");

      // A single quote in the command must be escaped, not break the entry.
      logs.length = 0;
      runCli(['cron', '--command', "echo 'hi'", '--log-path', '/tmp/b.log']);
      expect(logs[0]).toContain("bash -lc 'echo '\\''hi'\\'' >> \"/tmp/b.log\" 2>&1'");
    } finally {
      console.log = originalLog;
    }
  });

  it('resolves backup directories from env + candidates, expanding ~ and de-duping', () => {
    const {
      resolveBackupDirectories,
    } = require('../index.js') as typeof import('../index');
    const home = '/home/tester';
    const dirs = resolveBackupDirectories({
      env: { BACKUP_DIRS: '~/backups, /srv/app/backups' },
      candidates: ['/srv/app/backups', '~/backups', 'relative/dir'],
      home,
    });
    expect(dirs).toEqual([
      '/home/tester/backups',
      '/srv/app/backups',
      path.resolve('relative/dir'),
    ]);
  });

  it('contains a user-supplied restore path within allowed directories', () => {
    const {
      resolveContainedBackupPath,
    } = require('../index.js') as typeof import('../index');
    const directories = ['/srv/app/backups', '/home/tester/backups'];
    expect(
      resolveContainedBackupPath('/srv/app/backups/daily/db.gz', { directories }),
    ).toBe('/srv/app/backups/daily/db.gz');
    // Traversal / arbitrary-file access is rejected.
    expect(
      resolveContainedBackupPath('/srv/app/backups/../../etc/passwd', { directories }),
    ).toBeNull();
    expect(resolveContainedBackupPath('/etc/passwd', { directories })).toBeNull();
  });

  it('reads and appends backup manifest entries', () => {
    const {
      readBackupManifest,
      appendBackupManifestEntry,
    } = require('../index.js') as typeof import('../index');
    const dir = makeTempDir();
    expect(readBackupManifest(dir)).toEqual({ version: 1, entries: [] });

    const entry = {
      name: 'sqlite-backup-x.db.gz',
      path: path.join(dir, 'sqlite-backup-x.db.gz'),
      createdAt: fixedNow.toISOString(),
      sizeBytes: 128,
      label: 'manual',
      source: 'api',
    };
    appendBackupManifestEntry(dir, entry);
    const manifest = readBackupManifest(dir);
    expect(manifest.version).toBe(1);
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]).toMatchObject({ name: 'sqlite-backup-x.db.gz', label: 'manual', source: 'api' });
  });

  // --- P0 #3: restore round-trip, --latest, engine mismatch, truncated .gz ---

  it('restores a SQLite backup created via the cp-fallback path, round-tripping bytes exactly', () => {
    const cwd = makeTempDir();
    const dbPath = path.join(cwd, 'data', 'app.db');
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const originalBytes = Buffer.from('arbitrary sqlite bytes, not a real sqlite file, 12345');
    fs.writeFileSync(dbPath, originalBytes);

    const runtime = makeRuntime({ commandExists: () => false });
    const created = runBackupJob({
      allowUnsafeCopy: true,
      cwd,
      databaseUrl: 'file:./data/app.db',
      outputDir,
      compressSqlite: false,
      runtime,
    });

    // Mutate the live DB so the assertion actually proves restore rewrote it.
    fs.writeFileSync(dbPath, 'mutated after backup');

    const result = restoreBackup({
      cwd,
      databaseUrl: 'file:./data/app.db',
      outputDir,
      backupFile: created.created.fileName,
      createPreRestoreBackup: false,
      runtime,
    });

    expect(result.target).toBe(dbPath);
    expect(fs.readFileSync(dbPath).equals(originalBytes)).toBe(true);
  });

  it('restore --latest picks the newest backup by timestamp', () => {
    const cwd = makeTempDir();
    const dbPath = path.join(cwd, 'app.db');
    const outputDir = path.join(cwd, 'backups');
    fs.writeFileSync(dbPath, 'version 1');

    const olderRuntime = makeRuntime({ now: () => new Date('2026-07-01T00:00:00.000Z') });
    runBackupJob({ cwd, databaseUrl: 'file:./app.db', outputDir, compressSqlite: false, runtime: olderRuntime, allowUnsafeCopy: true });

    fs.writeFileSync(dbPath, 'version 2');
    const newerRuntime = makeRuntime({ now: () => new Date('2026-07-05T00:00:00.000Z') });
    const second = runBackupJob({ cwd, databaseUrl: 'file:./app.db', outputDir, compressSqlite: false, runtime: newerRuntime, allowUnsafeCopy: true });

    fs.writeFileSync(dbPath, 'mutated after both backups');

    const result = restoreBackup({
      cwd,
      databaseUrl: 'file:./app.db',
      outputDir,
      useLatest: true,
      createPreRestoreBackup: false,
      runtime: newerRuntime,
    });

    expect(result.restored.fileName).toBe(second.created.fileName);
    expect(fs.readFileSync(dbPath, 'utf8')).toBe('version 2');
  });

  it('throws an engine-mismatch error when the selected backup engine does not match DATABASE_URL', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'sqlite-backup-20260705-150000Z.db'), 'sqlite bytes');

    expect(() =>
      restoreBackup({
        cwd,
        databaseUrl: 'postgres://user:pass@host/db',
        outputDir,
        backupFile: 'sqlite-backup-20260705-150000Z.db',
        createPreRestoreBackup: false,
        runtime: makeRuntime(),
      allowUnsafeCopy: true,
      }),
    ).toThrow(/engine mismatch/i);
  });

  it('leaves the live DB untouched and cleans up the temp file when a truncated .gz backup fails to decompress', () => {
    const cwd = makeTempDir();
    const dbPath = path.join(cwd, 'data', 'app.db');
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    const originalBytes = Buffer.from('the live database, unchanged');
    fs.writeFileSync(dbPath, originalBytes);
    const backupPath = path.join(outputDir, 'sqlite-backup-20260705-150000Z.db.gz');
    fs.writeFileSync(backupPath, 'not actually gzip data');

    expect(() =>
      restoreBackup({
        cwd,
        databaseUrl: 'file:./data/app.db',
        outputDir,
        backupFile: path.basename(backupPath),
        createPreRestoreBackup: false,
        runtime: makeRuntime(),
      allowUnsafeCopy: true,
      }),
    ).toThrow();

    expect(fs.readFileSync(dbPath).equals(originalBytes)).toBe(true);
    const remaining = fs.readdirSync(path.dirname(dbPath)).filter((name) => name.startsWith('.restore-'));
    expect(remaining).toEqual([]);
  });

  // --- P0 #3: retention edges on planRetention ---

  it('planRetention: dailySlots > maxBackups keeps only maxBackups worth of dailies', () => {
    const backups = [
      backupEntry('day-0.db.gz', 0),
      backupEntry('day-1.db.gz', 1),
      backupEntry('day-2.db.gz', 2),
      backupEntry('day-3.db.gz', 3),
    ];
    const policy = { ...DEFAULT_RETENTION_POLICY, maxBackups: 2, dailySlots: 10 };

    const plan = planRetention(backups, policy, fixedNow);

    expect(plan.keep.map((entry) => entry.fileName)).toEqual(['day-0.db.gz', 'day-1.db.gz']);
    expect(plan.remove.map((entry) => entry.fileName)).toEqual(['day-2.db.gz', 'day-3.db.gz']);
  });

  it('planRetention: an empty backup list keeps and removes nothing', () => {
    const plan = planRetention([], DEFAULT_RETENTION_POLICY, fixedNow);
    expect(plan.keep).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it('planRetention: a future-dated (clock-skewed) backup cannot starve the newest real daily slot', () => {
    // Both effective (clamped) times tie at `fixedNow`: the future entry's raw
    // createdAt is capped down to `fixedNow`, and the just-created real entry's
    // createdAt IS `fixedNow`. Array.prototype.sort is stable (ES2019+), so with
    // the real entry listed first, the tie resolves in its favor — daily slot 1
    // goes to the real backup, not the clock-skewed one.
    const realSlot1 = backupEntry('day-0.db.gz', 0);
    const future = backupEntry('future.db.gz', -30); // createdAt ~30 days ahead of "now"
    const day1 = backupEntry('day-1.db.gz', 1);
    const day8 = backupEntry('day-8.db.gz', 8);

    const plan = planRetention([realSlot1, future, day1, day8], DEFAULT_RETENTION_POLICY, fixedNow);

    expect(plan.keep[0].fileName).toBe('day-0.db.gz');
    expect(plan.keep[0].retentionReason).toBe('daily');
    expect(plan.keep.some((entry) => entry.retentionReason === 'last_week' && entry.fileName === 'day-8.db.gz')).toBe(
      true,
    );
  });

  // --- P0 #3: locked-DB retry ---

  it('retries sqlite3 .backup on "database is locked" and succeeds on the third attempt', () => {
    const cwd = makeTempDir();
    const sourcePath = path.join(cwd, 'dev.db');
    const outputDir = path.join(cwd, 'backups');
    fs.writeFileSync(sourcePath, 'source');

    const backupCalls: string[] = [];
    const sleepCalls: number[] = [];
    let attempt = 0;

    const runtime = makeRuntime({
      commandExists: (command) => command === 'sqlite3',
      sleep: (ms) => sleepCalls.push(ms),
      execFileSync: (command: string, args: string[]) => {
        if (command === 'sqlite3' && args[1] === 'PRAGMA integrity_check;') {
          return Buffer.from('ok\n') as unknown as void;
        }
        if (command === 'sqlite3' && String(args[3]).startsWith('.backup')) {
          attempt += 1;
          backupCalls.push(args[3]);
          if (attempt < 3) {
            const error = new Error('sqlite3 failed') as Error & { stderr?: Buffer };
            error.stderr = Buffer.from('Error: database is locked');
            throw error;
          }
          const match = String(args[3]).match(/^\.backup "(.+)"$/);
          fs.writeFileSync(match![1].replace(/''/g, "'"), 'backup bytes');
        }
        return undefined;
      },
    });

    const result = runBackupJob({
      allowUnsafeCopy: true,
      cwd,
      databaseUrl: 'file:./dev.db',
      outputDir,
      compressSqlite: false,
      runtime,
    });

    expect(backupCalls).toHaveLength(3);
    expect(sleepCalls).toHaveLength(2);
    expect(result.created.fileName).toBe('sqlite-backup-20260705-150000Z.db');
  });

  // --- P0 #3: loadEnvironment (exercised via resolveBackupOptions) ---

  it('loadEnvironment: prod mode prefers .env.production over the base .env', () => {
    const cwd = makeTempDir();
    fs.writeFileSync(path.join(cwd, '.env'), 'DATABASE_URL=file:./dev.db\n');
    fs.writeFileSync(path.join(cwd, '.env.production'), 'DATABASE_URL=file:./prod.db\n');
    fs.writeFileSync(path.join(cwd, 'prod.db'), 'prod bytes');
    const outputDir = path.join(cwd, 'backups');

    const originalUrl = process.env.DATABASE_URL;
    try {
      delete process.env.DATABASE_URL;
      const result = runBackupJob({ cwd, mode: 'prod', outputDir, compressSqlite: false, runtime: makeRuntime(), allowUnsafeCopy: true });
      expect(fs.readFileSync(result.created.fullPath, 'utf8')).toBe('prod bytes');
    } finally {
      if (originalUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalUrl;
    }
  });

  it('loadEnvironment: prod mode throws when neither shell env nor .env.production has DATABASE_URL', () => {
    const cwd = makeTempDir();
    fs.writeFileSync(path.join(cwd, '.env'), 'DATABASE_URL=file:./dev.db\n');
    const outputDir = path.join(cwd, 'backups');

    const originalUrl = process.env.DATABASE_URL;
    try {
      delete process.env.DATABASE_URL;
      expect(() =>
        runBackupJob({ cwd, mode: 'prod', outputDir, compressSqlite: false, runtime: makeRuntime(), allowUnsafeCopy: true }),
      ).toThrow(/production backups/i);
    } finally {
      if (originalUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalUrl;
    }
  });

  // --- P1 #4: Postgres dump verification ---

  it('deletes the dump and throws when pg_restore --list fails to verify a Postgres backup', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    const databaseUrl = 'postgresql://user:secret@db.example/app';

    const runtime = makeRuntime({
      commandExists: (command) => command === 'pg_dump' || command === 'pg_restore',
      execFileSync: (command: string, args: string[]) => {
        if (command === 'pg_dump') {
          const outputArg = args.find((arg) => arg.startsWith('--file='));
          if (!outputArg) throw new Error('pg_dump call missing --file argument');
          fs.writeFileSync(outputArg.slice('--file='.length), 'not a real dump');
          return undefined;
        }
        if (command === 'pg_restore' && args[0] === '--list') {
          const error = new Error('pg_restore failed') as Error & { stderr?: Buffer };
          error.stderr = Buffer.from('pg_restore: error: input file does not appear to be a valid archive');
          throw error;
        }
        return undefined;
      },
    });

    expect(() => runBackupJob({ cwd, databaseUrl, outputDir, runtime })).toThrow(
      /PostgreSQL backup verification failed/i,
    );
    const dumpFiles = fs.existsSync(outputDir)
      ? fs.readdirSync(outputDir).filter((name) => name.endsWith('.dump'))
      : [];
    expect(dumpFiles).toEqual([]);
  });

  it('skips Postgres verification (and keeps the dump) when pg_restore is absent', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    const databaseUrl = 'postgresql://user:secret@db.example/app';

    const runtime = makeRuntime({
      commandExists: (command) => command === 'pg_dump',
      execFileSync: (command: string, args: string[]) => {
        const outputArg = args.find((arg) => arg.startsWith('--file='));
        if (!outputArg) throw new Error('pg_dump call missing --file argument');
        fs.writeFileSync(outputArg.slice('--file='.length), 'dump bytes');
        return undefined;
      },
    });

    const result = runBackupJob({ cwd, databaseUrl, outputDir, runtime });
    expect(fs.existsSync(result.created.fullPath)).toBe(true);
  });

  // --- P1 #5: advisory backup lock ---

  it('runBackupJob throws when a fresh (non-stale) lock is already held, and leaves it in place', () => {
    const cwd = makeTempDir();
    const sourcePath = path.join(cwd, 'app.db');
    const outputDir = path.join(cwd, 'backups');
    fs.writeFileSync(sourcePath, 'bytes');
    fs.mkdirSync(outputDir, { recursive: true });
    const lockPath = path.join(outputDir, '.db-backup.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, at: fixedNow.toISOString(), token: 'someone-else' }));

    expect(() =>
      runBackupJob({ cwd, databaseUrl: 'file:./app.db', outputDir, compressSqlite: false, runtime: makeRuntime() }),
    ).toThrow(/holds the lock/i);

    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('runBackupJob steals a stale lock and succeeds, removing the lock file afterward', () => {
    const cwd = makeTempDir();
    const sourcePath = path.join(cwd, 'app.db');
    const outputDir = path.join(cwd, 'backups');
    fs.writeFileSync(sourcePath, 'bytes');
    fs.mkdirSync(outputDir, { recursive: true });
    const lockPath = path.join(outputDir, '.db-backup.lock');
    const staleAt = new Date(fixedNow.getTime() - 60 * 60 * 1000).toISOString(); // 1h old, > default 30m staleMs
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, at: staleAt, token: 'stale-token' }));

    const result = runBackupJob({
      cwd,
      databaseUrl: 'file:./app.db',
      outputDir,
      compressSqlite: false,
      runtime: makeRuntime(),
      allowUnsafeCopy: true,
    });

    expect(result.created.fileName).toBe('sqlite-backup-20260705-150000Z.db');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('steals a corrupt/zero-byte leftover lock (crash between create and write)', () => {
    const cwd = makeTempDir();
    const sourcePath = path.join(cwd, 'app.db');
    const outputDir = path.join(cwd, 'backups');
    fs.writeFileSync(sourcePath, 'bytes');
    fs.mkdirSync(outputDir, { recursive: true });
    const lockPath = path.join(outputDir, '.db-backup.lock');
    fs.writeFileSync(lockPath, ''); // zero-byte, unparsable — a crashed run's leftover

    const result = runBackupJob({
      cwd,
      databaseUrl: 'file:./app.db',
      outputDir,
      compressSqlite: false,
      runtime: makeRuntime(),
      allowUnsafeCopy: true,
    });

    expect(result.created.fileName).toBe('sqlite-backup-20260705-150000Z.db');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('removes the lock file even when the wrapped job throws', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    const lockPath = path.join(outputDir, '.db-backup.lock');

    expect(() =>
      runBackupJob({
        cwd,
        databaseUrl: 'file:./missing.db',
        outputDir,
        compressSqlite: false,
        runtime: makeRuntime(),
      allowUnsafeCopy: true,
      }),
    ).toThrow(/not found/i);

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  // --- P1 #6: sha256 + manifest wiring ---

  it('runBackupJob appends a manifest entry with a 64-hex sha256', () => {
    const cwd = makeTempDir();
    const sourcePath = path.join(cwd, 'app.db');
    const outputDir = path.join(cwd, 'backups');
    fs.writeFileSync(sourcePath, 'sqlite bytes');

    const result = runBackupJob({
      cwd,
      databaseUrl: 'file:./app.db',
      outputDir,
      compressSqlite: false,
      runtime: makeRuntime(),
      allowUnsafeCopy: true,
    });

    expect(result.created.sha256).toMatch(/^[0-9a-f]{64}$/);

    const manifest = readBackupManifest(outputDir);
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]).toMatchObject({
      name: result.created.fileName,
      path: result.created.fullPath,
      sha256: result.created.sha256,
    });
  });

  it('restoreBackup throws a checksum-mismatch error when the manifested backup bytes were tampered with', () => {
    const cwd = makeTempDir();
    const sourcePath = path.join(cwd, 'app.db');
    const outputDir = path.join(cwd, 'backups');
    fs.writeFileSync(sourcePath, 'sqlite bytes');

    const created = runBackupJob({
      allowUnsafeCopy: true,
      cwd,
      databaseUrl: 'file:./app.db',
      outputDir,
      compressSqlite: false,
      runtime: makeRuntime(),
      allowUnsafeCopy: true,
    });
    // Corrupt the backup bytes on disk without touching the manifest.
    fs.writeFileSync(created.created.fullPath, 'tampered bytes');

    expect(() =>
      restoreBackup({
        cwd,
        databaseUrl: 'file:./app.db',
        outputDir,
        backupFile: created.created.fileName,
        createPreRestoreBackup: false,
        runtime: makeRuntime(),
      allowUnsafeCopy: true,
      }),
    ).toThrow(/checksum mismatch/i);
  });

  it('restoreBackup restores fine when the backup has no manifest at all (older backups)', () => {
    const cwd = makeTempDir();
    const dbPath = path.join(cwd, 'app.db');
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(dbPath, 'old bytes');
    const backupPath = path.join(outputDir, 'sqlite-backup-20260705-150000Z.db');
    fs.writeFileSync(backupPath, 'restored bytes');

    const result = restoreBackup({
      cwd,
      databaseUrl: 'file:./app.db',
      outputDir,
      backupFile: path.basename(backupPath),
      createPreRestoreBackup: false,
      runtime: makeRuntime(),
      allowUnsafeCopy: true,
    });

    expect(result.target).toBe(dbPath);
    expect(fs.readFileSync(dbPath, 'utf8')).toBe('restored bytes');
  });

  it('checks the checksum for an absolute --file path outside outputDir against a manifest colocated with the file', () => {
    const cwd = makeTempDir();
    const dbPath = path.join(cwd, 'app.db');
    const outputDir = path.join(cwd, 'backups');
    const externalDir = path.join(cwd, 'external-backups');
    fs.mkdirSync(externalDir, { recursive: true });
    fs.writeFileSync(dbPath, 'old bytes');

    const backupPath = path.join(externalDir, 'sqlite-backup-20260705-150000Z.db');
    fs.writeFileSync(backupPath, 'restored bytes');
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex');

    appendBackupManifestEntry(externalDir, {
      name: path.basename(backupPath),
      path: backupPath,
      createdAt: fixedNow.toISOString(),
      sizeBytes: fs.statSync(backupPath).size,
      sha256,
    });

    // Corrupt the file after manifesting: the colocated manifest should catch it
    // even though `outputDir` (passed below) is a different directory entirely.
    fs.writeFileSync(backupPath, 'tampered');

    expect(() =>
      restoreBackup({
        cwd,
        databaseUrl: 'file:./app.db',
        outputDir,
        backupFile: backupPath, // absolute path, outside outputDir
        createPreRestoreBackup: false,
        runtime: makeRuntime(),
      allowUnsafeCopy: true,
      }),
    ).toThrow(/checksum mismatch/i);
  });

  // --- P1 #7: SQLite restore validation (temp-first, non-deleting) ---

  it('fails restore when the temp file fails SQLite integrity check, leaving the live DB untouched', () => {
    const cwd = makeTempDir();
    const dbPath = path.join(cwd, 'data', 'app.db');
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    const originalBytes = Buffer.from('the live database, unchanged');
    fs.writeFileSync(dbPath, originalBytes);

    const backupPath = path.join(outputDir, 'sqlite-backup-20260705-150000Z.db');
    fs.writeFileSync(backupPath, 'a backup file (cp-fallback path, no compression)');

    const runtime = makeRuntime({
      commandExists: (command) => command === 'sqlite3',
      execFileSync: (command: string, args: string[]) => {
        if (command === 'sqlite3' && args[1] === 'PRAGMA integrity_check;') {
          return Buffer.from('*** in database main ***\nrow 1 missing from index idx') as unknown as void;
        }
        return undefined;
      },
    });

    expect(() =>
      restoreBackup({
        cwd,
        databaseUrl: 'file:./data/app.db',
        outputDir,
        backupFile: path.basename(backupPath),
        createPreRestoreBackup: false,
        runtime,
      }),
    ).toThrow(/integrity check failed/i);

    expect(fs.readFileSync(dbPath).equals(originalBytes)).toBe(true);
    const remaining = fs.readdirSync(path.dirname(dbPath)).filter((name) => name.startsWith('.restore-'));
    expect(remaining).toEqual([]);
  });
});

describe('checkRemoteFreshness (off-host dead-man switch)', () => {
  const at = (hoursFromNow: number) =>
    new Date(fixedNow.getTime() + hoursFromNow * 3600_000).toISOString();
  const rcloneRuntime = (
    entries: Array<{ Path: string; ModTime: string; IsDir?: boolean }>,
  ) =>
    makeRuntime({
      commandExists: (c: string) => c === 'rclone',
      execFileSync: ((command: string, args: string[]) =>
        command === 'rclone' && args[0] === 'lsjson'
          ? Buffer.from(JSON.stringify(entries))
          : Buffer.from('')) as never,
    });

  it('is fresh when the newest remote object is within the threshold', () => {
    const s = checkRemoteFreshness({
      remote: { target: 'r2:b/p' },
      runtime: rcloneRuntime([
        { Path: 'old.db.gz', ModTime: at(-30) },
        { Path: 'new.db.gz', ModTime: at(-2) },
      ]),
      maxAgeHours: 24,
      now: fixedNow,
    });
    expect(s).toMatchObject({ fresh: true, clockSkew: false });
    expect(s.ageHours).toBeCloseTo(2, 5);
  });

  it('is not fresh when the newest object is older than the threshold', () => {
    const s = checkRemoteFreshness({
      remote: { target: 'r2:b/p' },
      runtime: rcloneRuntime([{ Path: 'x.db.gz', ModTime: at(-48) }]),
      maxAgeHours: 24,
      now: fixedNow,
    });
    expect(s.fresh).toBe(false);
  });

  it('is not fresh (stampedAt null) when the remote is empty', () => {
    const s = checkRemoteFreshness({
      remote: { target: 'r2:b/p' },
      runtime: rcloneRuntime([]),
      maxAgeHours: 24,
      now: fixedNow,
    });
    expect(s).toMatchObject({ fresh: false, stampedAt: null });
  });

  it('flags a future ModTime as a clock problem, not fresh', () => {
    const s = checkRemoteFreshness({
      remote: { target: 'r2:b/p' },
      runtime: rcloneRuntime([{ Path: 'x.db.gz', ModTime: at(2) }]),
      maxAgeHours: 24,
      now: fixedNow,
    });
    expect(s).toMatchObject({ fresh: false, clockSkew: true });
  });

  it('ignores directories when picking the newest object', () => {
    const s = checkRemoteFreshness({
      remote: { target: 'r2:b/p' },
      runtime: rcloneRuntime([
        { Path: 'today', ModTime: at(-1), IsDir: true },
        { Path: 'x.db.gz', ModTime: at(-40) },
      ]),
      maxAgeHours: 24,
      now: fixedNow,
    });
    expect(s.fresh).toBe(false); // the fresh entry is a directory; the only file is 40h old
  });

  it('throws when rclone is unavailable — a check that cannot run is not "fresh"', () => {
    expect(() =>
      checkRemoteFreshness({
        remote: { target: 'r2:b/p' },
        runtime: makeRuntime({ commandExists: () => false }),
        maxAgeHours: 24,
        now: fixedNow,
      }),
    ).toThrow(/rclone.*unavailable/i);
  });
});

describe('notifyAlert', () => {
  it('POSTs {content} to a Discord webhook via curl, message over stdin', () => {
    const calls: Array<{ command: string; args: string[]; options: any }> = [];
    notifyAlert('backup stale', {
      notifyDiscord: 'https://discord/webhook',
      runtime: makeRuntime({
        commandExists: (c: string) => c === 'curl',
        execFileSync: ((command: string, args: string[], options: any) => {
          calls.push({ command, args, options });
        }) as never,
      }),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('curl');
    expect(calls[0].args).toContain('https://discord/webhook');
    expect(JSON.parse(calls[0].options.input)).toEqual({ content: 'backup stale' });
  });

  it('runs --notify-command with the message in $DB_BACKUP_ALERT', () => {
    const calls: Array<{ command: string; args: string[]; options: any }> = [];
    notifyAlert('boom', {
      notifyCommand: 'echo hi',
      runtime: makeRuntime({
        commandExists: () => true,
        execFileSync: ((command: string, args: string[], options: any) => {
          calls.push({ command, args, options });
        }) as never,
      }),
    });
    expect(calls[0].command).toBe('/bin/sh');
    expect(calls[0].args).toEqual(['-c', 'echo hi']);
    expect(calls[0].options.env.DB_BACKUP_ALERT).toBe('boom');
  });

  it('never throws when curl is missing or the POST fails', () => {
    expect(() =>
      notifyAlert('x', { notifyDiscord: 'https://d', runtime: makeRuntime({ commandExists: () => false }) }),
    ).not.toThrow();
    expect(() =>
      notifyAlert('x', {
        notifyWebhook: 'https://w',
        runtime: makeRuntime({
          commandExists: () => true,
          execFileSync: (() => {
            throw new Error('network down');
          }) as never,
        }),
      }),
    ).not.toThrow();
  });
});

describe('runCli freshness wiring', () => {
  it('requires --stamp-file or --remote', () => {
    expect(() => runCli(['freshness'])).toThrow(/--stamp-file .* or --remote/);
  });

  it('fires --notify-command and exits non-zero on a stale stamp (end-to-end)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-backup-notify-'));
    tempDirs.push(dir);
    const stamp = path.join(dir, '.last-success');
    const sentinel = path.join(dir, 'alert.txt');
    fs.writeFileSync(stamp, '2020-01-01T00:00:00.000Z\n'); // ancient → stale
    const prevExit = process.exitCode;
    process.exitCode = 0;
    runCli([
      'freshness',
      '--stamp-file',
      stamp,
      '--max-age-hours',
      '1',
      '--notify-command',
      `printf '%s' "$DB_BACKUP_ALERT" > ${sentinel}`,
    ]);
    expect(process.exitCode).toBe(1);
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(fs.readFileSync(sentinel, 'utf8')).toMatch(/STALE/);
    process.exitCode = prevExit;
  });
});
