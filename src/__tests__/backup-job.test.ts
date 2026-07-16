import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { dbBackup, fixedNow, makeTempDir, makeRuntime, cleanupTempDirs } from './helpers';

const {
  restoreBackup,
  runBackupJob,
  runCli,
  readBackupManifest,
  appendBackupManifestEntry,
  createSqliteSnapshot,
  verifySqliteBackupIntegrity,
  normalizeRuntime,
  DEFAULT_COMMAND_TIMEOUT_MS,
  listBackupMarkers,
  listBackupsWithPlan,
  pruneBackupsJob,
} = dbBackup;

afterEach(() => {
  cleanupTempDirs();
});

describe('@andrewpopov/db-backup — backup job (SQLite/Postgres creation, integrity, locking, sha256/manifest wiring)', () => {
  it('creates a SQLite backup from a URL-encoded relative file path without external binaries', () => {
    const cwd = makeTempDir();
    const sourcePath = path.join(cwd, 'db with spaces.db');
    const outputDir = path.join(cwd, 'backups');
    fs.writeFileSync(sourcePath, 'sqlite bytes');

    const result = runBackupJob({ skipRemote: true,
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
    // Machine-readable contract: backupId is the stable identifier downstream
    // tooling (e.g. deploy-kit) may key off, top-level and equal to
    // created.fileName.
    expect(result.backupId).toBe(result.created.fileName);
  });

  it('does not overwrite a same-second SQLite backup', () => {
    const cwd = makeTempDir();
    const sourcePath = path.join(cwd, 'app.db');
    const outputDir = path.join(cwd, 'backups');
    fs.writeFileSync(sourcePath, 'sqlite bytes');

    const first = runBackupJob({ skipRemote: true,
      cwd,
      databaseUrl: 'file:./app.db',
      outputDir,
      runtime: makeRuntime(),
      allowUnsafeCopy: true,
    });
    fs.writeFileSync(sourcePath, 'new sqlite bytes');
    const second = runBackupJob({ skipRemote: true,
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
    const result = runBackupJob({ skipRemote: true,
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
      runBackupJob({ skipRemote: true, cwd, databaseUrl: 'file:./dev.db', outputDir, compressSqlite: false, runtime }),
    ).toThrow(/integrity check failed/i);
    // The corrupt snapshot must not be left behind. A `.failed` lifecycle
    // marker is expected instead (see getOperationalStatus/listBackupMarkers).
    const leftovers = (fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : []).filter(
      (name) => !name.endsWith('.failed') && !name.endsWith('.inprogress'),
    );
    expect(leftovers).toEqual([]);
  });

  it('skips the backup when the database is missing and --allow-missing is set', async () => {
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
      await runCli(['backup', '--allow-missing', '--skip-remote', '--output-dir', outputDir]);
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

  it('includes a top-level backupId equal to created.fileName in `backup --json` output', async () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    // A real (if minimal) SQLite file — this exercises the actual sqlite3
    // binary via runCli (no injected runtime), which rejects non-database bytes.
    execFileSync('sqlite3', [path.join(cwd, 'app.db'), 'CREATE TABLE t (a INTEGER);']);
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    const originalUrl = process.env.DATABASE_URL;
    const originalNodeEnv = process.env.NODE_ENV;
    const originalCwd = process.cwd();
    try {
      process.chdir(cwd);
      process.env.DATABASE_URL = 'file:./app.db';
      process.env.NODE_ENV = 'development';
      await runCli(['backup', '--output-dir', outputDir, '--allow-unsafe-copy', '--skip-remote', '--json']);
      const result = JSON.parse(logs[logs.length - 1]);
      expect(result.backupId).toBe(result.created.fileName);
    } finally {
      console.log = originalLog;
      process.chdir(originalCwd);
      if (originalUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalUrl;
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('omits backupId from the CLI --allow-missing skipped-run JSON shape', async () => {
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
      await runCli(['backup', '--allow-missing', '--skip-remote', '--output-dir', outputDir, '--json']);
      const skipped = JSON.parse(logs[logs.length - 1]);
      expect(skipped).toMatchObject({ skipped: true });
      expect(skipped.backupId).toBeUndefined();
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

    const result = runBackupJob({ skipRemote: true,
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

    const first = runBackupJob({ skipRemote: true, cwd, databaseUrl, outputDir, runtime });
    const second = runBackupJob({ skipRemote: true, cwd, databaseUrl, outputDir, runtime });

    expect(first.created.fileName).toBe('postgres-backup-20260705-150000Z.dump');
    expect(second.created.fileName).toBe('postgres-backup-20260705-150000Z-2.dump');
    expect(fs.readFileSync(first.created.fullPath, 'utf8')).toBe('postgres dump 1');
    expect(fs.readFileSync(second.created.fullPath, 'utf8')).toBe('postgres dump 2');
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
      runBackupJob({ skipRemote: true,
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

  // The two tests above only cover the shape where sqlite3 RETURNS a "not ok"
  // verdict. Real disk corruption — a valid header with torn interior pages —
  // makes sqlite3 EXIT NON-ZERO ("database disk image is malformed"), so
  // execFileSync THROWS instead. That path skipped the deletion branch entirely,
  // leaving a corrupt snapshot in the output dir under a valid backup name: it
  // occupied a retention slot (evicting a good backup) and `list` ranked it as a
  // real one.
  it('deletes its own snapshot when sqlite3 THROWS (malformed image), not just when it returns not-ok', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'own-snapshot.db');
    fs.writeFileSync(filePath, 'db bytes');

    const runtime = makeRuntime({
      commandExists: () => true,
      execFileSync: (() => {
        throw new Error('Command failed: sqlite3 ... database disk image is malformed (11)');
      }) as never,
    });

    expect(() =>
      verifySqliteBackupIntegrity(filePath, runtime, { deleteOnFailure: true }),
    ).toThrow(/malformed/i);
    expect(fs.existsSync(filePath), 'a snapshot we own must not survive a failed check').toBe(false);
  });

  it('still does NOT delete a file it does not own when sqlite3 throws (BWK-129 default holds)', () => {
    // The fix above must not weaken the non-destructive default: a consumer
    // vetting a user-supplied path must keep its file even on the throwing path.
    const dir = makeTempDir();
    const filePath = path.join(dir, 'users-backup.db');
    fs.writeFileSync(filePath, 'db bytes');

    const runtime = makeRuntime({
      commandExists: () => true,
      execFileSync: (() => {
        throw new Error('Command failed: sqlite3 ... database disk image is malformed (11)');
      }) as never,
    });

    expect(() => verifySqliteBackupIntegrity(filePath, runtime)).toThrow(/malformed/i);
    expect(fs.existsSync(filePath), 'the caller’s file must survive').toBe(true);
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
    const result = runBackupJob({ skipRemote: true,
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
      runBackupJob({ skipRemote: true,
        allowUnsafeCopy: true,
        cwd,
        databaseUrl: 'file:./app.db',
        outputDir,
        compressSqlite: false,
        minBytes: 32768,
        runtime: makeRuntime(),
      }),
    ).toThrow(/below the 32768-byte minimum/);

    // A `.failed` lifecycle marker is expected (see getOperationalStatus);
    // only the on-disk backup artifact itself must be gone.
    const leftovers = fs
      .readdirSync(outputDir)
      .filter((f) => f.startsWith('sqlite-backup-') && !f.endsWith('.failed') && !f.endsWith('.inprogress'));
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
      runBackupJob({ skipRemote: true,
        allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir,
        compressSqlite: false, minBytes: 32768, stampFile, runtime: makeRuntime(),
      }),
    ).toThrow();
    expect(fs.existsSync(stampFile), 'a failed run must not stamp success').toBe(false);

    // A clean run stamps.
    runBackupJob({ skipRemote: true,
      allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir,
      compressSqlite: false, stampFile, runtime: makeRuntime(),
    });
    expect(fs.readFileSync(stampFile, 'utf8').trim()).toBe(fixedNow.toISOString());
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

      const result = runBackupJob({ skipRemote: true,
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

    runBackupJob({ skipRemote: true,
      allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir,
      compressSqlite: false, runtime: makeRuntime(),
    });

    expect(fs.statSync(outputDir).mode & 0o777, 'existing dir mode preserved').toBe(0o750);
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

    const result = runBackupJob({ skipRemote: true,
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

    expect(() => runBackupJob({ skipRemote: true, cwd, databaseUrl, outputDir, runtime })).toThrow(
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

    const result = runBackupJob({ skipRemote: true, cwd, databaseUrl, outputDir, runtime });
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
      runBackupJob({ skipRemote: true, cwd, databaseUrl: 'file:./app.db', outputDir, compressSqlite: false, runtime: makeRuntime() }),
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

    const result = runBackupJob({ skipRemote: true,
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

    const result = runBackupJob({ skipRemote: true,
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
      runBackupJob({ skipRemote: true,
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

  it('restoreBackup throws when a fresh (non-stale) lock is already held, and leaves it in place', () => {
    const cwd = makeTempDir();
    const dbPath = path.join(cwd, 'app.db');
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(dbPath, 'old bytes');
    const backupPath = path.join(outputDir, 'sqlite-backup-20260705-150000Z.db');
    fs.writeFileSync(backupPath, 'restored bytes');

    const lockPath = path.join(outputDir, '.db-backup.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, at: fixedNow.toISOString(), token: 'someone-else' }));

    expect(() =>
      restoreBackup({
        cwd,
        databaseUrl: 'file:./app.db',
        outputDir,
        backupFile: path.basename(backupPath),
        createPreRestoreBackup: false,
        runtime: makeRuntime(),
        allowUnsafeCopy: true,
      }),
    ).toThrow(/holds the lock/i);

    expect(fs.existsSync(lockPath)).toBe(true);
    // The live DB must be untouched: the lock must be checked before the restore
    // (or the pre-restore backup) ever runs.
    expect(fs.readFileSync(dbPath, 'utf8')).toBe('old bytes');
  });

  it('restoreBackup succeeds via an absolute --file path when outputDir does not exist, without creating outputDir or a lock file', () => {
    const cwd = makeTempDir();
    const dbPath = path.join(cwd, 'app.db');
    const outputDir = path.join(cwd, 'backups'); // intentionally never created
    const externalDir = path.join(cwd, 'external-backups');
    fs.mkdirSync(externalDir, { recursive: true });
    fs.writeFileSync(dbPath, 'old bytes');

    const backupPath = path.join(externalDir, 'sqlite-backup-20260705-150000Z.db');
    fs.writeFileSync(backupPath, 'restored bytes');

    expect(fs.existsSync(outputDir)).toBe(false);

    const result = restoreBackup({
      cwd,
      databaseUrl: 'file:./app.db',
      outputDir,
      backupFile: backupPath, // absolute path, outside outputDir
      createPreRestoreBackup: false,
      skipVerify: true,
      allowOnlineRestore: true,
      runtime: makeRuntime(),
      allowUnsafeCopy: true,
    });

    expect(result.target).toBe(dbPath);
    expect(fs.readFileSync(dbPath, 'utf8')).toBe('restored bytes');
    // No lock file was attempted inside a directory that doesn't exist, and the
    // directory itself was never created as a side effect of restoring.
    expect(fs.existsSync(outputDir)).toBe(false);
  });

  // --- P1 #6: sha256 + manifest wiring ---

  it('runBackupJob appends a manifest entry with a 64-hex sha256', () => {
    const cwd = makeTempDir();
    const sourcePath = path.join(cwd, 'app.db');
    const outputDir = path.join(cwd, 'backups');
    fs.writeFileSync(sourcePath, 'sqlite bytes');

    const result = runBackupJob({ skipRemote: true,
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

    const created = runBackupJob({ skipRemote: true,
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
      skipVerify: true,
      allowOnlineRestore: true,
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

  // ---------------------------------------------------------------------------
  // Lifecycle markers (PKG-28): `<prefix>-<startedAt>-<jobId>.inprogress` /
  // `.failed` stand in for a job that has no completed artifact (yet, or
  // ever). Named by JOB IDENTITY — never by a predicted artifact filename.
  // See listBackupMarkers's doc comment in src/index.js for the full design.
  // ---------------------------------------------------------------------------
  describe('lifecycle markers', () => {
    it('an .inprogress marker exists while the job is running and is gone on success', () => {
      const cwd = makeTempDir();
      const sourcePath = path.join(cwd, 'dev.db');
      const outputDir = path.join(cwd, 'backups');
      fs.writeFileSync(sourcePath, 'source');

      let sawMarkerDuringBackup = false;
      const runtime = makeRuntime({
        commandExists: (command) => command === 'sqlite3',
        execFileSync: (command, args) => {
          if (command === 'sqlite3' && args[1] === 'PRAGMA integrity_check;') {
            return Buffer.from('ok\n');
          }
          if (command === 'sqlite3') {
            // The job is mid-flight right here: the marker must already exist.
            const markers = fs.existsSync(outputDir) ? fs.readdirSync(outputDir).filter((f) => f.endsWith('.inprogress')) : [];
            sawMarkerDuringBackup = markers.length === 1;
            const match = String(args[3]).match(/^\.backup "(.+)"$/);
            fs.writeFileSync(match![1].replace(/''/g, "'"), 'backup bytes');
          }
          return undefined;
        },
      });

      const result = runBackupJob({
        skipRemote: true,
        allowUnsafeCopy: true,
        cwd,
        databaseUrl: 'file:./dev.db',
        outputDir,
        compressSqlite: false,
        runtime,
      });

      expect(sawMarkerDuringBackup).toBe(true);
      const leftoverMarkers = fs.readdirSync(outputDir).filter((f) => f.endsWith('.inprogress') || f.endsWith('.failed'));
      expect(leftoverMarkers).toEqual([]);
      expect(fs.existsSync(result.created.fullPath)).toBe(true);
    });

    it('marker names carry job identity (prefix-startedAt-jobId), independent of the artifact filename', () => {
      const cwd = makeTempDir();
      const sourcePath = path.join(cwd, 'dev.db');
      const outputDir = path.join(cwd, 'backups');
      fs.writeFileSync(sourcePath, 'source');

      let markerNameDuringBackup: string | null = null;
      const runtime = makeRuntime({
        commandExists: (command) => command === 'sqlite3',
        execFileSync: (command, args) => {
          if (command === 'sqlite3' && args[1] === 'PRAGMA integrity_check;') {
            return Buffer.from('ok\n');
          }
          if (command === 'sqlite3') {
            markerNameDuringBackup =
              fs.readdirSync(outputDir).find((f) => f.endsWith('.inprogress')) || null;
            const match = String(args[3]).match(/^\.backup "(.+)"$/);
            fs.writeFileSync(match![1].replace(/''/g, "'"), 'backup bytes');
          }
          return undefined;
        },
      });

      const result = runBackupJob({
        skipRemote: true,
        allowUnsafeCopy: true,
        cwd,
        databaseUrl: 'file:./dev.db',
        outputDir,
        compressSqlite: false,
        runtime,
      });

      // Job-identity shape: prefix, start timestamp, job id — and explicitly
      // NOT the artifact's filename (no artifact-extension prediction).
      expect(markerNameDuringBackup).toMatch(/^sqlite-backup-\d{8}-\d{6}Z-[A-Za-z0-9]+\.inprogress$/);
      expect(markerNameDuringBackup).not.toContain('.db');
      expect(markerNameDuringBackup!.replace(/\.inprogress$/, '')).not.toBe(result.created.fileName);
    });

    it('a failed job leaves a .failed marker with a truncated error, and no .inprogress marker', () => {
      const cwd = makeTempDir();
      const sourcePath = path.join(cwd, 'dev.db');
      const outputDir = path.join(cwd, 'backups');
      fs.writeFileSync(sourcePath, 'source');

      const hugeMessage = 'x'.repeat(2000);
      const runtime = makeRuntime({
        commandExists: (command) => command === 'sqlite3',
        execFileSync: (command, args) => {
          if (command === 'sqlite3' && String(args[3] || '').startsWith('.backup')) {
            throw new Error(hugeMessage);
          }
          return undefined;
        },
      });

      expect(() =>
        runBackupJob({
          skipRemote: true,
          allowUnsafeCopy: true,
          cwd,
          databaseUrl: 'file:./dev.db',
          outputDir,
          compressSqlite: false,
          runtime,
        }),
      ).toThrow();

      const files = fs.readdirSync(outputDir);
      expect(files.some((f) => f.endsWith('.inprogress'))).toBe(false);
      const failedMarker = files.find((f) => f.endsWith('.failed'));
      expect(failedMarker).toBeTruthy();

      const body = JSON.parse(fs.readFileSync(path.join(outputDir, failedMarker!), 'utf8'));
      expect(body.startedAt).toBe(fixedNow.toISOString());
      expect(body.failedAt).toBe(fixedNow.toISOString());
      expect(body.error.length).toBeLessThanOrEqual(500);
      expect(hugeMessage.length).toBeGreaterThan(500);
    });

    // Fixture helper: write a marker in the job-identity naming scheme.
    function writeMarker(
      outputDir: string,
      opts: { ts: string; jobId: string; suffix: '.inprogress' | '.failed'; body: Record<string, unknown> },
    ) {
      const name = `sqlite-backup-${opts.ts}-${opts.jobId}${opts.suffix}`;
      fs.writeFileSync(path.join(outputDir, name), JSON.stringify(opts.body));
      return name;
    }

    it('markers are excluded from retention selection: listBackupsWithPlan surfaces them with state, never as keep/rotate candidates', () => {
      const cwd = makeTempDir();
      const outputDir = path.join(cwd, 'backups');
      fs.mkdirSync(outputDir, { recursive: true });

      // A real, current backup the policy keeps.
      fs.writeFileSync(path.join(outputDir, 'sqlite-backup-20260705-150000Z.db'), 'a real backup');

      // A running marker for a job in flight right now.
      const runningName = writeMarker(outputDir, {
        ts: '20260705-160000Z',
        jobId: 'run001',
        suffix: '.inprogress',
        body: { startedAt: fixedNow.toISOString() },
      });

      // The newest failure (recent) — always retained.
      writeMarker(outputDir, {
        ts: '20260704-000000Z',
        jobId: 'new001',
        suffix: '.failed',
        body: {
          startedAt: new Date(fixedNow.getTime() - 86400000).toISOString(),
          failedAt: new Date(fixedNow.getTime() - 86400000).toISOString(),
          error: 'network blip',
        },
      });

      // A stale failed marker, far older than the backup the plan is keeping
      // AND not the newest failure — the only sweepable combination.
      const staleAt = new Date(fixedNow.getTime() - 400 * 24 * 60 * 60 * 1000);
      const staleName = writeMarker(outputDir, {
        ts: '20250601-000000Z',
        jobId: 'old001',
        suffix: '.failed',
        body: { startedAt: staleAt.toISOString(), failedAt: staleAt.toISOString(), error: 'disk full' },
      });
      const staleBase = staleName.replace(/\.failed$/, '');

      const result = listBackupsWithPlan({
        outputDir,
        requireDatabaseUrl: false,
        policy: { mode: 'keep-last', keepLast: 5 },
        runtime: makeRuntime(),
      });

      const running = result.backups.find((b: any) => b.state === 'running');
      const stale = result.backups.find((b: any) => b.fileName === staleBase);
      expect(running).toBeTruthy();
      expect(running.keep).toBe(true);
      expect(stale).toBeTruthy();
      expect(stale.error).toBe('disk full');

      // No marker is ever a keep/rotate candidate in plan.keep.
      expect(result.plan.keep.some((e: any) => e.state && e.state !== 'completed')).toBe(false);
      // Only the stale, non-newest failed marker is folded into plan.remove.
      expect(result.plan.remove.some((e: any) => e.fileName === staleBase && e.retentionReason === 'stale_marker')).toBe(true);
      expect(result.plan.remove.filter((e: any) => e.state === 'failed')).toHaveLength(1);

      // pruneBackupsJob removes the stale marker but leaves the running one
      // and the newest failure.
      const pruneResult = pruneBackupsJob({
        outputDir,
        requireDatabaseUrl: false,
        policy: { mode: 'keep-last', keepLast: 5 },
        runtime: makeRuntime(),
      });
      expect(pruneResult.removed.some((e: any) => e.fileName === staleBase)).toBe(true);
      expect(fs.existsSync(path.join(outputDir, runningName))).toBe(true);
      expect(fs.readdirSync(outputDir).filter((f) => f.endsWith('.failed'))).toHaveLength(1);
    });

    it('with no completed backups, a failed marker is never stale: the first failure survives prune (evidence preservation)', () => {
      const cwd = makeTempDir();
      const outputDir = path.join(cwd, 'backups');
      fs.mkdirSync(outputDir, { recursive: true });

      // Nothing has ever succeeded; the only file is an ancient failure.
      const ancient = new Date(fixedNow.getTime() - 1000 * 24 * 60 * 60 * 1000);
      const name = writeMarker(outputDir, {
        ts: '20230101-000000Z',
        jobId: 'first1',
        suffix: '.failed',
        body: { startedAt: ancient.toISOString(), failedAt: ancient.toISOString(), error: 'never worked' },
      });

      const result = listBackupsWithPlan({
        outputDir,
        requireDatabaseUrl: false,
        policy: { mode: 'keep-last', keepLast: 5 },
        runtime: makeRuntime(),
      });
      expect(result.plan.remove).toEqual([]);

      pruneBackupsJob({
        outputDir,
        requireDatabaseUrl: false,
        policy: { mode: 'keep-last', keepLast: 5 },
        runtime: makeRuntime(),
      });
      expect(fs.existsSync(path.join(outputDir, name))).toBe(true);
    });

    it('the newest failed marker is always retained, even when older than every kept backup', () => {
      const cwd = makeTempDir();
      const outputDir = path.join(cwd, 'backups');
      fs.mkdirSync(outputDir, { recursive: true });

      // A recent completed backup the policy keeps (age 0).
      fs.writeFileSync(path.join(outputDir, 'sqlite-backup-20260705-150000Z.db'), 'a real backup');

      // A single, ancient failure — far older than the kept backup, but it is
      // the NEWEST (only) failure, so it must survive.
      const ancient = new Date(fixedNow.getTime() - 500 * 24 * 60 * 60 * 1000);
      const name = writeMarker(outputDir, {
        ts: '20250201-000000Z',
        jobId: 'only01',
        suffix: '.failed',
        body: { startedAt: ancient.toISOString(), failedAt: ancient.toISOString(), error: 'long ago' },
      });

      const result = listBackupsWithPlan({
        outputDir,
        requireDatabaseUrl: false,
        policy: { mode: 'keep-last', keepLast: 5 },
        runtime: makeRuntime(),
      });
      expect(result.plan.remove.some((e: any) => e.state === 'failed')).toBe(false);

      pruneBackupsJob({
        outputDir,
        requireDatabaseUrl: false,
        policy: { mode: 'keep-last', keepLast: 5 },
        runtime: makeRuntime(),
      });
      expect(fs.existsSync(path.join(outputDir, name))).toBe(true);
    });

    it('listBackupMarkers surfaces running/failed rows directly, newest first, ranking failures by failedAt', () => {
      const cwd = makeTempDir();
      const outputDir = path.join(cwd, 'backups');
      fs.mkdirSync(outputDir, { recursive: true });
      writeMarker(outputDir, {
        ts: '20260705-150000Z',
        jobId: 'run001',
        suffix: '.inprogress',
        body: { startedAt: fixedNow.toISOString() },
      });
      // Started two days ago, but FAILED only an hour ago — must rank by the
      // failure time, not the start time.
      writeMarker(outputDir, {
        ts: '20260703-150000Z',
        jobId: 'fail01',
        suffix: '.failed',
        body: {
          startedAt: new Date(fixedNow.getTime() - 2 * 86400000).toISOString(),
          failedAt: new Date(fixedNow.getTime() + 3600000).toISOString(),
          error: 'boom',
        },
      });

      const markers = listBackupMarkers(outputDir, fixedNow, null);
      expect(markers.map((m: any) => m.state)).toEqual(['failed', 'running']);
      expect(markers[0].failedAt).toBe(new Date(fixedNow.getTime() + 3600000).toISOString());
      expect(markers[0].createdAt).toBe(markers[0].failedAt);
      expect(markers.every((m: any) => m.sizeBytes === 0)).toBe(true);
    });
  });
});
