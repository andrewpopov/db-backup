import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  DEFAULT_RETENTION_POLICY,
  listBackupsWithPlan,
  planRetention,
  restoreBackup,
  runBackupJob,
  runCli,
} = require('../index.js') as typeof import('../index');

const fixedNow = new Date('2026-07-05T15:00:00.000Z');
const tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-backup-manager-'));
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

describe('@bewks/db-backup-manager', () => {
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
    });
    fs.writeFileSync(sourcePath, 'new sqlite bytes');
    const second = runBackupJob({
      cwd,
      databaseUrl: 'file:./app.db',
      outputDir,
      runtime: makeRuntime(),
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
          const match = backupCommand.match(/^\.backup '(.+)'$/);
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
        args: ['-cmd', '.timeout 5000', sourcePath, `.backup '${rawPath}'`],
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
          const match = String(args[3]).match(/^\.backup '(.+)'$/);
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
    });

    expect(result.target).toBe(dbPath);
    expect(fs.readFileSync(dbPath, 'utf8')).toBe('restored database');
    expect(fs.existsSync(path.join(path.dirname(dbPath), '.restore-fixed-restore-id.db'))).toBe(false);
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
});
