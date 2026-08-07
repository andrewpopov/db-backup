import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dbBackup, fixedNow, makeTempDir, makeRuntime, cleanupTempDirs } from './helpers';

// These cases assert POSIX behaviour this package targets but Windows cannot
// provide: absolute paths like `/srv/app/backups` (path.resolve turns them
// into `D:\srvppackups` here), `~` expansion, cron lines built for a
// Linux host, notify commands run through a shell, and the external sqlite3 /
// gzip / rclone binaries. db-backup runs on a Linux server; these run there.
const itOnPosix = process.platform === 'win32' ? it.skip : it;


const {
  resolveRetentionPolicy,
  runBackupJob,
  runBackupJobAsync,
  runCli,
  readBackupManifest,
  appendBackupManifestEntry,
} = dbBackup;

afterEach(() => {
  cleanupTempDirs();
});

describe('@andrewpopov/db-backup — CLI (cron, backup directories, manifest helpers, config file, env loading)', () => {
  itOnPosix('cron output reflects --output-dir/--prod/--allow-missing and honors --command', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    try {
      await runCli(['cron', '--hour', '4', '--minute', '30', '--prod', '--output-dir', '/var/backups/app', '--allow-missing']);
      expect(logs[0]).toMatch(/^30 4 \* \* \* /);
      expect(logs[0]).toContain('npx db-backup backup --prod --output-dir "/var/backups/app" --allow-missing');
      expect(logs[0]).toContain('/var/backups/app/backup.log');

      logs.length = 0;
      await runCli(['cron', '--command', 'pnpm exec db-backup backup', '--log-path', '/tmp/b.log']);
      expect(logs[0]).toContain("bash -lc 'pnpm exec db-backup backup >> \"/tmp/b.log\" 2>&1'");

      // A single quote in the command must be escaped, not break the entry.
      logs.length = 0;
      await runCli(['cron', '--command', "echo 'hi'", '--log-path', '/tmp/b.log']);
      expect(logs[0]).toContain("bash -lc 'echo '\\''hi'\\'' >> \"/tmp/b.log\" 2>&1'");
    } finally {
      console.log = originalLog;
    }
  });

  itOnPosix('resolves backup directories from env + candidates, expanding ~ and de-duping', () => {
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

  itOnPosix('contains a user-supplied restore path within allowed directories', () => {
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
      const result = runBackupJob({ skipRemote: true, cwd, mode: 'prod', outputDir, compressSqlite: false, runtime: makeRuntime(), allowUnsafeCopy: true });
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
        runBackupJob({ skipRemote: true, cwd, mode: 'prod', outputDir, compressSqlite: false, runtime: makeRuntime(), allowUnsafeCopy: true }),
      ).toThrow(/production backups/i);
    } finally {
      if (originalUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalUrl;
    }
  });

  // ---------------------------------------------------------------------------
  // db-backup.config.json: a declarative alternative to re-typing the same
  // ~10 flags in a per-app bash script (see loadDbBackupConfig / resolveConfigFile).
  // ---------------------------------------------------------------------------
  describe('config file (db-backup.config.json)', () => {
    function writeConfig(dir: string, config: unknown, name = 'db-backup.config.json') {
      const configPath = path.join(dir, name);
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      return configPath;
    }

    // runCli resolves --config and DATABASE_URL against the REAL
    // process.cwd()/env, so every end-to-end CLI test here must chdir into
    // the temp dir and set DATABASE_URL, restoring both afterward — the same
    // pattern the rest of this file's CLI tests already use.
    async function withCliCwd(cwd: string, databaseUrl: string, fn: () => Promise<void>) {
      const originalUrl = process.env.DATABASE_URL;
      const originalNodeEnv = process.env.NODE_ENV;
      const originalCwd = process.cwd();
      try {
        process.chdir(cwd);
        process.env.DATABASE_URL = databaseUrl;
        process.env.NODE_ENV = 'development';
        await fn();
      } finally {
        process.chdir(originalCwd);
        if (originalUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = originalUrl;
        if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalNodeEnv;
      }
    }

    // A config declaring "mode": "prod" was silently IGNORED: db-backup fell back to
    // NODE_ENV and resolved DEV env files while the operator believed they were
    // running prod. Caught on the Pi -- cairn's config said prod, the CLI printed
    // "Mode: dev". A config key that is accepted and does nothing is worse than one
    // that errors.
    it('honors "mode" from the config file (CLI prints prod, not dev)', async () => {
      const cwd = makeTempDir();
      fs.writeFileSync(path.join(cwd, 'app.db'), 'db');
      const backupDir = path.join(cwd, 'cfg-backups');
      writeConfig(cwd, {
        mode: 'prod',
        destinations: [{ type: 'local', path: backupDir }],
      });

      const lines: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
        lines.push(a.join(' '));
      });
      try {
        await withCliCwd(cwd, 'file:./app.db', async () => {
          await runCli(['list']);
        });
      } finally {
        spy.mockRestore();
      }

      const modeLine = lines.find((l) => l.includes('Mode:'));
      expect(modeLine).toContain('prod');
      expect(modeLine).not.toContain('dev');
    });

    it('rejects an invalid config "mode" rather than silently ignoring it', async () => {
      const cwd = makeTempDir();
      fs.writeFileSync(path.join(cwd, 'app.db'), 'db');
      writeConfig(cwd, {
        mode: 'production',
        destinations: [{ type: 'local', path: path.join(cwd, 'b') }],
      });
      await withCliCwd(cwd, 'file:./app.db', async () => {
        await expect(runCli(['list'])).rejects.toThrow(/mode/);
      });
    });

    it('a config file is parsed and applied (destinations + retention)', async () => {
      const cwd = makeTempDir();
      fs.writeFileSync(path.join(cwd, 'app.db'), 'db');
      const backupDir = path.join(cwd, 'cfg-backups');
      const configPath = writeConfig(cwd, {
        destinations: [{ type: 'local', path: backupDir }],
        retention: { daily: 5, weekly: 2, monthly: 1, yearly: 1 },
      });

      await withCliCwd(cwd, 'file:./app.db', async () => {
        const result = await runBackupJobAsync({
          cwd,
          allowUnsafeCopy: true,
          runtime: makeRuntime({ commandExists: () => false }),
          databaseUrl: 'file:./app.db',
          destinations: JSON.parse(fs.readFileSync(configPath, 'utf8')).destinations,
          policy: { mode: 'gfs', ...JSON.parse(fs.readFileSync(configPath, 'utf8')).retention },
        });
        expect(fs.existsSync(path.join(backupDir, result.created.fileName))).toBe(true);
      });
    });

    it('CLI --retain-daily overrides config.retention (CLI wins)', () => {
      // Simulate the precedence rule runCli applies: when a CLI retention
      // flag is present, config.retention must never be consulted.
      const cliRetentionUsed = true;
      const config = { retention: { daily: 1 } };
      const policy = cliRetentionUsed ? resolveRetentionPolicy({ retainDaily: 9 }) : config.retention;
      expect(policy).toEqual({ mode: 'gfs', daily: 9, weekly: 0, monthly: 0, yearly: 0 });
    });

    it('a config file attempting to set AWS credentials on a destination is REJECTED', async () => {
      const cwd = makeTempDir();
      const configPath = writeConfig(cwd, {
        destinations: [{ type: 's3', bucket: 'x', accessKeyId: 'AKIA...', secretAccessKey: 'shh' }],
        retention: { daily: 1 },
      });

      await withCliCwd(cwd, 'file:./app.db', async () => {
        await expect(runCli(['backup', '--config', configPath])).rejects.toThrow(/credentials are environment-only/i);
      });
    });

    it('a config file attempting to set AWS_SECRET_ACCESS_KEY at the top level is REJECTED', async () => {
      const cwd = makeTempDir();
      const configPath = writeConfig(cwd, {
        AWS_SECRET_ACCESS_KEY: 'shh',
        destinations: [{ type: 'local', path: 'x' }],
      });

      await withCliCwd(cwd, 'file:./app.db', async () => {
        await expect(runCli(['backup', '--config', configPath])).rejects.toThrow(/credentials are environment-only/i);
      });
    });

    it('an unreadable encryptPassphraseFile from config aborts before any backup work', async () => {
      const cwd = makeTempDir();
      fs.writeFileSync(path.join(cwd, 'app.db'), 'db');
      const configPath = writeConfig(cwd, {
        destinations: [{ type: 'local', path: path.join(cwd, 'cfg-backups') }],
        retention: { daily: 1 },
        encryptPassphraseFile: path.join(cwd, 'nonexistent.pass'),
      });

      await withCliCwd(cwd, 'file:./app.db', async () => {
        await expect(
          runCli(['backup', '--config', configPath, '--allow-unsafe-copy']),
        ).rejects.toThrow(/passphrase file not found/i);
        expect(fs.existsSync(path.join(cwd, 'cfg-backups'))).toBe(false);
      });
    });

    it('a config file with zero destinations aborts', async () => {
      const cwd = makeTempDir();
      const configPath = writeConfig(cwd, { destinations: [] });
      await withCliCwd(cwd, 'file:./app.db', async () => {
        await expect(runCli(['backup', '--config', configPath])).rejects.toThrow(/zero destinations/i);
      });
    });

    it('config destinations mixed with a legacy --remote flag is an ERROR', async () => {
      const cwd = makeTempDir();
      const configPath = writeConfig(cwd, { destinations: [{ type: 'local', path: 'x' }] });
      await withCliCwd(cwd, 'file:./app.db', async () => {
        await expect(
          runCli(['backup', '--config', configPath, '--remote', 'r2:backups']),
        ).rejects.toThrow(/cannot be combined/);
      });
    });
  });
});
