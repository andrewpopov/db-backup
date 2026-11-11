import fs from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dbBackup, fixedNow, makeTempDir, makeRuntime, cleanupTempDirs, DEFAULT_TEST_REMOTES } from './helpers';

const itOnPosix = process.platform === 'win32' ? it.skip : it;

const { runBackupJob, runBackupJobAsync, runCli, normalizeDestination, uploadBackupToRemote, normalizeRuntime } = dbBackup;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const drimeModule = require('../drime.js') as {
  drimeAudit: (o: Record<string, unknown>) => { objects: number; findings: { kind: string; path: string; detail: string }[] };
  runDrimeOperation: (dest: unknown, runtime: unknown, operation: unknown) => unknown;
};
const { drimeAudit } = drimeModule;
const runDrimeOperation = drimeModule.runDrimeOperation;

const SECRETS = {
  token: 'SENTINEL_TOKEN_9d41e7',
  pass: 'SENTINEL_PASS_ONE_5b7c10',
  pass2: 'SENTINEL_PASS_TWO_c20e84',
  plainPass: 'SENTINEL_PLAINTEXT_PASSWORD_77aa',
};
const ALL_SECRETS = Object.values(SECRETS);
const NEW_NAME = 'sqlite-backup-20260705-150000Z.db';
const ARTIFACT_BYTES = Buffer.byteLength('database bytes');
const MAGIC = Buffer.from('RCLONE\0\0', 'latin1');

afterEach(() => {
  cleanupTempDirs();
  vi.restoreAllMocks();
});

function envFileLines(overrides: Record<string, string | null> = {}): string {
  const base: Record<string, string> = {
    RCLONE_CONFIG_DRIME_TYPE: 'drime',
    RCLONE_CONFIG_DRIME_ACCESS_TOKEN: SECRETS.token,
    RCLONE_CONFIG_DRIMECRYPT_TYPE: 'crypt',
    RCLONE_CONFIG_DRIMECRYPT_REMOTE: 'drime:backups-encrypted',
    RCLONE_CONFIG_DRIMECRYPT_FILENAME_ENCRYPTION: 'standard',
    RCLONE_CONFIG_DRIMECRYPT_DIRECTORY_NAME_ENCRYPTION: 'true',
    RCLONE_CONFIG_DRIMECRYPT_PASSWORD: SECRETS.pass,
    RCLONE_CONFIG_DRIMECRYPT_PASSWORD2: SECRETS.pass2,
  };
  const merged = { ...base, ...overrides };
  return Object.entries(merged)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function writeEnvFile(dir: string, overrides: Record<string, string | null> = {}): string {
  const file = path.join(dir, 'drime.env');
  fs.writeFileSync(file, `# comment\n${envFileLines(overrides)}\n`, { mode: 0o600 });
  return file;
}

function setup() {
  const cwd = makeTempDir();
  const outputDir = path.join(cwd, 'backups');
  fs.writeFileSync(path.join(cwd, 'app.db'), 'database bytes');
  return { cwd, outputDir, envFile: writeEnvFile(cwd) };
}

function jobOptions(cwd: string, outputDir: string, extra: Record<string, unknown> = {}) {
  return { allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', compressSqlite: false, now: fixedNow, outputDir, ...extra };
}

interface Call { args: string[]; env: Record<string, string>; config: { exists: boolean; mode: number; size: number; file: string } }

// Fake rclone for the in-process runtime. Drime children address the private
// `dbbdrimecrypt:` remote; anything else is the generic `offsite:` target.
function makeFakeRclone(options: { seeded?: string[]; hideNewFromListing?: boolean; fail?: (args: string[]) => Error | null } = {}) {
  const drimeObjects = new Set<string>(options.seeded || []);
  const otherObjects = new Set<string>();
  const deleted: string[] = [];
  const calls: Call[] = [];
  let lastUploadSize = 0;
  const execFileSync = (_command: string, args: string[], opts?: { env?: Record<string, string> }) => {
    const env = opts?.env || {};
    const configFile = env.RCLONE_CONFIG || '';
    const exists = Boolean(configFile) && fs.existsSync(configFile);
    calls.push({
      args,
      env,
      config: { exists, mode: exists ? fs.statSync(configFile).mode & 0o777 : 0, size: exists ? fs.statSync(configFile).size : -1, file: configFile },
    });
    const failure = options.fail?.(args);
    if (failure) throw failure;
    const isDrime = args.some((a) => String(a).startsWith('dbbdrimecrypt:'));
    const objects = isDrime ? drimeObjects : otherObjects;
    if (args[0] === 'copyto') {
      objects.add(String(args[2]).split('/').pop()!);
      lastUploadSize = fs.statSync(args[1]).size;
    } else if (args[0] === 'lsjson') {
      return Buffer.from(JSON.stringify({ Size: lastUploadSize }));
    } else if (args[0] === 'lsf') {
      return Buffer.from([...objects].filter((n) => !(options.hideNewFromListing && n === NEW_NAME)).join('\n'));
    } else if (args[0] === 'deletefile') {
      const name = String(args[1]).split('/').pop()!;
      deleted.push(name);
      objects.delete(name);
    }
    return Buffer.from('');
  };
  return { drimeObjects, otherObjects, deleted, calls, execFileSync };
}

function leakyError(status = 1) {
  const stderr = `Failed: token=${SECRETS.token} pass=${SECRETS.pass} plain=${SECRETS.plainPass} pass2=${SECRETS.pass2}`;
  return Object.assign(new Error(`Command failed: rclone ... ${stderr}`), { status, stderr: Buffer.from(stderr), stdout: Buffer.from(stderr) });
}

function expectNoSecrets(text: string) {
  for (const secret of ALL_SECRETS) expect(text).not.toContain(secret);
}

const CLI_FLAGS = ['backup', '--allow-unsafe-copy', '--no-compress'];

function useRealSqliteIfPresent(cwd: string) {
  const dbPath = path.join(cwd, 'app.db');
  fs.rmSync(dbPath);
  try {
    execFileSync('sqlite3', [dbPath, 'create table t(x);'], { stdio: 'ignore' });
  } catch {
    fs.writeFileSync(dbPath, 'database bytes');
  }
}

function installFakeRclone(rules: unknown[]) {
  const dir = makeTempDir();
  const script = path.join(dir, 'rclone');
  fs.writeFileSync(script, [
    `#!${process.execPath}`,
    "const fs = require('fs'); const path = require('path');",
    'const args = process.argv.slice(2);',
    "fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify({ args, env: process.env }) + '\\n');",
    "const rules = JSON.parse(fs.readFileSync(path.join(__dirname, 'rules.json'), 'utf8'));",
    "const rule = rules.find((r) => args.join(' ').startsWith(r.match));",
    "if (rule && rule.badEnv && rule.badEnv.some((k) => !/^[A-Za-z0-9_-]+$/.test(process.env[k] || ''))) { process.stderr.write(rule.stderr || ''); process.exit(rule.exit || 1); }",
    "if (rule && rule.badEnv) { process.exit(0); }",
    'if (rule && rule.stderr) process.stderr.write(rule.stderr);',
    "if (rule && rule.stdoutBase64) process.stdout.write(Buffer.from(rule.stdoutBase64, 'base64'));",
    'process.exit(rule && rule.exit ? rule.exit : 0);',
  ].join('\n'), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify(rules));
  return dir;
}

async function cli(binDir: string, cwd: string, argv: string[]) {
  const out: string[] = [];
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  vi.spyOn(console, 'log').mockImplementation((...p: unknown[]) => { out.push(p.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...p: unknown[]) => { out.push(p.join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation((...p: unknown[]) => { out.push(p.join(' ')); });
  vi.stubEnv('DATABASE_URL', 'file:./app.db');
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  const previousExit = process.exitCode;
  process.exitCode = undefined;
  let thrown: (Error & { stderr?: unknown; stdout?: unknown }) | null = null;
  try { await runCli(argv); } catch (error) { thrown = error as Error; } finally { process.env.PATH = previousPath; }
  const exitCode = process.exitCode as number | undefined;
  process.exitCode = previousExit;
  return { out: out.join('\n'), thrown, exitCode };
}

describe('drime destination: config validation', () => {
  it('defaults keep to 10 and maxBytes to 5_000_000_000, and carries no secrets', () => {
    const cwd = makeTempDir();
    const dest = normalizeDestination({ type: 'drime', path: 'app' } as never, cwd) as unknown as Record<string, unknown>;
    expect(dest).toMatchObject({ type: 'drime', path: 'app', keep: 10, maxBytes: 5_000_000_000, envFile: '/etc/db-backup/drime.env', target: 'drimecrypt:app' });
    expect(JSON.stringify(dest)).not.toMatch(/token|password/i);
  });

  it('refuses unsafe paths and invalid keep/maxBytes/remote names', () => {
    const cwd = makeTempDir();
    for (const bad of ['', '/abs', '../x', 'a/../b', 'a:b', 'a//b', 'a\\b', '.', 'a/./b']) {
      expect(() => normalizeDestination({ type: 'drime', path: bad } as never, cwd), bad).toThrow(/Invalid "path" for drime/);
    }
    for (const maxBytes of [0, -1, 1.5, '5', Number.NaN, 2 ** 60]) {
      expect(() => normalizeDestination({ type: 'drime', path: 'a', maxBytes } as never, cwd)).toThrow(/maxBytes/);
    }
    for (const keep of [0, 1.5, '3']) {
      expect(() => normalizeDestination({ type: 'drime', path: 'a', keep } as never, cwd)).toThrow(/keep/);
    }
    expect(() => normalizeDestination({ type: 'drime', path: 'a', baseRemote: 'x', cryptRemote: 'x' } as never, cwd)).toThrow(/different/);
    expect(() => normalizeDestination({ type: 'drime', path: 'a', baseRemote: 'my_remote' } as never, cwd)).toThrow(/baseRemote/);
  });

  itOnPosix('--dest drime:<path> with --drime-env-file reaches the env-file preflight', async () => {
    const { cwd, outputDir } = setup();
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    vi.stubEnv('DATABASE_URL', 'file:./app.db');
    const missing = path.join(cwd, 'absent.env');
    await expect(runCli(['backup', '--dest', 'drime:app', '--drime-env-file', missing, '--output-dir', outputDir])).rejects.toThrow(
      `Drime env file ${missing} is not readable`,
    );
    expect(fs.existsSync(outputDir)).toBe(false);
  });
});

describe('drime env file: refuse before any backup work', () => {
  const cases: [string, Record<string, string | null>][] = [
    ['base TYPE is not drime', { RCLONE_CONFIG_DRIME_TYPE: 's3' }],
    ['base access token missing', { RCLONE_CONFIG_DRIME_ACCESS_TOKEN: null }],
    ['base root_folder_id would hide plaintext', { RCLONE_CONFIG_DRIME_ROOT_FOLDER_ID: '123' }],
    ['base workspace_id', { RCLONE_CONFIG_DRIME_WORKSPACE_ID: '1' }],
    ['crypt FILENAME_ENCRYPTION off', { RCLONE_CONFIG_DRIMECRYPT_FILENAME_ENCRYPTION: 'off' }],
    ['crypt DIRECTORY_NAME_ENCRYPTION false', { RCLONE_CONFIG_DRIMECRYPT_DIRECTORY_NAME_ENCRYPTION: 'false' }],
    ['crypt NO_DATA_ENCRYPTION true', { RCLONE_CONFIG_DRIMECRYPT_NO_DATA_ENCRYPTION: 'true' }],
    ['crypt TYPE is not crypt', { RCLONE_CONFIG_DRIMECRYPT_TYPE: 'alias' }],
    ['crypt unknown option', { RCLONE_CONFIG_DRIMECRYPT_SUFFIX: 'none' }],
    ['crypt PASSWORD2 missing', { RCLONE_CONFIG_DRIMECRYPT_PASSWORD2: null }],
    ['crypt PASSWORD empty', { RCLONE_CONFIG_DRIMECRYPT_PASSWORD: '' }],
    ['crypt REMOTE names another base', { RCLONE_CONFIG_DRIMECRYPT_REMOTE: 'other:backups' }],
    ['crypt REMOTE has empty root', { RCLONE_CONFIG_DRIMECRYPT_REMOTE: 'drime:' }],
    ['crypt REMOTE has a nested root', { RCLONE_CONFIG_DRIMECRYPT_REMOTE: 'drime:a/b' }],
    ['crypt REMOTE root is ..', { RCLONE_CONFIG_DRIMECRYPT_REMOTE: 'drime:..' }],
  ];

  it.each(cases)('refuses: %s', (_name, overrides) => {
    const { cwd, outputDir } = setup();
    const envFile = writeEnvFile(cwd, overrides);
    const rclone = makeFakeRclone();
    expect(() =>
      runBackupJob(jobOptions(cwd, outputDir, {
        destinations: [{ type: 'drime', path: 'app', envFile }],
        runtime: makeRuntime({ commandExists: (c: string) => c === 'rclone', execFileSync: rclone.execFileSync }),
      })),
    ).toThrow(/Drime env file/);
    expect(rclone.calls).toEqual([]);
    expect(fs.existsSync(outputDir), 'no backup work happened').toBe(false);
  });

  it('refuses a missing env file and a malformed line without echoing line content', () => {
    const { cwd, outputDir } = setup();
    const run = (envFile: string) =>
      runBackupJob(jobOptions(cwd, outputDir, {
        destinations: [{ type: 'drime', path: 'app', envFile }],
        runtime: makeRuntime({ commandExists: (c: string) => c === 'rclone', execFileSync: makeFakeRclone().execFileSync }),
      }));
    expect(() => run(path.join(cwd, 'nope.env'))).toThrow(/not readable/);

    const bad = path.join(cwd, 'bad.env');
    fs.writeFileSync(bad, `${envFileLines()}\n${SECRETS.plainPass} no equals sign\n`);
    let message = '';
    try { run(bad); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/not KEY=VALUE/);
    expectNoSecrets(message);
    expect(fs.existsSync(outputDir)).toBe(false);
  });

  it('refuses a duplicated key', () => {
    const { cwd, outputDir } = setup();
    const dup = path.join(cwd, 'dup.env');
    fs.writeFileSync(dup, `${envFileLines()}\nRCLONE_CONFIG_DRIME_ACCESS_TOKEN=other\n`);
    expect(() =>
      runBackupJob(jobOptions(cwd, outputDir, { destinations: [{ type: 'drime', path: 'app', envFile: dup }], runtime: makeRuntime({ commandExists: (c: string) => c === 'rclone' }) })),
    ).toThrow(/more than once/);
  });

  it('accepts the bigpi file shape (TYPE + ACCESS_TOKEN only on the base)', () => {
    const { cwd, outputDir, envFile } = setup();
    const rclone = makeFakeRclone();
    const result = runBackupJob(jobOptions(cwd, outputDir, {
      destinations: [{ type: 'drime', path: 'app', envFile }],
      runtime: makeRuntime({ commandExists: (c: string) => c === 'rclone', execFileSync: rclone.execFileSync }),
    }));
    expect(result.destinationResults?.[0].outcome).toEqual({ status: 'uploaded', size: ARTIFACT_BYTES });
  });
});

describe('drime destination: hermetic rclone child', () => {
  const polluted = {
    PATH: process.env.PATH,
    HOME: '/home/backup',
    TMPDIR: os.tmpdir(),
    LANG: 'C.UTF-8',
    LC_ALL: 'C',
    RCLONE_CONFIG: '/evil/rclone.conf',
    RCLONE_LOG_FILE: '/evil/log',
    RCLONE_CONFIG_DRIME_ACCESS_TOKEN: 'ambient-token',
    RCLONE_CONFIG_DRIMECRYPT_NO_DATA_ENCRYPTION: 'true',
    RCLONE_CONFIG_PASS: 'ambient-config-pass',
    RCLONE_DUMP: 'bodies',
    AWS_SECRET_ACCESS_KEY: 'ambient-aws',
    HTTPS_PROXY: 'http://proxy.invalid',
  };

  function uploadWithPollutedEnv() {
    const { cwd, outputDir, envFile } = setup();
    const rclone = makeFakeRclone({ seeded: ['sqlite-backup-20260101-000000Z.db'] });
    runBackupJob(jobOptions(cwd, outputDir, {
      destinations: [{ type: 'drime', path: 'app', envFile }],
      runtime: makeRuntime({ commandExists: (c: string) => c === 'rclone', execFileSync: rclone.execFileSync, env: polluted }),
    }));
    return rclone;
  }

  it('drops every inherited RCLONE_* and non-allowlisted variable, and uses a private empty 0600 config', () => {
    const { calls } = uploadWithPollutedEnv();
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      const names = Object.keys(call.env);
      const inheritedRclone = names.filter((n) => n.startsWith('RCLONE_') && !n.startsWith('RCLONE_CONFIG_DBBDRIME') && n !== 'RCLONE_CONFIG');
      expect(inheritedRclone).toEqual([]);
      expect(call.env.RCLONE_CONFIG).not.toBe('/evil/rclone.conf');
      expect(path.isAbsolute(call.env.RCLONE_CONFIG)).toBe(true);
      expect(call.config).toMatchObject({ exists: true, mode: 0o600, size: 0 });
      expect(call.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(call.env.HTTPS_PROXY).toBeUndefined();
      expect(call.env).toMatchObject({ HOME: '/home/backup', LANG: 'C.UTF-8', LC_ALL: 'C' });
      expect(call.env.RCLONE_CONFIG_DRIME_ACCESS_TOKEN).toBeUndefined();
      expect(call.env.RCLONE_CONFIG_PASS).toBeUndefined();
    }
    for (const call of calls) expect(fs.existsSync(call.config.file), 'private config removed').toBe(false);
  });

  it('forces the encryption constants and addresses only the private crypt remote', () => {
    const { calls } = uploadWithPollutedEnv();
    for (const { env } of calls) {
      expect(env).toMatchObject({
        RCLONE_CONFIG_DBBDRIMECRYPT_TYPE: 'crypt',
        RCLONE_CONFIG_DBBDRIMECRYPT_REMOTE: 'dbbdrimebase:backups-encrypted',
        RCLONE_CONFIG_DBBDRIMECRYPT_FILENAME_ENCRYPTION: 'standard',
        RCLONE_CONFIG_DBBDRIMECRYPT_DIRECTORY_NAME_ENCRYPTION: 'true',
        RCLONE_CONFIG_DBBDRIMECRYPT_NO_DATA_ENCRYPTION: 'false',
        RCLONE_CONFIG_DBBDRIMECRYPT_PASSWORD: SECRETS.pass,
        RCLONE_CONFIG_DBBDRIMECRYPT_PASSWORD2: SECRETS.pass2,
        RCLONE_CONFIG_DBBDRIMEBASE_TYPE: 'drime',
        RCLONE_CONFIG_DBBDRIMEBASE_ACCESS_TOKEN: SECRETS.token,
      });
    }
    const copy = calls.find((c) => c.args[0] === 'copyto')!;
    expect(copy.args[2]).toMatch(/^dbbdrimecrypt:app\/sqlite-backup-/);
    for (const { args } of calls) {
      for (const arg of args) expect(arg).not.toMatch(/^(drime|drimecrypt|dbbdrimebase):/);
    }
  });
});

describe('drime destination: secrets never surface', () => {
  function runFailing(failOn: string) {
    const { cwd, outputDir, envFile } = setup();
    const rclone = makeFakeRclone({ fail: (args) => (args[0] === failOn ? leakyError() : null) });
    const logs: string[] = [];
    for (const method of ['log', 'warn', 'error', 'info'] as const) {
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { logs.push(parts.join(' ')); });
    }
    const run = () => runBackupJob(jobOptions(cwd, outputDir, {
      destinations: [{ type: 'drime', path: 'app', envFile }],
      runtime: makeRuntime({ commandExists: (c: string) => c === 'rclone', execFileSync: rclone.execFileSync }),
    }));
    return { run, logs, outputDir, rclone };
  }

  it.each(['copyto', 'lsjson'])('a failing %s throws a fixed string with nothing attached', (op) => {
    const { run, logs, outputDir } = runFailing(op);
    let error: Error | null = null;
    try { run(); } catch (caught) { error = caught as Error; }
    expect(error?.message).toBe(`rclone ${op} failed (exit 1)`);
    expect(Object.getOwnPropertyNames(error).filter((n) => n !== 'markerPath').sort()).toEqual(['message', 'stack']);
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    expectNoSecrets(String(error?.stack));
    expectNoSecrets(logs.join('\n'));
    const marker = fs.readdirSync(outputDir).find((f) => f.endsWith('.failed'))!;
    expectNoSecrets(fs.readFileSync(path.join(outputDir, marker), 'utf8'));
  });

  it('a prune failure that echoes the secrets warns without them and does not fail the run', () => {
    const { cwd, outputDir, envFile } = setup();
    const seeded = Array.from({ length: 12 }, (_v, i) => `sqlite-backup-202606${String(i + 10).padStart(2, '0')}-150000Z.db`);
    const rclone = makeFakeRclone({ seeded, fail: (args) => (args[0] === 'deletefile' ? leakyError() : null) });
    const logs: string[] = [];
    for (const method of ['log', 'warn', 'error']) {
      vi.spyOn(console, method as 'log').mockImplementation((...parts: unknown[]) => { logs.push(parts.join(' ')); });
    }
    const result = runBackupJob(jobOptions(cwd, outputDir, {
      destinations: [{ type: 'drime', path: 'app', envFile }],
      runtime: makeRuntime({ commandExists: (c: string) => c === 'rclone', execFileSync: rclone.execFileSync }),
    }));
    const text = logs.join('\n');
    expectNoSecrets(text);
    expect(text).toMatch(/ALERT drime prune failed for app: 3 objects over keep 10/);
    expect(result.destinationResults?.[0]).toMatchObject({ pruneFailed: { overKeep: 3 }, removed: [] });
    expectNoSecrets(JSON.stringify(result));
  });

  it('a failed listing during prune raises the distinct alert and still succeeds', () => {
    const { cwd, outputDir, envFile } = setup();
    const rclone = makeFakeRclone({ fail: (args) => (args[0] === 'lsf' ? leakyError() : null) });
    const errors: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { errors.push(parts.join(' ')); });
    const result = runBackupJob(jobOptions(cwd, outputDir, {
      destinations: [{ type: 'drime', path: 'app', envFile }],
      runtime: makeRuntime({ commandExists: (c: string) => c === 'rclone', execFileSync: rclone.execFileSync }),
    }));
    expect(errors.join('\n')).toMatch(/ALERT drime prune failed for app: an unknown number of objects over keep 10/);
    expect(result.destinationResults?.[0].pruneFailed).toEqual({ overKeep: null });
  });

  describe('through the CLI with a real rclone-shaped subprocess', () => {
    itOnPosix('a failing rclone that echoes both password forms on stderr leaks nothing through runCli --json or the thrown error', async () => {
      const { cwd, outputDir, envFile } = setup();
      useRealSqliteIfPresent(cwd);
      const stderr = `${SECRETS.pass} ${SECRETS.plainPass} ${SECRETS.pass2} ${SECRETS.token}`;
      const bin = installFakeRclone([{ match: 'copyto', exit: 1, stderr }]);
      const { out, thrown } = await cli(bin, cwd, [...CLI_FLAGS, '--dest', 'drime:app', '--drime-env-file', envFile, '--output-dir', outputDir]);
      expect(thrown?.message).toBe('rclone copyto failed (exit 1)');
      expect(thrown?.stderr).toBeUndefined();
      expect(thrown?.stdout).toBeUndefined();
      expectNoSecrets(out + String(thrown?.stack));
    });

    itOnPosix('over-cap through runCli --json reports the typed outcome and fails', async () => {
      const { cwd, outputDir, envFile } = setup();
      useRealSqliteIfPresent(cwd);
      const cfg = path.join(cwd, 'db-backup.config.json');
      fs.writeFileSync(cfg, JSON.stringify({ databaseUrl: 'file:./app.db', destinations: [{ type: 'drime', path: 'app', envFile, maxBytes: 3 }] }));
      const bin = installFakeRclone([]);
      const { out, thrown } = await cli(bin, cwd, [...CLI_FLAGS, '--config', cfg, '--json', '--output-dir', outputDir]);
      expect(thrown?.message).toMatch(/over its size cap/);
      const json = JSON.parse(out.slice(out.indexOf('{')));
      expect(json.ok).toBe(false);
      expect(json.destinationResults[0].outcome).toMatchObject({ status: 'skipped-over-cap', maxBytes: 3 });
      expect(json.destinationResults[0].outcome.size).toBeGreaterThan(3);
      expectNoSecrets(out);
    });
  });
});

describe('drime destination: over-cap is a failure, not a success', () => {
  const OLD = ['sqlite-backup-20260701-120000Z.db', 'sqlite-backup-20260702-120000Z.db'];

  it('drime-only: fails, nothing uploaded, staging and stamp preserved, marker names set and size', () => {
    const { cwd, outputDir, envFile } = setup();
    const stampFile = path.join(cwd, 'stamp', '.last-success');
    fs.mkdirSync(path.dirname(stampFile), { recursive: true });
    fs.writeFileSync(stampFile, '2026-07-01T00:00:00.000Z\n');
    const rclone = makeFakeRclone();
    let error: (Error & { destinationResults?: { outcome?: unknown }[] }) | null = null;
    try {
      runBackupJob(jobOptions(cwd, outputDir, {
        stampFile,
        destinations: [{ type: 'drime', path: 'app', envFile, maxBytes: ARTIFACT_BYTES - 1 }],
        runtime: makeRuntime({ commandExists: (c: string) => c === 'rclone', execFileSync: rclone.execFileSync }),
      }));
    } catch (caught) { error = caught as typeof error; }

    expect(error?.message).toMatch(/app: sqlite-backup-.* is 14 bytes, over maxBytes 13/);
    expect(error?.destinationResults?.[0].outcome).toEqual({ status: 'skipped-over-cap', size: 14, maxBytes: 13 });
    expect(rclone.calls.some((c) => c.args[0] === 'copyto')).toBe(false);
    expect(rclone.calls.some((c) => c.args[0] === 'deletefile')).toBe(false);
    expect(fs.readdirSync(outputDir).some((f) => f.startsWith('sqlite-backup-') && f.endsWith('.db')), 'staging preserved').toBe(true);
    expect(fs.readFileSync(stampFile, 'utf8').trim()).toBe('2026-07-01T00:00:00.000Z');
    const marker = fs.readdirSync(outputDir).find((f) => f.endsWith('.failed'))!;
    expect(fs.readFileSync(path.join(outputDir, marker), 'utf8')).toMatch(/app: .* is 14 bytes, over maxBytes 13/);
  });

  it('a backup exactly at maxBytes uploads', () => {
    const { cwd, outputDir, envFile } = setup();
    const rclone = makeFakeRclone();
    const result = runBackupJob(jobOptions(cwd, outputDir, {
      destinations: [{ type: 'drime', path: 'app', envFile, maxBytes: ARTIFACT_BYTES }],
      runtime: makeRuntime({ commandExists: (c: string) => c === 'rclone', execFileSync: rclone.execFileSync }),
    }));
    expect(result.destinationResults?.[0].outcome).toMatchObject({ status: 'uploaded' });
    expect(rclone.drimeObjects.has(NEW_NAME)).toBe(true);
  });

  it('local + drime: local history is not pruned and the stamp is untouched', () => {
    const { cwd, outputDir, envFile } = setup();
    fs.mkdirSync(outputDir, { recursive: true });
    for (const name of OLD) fs.writeFileSync(path.join(outputDir, name), 'old');
    const stampFile = path.join(cwd, '.last-success');
    const rclone = makeFakeRclone();
    expect(() =>
      runBackupJob(jobOptions(cwd, outputDir, {
        stampFile,
        policy: { mode: 'keep-last', keepLast: 1 },
        destinations: [{ type: 'local', path: outputDir }, { type: 'drime', path: 'app', envFile, maxBytes: 1 }],
        runtime: makeRuntime({ commandExists: (c: string) => c === 'rclone', execFileSync: rclone.execFileSync }),
      })),
    ).toThrow(/over its size cap/);
    for (const name of OLD) expect(fs.existsSync(path.join(outputDir, name))).toBe(true);
    expect(fs.existsSync(stampFile)).toBe(false);
  });

  it('local + drime + s3: the other destinations are still uploaded, then the run fails without pruning', async () => {
    const { cwd, outputDir, envFile } = setup();
    fs.mkdirSync(outputDir, { recursive: true });
    for (const name of OLD) fs.writeFileSync(path.join(outputDir, name), 'old');
    const s3Objects = new Map<string, Buffer>([['old-object', Buffer.from('x')]]);
    const s3Methods: string[] = [];
    const fetchImpl = (url: string, opts: { method: string; body?: Buffer }) => {
      s3Methods.push(opts.method);
      const key = decodeURIComponent(new URL(url).pathname.replace(/^\/[^/]+\//, ''));
      if (opts.method === 'PUT') {
        const body = Buffer.from(opts.body || Buffer.alloc(0));
        s3Objects.set(key, body);
        return { status: 200, headers: { etag: `"${crypto.createHash('md5').update(body).digest('hex')}"` }, body: Buffer.alloc(0) };
      }
      const obj = s3Objects.get(key);
      return obj
        ? { status: 200, headers: { 'content-length': String(obj.length), etag: `"${crypto.createHash('md5').update(obj).digest('hex')}"` }, body: Buffer.alloc(0) }
        : { status: 404, headers: {}, body: Buffer.alloc(0) };
    };
    const rclone = makeFakeRclone();
    await expect(
      runBackupJobAsync(jobOptions(cwd, outputDir, {
        policy: { mode: 'keep-last', keepLast: 1 },
        destinations: [
          { type: 'local', path: outputDir },
          { type: 'drime', path: 'app', envFile, maxBytes: 1 },
          { type: 's3', bucket: 'b', keep: 1 },
        ],
        runtime: makeRuntime({ commandExists: (c: string) => c === 'rclone', execFileSync: rclone.execFileSync, fetchImpl, env: { AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secretsecretsecret' } } as never),
      })),
    ).rejects.toThrow(/over its size cap/);
    expect([...s3Objects.keys()].some((k) => k.endsWith(NEW_NAME)), 's3 upload ran').toBe(true);
    expect(s3Methods).not.toContain('DELETE');
    expect(s3Objects.has('old-object')).toBe(true);
    for (const name of OLD) expect(fs.existsSync(path.join(outputDir, name))).toBe(true);
    expect(rclone.drimeObjects.size).toBe(0);
  });
});

describe('drime destination: keep 10', () => {
  const seeded = (n: number) => Array.from({ length: n }, (_v, i) => `sqlite-backup-202606${String(i + 1).padStart(2, '0')}-150000Z.db`);

  function run(extra: Record<string, unknown>, rcloneOptions: Parameters<typeof makeFakeRclone>[0]) {
    const { cwd, outputDir, envFile } = setup();
    const rclone = makeFakeRclone(rcloneOptions);
    const result = runBackupJob(jobOptions(cwd, outputDir, {
      destinations: [{ type: 'drime', path: 'app', envFile, ...extra }],
      runtime: makeRuntime({ commandExists: (c: string) => c === 'rclone', execFileSync: rclone.execFileSync }),
    }));
    return { rclone, result };
  }

  it('leaves exactly 10 including the new object, newest kept', () => {
    const { rclone } = run({}, { seeded: seeded(15) });
    expect(rclone.drimeObjects.size).toBe(10);
    expect(rclone.drimeObjects.has(NEW_NAME)).toBe(true);
    expect(rclone.deleted.sort()).toEqual(seeded(15).slice(0, 6));
  });

  it('beats a GFS plan: a GFS policy does not widen the Drime set', () => {
    const { cwd, outputDir, envFile } = setup();
    const rclone = makeFakeRclone({ seeded: seeded(15) });
    runBackupJob(jobOptions(cwd, outputDir, {
      policy: { mode: 'gfs', daily: 30, weekly: 10 },
      destinations: [{ type: 'local', path: outputDir }, { type: 'drime', path: 'app', envFile }],
      runtime: makeRuntime({ commandExists: (c: string) => c === 'rclone', execFileSync: rclone.execFileSync }),
    }));
    expect(rclone.drimeObjects.size).toBe(10);
  });

  it('keep 1 leaves only the new object', () => {
    const { rclone } = run({ keep: 1 }, { seeded: seeded(4) });
    expect([...rclone.drimeObjects]).toEqual([NEW_NAME]);
  });

  it('a listing that misses the just-uploaded object still leaves exactly 10', () => {
    const { rclone } = run({}, { seeded: seeded(15), hideNewFromListing: true });
    expect(rclone.drimeObjects.size).toBe(10);
    expect(rclone.drimeObjects.has(NEW_NAME)).toBe(true);
  });
});

describe('generic rclone destinations never reach Drime unencrypted', () => {
  const run = (remotes: { name: string; type: string }[] | null, target: string, rcloneOptions: Parameters<typeof makeFakeRclone>[0] = {}, extra: Record<string, unknown> = {}) => {
    const { cwd, outputDir } = setup();
    const rclone = makeFakeRclone(rcloneOptions);
    const job = () => runBackupJob(jobOptions(cwd, outputDir, {
      remote: { target, ...extra },
      runtime: makeRuntime({ commandExists: (c: string) => c === 'rclone', execFileSync: rclone.execFileSync, remotes }),
    }));
    return { job, rclone };
  };

  it.each(['drime', 'alias', 'union', 'combine', 'chunker', 'hasher', 'compress', 'crypt', 'cache'])('refuses a %s remote before any copy', (type) => {
    const { job, rclone } = run([{ name: 'offsite', type }], 'offsite:backups');
    expect(job).toThrow(/Refusing rclone target "offsite:"/);
    expect(rclone.calls.some((c) => c.args[0] === 'copyto')).toBe(false);
  });

  it.each([':drime:backups', ':s3,env_auth=true:bucket/x', 'offsite,root_folder_id=1:backups', "offsite,opt='a:b':x", ':alias,remote=drime:x:y'])(
    'refuses the connection-string target %s',
    (target) => {
      const { job, rclone } = run(DEFAULT_TEST_REMOTES, target);
      expect(job).toThrow(/connection-string/);
      expect(rclone.calls).toEqual([]);
    },
  );

  it('refuses an unresolved name, unparseable listing output, and a failing listing (fail closed)', () => {
    expect(run([], 'offsite:x').job).toThrow(/no remote with that name/);
    const bad = run(null, 'offsite:x', { fail: (a) => (a[0] === 'listremotes' ? new Error('boom') : null) });
    expect(bad.job).toThrow(/could not resolve its type/);
    const garbled = makeFakeRclone();
    const { cwd, outputDir } = setup();
    expect(() =>
      runBackupJob(jobOptions(cwd, outputDir, {
        remote: { target: 'offsite:x' },
        runtime: makeRuntime({ commandExists: (c: string) => c === 'rclone', remotes: null, execFileSync: ((_c: string, a: string[]) => (a[0] === 'listremotes' ? Buffer.from('offsite: s3') : garbled.execFileSync(_c, a))) as never }),
      })),
    ).toThrow(/could not parse/);
  });

  it('allows a plain remote and a local path, and keeps type information only', () => {
    const ok = run(DEFAULT_TEST_REMOTES, 'offsite:backups');
    ok.job();
    expect(ok.rclone.otherObjects.has(NEW_NAME)).toBe(true);
    const local = run([], '/srv/offsite-copy');
    local.job();
    expect(local.rclone.calls.some((c) => c.args[0] === 'listremotes')).toBe(false);
  });

  it('refuses through the exported upload helper too', () => {
    const cwd = makeTempDir();
    const file = path.join(cwd, NEW_NAME);
    fs.writeFileSync(file, 'x');
    const runtime = normalizeRuntime(makeRuntime({
      commandExists: (c: string) => c === 'rclone',
      remotes: [{ name: 'offsite', type: 'drime' }],
    }) as never);
    const entry = { fileName: NEW_NAME, fullPath: file, engine: 'sqlite', compressed: false, createdAt: fixedNow.toISOString(), sizeBytes: 1 };
    expect(() => uploadBackupToRemote(entry as never, { target: 'offsite:x' } as never, runtime as never)).toThrow(/Drime remote/);
  });

  it('resolves the type with the same config the upload uses (regression: s3 in the default config, drime in the destination configFile)', () => {
    const configFile = path.join(makeTempDir(), 'drime.conf');
    fs.writeFileSync(configFile, '[offsite]\ntype = drime\n');
    const seenEnv: (string | undefined)[] = [];
    const execFileSync = (_c: string, args: string[], opts?: { env?: Record<string, string> }) => {
      seenEnv.push(opts?.env?.RCLONE_CONFIG);
      if (args[0] === 'listremotes') {
        const type = opts?.env?.RCLONE_CONFIG === configFile ? 'drime' : 's3';
        return Buffer.from(JSON.stringify([{ name: 'offsite', type, source: 'config file', description: 'ignored' }]));
      }
      return Buffer.from('');
    };
    const { cwd, outputDir } = setup();
    expect(() =>
      runBackupJob(jobOptions(cwd, outputDir, {
        remote: { target: 'offsite:x', configFile },
        runtime: makeRuntime({ commandExists: (c: string) => c === 'rclone', remotes: null, execFileSync }),
      })),
    ).toThrow(/Drime remote/);
    expect(seenEnv).toEqual([configFile]);

    const withoutConfig = makeFakeRclone();
    const asDefault = (c: string, a: string[], o?: { env?: Record<string, string> }) =>
      a[0] === 'listremotes' ? execFileSync(c, a, o) : withoutConfig.execFileSync(c, a, o);
    const second = setup();
    runBackupJob(jobOptions(second.cwd, second.outputDir, {
      remote: { target: 'offsite:x' },
      runtime: makeRuntime({ commandExists: (c: string) => c === 'rclone', remotes: null, execFileSync: asDefault }),
    }));
    expect(withoutConfig.otherObjects.has(NEW_NAME)).toBe(true);
  });
});

describe('drime-audit', () => {
  interface Raw { path: string; size?: number; head?: Buffer; dir?: boolean }
  type Failure = 'decrypt' | 'timeout' | 'exit5' | 'password' | 'isfile' | { stderr: string };

  function failure(kind: Failure) {
    if (typeof kind === 'object') return Object.assign(new Error('rclone blew up'), { status: 1, stderr: Buffer.from(kind.stderr) });
    const stderr =
      kind === 'decrypt' ? `undecryptable file name detected: illegal base32 ${SECRETS.pass}`
        : kind === 'password' ? 'Failed to backend: failed to decrypt password: base64 decode failed when revealing password - is it obscured?'
          : kind === 'isfile' ? 'Failed to backend: is a file not a directory'
            : SECRETS.pass;
    return Object.assign(new Error(`rclone blew up ${SECRETS.token}`), {
      status: kind === 'decrypt' || kind === 'password' || kind === 'isfile' ? 1 : kind === 'exit5' ? 5 : null,
      stderr: Buffer.from(stderr),
    });
  }

  function makeAuditRclone(options: {
    top?: { Path: string; IsDir: boolean }[];
    raw?: Raw[];
    strict?: Failure;
    probe?: Failure;
    malformedStrict?: boolean;
    cryptDuplicates?: string[];
    decodeFails?: Record<string, Failure>;
    catFails?: string[];
    catShort?: boolean;
    listFails?: boolean;
  } = {}) {
    const top = options.top || [{ Path: 'backups-encrypted', IsDir: true }];
    const raw = options.raw || [{ path: 'dirx', dir: true }, { path: 'dirx/filea' }, { path: 'dirx/fileb' }];
    const calls: Call[] = [];
    const execFileSync = (_c: string, args: string[], opts?: { env?: Record<string, string> }) => {
      calls.push({ args, env: opts?.env || {}, config: { exists: false, mode: 0, size: 0, file: '' } });
      const filesOnly = args.includes('--files-only');
      if (args[0] === 'lsjson' && args[1] === 'dbbdrimebase:') {
        if (options.listFails) throw failure('exit5');
        return Buffer.from(JSON.stringify(top));
      }
      if (args[0] === 'lsjson' && args.includes('--encrypted')) {
        if (options.strict) throw failure(options.strict);
        if (options.malformedStrict) return Buffer.from('<html>');
        const entries = raw.filter((r) => !(filesOnly && r.dir)).map((r) => ({ Path: `dec/${r.path}`, EncryptedPath: r.path, IsDir: Boolean(r.dir) }));
        return Buffer.from(JSON.stringify([...entries, ...(options.cryptDuplicates || []).map((d) => ({ Path: `dup/${d}`, EncryptedPath: d }))]));
      }
      if (args[0] === 'lsjson') {
        return Buffer.from(JSON.stringify(raw.filter((r) => !(filesOnly && r.dir)).map((r) => (r.dir ? { Path: r.path, IsDir: true } : { Path: r.path, Size: r.size ?? 100, IsDir: false }))));
      }
      if (args[0] === 'backend' && args[1] === 'features') {
        if (options.probe) throw failure(options.probe);
        return Buffer.from('{}');
      }
      if (args[0] === 'backend') {
        const kind = (options.decodeFails || {})[args[args.length - 1]];
        if (kind) throw failure(kind);
        return Buffer.from('decoded');
      }
      if (args[0] === 'cat') {
        const target = args[3].replace('dbbdrimebase:backups-encrypted/', '');
        if ((options.catFails || []).includes(target)) throw failure('timeout');
        if (options.catShort) return Buffer.from('RCL');
        return Buffer.from(raw.find((r) => r.path === target && !r.dir)?.head ?? MAGIC);
      }
      throw new Error(`unexpected ${args.join(' ')}`);
    };
    return { calls, execFileSync };
  }

  const audit = (fake: ReturnType<typeof makeAuditRclone>, env: Record<string, string | undefined> = {}) => {
    const { envFile } = setup();
    return drimeAudit({ envFile, runtime: { execFileSync: fake.execFileSync, env } });
  };
  const kinds = (report: { findings: { kind: string }[] }) => report.findings.map((f) => f.kind);

  it('a clean store has no findings and reads the first 8 bytes of every raw file only', () => {
    const fake = makeAuditRclone();
    const report = audit(fake, { PATH: '/usr/bin', RCLONE_CONFIG: '/evil', RCLONE_LOG_FILE: '/evil' });
    expect(report).toEqual({ objects: 2, findings: [] });
    const cats = fake.calls.filter((c) => c.args[0] === 'cat');
    expect(cats.map((c) => c.args.slice(0, 3))).toEqual([['cat', '--count', '8'], ['cat', '--count', '8']]);
    expect(fake.calls.every((c) => c.env.RCLONE_CONFIG !== '/evil' && c.env.RCLONE_LOG_FILE === undefined)).toBe(true);
    expect(fake.calls.some((c) => c.args.includes('--crypt-strict-names'))).toBe(true);
  });

  it('flags anything at the raw top level other than the crypt root', () => {
    const report = audit(makeAuditRclone({ top: [{ Path: 'backups-encrypted', IsDir: true }, { Path: 'plaintext-folder', IsDir: true }] }));
    expect(report.findings).toEqual([{ kind: 'unexpected-top-level', path: 'drime:plaintext-folder', detail: 'not the crypt root' }]);
  });

  it('names the raw path of a file whose name does not decrypt', () => {
    const report = audit(makeAuditRclone({ strict: 'decrypt', decodeFails: { 'dirx/fileb': 'decrypt' } }));
    expect(report.findings.map((f) => [f.kind, f.path])).toEqual([['undecryptable', 'drime:backups-encrypted/dirx/fileb']]);
  });

  it('names an undecryptable EMPTY directory by its raw path (directories are inventoried)', () => {
    const report = audit(makeAuditRclone({
      raw: [{ path: 'dirx', dir: true }, { path: 'dirx/filea' }, { path: 'emptybad', dir: true }],
      strict: 'decrypt',
      decodeFails: { emptybad: 'decrypt' },
    }));
    expect(report.findings.map((f) => [f.kind, f.path])).toEqual([['undecryptable', 'drime:backups-encrypted/emptybad']]);
  });

  it('flags an empty directory the crypt listing does not know', () => {
    const fake = makeAuditRclone({ raw: [{ path: 'dirx', dir: true }, { path: 'dirx/filea' }] });
    const original = fake.execFileSync;
    const trimmed = (c: string, a: string[], o?: { env?: Record<string, string> }) => {
      const out = original(c, a, o);
      return a.includes('--encrypted') ? Buffer.from(JSON.stringify(JSON.parse(String(out)).filter((e: { IsDir: boolean }) => !e.IsDir))) : out;
    };
    const report = audit({ calls: fake.calls, execFileSync: trimmed });
    expect(report.findings.map((f) => [f.kind, f.path])).toEqual([['undecryptable', 'drime:backups-encrypted/dirx']]);
  });

  it('flags plaintext hiding under a validly encrypted name (magic header check)', () => {
    const report = audit(makeAuditRclone({ raw: [{ path: 'dirx', dir: true }, { path: 'dirx/filea' }, { path: 'dirx/fileb', head: Buffer.from('SQLite f') }] }));
    expect(report.findings).toEqual([{ kind: 'not-crypt-format', path: 'drime:backups-encrypted/dirx/fileb', detail: 'missing rclone crypt header' }]);
  });

  it('flags files too small to be crypt files', () => {
    const report = audit(makeAuditRclone({ raw: [{ path: 'tiny', size: 5 }] }));
    expect(report.findings.map((f) => [f.kind, f.path])).toEqual([['not-crypt-format', 'drime:backups-encrypted/tiny']]);
  });

  describe('an ambiguous inventory is never clean (Drime allows duplicate names)', () => {
    it('two raw files at one path', () => {
      const fake = makeAuditRclone({ raw: [{ path: 'dirx', dir: true }, { path: 'dirx/filea' }, { path: 'dirx/filea', head: Buffer.from('SQLite f') }] });
      const report = audit(fake);
      expect(report.findings.map((f) => [f.kind, f.path])).toEqual([['ambiguous-path', 'drime:backups-encrypted/dirx/filea']]);
      expect(fake.calls.filter((c) => c.args[0] === 'cat')).toEqual([]);
    });

    it('a file and a directory at one path', () => {
      const report = audit(makeAuditRclone({ raw: [{ path: 'x', dir: true }, { path: 'x' }] }));
      expect(kinds(report)).toContain('ambiguous-path');
    });

    it('a duplicated or non-directory crypt root', () => {
      expect(kinds(audit(makeAuditRclone({ top: [{ Path: 'backups-encrypted', IsDir: true }, { Path: 'backups-encrypted', IsDir: true }] })))).toContain('ambiguous-path');
      const fileRoot = makeAuditRclone({ top: [{ Path: 'backups-encrypted', IsDir: false }], probe: 'isfile' });
      expect(audit(fileRoot).findings.map((f) => [f.kind, f.path])).toEqual([['ambiguous-path', 'drime:backups-encrypted']]);
      expect(fileRoot.calls.some((c) => c.args[0] === 'backend' && c.args[1] === 'features')).toBe(false);
    });

    it('two crypt entries mapping to one raw path', () => {
      const report = audit(makeAuditRclone({ cryptDuplicates: ['dirx/filea'] }));
      expect(report.findings.map((f) => [f.kind, f.path])).toEqual([['ambiguous-path', 'drime:backups-encrypted/dirx/filea']]);
    });
  });

  describe('inability to complete is an error (exit 2), not a finding', () => {
    const throwsWith = (options: Parameters<typeof makeAuditRclone>[0], pattern: RegExp) => {
      let message = '';
      try { audit(makeAuditRclone(options)); } catch (error) { message = (error as Error).message; }
      expect(message).toMatch(pattern);
      expectNoSecrets(message);
    };

    it('a timed-out or failing strict crypt listing', () => {
      throwsWith({ strict: 'timeout' }, /^strict crypt listing: rclone lsjson failed \(exit unknown\)$/);
      throwsWith({ strict: 'exit5' }, /^strict crypt listing: rclone lsjson failed \(exit 5\)$/);
    });

    it('malformed crypt listing output', () => {
      throwsWith({ malformedStrict: true }, /could not parse crypt listing/);
    });

    it('a decrypt failure no name can be blamed for', () => {
      throwsWith({ strict: 'decrypt' }, /no undecryptable name could be identified/);
    });

    it('a name decode that fails for a non-decrypt reason', () => {
      throwsWith({ strict: 'decrypt', decodeFails: { 'dirx/filea': 'timeout' } }, /^decoding names: rclone backend failed \(exit unknown\)$/);
    });

    it('a header read that fails or returns too few bytes', () => {
      throwsWith({ catFails: ['dirx/filea'] }, /^reading object header: rclone cat failed \(exit unknown\)$/);
      throwsWith({ catShort: true }, /fewer bytes than requested/);
    });

    it('the raw listing failing', () => {
      throwsWith({ listFails: true }, /^listing base remote: rclone lsjson failed \(exit 5\)$/);
    });
  });

  describe('credential and crypt-initialisation failures are errors, never findings (PKG-304 review 6b)', () => {
    const throwsWith = (options: Parameters<typeof makeAuditRclone>[0], pattern: RegExp) => {
      let message = '';
      let report: unknown = null;
      try { report = audit(makeAuditRclone(options)); } catch (error) { message = (error as Error).message; }
      expect(report).toBeNull();
      expect(message).toMatch(pattern);
    };

    it('a crypt remote that cannot initialise stops the audit before the recursive listings', () => {
      const fake = makeAuditRclone({ probe: 'password' });
      expect(() => audit(fake)).toThrow(/^initialising crypt remote: rclone backend failed \(exit 1\)$/);
      expect(fake.calls.some((c) => c.args[0] === 'lsjson' && c.args.includes('-R'))).toBe(false);
    });

    it('a "failed to decrypt password" strict listing is not a per-name violation', () => {
      throwsWith({ strict: 'password' }, /^strict crypt listing: rclone lsjson failed \(exit 1\)$/);
    });

    it('a "failed to decrypt password" decode is not a per-name violation', () => {
      throwsWith({ strict: 'decrypt', decodeFails: { 'dirx/filea': 'password' } }, /^decoding names: rclone backend failed \(exit 1\)$/);
    });
  });

  describe('every crypt name-decoding error is a finding (PKG-304 review 9a)', () => {
    const MESSAGES: [string, string][] = [
      ['a=', 'failed to decrypt: a=: bad base32 filename encoding'],
      ['aa', 'failed to decrypt: aa: not a multiple of blocksize'],
      ['a', 'failed to decrypt: a: illegal base32 data at input byte 1'],
      ['aaaaaaaaaaaaaaaaaaaaaaaaaa', 'failed to decrypt: aaaaaaaaaaaaaaaaaaaaaaaaaa: bad PKCS#7 padding - too long'],
      ['short', 'failed to decrypt: short: too short after base32 decode'],
      ['long', 'failed to decrypt: long: too long after base32 decode'],
      ['utf', 'failed to decrypt: utf: bad decryption - utf-8 invalid'],
      ['ctl', 'failed to decrypt: ctl: bad decryption - contains control chars'],
    ];

    it.each(MESSAGES)('a directory named %s whose decode says "%s" is a finding', (name, stderr) => {
      const report = audit(makeAuditRclone({
        raw: [{ path: 'dirx', dir: true }, { path: 'dirx/filea' }, { path: name, dir: true }],
        strict: 'decrypt',
        decodeFails: { [name]: { stderr: `NOTICE: Failed to backend: command "decode" failed: ${stderr}` } },
      }));
      expect(report.findings.map((f) => [f.kind, f.path])).toEqual([['undecryptable', `drime:backups-encrypted/${name}`]]);
    });

    it('still treats the password error as an init failure, not a name error', () => {
      const bad = { stderr: 'NOTICE: Failed to backend: failed to decrypt password: base64 decode failed when revealing password - is it obscured?' };
      expect(() => audit(makeAuditRclone({ raw: [{ path: 'dirx', dir: true }], strict: 'decrypt', decodeFails: { dirx: bad } }))).toThrow(/decoding names/);
    });
  });

  describe('raw names are data, never remotes or flags (PKG-304 review 7b)', () => {
    it.each(['bad:name', '--unknown-option'])('an empty undecryptable directory named %s is a finding named by raw path', (name) => {
      const fake = makeAuditRclone({
        raw: [{ path: 'dirx', dir: true }, { path: 'dirx/filea' }, { path: name, dir: true }],
        strict: 'decrypt',
        decodeFails: { [name]: 'decrypt' },
      });
      const report = audit(fake);
      expect(report.findings.map((f) => [f.kind, f.path])).toEqual([['undecryptable', `drime:backups-encrypted/${name}`]]);
      const decode = fake.calls.find((c) => c.args[0] === 'backend' && c.args[1] === 'decode' && c.args.at(-1) === name)!;
      expect(decode.args).toEqual(['backend', 'decode', 'dbbdrimecrypt:', '--', name]);
    });
  });

  it('refuses a bad env file before touching rclone', () => {
    const { cwd } = setup();
    const fake = makeAuditRclone();
    const envFile = writeEnvFile(cwd, { RCLONE_CONFIG_DRIME_ROOT_FOLDER_ID: '9' });
    expect(() => drimeAudit({ envFile, runtime: { execFileSync: fake.execFileSync, env: {} } })).toThrow(/Drime env file/);
    expect(fake.calls).toEqual([]);
  });

  describe('exit codes through runCli', () => {
    const b64 = (text: string) => Buffer.from(text).toString('base64');
    async function auditCli(rules: unknown[]) {
      const { envFile } = setup();
      const bin = installFakeRclone(rules);
      return cli(bin, makeTempDir(), ['drime-audit', '--env-file', envFile]);
    }

    itOnPosix('exits 1 on a demonstrated violation', async () => {
      const { exitCode, out } = await auditCli([{ match: 'lsjson dbbdrimebase:', stdoutBase64: b64('[{"Path":"plain","IsDir":true}]') }]);
      expect(exitCode).toBe(1);
      expect(out).toMatch(/FINDING unexpected-top-level: drime:plain/);
    });

    itOnPosix('exits 2 when a transport failure stops the audit', async () => {
      const { exitCode, out } = await auditCli([{ match: 'lsjson dbbdrimebase:', exit: 5, stderr: SECRETS.token }]);
      expect(exitCode).toBe(2);
      expectNoSecrets(out);
    });

    const BAD_OBSCURED = 'not valid!!';
    const initFailure = (varName: string) => ({ exit: 1, stderr: 'failed to decrypt password: base64 decode failed', badEnv: [varName] });
    const rulesForMalformed = (varName: string) => [
      { match: 'backend features', ...initFailure(varName) },
      { match: 'backend decode', ...initFailure(varName) },
      { match: 'lsjson -R --encrypted', ...initFailure(varName) },
      { match: 'lsjson dbbdrimebase:', stdoutBase64: b64('[{"Path":"backups-encrypted","IsDir":true}]') },
      { match: 'lsjson -R dbbdrimebase:', stdoutBase64: b64('[{"Path":"d","IsDir":true}]') },
    ];

    itOnPosix.each([['PASSWORD'], ['PASSWORD2']])('a malformed obscured %s exits 2 with no findings', async (key) => {
      const { cwd } = setup();
      const envFile = writeEnvFile(cwd, { [`RCLONE_CONFIG_DRIMECRYPT_${key}`]: BAD_OBSCURED });
      const bin = installFakeRclone(rulesForMalformed(`RCLONE_CONFIG_DBBDRIMECRYPT_${key}`));
      const { exitCode, out } = await cli(bin, makeTempDir(), ['drime-audit', '--env-file', envFile]);
      expect(exitCode).toBe(2);
      expect(out).toMatch(/cannot audit/);
      expect(out).not.toMatch(/FINDING/);
    });

    itOnPosix.each(['bad:name', '--unknown-option'])('an empty undecryptable directory named %s exits 1 as a finding', async (name) => {
      const { envFile } = setup();
      const bin = installFakeRclone([
        { match: 'lsjson dbbdrimebase:', stdoutBase64: b64('[{"Path":"backups-encrypted","IsDir":true}]') },
        { match: 'lsjson -R dbbdrimebase:', stdoutBase64: b64(JSON.stringify([{ Path: name, IsDir: true }])) },
        { match: 'lsjson -R --encrypted', exit: 1, stderr: 'undecryptable file name detected: illegal base32' },
        { match: `backend decode dbbdrimecrypt: -- ${name}`, exit: 1, stderr: 'failed to decrypt: illegal base32 data' },
      ]);
      const { exitCode, out } = await cli(bin, makeTempDir(), ['drime-audit', '--env-file', envFile]);
      expect(exitCode).toBe(1);
      expect(out).toContain(`FINDING undecryptable: drime:backups-encrypted/${name}`);
    });

    itOnPosix('a directory named a= (bad base32 filename encoding) exits 1 as a finding', async () => {
      const { envFile } = setup();
      const bin = installFakeRclone([
        { match: 'lsjson dbbdrimebase:', stdoutBase64: b64('[{"Path":"backups-encrypted","IsDir":true}]') },
        { match: 'lsjson -R dbbdrimebase:', stdoutBase64: b64('[{"Path":"a=","IsDir":true}]') },
        { match: 'lsjson -R --encrypted', exit: 1, stderr: 'ERROR : error listing: there were 1 undecryptable name errors' },
        { match: 'backend decode dbbdrimecrypt: -- a=', exit: 1, stderr: 'NOTICE: Failed to backend: command "decode" failed: failed to decrypt: a=: bad base32 filename encoding' },
      ]);
      const { exitCode, out } = await cli(bin, makeTempDir(), ['drime-audit', '--env-file', envFile]);
      expect(exitCode).toBe(1);
      expect(out).toContain('FINDING undecryptable: drime:backups-encrypted/a=');
    });

    itOnPosix('a crypt root that is a file is a finding (exit 1), though crypt init fails on it', async () => {
      const { envFile } = setup();
      const bin = installFakeRclone([
        { match: 'lsjson dbbdrimebase:', stdoutBase64: b64('[{"Path":"backups-encrypted","IsDir":false}]') },
        { match: 'backend features', exit: 1, stderr: 'Failed to backend: is a file not a directory' },
      ]);
      const { exitCode, out } = await cli(bin, makeTempDir(), ['drime-audit', '--env-file', envFile]);
      expect(exitCode).toBe(1);
      expect(out).toContain('FINDING ambiguous-path: drime:backups-encrypted');
    });

    itOnPosix('exits 2 when it cannot audit and prints no credentials', async () => {
      const { cwd } = setup();
      const out: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((...p: unknown[]) => { out.push(p.join(' ')); });
      const previousExit = process.exitCode;
      process.exitCode = undefined;
      await runCli(['drime-audit', '--env-file', path.join(cwd, 'missing.env')]);
      const code = process.exitCode as number | undefined;
      process.exitCode = previousExit;
      expect(code).toBe(2);
      expect(out.join('\n')).toMatch(/cannot audit/);
    });
  });
});

describe('drime destination: writes can only address the crypt remote (PKG-304 review 1)', () => {
  function drimeDestination() {
    const { cwd, envFile } = setup();
    return { cwd, dest: normalizeDestination({ type: 'drime', path: 'app', envFile } as never, cwd) as unknown as Record<string, unknown> };
  }

  it('a caller-supplied target cannot redirect an upload to the plaintext base remote', () => {
    const { cwd, dest } = drimeDestination();
    const file = path.join(cwd, NEW_NAME);
    fs.writeFileSync(file, 'x');
    const rclone = makeFakeRclone();
    const runtime = normalizeRuntime(makeRuntime({ commandExists: (c: string) => c === 'rclone', execFileSync: rclone.execFileSync }) as never);
    const entry = { fileName: NEW_NAME, fullPath: file, engine: 'sqlite', compressed: false, createdAt: fixedNow.toISOString(), sizeBytes: 1 };
    uploadBackupToRemote(entry as never, { ...dest, target: 'drime:backups-encrypted/app' } as never, runtime as never);
    expect(rclone.calls.length).toBeGreaterThanOrEqual(2);
    for (const { args } of rclone.calls) {
      for (const arg of args.slice(1).filter((a) => !a.startsWith('-')).slice(args[0] === 'copyto' ? 1 : 0)) {
        expect(arg.startsWith('dbbdrimecrypt:app/') || arg === 'dbbdrimecrypt:app', arg).toBe(true);
      }
    }
    expect(rclone.drimeObjects.has(NEW_NAME)).toBe(true);
    expect(rclone.otherObjects.size).toBe(0);
  });

  const rt = (rclone: ReturnType<typeof makeFakeRclone>) => ({ execFileSync: rclone.execFileSync, env: {} });

  it.each([
    ['an old-style argv array carrying an encryption-disabling flag', ['copyto', '/tmp/b.db', 'drimecrypt:app/b.db', '--crypt-no-data-encryption=true']],
    ['an extra flags field on a valid operation', { op: 'copyto', localPath: '/tmp/b.db', remoteRel: 'b.db', flags: ['--crypt-no-data-encryption=true'] }],
    ['extra args on list', { op: 'list', args: ['--crypt-filename-encryption=off'] }],
    ['an operation outside the write/verify set', { op: 'purge' }],
    ['a base-remote target field', { op: 'deletefile', remoteRel: 'x', target: 'drime:backups-encrypted' }],
  ])('refuses %s before spawning rclone', (_name, operation) => {
    const { dest } = drimeDestination();
    const rclone = makeFakeRclone();
    expect(() => runDrimeOperation(dest, rt(rclone), operation)).toThrow(/must be one of copyto, stat, list, deletefile, with no extra fields/);
    expect(rclone.calls).toEqual([]);
  });

  it.each([
    ['a relative localPath that looks like a flag', { op: 'copyto', localPath: '--crypt-no-data-encryption=true', remoteRel: 'b.db' }],
    ['a remoteRel that climbs out of the path', { op: 'deletefile', remoteRel: '../other/x' }],
    ['an absolute remoteRel', { op: 'stat', remoteRel: '/etc/x' }],
    ['an empty remoteRel', { op: 'stat', remoteRel: '' }],
  ])('refuses %s before spawning rclone', (_name, operation) => {
    const { dest } = drimeDestination();
    const rclone = makeFakeRclone();
    expect(() => runDrimeOperation(dest, rt(rclone), operation)).toThrow(/drime/i);
    expect(rclone.calls).toEqual([]);
  });

  it('builds every argument itself: only the fixed flags, only the private crypt remote under its own path', () => {
    const { cwd, dest } = drimeDestination();
    const local = path.join(cwd, 'f');
    fs.writeFileSync(local, 'x');
    const rclone = makeFakeRclone();
    for (const operation of [
      { op: 'copyto', localPath: local, remoteRel: 'f' },
      { op: 'stat', remoteRel: 'f' },
      { op: 'list' },
      { op: 'deletefile', remoteRel: 'f' },
    ]) runDrimeOperation(dest, rt(rclone), operation);
    expect(rclone.calls.map((c) => c.args)).toEqual([
      ['copyto', local, 'dbbdrimecrypt:app/f'],
      ['lsjson', '--stat', 'dbbdrimecrypt:app/f'],
      ['lsf', 'dbbdrimecrypt:app', '--files-only'],
      ['deletefile', 'dbbdrimecrypt:app/f'],
    ]);
  });
});

describe('connection-string refusal leaks nothing (PKG-304 review 2)', () => {
  const INLINE = `:drime,access_token=${SECRETS.token}:backups`;

  it.each([
    ['legacy remote', (o: Record<string, unknown>) => ({ ...o, remote: { target: INLINE } })],
    ['rclone destination', (o: Record<string, unknown>) => ({ ...o, destinations: [{ type: 'rclone', target: INLINE }] })],
  ])('the %s error and failure marker carry no target text', (_name, build) => {
    const { cwd, outputDir } = setup();
    let message = '';
    try {
      runBackupJob(build(jobOptions(cwd, outputDir, { runtime: makeRuntime({ commandExists: (c: string) => c === 'rclone' }) })) as never);
    } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/connection-string/);
    expectNoSecrets(message);
    const marker = fs.readdirSync(outputDir).find((f) => f.endsWith('.failed'));
    expect(marker).toBeTruthy();
    expectNoSecrets(fs.readFileSync(path.join(outputDir, marker!), 'utf8'));
  });

  itOnPosix('runCli output and the thrown error carry no target text', async () => {
    const { cwd, outputDir } = setup();
    useRealSqliteIfPresent(cwd);
    const { out, thrown } = await cli(installFakeRclone([]), cwd, [...CLI_FLAGS, '--remote', INLINE, '--output-dir', outputDir]);
    expect(thrown?.message).toMatch(/connection-string/);
    expectNoSecrets(out + String(thrown?.stack) + JSON.stringify(thrown?.message));
  });
});

describe('a later failure keeps the accumulated results (PKG-304 review 4)', () => {
  const capped = (envFile: string) => ({ type: 'drime', path: 'app', envFile, maxBytes: 1 });

  it('async: an S3 failure after an over-cap Drime skip still reports the skip', async () => {
    const { cwd, outputDir, envFile } = setup();
    const fetchImpl = () => ({ status: 500, headers: {}, body: Buffer.from('InternalError') });
    let error: (Error & { destinationResults?: { outcome?: unknown }[] }) | null = null;
    try {
      await runBackupJobAsync(jobOptions(cwd, outputDir, {
        destinations: [{ type: 'local', path: outputDir }, capped(envFile), { type: 's3', bucket: 'b' }],
        runtime: makeRuntime({ commandExists: (c: string) => c === 'rclone', fetchImpl, env: { AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secretsecretsecret' } } as never),
      }));
    } catch (caught) { error = caught as typeof error; }
    expect(error).toBeTruthy();
    expect(error?.destinationResults?.[0].outcome).toMatchObject({ status: 'skipped-over-cap', maxBytes: 1 });
    expect(error?.message).toMatch(/also: Drime upload skipped because the backup is over its size cap/);
  });

  it('sync: a generic rclone failure after an over-cap Drime skip still reports the skip', () => {
    const { cwd, outputDir, envFile } = setup();
    const rclone = makeFakeRclone({ fail: (args) => (args[0] === 'copyto' && String(args[2]).startsWith('offsite:') ? new Error('upload exploded') : null) });
    let error: (Error & { destinationResults?: { outcome?: unknown }[] }) | null = null;
    try {
      runBackupJob(jobOptions(cwd, outputDir, {
        destinations: [{ type: 'local', path: outputDir }, capped(envFile), { type: 'rclone', target: 'offsite:x' }],
        runtime: makeRuntime({ commandExists: (c: string) => c === 'rclone', execFileSync: rclone.execFileSync }),
      }));
    } catch (caught) { error = caught as typeof error; }
    expect(error?.message).toMatch(/^upload exploded; also: Drime upload skipped/);
    expect(error?.destinationResults?.[0].outcome).toMatchObject({ status: 'skipped-over-cap' });
  });

  itOnPosix('runCli --json includes the skipped outcome when a later destination fails', async () => {
    const { cwd, outputDir, envFile } = setup();
    useRealSqliteIfPresent(cwd);
    const cfg = path.join(cwd, 'db-backup.config.json');
    fs.writeFileSync(cfg, JSON.stringify({ databaseUrl: 'file:./app.db', destinations: [capped(envFile), { type: 'rclone', target: 'offsite:x' }] }));
    const bin = installFakeRclone([
      { match: 'listremotes', stdoutBase64: Buffer.from('[{"name":"offsite","type":"s3"}]').toString('base64') },
      { match: 'copyto', exit: 1 },
    ]);
    const { out, thrown } = await cli(bin, cwd, [...CLI_FLAGS, '--config', cfg, '--json', '--output-dir', outputDir]);
    expect(thrown).toBeTruthy();
    const json = JSON.parse(out.slice(out.indexOf('{')));
    expect(json.ok).toBe(false);
    expect(json.destinationResults[0].outcome).toMatchObject({ status: 'skipped-over-cap' });
  });
});

describe('--drime-env-file overrides config-file destinations (PKG-304 review 5)', () => {
  itOnPosix('the flag wins over the envFile a --config destination names', async () => {
    const { cwd, outputDir, envFile } = setup();
    useRealSqliteIfPresent(cwd);
    const cfg = path.join(cwd, 'db-backup.config.json');
    fs.writeFileSync(cfg, JSON.stringify({ databaseUrl: 'file:./app.db', destinations: [{ type: 'drime', path: 'app', envFile }] }));
    const override = path.join(cwd, 'override.env');
    const { thrown } = await cli(installFakeRclone([]), cwd, [...CLI_FLAGS, '--config', cfg, '--drime-env-file', override, '--output-dir', outputDir]);
    expect(thrown?.message).toBe(`Drime env file ${override} is not readable (ENOENT)`);
  });
});
