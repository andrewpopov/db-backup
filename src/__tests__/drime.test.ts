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
  drimeAudit: (o: Record<string, unknown>) => Promise<{ objects: number; findings: { kind: string; path: string; detail: string }[]; changedDuringAudit: string[] }>;
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

interface Call { maxBuffer?: number; args: string[]; env: Record<string, string>; config: { exists: boolean; mode: number; size: number; file: string } }

// Object names as a bag, not a Set: Drime allows duplicate names, and a delete
// by name removes whichever copy rclone resolves first (the first).
class NameBag {
  private readonly names: string[];
  constructor(initial: string[] = []) { this.names = [...initial]; }
  add(name: string) { this.names.push(name); }
  has(name: string) { return this.names.includes(name); }
  count(name: string) { return this.names.filter((n) => n === name).length; }
  delete(name: string) { const at = this.names.indexOf(name); if (at >= 0) this.names.splice(at, 1); }
  get size() { return this.names.length; }
  [Symbol.iterator]() { return this.names[Symbol.iterator](); }
}

// Fake rclone for the in-process runtime. Drime children address the private
// `dbbdrimecrypt:` remote; anything else is the generic `offsite:` target.
function makeFakeRclone(options: { seeded?: string[]; seededOther?: string[]; seededDirs?: string[]; hideNewFromListing?: boolean; fail?: (args: string[]) => Error | null } = {}) {
  const drimeObjects = new NameBag(options.seeded);
  const otherObjects = new NameBag(options.seededOther);
  const deleted: string[] = [];
  const calls: Call[] = [];
  let lastUploadSize = 0;
  const execFileSync = (_command: string, args: string[], opts?: { env?: Record<string, string>; maxBuffer?: number }) => {
    const env = opts?.env || {};
    const configFile = env.RCLONE_CONFIG || '';
    const exists = Boolean(configFile) && fs.existsSync(configFile);
    calls.push({
      args,
      maxBuffer: opts?.maxBuffer,
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
    } else if (args[0] === 'lsjson' && args.includes('--stat')) {
      return Buffer.from(JSON.stringify({ Size: lastUploadSize }));
    } else if (args[0] === 'lsjson') {
      const files = [...objects].filter((n) => !(options.hideNewFromListing && n === NEW_NAME));
      const dirs = isDrime ? options.seededDirs || [] : [];
      return Buffer.from(JSON.stringify([
        ...files.map((n) => ({ Path: n, Name: n, IsDir: false })),
        ...dirs.map((n) => ({ Path: n, Name: n, IsDir: true })),
      ]));
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
    expect(Object.getOwnPropertyNames(error).filter((n) => n !== 'markerPath').sort()).toEqual(['destinationResults', 'message', 'stack']);
    expectNoSecrets(JSON.stringify((error as { destinationResults?: unknown }).destinationResults));
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
    expect(text).toMatch(/ALERT drime prune failed for app: 3 objects over keep 10 \(delete-failed\)/);
    expect(result.destinationResults?.[0]).toMatchObject({ pruneFailed: { overKeep: 3, reason: 'delete-failed' }, removed: [] });
    expectNoSecrets(JSON.stringify(result));
  });

  it('a failed listing during prune raises the distinct alert and still succeeds', () => {
    const { cwd, outputDir, envFile } = setup();
    const rclone = makeFakeRclone({ fail: (args) => (args[0] === 'lsjson' && !args.includes('--stat') ? leakyError() : null) });
    const errors: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { errors.push(parts.join(' ')); });
    const result = runBackupJob(jobOptions(cwd, outputDir, {
      destinations: [{ type: 'drime', path: 'app', envFile }],
      runtime: makeRuntime({ commandExists: (c: string) => c === 'rclone', execFileSync: rclone.execFileSync }),
    }));
    expect(errors.join('\n')).toMatch(/ALERT drime prune failed for app: an unknown number of objects over keep 10 \(list-failed\)/);
    expect(result.destinationResults?.[0].pruneFailed).toEqual({ overKeep: null, reason: 'list-failed' });
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
  interface Raw { path: string; size?: number; head?: Buffer; dir?: boolean; modTime?: string }
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
    catFlaky?: Record<string, number>;
    catShort?: boolean;
    listFails?: boolean;
    listFlaky?: Partial<Record<'top' | 'raw' | 'crypt' | 'cryptTop' | 'stat' | 'decode', number>>;
    setNames?: Record<string, string>;
    latencyMs?: number;
    vanish?: string[];
    replace?: Record<string, Buffer>;
    rawSequence?: (listing: number) => Raw[];
    topSequence?: (listing: number) => { Path: string; IsDir: boolean }[];
  } = {}) {
    const top = options.top || [{ Path: 'backups-encrypted', IsDir: true }];
    const rawAt = (listing: number): Raw[] => (options.rawSequence ? options.rawSequence(listing) : options.raw || [{ path: 'dirx', dir: true }, { path: 'dirx/filea' }, { path: 'dirx/fileb' }]);
    const raw = rawAt(0);
    let rawListings = 0;
    let topListings = 0;
    const calls: Call[] = [];
    const gone = () => Object.assign(new Error('rclone: not found'), { status: 3, stderr: Buffer.from('directory not found') });
    const replaced = new Set<string>();
    const flakyLeft: Record<string, number> = {};
    const rawTarget = (arg: string) => arg.replace('dbbdrimebase:backups-encrypted/', '');
    const flakyUsed: Record<string, number> = {};
    const flakeOut = (kind: keyof NonNullable<typeof options.listFlaky>) => {
      if ((flakyUsed[kind] ?? 0) < (options.listFlaky?.[kind] ?? 0)) {
        flakyUsed[kind] = (flakyUsed[kind] ?? 0) + 1;
        throw failure({ stderr: 'transient' });
      }
    };
    const underSet = (listing: Raw[], dir: string) => (dir ? listing.filter((r) => r.path.startsWith(`${dir}/`)).map((r) => ({ ...r, path: r.path.slice(dir.length + 1) })) : listing);
    const execFileSync = (_c: string, args: string[], opts?: { env?: Record<string, string> }) => {
      calls.push({ args, env: opts?.env || {}, config: { exists: false, mode: 0, size: 0, file: '' } });
      const filesOnly = args.includes('--files-only');
      if (args[0] === 'lsjson' && args[1] === '--stat') {
        flakeOut('stat');
        const target = rawTarget(args[2]);
        if (!(options.replace && target in options.replace && replaced.has(target))) throw gone();
        return Buffer.from(JSON.stringify({ Path: target, Size: 100, IsDir: false }));
      }
      if (args[0] === 'lsjson' && args[1] === 'dbbdrimebase:') {
        if (options.listFails) throw failure('exit5');
        flakeOut('top');
        const listing = options.topSequence ? options.topSequence(topListings) : top;
        topListings += 1;
        return Buffer.from(JSON.stringify(listing));
      }
      if (args[0] === 'lsjson' && args.includes('--encrypted') && !args.includes('-R')) {
        flakeOut('cryptTop');
        const firsts = [...new Set(raw.map((r) => r.path.split('/')[0]))];
        return Buffer.from(JSON.stringify(firsts.map((first) => ({ Path: options.setNames?.[first] ?? `${first}-dec`, EncryptedPath: first, IsDir: true }))));
      }
      if (args[0] === 'lsjson' && args.includes('--encrypted')) {
        flakeOut('crypt');
        if (options.strict) throw failure(options.strict);
        if (options.malformedStrict) return Buffer.from('<html>');
        const set = args[args.length - 1].replace('dbbdrimecrypt:', '');
        const dir = Object.entries(options.setNames ?? {}).find(([, decrypted]) => decrypted === set)?.[0] ?? '';
        const entries = underSet(raw, dir).filter((r) => !(filesOnly && r.dir)).map((r) => ({ Path: `dec/${r.path}`, EncryptedPath: r.path, IsDir: Boolean(r.dir) }));
        return Buffer.from(JSON.stringify([...entries, ...(options.cryptDuplicates || []).map((d) => ({ Path: `dup/${d}`, EncryptedPath: d }))]));
      }
      if (args[0] === 'lsjson') {
        flakeOut('raw');
        const listing = underSet(rawAt(rawListings), args[args.length - 1].replace('dbbdrimebase:backups-encrypted', '').replace(/^\//, ''));
        rawListings += 1;
        return Buffer.from(JSON.stringify(listing.filter((r) => !(filesOnly && r.dir)).map((r) => (r.dir ? { Path: r.path, IsDir: true } : { Path: r.path, Size: r.size ?? 100, ModTime: r.modTime, IsDir: false }))));
      }
      if (args[0] === 'backend' && args[1] === 'features') {
        if (options.probe) throw failure(options.probe);
        return Buffer.from('{}');
      }
      if (args[0] === 'backend') {
        flakeOut('decode');
        const kind = (options.decodeFails || {})[args[args.length - 1]];
        if (kind) throw failure(kind);
        return Buffer.from('decoded');
      }
      if (args[0] === 'cat') {
        const target = rawTarget(args[3]);
        if ((options.vanish || []).includes(target)) throw gone();
        if (options.replace && target in options.replace) {
          if (!replaced.has(target)) {
            replaced.add(target);
            throw gone();
          }
          return options.replace[target];
        }
        if ((options.catFails || []).includes(target)) throw failure('timeout');
        if (options.catFlaky && (flakyLeft[target] ??= options.catFlaky[target] ?? 0) > 0) {
          flakyLeft[target] -= 1;
          throw failure({ stderr: 'transient' });
        }
        if (options.catShort) return Buffer.from('RCL');
        return Buffer.from(rawAt(Math.max(rawListings - 1, 0)).find((r) => r.path === target && !r.dir)?.head ?? MAGIC);
      }
      throw new Error(`unexpected ${args.join(' ')}`);
    };
    const concurrency = { active: 0, max: 0 };
    const execFile = async (command: string, args: string[], opts?: { env?: Record<string, string> }) => {
      concurrency.active += 1;
      concurrency.max = Math.max(concurrency.max, concurrency.active);
      try {
        if (options.latencyMs && args[0] === 'cat') await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
        return execFileSync(command, args, opts);
      } finally {
        concurrency.active -= 1;
      }
    };
    return { calls, execFileSync, execFile, concurrency, rawListings: () => rawListings, topListings: () => topListings };
  }

  const audit = (
    fake: Pick<ReturnType<typeof makeAuditRclone>, 'execFileSync'> & { execFile?: ReturnType<typeof makeAuditRclone>['execFile'] },
    env: Record<string, string | undefined> = {},
    limits: { concurrency?: number; maxChanged?: number } = {},
  ) => {
    const { envFile } = setup();
    return drimeAudit({ envFile, ...limits, runtime: { execFileSync: fake.execFileSync, execFile: fake.execFile, env, sleepAsync: async () => {} } });
  };
  const kinds = (report: { findings: { kind: string }[] }) => report.findings.map((f) => f.kind);

  it('a clean store has no findings and reads the first 8 bytes of every raw file only', async () => {
    const fake = makeAuditRclone();
    const report = await audit(fake, { PATH: '/usr/bin', RCLONE_CONFIG: '/evil', RCLONE_LOG_FILE: '/evil' });
    expect(report).toEqual({ objects: 2, findings: [], changedDuringAudit: [] });
    const cats = fake.calls.filter((c) => c.args[0] === 'cat');
    expect(cats.map((c) => c.args.slice(0, 3))).toEqual([['cat', '--count', '8'], ['cat', '--count', '8']]);
    expect(fake.calls.every((c) => c.env.RCLONE_CONFIG !== '/evil' && c.env.RCLONE_LOG_FILE === undefined)).toBe(true);
    expect(fake.calls.some((c) => c.args.includes('--crypt-strict-names'))).toBe(true);
  });

  it('flags anything at the raw top level other than the crypt root', async () => {
    const report = await audit(makeAuditRclone({ top: [{ Path: 'backups-encrypted', IsDir: true }, { Path: 'plaintext-folder', IsDir: true }] }));
    expect(report.findings).toEqual([{ kind: 'unexpected-top-level', path: 'drime:plaintext-folder', detail: 'not the crypt root' }]);
  });

  it('names the raw path of a file whose name does not decrypt', async () => {
    const report = await audit(makeAuditRclone({ strict: 'decrypt', decodeFails: { 'dirx/fileb': 'decrypt' } }));
    expect(report.findings.map((f) => [f.kind, f.path])).toEqual([['undecryptable', 'drime:backups-encrypted/dirx/fileb']]);
  });

  it('names an undecryptable EMPTY directory by its raw path (directories are inventoried)', async () => {
    const report = await audit(makeAuditRclone({
      raw: [{ path: 'dirx', dir: true }, { path: 'dirx/filea' }, { path: 'emptybad', dir: true }],
      strict: 'decrypt',
      decodeFails: { emptybad: 'decrypt' },
    }));
    expect(report.findings.map((f) => [f.kind, f.path])).toEqual([['undecryptable', 'drime:backups-encrypted/emptybad']]);
  });

  it('flags an empty directory the crypt listing does not know', async () => {
    const fake = makeAuditRclone({ raw: [{ path: 'dirx', dir: true }, { path: 'dirx/filea' }] });
    const original = fake.execFileSync;
    const trimmed = (c: string, a: string[], o?: { env?: Record<string, string> }) => {
      const out = original(c, a, o);
      return a.includes('--encrypted') ? Buffer.from(JSON.stringify(JSON.parse(String(out)).filter((e: { IsDir: boolean }) => !e.IsDir))) : out;
    };
    const report = await audit({ execFileSync: trimmed });
    expect(report.findings.map((f) => [f.kind, f.path])).toEqual([['undecryptable', 'drime:backups-encrypted/dirx']]);
  });

  it('flags plaintext hiding under a validly encrypted name (magic header check)', async () => {
    const report = await audit(makeAuditRclone({ raw: [{ path: 'dirx', dir: true }, { path: 'dirx/filea' }, { path: 'dirx/fileb', head: Buffer.from('SQLite f') }] }));
    expect(report.findings).toEqual([{ kind: 'not-crypt-format', path: 'drime:backups-encrypted/dirx/fileb', detail: 'missing rclone crypt header' }]);
  });

  it('flags files too small to be crypt files', async () => {
    const report = await audit(makeAuditRclone({ raw: [{ path: 'tiny', size: 5 }] }));
    expect(report.findings.map((f) => [f.kind, f.path])).toEqual([['not-crypt-format', 'drime:backups-encrypted/tiny']]);
  });

  describe('an ambiguous inventory is never clean (Drime allows duplicate names)', () => {
    it('two raw files at one path', async () => {
      const fake = makeAuditRclone({ raw: [{ path: 'dirx', dir: true }, { path: 'dirx/filea' }, { path: 'dirx/filea', head: Buffer.from('SQLite f') }] });
      const report = await audit(fake);
      expect(report.findings.map((f) => [f.kind, f.path])).toEqual([['ambiguous-path', 'drime:backups-encrypted/dirx/filea']]);
      expect(fake.calls.filter((c) => c.args[0] === 'cat')).toEqual([]);
    });

    it('a file and a directory at one path', async () => {
      const report = await audit(makeAuditRclone({ raw: [{ path: 'x', dir: true }, { path: 'x' }] }));
      expect(kinds(report)).toContain('ambiguous-path');
    });

    it('a duplicated or non-directory crypt root', async () => {
      expect(kinds(await audit(makeAuditRclone({ top: [{ Path: 'backups-encrypted', IsDir: true }, { Path: 'backups-encrypted', IsDir: true }] })))).toContain('ambiguous-path');
      const fileRoot = makeAuditRclone({ top: [{ Path: 'backups-encrypted', IsDir: false }], probe: 'isfile' });
      expect((await audit(fileRoot)).findings.map((f) => [f.kind, f.path])).toEqual([['ambiguous-path', 'drime:backups-encrypted']]);
      expect(fileRoot.calls.some((c) => c.args[0] === 'backend' && c.args[1] === 'features')).toBe(false);
    });

    it('two crypt entries mapping to one raw path', async () => {
      const report = await audit(makeAuditRclone({ cryptDuplicates: ['dirx/filea'] }));
      expect(report.findings.map((f) => [f.kind, f.path])).toEqual([['ambiguous-path', 'drime:backups-encrypted/dirx/filea']]);
    });
  });

  describe('inability to complete is an error (exit 2), not a finding', () => {
    const throwsWith = async (options: Parameters<typeof makeAuditRclone>[0], pattern: RegExp) => {
      let message = '';
      try { await audit(makeAuditRclone(options)); } catch (error) { message = (error as Error).message; }
      expect(message).toMatch(pattern);
      expectNoSecrets(message);
    };

    it('a timed-out or failing strict crypt listing', async () => {
      await throwsWith({ strict: 'timeout' }, /^strict crypt listing: rclone lsjson failed \(exit unknown\) after 3 attempt\(s\)$/);
      await throwsWith({ strict: 'exit5' }, /^strict crypt listing: rclone lsjson failed \(exit 5\) after 3 attempt\(s\)$/);
    });

    it('malformed crypt listing output', async () => {
      await throwsWith({ malformedStrict: true }, /could not parse crypt listing/);
    });

    it('a decrypt failure no name can be blamed for', async () => {
      await throwsWith({ strict: 'decrypt' }, /no undecryptable name could be identified/);
    });

    it('a name decode that fails for a non-decrypt reason', async () => {
      await throwsWith({ strict: 'decrypt', decodeFails: { 'dirx/filea': 'timeout' } }, /^decoding names: rclone backend failed \(exit unknown\) after 3 attempt\(s\)$/);
    });

    describe('header read retry', () => {
      const sleeps: number[] = [];
      const run = (options: Parameters<typeof makeAuditRclone>[0]) => {
        sleeps.length = 0;
        const fake = makeAuditRclone(options);
        const { envFile } = setup();
        const runtime = { execFileSync: fake.execFileSync, execFile: fake.execFile, env: {}, sleepAsync: async (ms: number) => { sleeps.push(ms); } };
        return { fake, report: drimeAudit({ envFile, runtime } as Parameters<typeof drimeAudit>[0]) };
      };
      const catsOf = (fake: ReturnType<typeof makeAuditRclone>, path: string) => fake.calls.filter((c) => c.args[0] === 'cat' && c.args[3].endsWith(`/${path}`));

      it('retry canary: a read that fails once then succeeds is checked and the audit is clean', async () => {
        const { fake, report } = run({ catFlaky: { 'dirx/filea': 1 } });
        const result = await report;
        expect(result.findings).toEqual([]);
        expect(catsOf(fake, 'dirx/filea')).toHaveLength(2);
        expect(sleeps).toEqual([1000]);
      });

      it('retry canary: a read that fails every attempt is exit 2 naming the path after 3 attempts', async () => {
        const { fake, report } = run({ catFlaky: { 'dirx/filea': 99 } });
        await expect(report).rejects.toThrow(/^reading object header of drime:backups-encrypted\/dirx\/filea: rclone cat failed \(exit 1\) after 3 attempt\(s\)$/);
        expect(catsOf(fake, 'dirx/filea')).toHaveLength(3);
        expect(sleeps).toEqual([1000, 3000]);
      });

      it('retry canary: a non-magic header is a finding on the first attempt, never retried', async () => {
        const { fake, report } = run({ raw: [{ path: 'dirx', dir: true }, { path: 'dirx/filea', head: Buffer.from('SQLite f') }] });
        expect((await report).findings.map((f) => f.kind)).toEqual(['not-crypt-format']);
        expect(catsOf(fake, 'dirx/filea')).toHaveLength(1);
        expect(sleeps).toEqual([]);
      });

      it('retry canary: a not-found read keeps its re-stat path and is not retried', async () => {
        const { fake, report } = run({ raw: [{ path: 'dirx', dir: true }, { path: 'dirx/filea' }], vanish: ['dirx/filea'] });
        expect((await report).changedDuringAudit).toHaveLength(1);
        expect(catsOf(fake, 'dirx/filea')).toHaveLength(1);
        expect(sleeps).toEqual([]);
      });
    });

    it('a header read that fails or returns too few bytes', async () => {
      await throwsWith({ catFails: ['dirx/filea'] }, /^reading object header of drime:backups-encrypted\/dirx\/filea: rclone cat failed \(exit unknown\) after 3 attempt\(s\)$/);
      await throwsWith({ catShort: true }, /fewer bytes than requested/);
    });

    it('the raw listing failing', async () => {
      await throwsWith({ listFails: true }, /^listing base remote: rclone lsjson failed \(exit 5\) after 3 attempt\(s\)$/);
    });
  });

  describe('credential and crypt-initialisation failures are errors, never findings (PKG-304 review 6b)', () => {
    const throwsWith = async (options: Parameters<typeof makeAuditRclone>[0], pattern: RegExp) => {
      let message = '';
      let report: unknown = null;
      try { report = await audit(makeAuditRclone(options)); } catch (error) { message = (error as Error).message; }
      expect(report).toBeNull();
      expect(message).toMatch(pattern);
    };

    it('a crypt remote that cannot initialise stops the audit before the recursive listings', async () => {
      const fake = makeAuditRclone({ probe: 'password' });
      await expect(audit(fake)).rejects.toThrow(/^initialising crypt remote: rclone backend failed \(exit 1\) after 1 attempt\(s\)$/);
      expect(fake.calls.some((c) => c.args[0] === 'lsjson' && c.args.includes('-R'))).toBe(false);
    });

    it('a "failed to decrypt password" strict listing is not a per-name violation', async () => {
      await throwsWith({ strict: 'password' }, /^strict crypt listing: rclone lsjson failed \(exit 1\) after 1 attempt\(s\)$/);
    });

    it('a "failed to decrypt password" decode is not a per-name violation', async () => {
      await throwsWith({ strict: 'decrypt', decodeFails: { 'dirx/filea': 'password' } }, /^decoding names: rclone backend failed \(exit 1\) after 1 attempt\(s\)$/);
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

    it.each(MESSAGES)('a directory named %s whose decode says "%s" is a finding', async (name, stderr) => {
      const report = await audit(makeAuditRclone({
        raw: [{ path: 'dirx', dir: true }, { path: 'dirx/filea' }, { path: name, dir: true }],
        strict: 'decrypt',
        decodeFails: { [name]: { stderr: `NOTICE: Failed to backend: command "decode" failed: ${stderr}` } },
      }));
      expect(report.findings.map((f) => [f.kind, f.path])).toEqual([['undecryptable', `drime:backups-encrypted/${name}`]]);
    });

    it('still treats the password error as an init failure, not a name error', async () => {
      const bad = { stderr: 'NOTICE: Failed to backend: failed to decrypt password: base64 decode failed when revealing password - is it obscured?' };
      await expect(audit(makeAuditRclone({ raw: [{ path: 'dirx', dir: true }], strict: 'decrypt', decodeFails: { dirx: bad } }))).rejects.toThrow(/decoding names/);
    });
  });

  describe('raw names are data, never remotes or flags (PKG-304 review 7b)', () => {
    it.each(['bad:name', '--unknown-option'])('an empty undecryptable directory named %s is a finding named by raw path', async (name) => {
      const fake = makeAuditRclone({
        raw: [{ path: 'dirx', dir: true }, { path: 'dirx/filea' }, { path: name, dir: true }],
        strict: 'decrypt',
        decodeFails: { [name]: 'decrypt' },
      });
      const report = await audit(fake);
      expect(report.findings.map((f) => [f.kind, f.path])).toEqual([['undecryptable', `drime:backups-encrypted/${name}`]]);
      const decode = fake.calls.find((c) => c.args[0] === 'backend' && c.args[1] === 'decode' && c.args.at(-1) === name)!;
      expect(decode.args).toEqual(['backend', 'decode', 'dbbdrimecrypt:', '--', name]);
    });
  });

  describe('header reads run in a bounded pool and the store may change under them (PKG-310)', () => {
    const manyFiles = (count: number): Raw[] => [{ path: 'd', dir: true }, ...Array.from({ length: count }, (_v, i) => ({ path: `d/f${i}` }))];
    const catPaths = (fake: ReturnType<typeof makeAuditRclone>) => fake.calls.filter((c) => c.args[0] === 'cat').map((c) => c.args[3].replace('dbbdrimebase:backups-encrypted/', ''));

    it('reads headers concurrently, never more than the configured bound', async () => {
      const fake = makeAuditRclone({ raw: manyFiles(60), latencyMs: 10 });
      const report = await audit(fake, {}, { concurrency: 4 });
      expect(report.findings).toEqual([]);
      expect(fake.concurrency.max).toBe(4);
    });

    it('a pool of 8 is several times faster than one at a time on a large listing', async () => {
      const timed = async (concurrency: number) => {
        const fake = makeAuditRclone({ raw: manyFiles(160), latencyMs: 10 });
        const started = Date.now();
        await audit(fake, {}, { concurrency });
        return Date.now() - started;
      };
      const serial = await timed(1);
      const pooled = await timed(8);
      console.info(`drime-audit header check, 160 objects at 10 ms each: concurrency 1 ${serial} ms, concurrency 8 ${pooled} ms (${(serial / pooled).toFixed(1)}x)`);
      expect(serial / pooled).toBeGreaterThan(3);
    });

    it('checks every listed object exactly once, so none can be reported clean unread', async () => {
      const fake = makeAuditRclone({ raw: manyFiles(75), latencyMs: 1 });
      const report = await audit(fake, {}, { concurrency: 8 });
      expect(report.objects).toBe(75);
      expect([...catPaths(fake)].sort()).toEqual(Array.from({ length: 75 }, (_v, i) => `d/f${i}`).sort());
    });

    it('a failed read among many is exit 2 naming its raw path, never a clean report', async () => {
      const fake = makeAuditRclone({ raw: manyFiles(40), latencyMs: 1, catFails: ['d/f33'] });
      const failure = await audit(fake, {}, { concurrency: 8 }).then(() => null, (error: Error) => error);
      expect(failure?.message).toBe('reading object header of drime:backups-encrypted/d/f33: rclone cat failed (exit unknown) after 3 attempt(s)');
      expectNoSecrets(failure?.message || '');
    });

    it('still catches a plaintext object among many concurrent reads', async () => {
      const raw = manyFiles(40).map((entry) => (entry.path === 'd/f27' ? { ...entry, head: Buffer.from('SQLite f') } : entry));
      const report = await audit(makeAuditRclone({ raw, latencyMs: 1 }), {}, { concurrency: 8 });
      expect(report.findings).toEqual([{ kind: 'not-crypt-format', path: 'drime:backups-encrypted/d/f27', detail: 'missing rclone crypt header' }]);
    });

    it('an object that vanishes mid-audit is recorded as changed-during-audit, not fatal and not counted as checked', async () => {
      const fake = makeAuditRclone({ raw: manyFiles(10), vanish: ['d/f4'] });
      const report = await audit(fake);
      expect(report).toEqual({ objects: 9, findings: [], changedDuringAudit: ['drime:backups-encrypted/d/f4'] });
      expect(fake.calls.some((c) => c.args[0] === 'lsjson' && c.args[1] === '--stat' && c.args[2] === 'dbbdrimebase:backups-encrypted/d/f4')).toBe(true);
    });

    it('an object replaced mid-audit is re-read once, and the new bytes are judged', async () => {
      const fake = makeAuditRclone({ raw: manyFiles(5), replace: { 'd/f2': Buffer.from('SQLite f') } });
      const report = await audit(fake);
      expect(report.changedDuringAudit).toEqual([]);
      expect(report.findings.map((f) => [f.kind, f.path])).toEqual([['not-crypt-format', 'drime:backups-encrypted/d/f2']]);
      expect(catPaths(fake).filter((p) => p === 'd/f2')).toHaveLength(2);
    });

    it('a store that changes past the bound is exit 2, not a report', async () => {
      const fake = makeAuditRclone({ raw: manyFiles(10), vanish: ['d/f1', 'd/f2', 'd/f3'] });
      await expect(audit(fake, {}, { maxChanged: 2 })).rejects.toThrow(/^store changed too much during audit \(more than 2 objects changed\)$/);
      expect((await audit(makeAuditRclone({ raw: manyFiles(10), vanish: ['d/f1', 'd/f2'] }), {}, { maxChanged: 2 })).changedDuringAudit).toHaveLength(2);
    });

    it('refuses an out-of-range concurrency before touching rclone', async () => {
      const fake = makeAuditRclone();
      await expect(audit(fake, {}, { concurrency: 0 })).rejects.toThrow(/concurrency/);
      await expect(audit(fake, {}, { concurrency: 65 })).rejects.toThrow(/concurrency/);
      expect(fake.calls).toEqual([]);
    });

    it('the CLI summary line reports the changed count and exits 0', async () => {
      const { envFile } = setup();
      const bin = installFakeRclone([
        { match: 'lsjson dbbdrimebase:', stdoutBase64: Buffer.from('[{"Path":"backups-encrypted","IsDir":true}]').toString('base64') },
        { match: 'lsjson -R dbbdrimebase:', stdoutBase64: Buffer.from('[{"Path":"gone","Size":100,"IsDir":false}]').toString('base64') },
        { match: 'lsjson -R --encrypted', stdoutBase64: Buffer.from('[{"Path":"dec","EncryptedPath":"gone","IsDir":false}]').toString('base64') },
        { match: 'cat', exit: 3, stderr: 'directory not found' },
        { match: 'lsjson --stat', exit: 3, stderr: 'directory not found' },
      ]);
      const { exitCode, out } = await cli(bin, makeTempDir(), ['drime-audit', '--env-file', envFile, '--concurrency', '2']);
      expect(exitCode).toBe(0);
      expect(out).toContain('drime-audit: clean, 0 object(s) checked, 1 changed during audit');
      expect(out).toContain('changed-during-audit: drime:backups-encrypted/gone');
    });
  });

  describe('a closing consistency pass makes only a stable, fully checked store clean (PKG-310 review)', () => {
    const base: Raw[] = [{ path: 'd', dir: true }, { path: 'd/f1', modTime: 't1' }, { path: 'd/f2', modTime: 't1' }];
    const PLAIN = Buffer.from('SQLite f');

    it('a stable store needs exactly one extra raw listing', async () => {
      const fake = makeAuditRclone({ raw: base });
      const report = await audit(fake);
      expect(report).toEqual({ objects: 2, findings: [], changedDuringAudit: [] });
      expect(fake.rawListings()).toBe(2);
      expect(fake.topListings()).toBe(2);
    });

    it('a plaintext file appearing at the top level after the first listing is a finding', async () => {
      const root = { Path: 'backups-encrypted', IsDir: true };
      const fake = makeAuditRclone({ raw: base, topSequence: (n) => (n === 0 ? [root] : [root, { Path: 'plain.db', IsDir: false }]) });
      const report = await audit(fake);
      expect(report.findings).toEqual([{ kind: 'unexpected-top-level', path: 'drime:plain.db', detail: 'not the crypt root' }]);
      expect(fake.topListings()).toBe(3);
    });

    it('a plaintext object appearing at a new path mid-audit is caught', async () => {
      const fake = makeAuditRclone({ rawSequence: (n) => (n === 0 ? base : [...base, { path: 'd/new', modTime: 't2', head: PLAIN }]) });
      const report = await audit(fake);
      expect(report.findings.map((f) => [f.kind, f.path])).toEqual([['not-crypt-format', 'drime:backups-encrypted/d/new']]);
      expect(report.objects).toBe(3);
      expect(fake.rawListings()).toBe(3);
    });

    it('a new path is also name-checked through the decode path', async () => {
      const fake = makeAuditRclone({
        rawSequence: (n) => (n === 0 ? base : [...base, { path: 'd/badname', modTime: 't2' }]),
        decodeFails: { 'd/badname': 'decrypt' },
      });
      const report = await audit(fake);
      expect(report.findings.map((f) => [f.kind, f.path])).toContainEqual(['undecryptable', 'drime:backups-encrypted/d/badname']);
    });

    it('an object replaced with plaintext after its header was read is caught', async () => {
      const fake = makeAuditRclone({
        rawSequence: (n) => (n === 0 ? base : base.map((r) => (r.path === 'd/f1' ? { ...r, modTime: 't2', head: PLAIN } : r))),
      });
      const report = await audit(fake);
      expect(report.findings.map((f) => [f.kind, f.path])).toEqual([['not-crypt-format', 'drime:backups-encrypted/d/f1']]);
    });

    it('an object removed after the first listing is counted as changed, not checked', async () => {
      const report = await audit(makeAuditRclone({ rawSequence: (n) => (n === 0 ? base : base.filter((r) => r.path !== 'd/f1')) }));
      expect(report).toEqual({ objects: 1, findings: [], changedDuringAudit: ['drime:backups-encrypted/d/f1'] });
    });

    it('a store that never stabilises is exit 2, not a report', async () => {
      const fake = makeAuditRclone({ rawSequence: (n) => [...base, { path: `d/n${n}`, modTime: `t${n}` }] });
      await expect(audit(fake, {}, { maxChanged: 100 })).rejects.toThrow(/^store changed too much during audit \(still changing after 3 re-listings\)$/);
      expect(fake.rawListings()).toBe(4);
    });
  });

  it('refuses a bad env file before touching rclone', async () => {
    const { cwd } = setup();
    const fake = makeAuditRclone();
    const envFile = writeEnvFile(cwd, { RCLONE_CONFIG_DRIME_ROOT_FOLDER_ID: '9' });
    await expect(drimeAudit({ envFile, runtime: { execFileSync: fake.execFileSync, env: {} } })).rejects.toThrow(/Drime env file/);
    expect(fake.calls).toEqual([]);
  });

  describe('listing retry', () => {
    const sleeps: number[] = [];
    const run = (options: Parameters<typeof makeAuditRclone>[0], paths?: string[]) => {
      sleeps.length = 0;
      const fake = makeAuditRclone(options);
      const { envFile } = setup();
      const runtime = { execFileSync: fake.execFileSync, execFile: fake.execFile, env: {}, sleepAsync: async (ms: number) => { sleeps.push(ms); } };
      return { fake, report: drimeAudit({ envFile, paths, runtime } as Parameters<typeof drimeAudit>[0]) };
    };
    const strictRaw: Raw[] = [{ path: 'dirx', dir: true }, { path: 'dirx/filea' }, { path: 'dirx/fileb' }];

    it.each([
      ['top', 'listing base remote', (a: string[]) => a[0] === 'lsjson' && a[1] === 'dbbdrimebase:'],
      ['raw', 'listing raw objects', (a: string[]) => a[0] === 'lsjson' && a[1] === '-R' && a[2].startsWith('dbbdrimebase:backups')],
      ['crypt', 'strict crypt listing', (a: string[]) => a.includes('--crypt-strict-names')],
    ] as const)('listing retry canary: a %s listing that fails once then succeeds is a clean audit', async (kind, _what, isThatListing) => {
      const { fake, report } = run({ listFlaky: { [kind]: 1 } });
      const result = await report;
      expect(result.findings).toEqual([]);
      expect(fake.calls.filter((c) => isThatListing(c.args)).length).toBeGreaterThanOrEqual(2);
      expect(sleeps).toEqual([1000]);
    });

    it.each([
      ['top', 'listing base remote', (a: string[]) => a[0] === 'lsjson' && a[1] === 'dbbdrimebase:'],
      ['raw', 'listing raw objects', (a: string[]) => a[0] === 'lsjson' && a[1] === '-R' && a[2].startsWith('dbbdrimebase:backups')],
      ['crypt', 'strict crypt listing', (a: string[]) => a.includes('--crypt-strict-names')],
    ] as const)('listing retry canary: a %s listing that fails every attempt is exit 2 after 3 attempts', async (kind, what, isThatListing) => {
      const { fake, report } = run({ listFlaky: { [kind]: 99 } });
      await expect(report).rejects.toThrow(new RegExp(`^${what}: rclone lsjson failed \\(exit 1\\) after 3 attempt\\(s\\)$`));
      expect(fake.calls.filter((c) => isThatListing(c.args))).toHaveLength(3);
      expect(sleeps).toEqual([1000, 3000]);
    });

    it('listing retry canary: a decode that fails once then succeeds still names the undecryptable file', async () => {
      const { report } = run({ raw: strictRaw, strict: 'decrypt', decodeFails: { 'dirx/fileb': 'decrypt' }, listFlaky: { decode: 1 } });
      expect((await report).findings.map((f) => [f.kind, f.path])).toEqual([['undecryptable', 'drime:backups-encrypted/dirx/fileb']]);
      expect(sleeps).toEqual([1000]);
    });

    it('listing retry canary: a stat that fails once then succeeds keeps the re-list path', async () => {
      const { fake, report } = run({ raw: [{ path: 'dirx', dir: true }, { path: 'dirx/filea' }], replace: { 'dirx/filea': MAGIC }, listFlaky: { stat: 1 } });
      expect((await report).findings).toEqual([]);
      expect(fake.calls.filter((c) => c.args[1] === '--stat')).toHaveLength(2);
      expect(sleeps).toEqual([1000]);
    });

    it('listing retry canary: a name that does not decrypt is deterministic and never retried', async () => {
      const { report } = run({ raw: strictRaw, strict: 'decrypt', decodeFails: { 'dirx/fileb': 'decrypt' } });
      await report;
      expect(sleeps).toEqual([]);
    });
  });

  describe('--path scope', () => {
    const raw: Raw[] = [
      { path: 'encA', dir: true }, { path: 'encA/f1' }, { path: 'encA/f2' },
      { path: 'encB', dir: true }, { path: 'encB/g1', head: Buffer.from('SQLite f') },
    ];
    const setNames = { encA: 'cairn', encB: 'savoro' };
    const scoped = (options: Parameters<typeof makeAuditRclone>[0], paths: string[]) => {
      const fake = makeAuditRclone({ raw, setNames, ...options });
      const { envFile } = setup();
      const runtime = { execFileSync: fake.execFileSync, execFile: fake.execFile, env: {}, sleepAsync: async () => {} };
      return { fake, report: drimeAudit({ envFile, paths, runtime } as Parameters<typeof drimeAudit>[0]) };
    };
    const catTargets = (fake: ReturnType<typeof makeAuditRclone>) => fake.calls.filter((c) => c.args[0] === 'cat').map((c) => c.args[3]);

    it('scope canary: --path cairn reads and lists only cairn, and a bad set elsewhere is not its verdict', async () => {
      const { fake, report } = scoped({}, ['cairn']);
      const result = await report;
      expect(result).toMatchObject({ objects: 2, findings: [], scope: ['cairn'] });
      expect(catTargets(fake).sort()).toEqual(['dbbdrimebase:backups-encrypted/encA/f1', 'dbbdrimebase:backups-encrypted/encA/f2']);
      const argv = JSON.stringify(fake.calls.map((c) => c.args));
      expect(argv).not.toContain('encB');
      expect(argv).not.toContain('savoro');
      expect(fake.calls.filter((c) => c.args.includes('-R') && !c.args.includes('--encrypted')).every((c) => c.args[2] === 'dbbdrimebase:backups-encrypted/encA')).toBe(true);
      expect(fake.calls.filter((c) => c.args.includes('--crypt-strict-names')).map((c) => c.args[c.args.length - 1])).toEqual(['dbbdrimecrypt:cairn']);
    });

    it('scope canary: without --path the same store reports the other set\'s plaintext', async () => {
      const { report } = scoped({}, []);
      const result = await report;
      expect(result.findings.map((f) => f.path)).toEqual(['drime:backups-encrypted/encB/g1']);
      expect('scope' in result).toBe(false);
    });

    it('scope canary: a plaintext file inside the chosen set is a finding', async () => {
      const { report } = scoped({}, ['savoro']);
      expect((await report).findings.map((f) => [f.kind, f.path])).toEqual([['not-crypt-format', 'drime:backups-encrypted/encB/g1']]);
    });

    it('scope canary: the top-level namespace check still runs and a plaintext top-level file is a finding', async () => {
      const top = [{ Path: 'backups-encrypted', IsDir: true }, { Path: 'notes.txt', IsDir: false }];
      const { fake, report } = scoped({ top }, ['cairn']);
      expect((await report).findings).toEqual([{ kind: 'unexpected-top-level', path: 'drime:notes.txt', detail: 'not the crypt root' }]);
      expect(fake.calls.some((c) => c.args[0] === 'lsjson' && c.args[1] === 'dbbdrimebase:')).toBe(true);
    });

    it('scope canary: an unknown set is exit 2 naming it, with no header read', async () => {
      const { fake, report } = scoped({}, ['cairn', 'nope']);
      await expect(report).rejects.toThrow(/^set nope not found in the crypt root$/);
      expect(catTargets(fake)).toEqual([]);
    });

    it.each(['', '..', '.', 'a/b', 'cairn/', '/cairn', 'a:b', 'a\\b'])('scope canary: invalid set name %j is refused before any rclone call', async (name) => {
      const { fake, report } = scoped({}, [name]);
      await expect(report).rejects.toThrow(/^Invalid --path /);
      expect(fake.calls).toEqual([]);
    });

    itOnPosix('the CLI repeats --path, names the scope in the summary and in --json', async () => {
      const b64 = (text: string) => Buffer.from(text).toString('base64');
      const rules = [
        { match: 'lsjson dbbdrimebase:', stdoutBase64: b64('[{"Path":"backups-encrypted","IsDir":true}]') },
        { match: 'lsjson --encrypted dbbdrimecrypt:', stdoutBase64: b64('[{"Path":"cairn","EncryptedPath":"encA","IsDir":true},{"Path":"savoro","EncryptedPath":"encB","IsDir":true}]') },
        { match: 'lsjson -R dbbdrimebase:backups-encrypted/encA', stdoutBase64: b64('[{"Path":"f1","Size":100,"IsDir":false}]') },
        { match: 'lsjson -R dbbdrimebase:backups-encrypted/encB', stdoutBase64: b64('[{"Path":"g1","Size":100,"IsDir":false}]') },
        { match: 'lsjson -R --encrypted --crypt-strict-names dbbdrimecrypt:cairn', stdoutBase64: b64('[{"Path":"f1","EncryptedPath":"f1","IsDir":false}]') },
        { match: 'lsjson -R --encrypted --crypt-strict-names dbbdrimecrypt:savoro', stdoutBase64: b64('[{"Path":"g1","EncryptedPath":"g1","IsDir":false}]') },
        { match: 'cat', stdoutBase64: MAGIC.toString('base64') },
      ];
      const { envFile } = setup();
      const bin = installFakeRclone(rules);
      const text = await cli(bin, makeTempDir(), ['drime-audit', '--env-file', envFile, '--path', 'cairn', '--path', 'savoro']);
      expect(text.exitCode).toBe(0);
      expect(text.out).toContain('drime-audit: clean (scope: cairn, savoro), 2 object(s) checked');
      vi.restoreAllMocks();
      const json = await cli(bin, makeTempDir(), ['drime-audit', '--env-file', envFile, '--path', 'cairn', '--json']);
      expect(JSON.parse(json.out)).toMatchObject({ status: 'clean', objects: 1, scope: ['cairn'] });
    });
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
    expect(() => runDrimeOperation(dest, rt(rclone), operation)).toThrow(/must be one of copyto, stat, list, download, deletefile, with no extra fields/);
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
      ['lsjson', 'dbbdrimecrypt:app'],
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

function makeS3Fetch(options: { failPut?: boolean } = {}) {
  const objects = new Map<string, Buffer>();
  const methods: string[] = [];
  const fetchImpl = (url: string, opts: { method: string; body?: Buffer }) => {
    methods.push(opts.method);
    const key = decodeURIComponent(new URL(url).pathname.replace(/^\/[^/]+\//, ''));
    if (opts.method === 'PUT') {
      if (options.failPut) return { status: 500, headers: {}, body: Buffer.from('InternalError') };
      const body = Buffer.from(opts.body || Buffer.alloc(0));
      objects.set(key, body);
      return { status: 200, headers: { etag: `"${crypto.createHash('md5').update(body).digest('hex')}"` }, body: Buffer.alloc(0) };
    }
    const obj = objects.get(key);
    return obj
      ? { status: 200, headers: { 'content-length': String(obj.length), etag: `"${crypto.createHash('md5').update(obj).digest('hex')}"` }, body: Buffer.alloc(0) }
      : { status: 404, headers: {}, body: Buffer.alloc(0) };
  };
  return { objects, methods, fetchImpl };
}

const S3_ENV = { AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secretsecretsecret' };

describe('prune refuses an ambiguous remote inventory (PKG-307 item 1)', () => {
  const day = (n: number) => `sqlite-backup-202607${String(n).padStart(2, '0')}-120000Z.db`;

  function runPrune(rcloneOptions: Parameters<typeof makeFakeRclone>[0], destination: Record<string, unknown>) {
    const { cwd, outputDir, envFile } = setup();
    const stampFile = path.join(cwd, '.last-success');
    const rclone = makeFakeRclone(rcloneOptions);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = runBackupJob(jobOptions(cwd, outputDir, {
      stampFile,
      destinations: [{ ...destination, ...(destination.type === 'drime' ? { envFile } : {}) }],
      runtime: makeRuntime({ commandExists: (c: string) => c === 'rclone', execFileSync: rclone.execFileSync }),
    }));
    return { rclone, result, stampFile };
  }

  it('drime: a duplicated name deletes nothing, keeps both copies, flags ambiguous-inventory, and the job still succeeds', () => {
    const { rclone, result, stampFile } = runPrune({ seeded: [day(2), day(2), day(1)] }, { type: 'drime', path: 'app', keep: 2 });
    expect(rclone.calls.some((c) => c.args[0] === 'deletefile')).toBe(false);
    expect(rclone.drimeObjects.count(day(2))).toBe(2);
    expect(rclone.drimeObjects.has(day(1))).toBe(true);
    expect(result.destinationResults?.[0]).toMatchObject({ removed: [], pruneFailed: { overKeep: null, reason: 'ambiguous-inventory' } });
    expect(fs.existsSync(stampFile)).toBe(true);
  });

  it('drime: a file and a directory at one path is ambiguous too', () => {
    const { rclone, result } = runPrune({ seeded: [day(2), day(1)], seededDirs: [day(2)] }, { type: 'drime', path: 'app', keep: 2 });
    expect(rclone.calls.some((c) => c.args[0] === 'deletefile')).toBe(false);
    expect(result.destinationResults?.[0].pruneFailed).toMatchObject({ reason: 'ambiguous-inventory' });
  });

  it('a directory named like a backup, or with a newline in its name, never takes a retention slot', () => {
    const newlineDir = `${day(7)}\njunk`;
    const { rclone, result } = runPrune(
      { seeded: [day(2), day(1)], seededDirs: [day(6), newlineDir] },
      { type: 'drime', path: 'app', keep: 2 },
    );
    expect(rclone.deleted).toEqual([day(1)]);
    expect(rclone.drimeObjects.has(day(2))).toBe(true);
    expect(result.destinationResults?.[0].pruneFailed).toBeUndefined();
  });

  it('the prune listing is read with the large output bound', () => {
    const { rclone } = runPrune({ seeded: [day(2)] }, { type: 'drime', path: 'app', keep: 2 });
    const list = rclone.calls.find((c) => c.args[0] === 'lsjson' && !c.args.includes('--stat'));
    expect(list?.maxBuffer).toBeGreaterThanOrEqual(256 * 1024 * 1024);
  });

  it('a clean inventory (a directory with a different name) still prunes', () => {
    const { rclone, result } = runPrune({ seeded: [day(3), day(2), day(1)], seededDirs: ['nested'] }, { type: 'drime', path: 'app', keep: 2 });
    expect(rclone.deleted).toEqual([day(2), day(1)]);
    expect(result.destinationResults?.[0].pruneFailed).toBeUndefined();
  });

  it('generic rclone: a duplicated name is refused the same way', () => {
    const { rclone, result } = runPrune({ seededOther: [day(2), day(2), day(1)] }, { type: 'rclone', target: 'offsite:x', keep: 2 });
    expect(rclone.calls.some((c) => c.args[0] === 'deletefile')).toBe(false);
    expect(rclone.otherObjects.count(day(2))).toBe(2);
    expect(result.destinationResults?.[0].pruneFailed).toMatchObject({ reason: 'ambiguous-inventory' });
  });
});

describe('every destination is attempted before the job fails (PKG-307 item 2)', () => {
  const OLD = ['sqlite-backup-20260701-120000Z.db', 'sqlite-backup-20260702-120000Z.db'];
  type Failed = Error & { destinationResults?: { destination: { type: string }; uploaded: unknown; uploadFailed?: boolean }[] };

  function seedLocal(outputDir: string) {
    fs.mkdirSync(outputDir, { recursive: true });
    for (const name of OLD) fs.writeFileSync(path.join(outputDir, name), 'old');
  }

  it('async: S3 fails, yet Drime and the second local copy upload, nothing is pruned, the stamp is untouched', async () => {
    const { cwd, outputDir, envFile } = setup();
    seedLocal(outputDir);
    const second = path.join(cwd, 'second');
    const stampFile = path.join(cwd, '.last-success');
    const s3 = makeS3Fetch({ failPut: true });
    const rclone = makeFakeRclone({ seeded: OLD });
    let error: Failed | null = null;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await runBackupJobAsync(jobOptions(cwd, outputDir, {
        stampFile,
        policy: { mode: 'keep-last', keepLast: 1 },
        destinations: [{ type: 'local', path: outputDir }, { type: 's3', bucket: 'b' }, { type: 'drime', path: 'app', envFile }, { type: 'local', path: second }],
        runtime: makeRuntime({ commandExists: (c: string) => c === 'rclone', execFileSync: rclone.execFileSync, fetchImpl: s3.fetchImpl, env: S3_ENV } as never),
      }));
    } catch (caught) { error = caught as Failed; }
    expect(error).toBeTruthy();
    expect(rclone.drimeObjects.has(NEW_NAME), 'drime uploaded after the S3 failure').toBe(true);
    expect(fs.existsSync(path.join(second, NEW_NAME)), 'later local copy written').toBe(true);
    expect(rclone.deleted).toEqual([]);
    for (const name of OLD) expect(fs.existsSync(path.join(outputDir, name))).toBe(true);
    expect(fs.existsSync(stampFile)).toBe(false);
    expect(error?.destinationResults?.map((r) => [r.destination.type, r.uploadFailed ?? false])).toEqual([['s3', true], ['drime', false], ['local', false]]);
  });

  it('async: Drime fails, yet S3 still uploads, and the job fails without pruning', async () => {
    const { cwd, outputDir, envFile } = setup();
    seedLocal(outputDir);
    const s3 = makeS3Fetch();
    const rclone = makeFakeRclone({ fail: (args) => (args[0] === 'copyto' ? leakyError() : null) });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      runBackupJobAsync(jobOptions(cwd, outputDir, {
        policy: { mode: 'keep-last', keepLast: 1 },
        destinations: [{ type: 'local', path: outputDir }, { type: 'drime', path: 'app', envFile }, { type: 's3', bucket: 'b', keep: 1 }],
        runtime: makeRuntime({ commandExists: (c: string) => c === 'rclone', execFileSync: rclone.execFileSync, fetchImpl: s3.fetchImpl, env: S3_ENV } as never),
      })),
    ).rejects.toThrow('rclone copyto failed (exit 1)');
    expect([...s3.objects.keys()].some((k) => k.endsWith(NEW_NAME)), 's3 uploaded after the Drime failure').toBe(true);
    expect(s3.methods).not.toContain('DELETE');
    for (const name of OLD) expect(fs.existsSync(path.join(outputDir, name))).toBe(true);
  });

  it('sync: a failing rclone destination does not stop Drime, and several failures are all named', () => {
    const { cwd, outputDir, envFile } = setup();
    const rclone = makeFakeRclone({ fail: (args) => (args[0] === 'copyto' && String(args[2]).startsWith('offsite:') ? new Error('upload exploded') : null) });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let error: Failed | null = null;
    try {
      runBackupJob(jobOptions(cwd, outputDir, {
        destinations: [{ type: 'local', path: outputDir }, { type: 'rclone', target: 'offsite:x' }, { type: 'drime', path: 'app', envFile }, { type: 'rclone', target: 'offsite:y' }],
        runtime: makeRuntime({ commandExists: (c: string) => c === 'rclone', execFileSync: rclone.execFileSync }),
      }));
    } catch (caught) { error = caught as Failed; }
    expect(rclone.drimeObjects.has(NEW_NAME)).toBe(true);
    expect(error?.message).toBe('2 destinations failed to upload: rclone:offsite:, rclone:offsite:');
    expect(error?.destinationResults?.map((r) => r.uploadFailed ?? false)).toEqual([true, false, true]);
  });
});

describe('upload failures never print error text (PKG-307 item 2)', () => {
  it('an S3 failure whose response body holds a sentinel never reaches the logs, but the thrown error is unchanged', async () => {
    const { cwd, outputDir } = setup();
    const SENTINEL = 'SENTINEL_S3_BODY_4f1c';
    const logs: string[] = [];
    for (const method of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { logs.push(parts.join(' ')); });
    }
    const fetchImpl = () => ({ status: 500, headers: {}, body: Buffer.from(SENTINEL) });
    let thrown: Error | null = null;
    try {
      await runBackupJobAsync(jobOptions(cwd, outputDir, {
        destinations: [{ type: 'local', path: outputDir }, { type: 's3', bucket: 'b' }],
        runtime: makeRuntime({ fetchImpl, env: S3_ENV } as never),
      }));
    } catch (caught) { thrown = caught as Error; }
    expect(thrown?.message, 'the caller still gets the original error').toContain(SENTINEL);
    expect(logs.join('\n')).toContain('upload to s3:b failed');
    expect(logs.join('\n')).not.toContain(SENTINEL);
  });
});

describe('backup alerts through --notify-command (PKG-307 item 3)', () => {
  function notifyFixture() {
    const { cwd, outputDir, envFile } = setup();
    useRealSqliteIfPresent(cwd);
    const sink = path.join(cwd, 'alerts.log');
    const notify = `printf '%s\\n' "$DB_BACKUP_ALERT" >> ${JSON.stringify(sink)}`;
    const alerts = () => (fs.existsSync(sink) ? fs.readFileSync(sink, 'utf8').trim().split('\n') : []);
    return { cwd, outputDir, envFile, notify, alerts };
  }
  const b64Json = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');

  itOnPosix('a failing deletefile: the backup succeeds (exit 0) and a distinct retention-failed alert is delivered', async () => {
    const { cwd, outputDir, envFile, notify, alerts } = notifyFixture();
    const seeded = Array.from({ length: 12 }, (_v, i) => `sqlite-backup-202606${String(i + 10).padStart(2, '0')}-150000Z.db`);
    const bin = installFakeRclone([
      { match: 'lsjson --stat', stdoutBase64: b64Json({ Size: fs.statSync(path.join(cwd, 'app.db')).size }) },
      { match: 'lsjson dbbdrimecrypt:', stdoutBase64: b64Json(seeded.map((n) => ({ Path: n, Name: n, IsDir: false }))) },
      { match: 'deletefile', exit: 1, stderr: `${SECRETS.token} ${SECRETS.pass}` },
    ]);
    const { out, thrown, exitCode } = await cli(bin, cwd, [...CLI_FLAGS, '--dest', 'drime:app', '--drime-env-file', envFile, '--output-dir', outputDir, '--notify-command', notify]);
    expect(thrown).toBeNull();
    expect(exitCode).toBeUndefined();
    const delivered = alerts();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('the backup succeeded but retention failed on drime:app (delete-failed)');
    expect(delivered[0]).not.toContain('FAILED');
    expectNoSecrets(out + delivered.join('\n'));
  });

  itOnPosix('a failed upload alerts a job failure with the destination label and no error text', async () => {
    const { cwd, outputDir, envFile, notify, alerts } = notifyFixture();
    const bin = installFakeRclone([{ match: 'copyto', exit: 1, stderr: `${SECRETS.token} ${SECRETS.pass}` }]);
    const { out, thrown } = await cli(bin, cwd, [...CLI_FLAGS, '--dest', 'drime:app', '--drime-env-file', envFile, '--output-dir', outputDir, '--notify-command', notify]);
    expect(thrown).toBeTruthy();
    const delivered = alerts();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toBe('🔴 db-backup FAILED: drime:app (upload failed). Nothing was pruned or stamped');
    expectNoSecrets(out + delivered.join('\n'));
  });

  itOnPosix('an over-cap backup alerts a job failure', async () => {
    const { cwd, outputDir, envFile, notify, alerts } = notifyFixture();
    const cfg = path.join(cwd, 'db-backup.config.json');
    fs.writeFileSync(cfg, JSON.stringify({ databaseUrl: 'file:./app.db', destinations: [{ type: 'drime', path: 'app', envFile, maxBytes: 3 }] }));
    const { thrown } = await cli(installFakeRclone([]), cwd, [...CLI_FLAGS, '--config', cfg, '--output-dir', outputDir, '--notify-command', notify]);
    expect(thrown).toBeTruthy();
    expect(alerts()).toEqual(['🔴 db-backup FAILED: drime:app (over its size cap). Nothing was pruned or stamped']);
  });

  itOnPosix('an ambiguous inventory raises the retention-failed alert with its reason', async () => {
    const { cwd, outputDir, envFile, notify, alerts } = notifyFixture();
    const dup = 'sqlite-backup-20260602-150000Z.db';
    const bin = installFakeRclone([
      { match: 'lsjson --stat', stdoutBase64: b64Json({ Size: fs.statSync(path.join(cwd, 'app.db')).size }) },
      { match: 'lsjson dbbdrimecrypt:', stdoutBase64: b64Json([dup, dup].map((n) => ({ Path: n, Name: n, IsDir: false }))) },
    ]);
    const { exitCode } = await cli(bin, cwd, [...CLI_FLAGS, '--dest', 'drime:app', '--drime-env-file', envFile, '--output-dir', outputDir, '--notify-command', notify]);
    expect(exitCode).toBeUndefined();
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toContain('retention failed on drime:app (ambiguous-inventory)');
  });

  itOnPosix('an unreadable --config still delivers the failure alert', async () => {
    const { cwd, outputDir, notify, alerts } = notifyFixture();
    const { thrown } = await cli(installFakeRclone([]), cwd, [...CLI_FLAGS, '--config', path.join(cwd, 'absent.json'), '--output-dir', outputDir, '--notify-command', notify]);
    expect(thrown).toBeTruthy();
    expect(alerts()).toEqual(['🔴 db-backup FAILED: the backup did not complete; see the job log']);
  });

  itOnPosix.each([
    ['inline connection string', ':drime,access_token=SENTINEL_CONN_TOKEN_5e2a:backups'],
    ['named connection string', 'offsite,access_token=SENTINEL_CONN_TOKEN_5e2a:backups'],
  ])('a refused %s target never reaches the error, --json output, logs or the alert', async (_name, target) => {
    const { cwd, outputDir, notify, alerts } = notifyFixture();
    const bin = installFakeRclone([]);
    const { out, thrown } = await cli(bin, cwd, [...CLI_FLAGS, '--remote', target, '--json', '--output-dir', outputDir, '--notify-command', notify]);
    expect(thrown?.message).toMatch(/connection-string/);
    const results = (thrown as { destinationResults?: { destination: Record<string, unknown> }[] }).destinationResults;
    expect(results?.[0].destination).toEqual({ type: 'rclone' });
    const everything = [out, String(thrown?.stack), JSON.stringify(results), ...alerts()].join('\n');
    expect(everything).not.toContain('SENTINEL_CONN_TOKEN_5e2a');
    expect(alerts()).toEqual(['🔴 db-backup FAILED: rclone:<rejected target> (upload failed). Nothing was pruned or stamped']);
  });

  itOnPosix('no sink + an invalid ambient timeout + a valid config timeout: a successful backup still exits 0', async () => {
    const { cwd, outputDir, envFile } = notifyFixture();
    const seeded = Array.from({ length: 12 }, (_v, i) => `sqlite-backup-202606${String(i + 10).padStart(2, '0')}-150000Z.db`);
    const cfg = path.join(cwd, 'db-backup.config.json');
    fs.writeFileSync(cfg, JSON.stringify({ databaseUrl: 'file:./app.db', commandTimeoutSeconds: 30, destinations: [{ type: 'drime', path: 'app', envFile }] }));
    const bin = installFakeRclone([
      { match: 'lsjson --stat', stdoutBase64: b64Json({ Size: fs.statSync(path.join(cwd, 'app.db')).size }) },
      { match: 'lsjson dbbdrimecrypt:', stdoutBase64: b64Json(seeded.map((n) => ({ Path: n, Name: n, IsDir: false }))) },
      { match: 'deletefile', exit: 1 },
    ]);
    vi.stubEnv('DB_BACKUP_COMMAND_TIMEOUT_MS', 'not-a-number');
    try {
      const { thrown, exitCode } = await cli(bin, cwd, [...CLI_FLAGS, '--config', cfg, '--output-dir', outputDir]);
      expect(thrown).toBeNull();
      expect(exitCode).toBeUndefined();
    } finally { vi.unstubAllEnvs(); }
  });

  itOnPosix('with a sink, a notifier setup failure never replaces the original error', async () => {
    const { cwd, outputDir, notify } = notifyFixture();
    const missing = path.join(cwd, 'absent.json');
    vi.stubEnv('DB_BACKUP_COMMAND_TIMEOUT_MS', 'not-a-number');
    try {
      const { out, thrown } = await cli(installFakeRclone([]), cwd, [...CLI_FLAGS, '--config', missing, '--output-dir', outputDir, '--notify-command', notify]);
      expect(thrown?.message).not.toMatch(/DB_BACKUP_COMMAND_TIMEOUT_MS/);
      expect(thrown?.message).toContain('absent.json');
      expect(out).toContain('notification skipped: could not set up the notifier');
    } finally { vi.unstubAllEnvs(); }
  });

  itOnPosix('a clean run sends nothing', async () => {
    const { cwd, outputDir, envFile, notify, alerts } = notifyFixture();
    const bin = installFakeRclone([
      { match: 'lsjson --stat', stdoutBase64: b64Json({ Size: fs.statSync(path.join(cwd, 'app.db')).size }) },
      { match: 'lsjson dbbdrimecrypt:', stdoutBase64: b64Json([]) },
    ]);
    const { thrown } = await cli(bin, cwd, [...CLI_FLAGS, '--dest', 'drime:app', '--drime-env-file', envFile, '--output-dir', outputDir, '--notify-command', notify]);
    expect(thrown).toBeNull();
    expect(alerts()).toEqual([]);
  });
});

describe('audit listings above the default exec buffer (PKG-307 item 4)', () => {
  const MIB = 1024 * 1024;

  function bigAuditRuntime(entries: number) {
    const raw = Array.from({ length: entries }, (_v, i) => ({ Path: `d/${'x'.repeat(200)}${i}`, Size: 100, IsDir: false }));
    const crypt = [{ Path: 'dec/d', EncryptedPath: 'd', IsDir: true }, ...raw.map((entry) => ({ Path: `dec/${entry.Path}`, EncryptedPath: entry.Path, IsDir: false }))];
    const execFileSync = (_c: string, args: string[], opts?: { maxBuffer?: number }) => {
      let out: Buffer;
      if (args[0] === 'lsjson' && args[1] === 'dbbdrimebase:') out = Buffer.from(JSON.stringify([{ Path: 'backups-encrypted', IsDir: true }]));
      else if (args[0] === 'lsjson' && args.includes('--encrypted')) out = Buffer.from(JSON.stringify(crypt));
      else if (args[0] === 'lsjson') out = Buffer.from(JSON.stringify([{ Path: 'd', IsDir: true }, ...raw]));
      else if (args[0] === 'cat') out = Buffer.from(MAGIC);
      else out = Buffer.from('{}');
      if (out.length > (opts?.maxBuffer ?? MIB)) throw Object.assign(new Error('spawnSync rclone ENOBUFS'), { code: 'ENOBUFS', status: null });
      return out;
    };
    return { runtime: { execFileSync, env: {} as Record<string, string | undefined> } };
  }

  it('audits completely a store whose recursive listing is over 1 MiB', async () => {
    const { runtime } = bigAuditRuntime(6000);
    const { envFile } = setup();
    const report = await drimeAudit({ envFile, runtime });
    expect(report.objects).toBe(6000);
    expect(report.findings).toEqual([]);
  });

  it('a listing past the bound is "cannot audit" (exit 2), never a truncated parse', async () => {
    const { cwd, envFile } = setup();
    const out: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...p: unknown[]) => { out.push(p.join(' ')); });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    const overflow = (_c: string, args: string[]) => {
      if (args[0] === 'lsjson' && args[1] === 'dbbdrimebase:') return Buffer.from('[{"Path":"backups-encrypted","IsDir":true}]');
      if (args[0] === 'backend') return Buffer.from('{}');
      throw Object.assign(new Error('spawnSync rclone ENOBUFS'), { code: 'ENOBUFS', status: null });
    };
    await expect(drimeAudit({ envFile, runtime: { execFileSync: overflow, env: {} } })).rejects.toThrow(/output exceeded the \d+-byte listing limit/);
    void out;
  });
});

describe('fetch from Drime (PKG-319)', () => {
  const { fetchFromDrime } = dbBackup;
  const OLD = 'sqlite-backup-20260701-030000Z.db.gz';
  const MID = 'sqlite-backup-20260705-030000Z.db.gz';
  const NEWEST = 'sqlite-backup-20260709-030000Z.db.gz';
  const BYTES = Buffer.from('decrypted backup bytes');

  interface Listed { Path: string; IsDir?: boolean; Size?: number }
  const listed = (name: string, size = BYTES.length): Listed => ({ Path: name, IsDir: false, Size: size });

  // In-process fake: listings answer execFileSync, downloads answer execFile
  // (the async path) and write `written` bytes to the local destination.
  function makeFetchRclone(options: { listing: Listed[]; written?: Buffer; failListing?: number; failDownload?: number; leak?: boolean }) {
    const calls: string[][] = [];
    let listingFailures = options.failListing ?? 0;
    let downloadFailures = options.failDownload ?? 0;
    const failure = () => (options.leak ? leakyError(5) : Object.assign(new Error('boom'), { status: 5, stderr: '' }));
    const execFileSync = (_c: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'lsjson') {
        if (listingFailures > 0) { listingFailures -= 1; throw failure(); }
        return Buffer.from(JSON.stringify(options.listing.map((entry) => ({ IsDir: false, ...entry }))));
      }
      throw new Error('unexpected sync rclone call');
    };
    const execFile = async (_c: string, args: string[]) => {
      calls.push(args);
      if (args[0] !== 'copyto') throw new Error('unexpected async rclone call');
      if (downloadFailures > 0) { downloadFailures -= 1; throw failure(); }
      fs.writeFileSync(args[2], options.written ?? BYTES);
      return Buffer.from('');
    };
    const sleeps: number[] = [];
    const runtime = { execFileSync, execFile, env: {}, sleepAsync: async (ms: number) => { sleeps.push(ms); } } as unknown as Parameters<typeof fetchFromDrime>[0]['runtime'];
    return { calls, runtime, sleeps, downloads: () => calls.filter((a) => a[0] === 'copyto') };
  }

  function fetchSetup() {
    const { cwd, envFile } = setup();
    return { envFile, outputDir: path.join(cwd, 'out', 'drill') };
  }

  it('--latest canary: picks the newest by filename timestamp, not listing order', async () => {
    const { envFile, outputDir } = fetchSetup();
    const fake = makeFetchRclone({ listing: [listed(MID), listed(NEWEST), listed(OLD), listed('notes.txt'), listed('sqlite-backup-20260801-030000Z.sql')] });
    const result = await fetchFromDrime({ set: 'app', latest: true, outputDir, envFile, runtime: fake.runtime });
    expect(result).toMatchObject({ file: NEWEST, size: BYTES.length, set: 'app' });
    expect(fake.downloads()[0].slice(1)).toEqual([`dbbdrimecrypt:app/${NEWEST}`, path.join(fs.realpathSync(outputDir), NEWEST)]);
    expect(fs.readFileSync(result.path)).toEqual(BYTES);
    expect(fs.statSync(outputDir).mode & 0o777).toBe(0o700);
  });

  it('--latest canary: the -N sequence breaks a timestamp tie, and two files sharing both refuse', async () => {
    const { envFile, outputDir } = fetchSetup();
    const seq = makeFetchRclone({ listing: [listed('sqlite-backup-20260709-030000Z-2.db.gz'), listed(NEWEST)] });
    expect((await fetchFromDrime({ set: 'app', latest: true, outputDir, envFile, runtime: seq.runtime })).file).toBe('sqlite-backup-20260709-030000Z-2.db.gz');
    const tie = makeFetchRclone({ listing: [listed(NEWEST), listed('sqlite-backup-20260709-030000Z.db')] });
    await expect(fetchFromDrime({ set: 'app', latest: true, outputDir: `${outputDir}-tie`, envFile, runtime: tie.runtime })).rejects.toThrow(/ambiguous/);
    expect(tie.downloads()).toHaveLength(0);
  });

  it('--latest honours --name-prefix and fails when nothing parses', async () => {
    const { envFile, outputDir } = fetchSetup();
    const fake = makeFetchRclone({ listing: [listed('myapp-20260709-030000Z.db.gz'), listed(NEWEST)] });
    expect((await fetchFromDrime({ set: 'app', latest: true, namePrefix: 'myapp', outputDir, envFile, runtime: fake.runtime })).file).toBe('myapp-20260709-030000Z.db.gz');
    const none = makeFetchRclone({ listing: [listed('notes.txt')] });
    await expect(fetchFromDrime({ set: 'app', latest: true, outputDir: `${outputDir}-b`, envFile, runtime: none.runtime })).rejects.toThrow('The Drime set has no backup to fetch');
  });

  describe('names are validated before any rclone call', () => {
    it.each([
      ['file with ..', { file: '..' }],
      ['file with ../x', { file: '../x.db' }],
      ['file with /', { file: 'a/b.db' }],
      ['file with :', { file: 'drime:x.db' }],
      ['file with a backslash', { file: 'a\\b.db' }],
      ['set with ..', { set: 'a/../b' }],
      ['set with a leading /', { set: '/etc' }],
      ['set with :', { set: 'drime:x' }],
    ])('canary: %s is refused', async (_label, override) => {
      const { envFile, outputDir } = fetchSetup();
      const fake = makeFetchRclone({ listing: [listed(MID)] });
      await expect(fetchFromDrime({ set: 'app', file: MID, outputDir, envFile, runtime: fake.runtime, ...override })).rejects.toThrow();
      expect(fake.calls).toHaveLength(0);
      expect(fs.existsSync(outputDir)).toBe(false);
    });

    it('canary: the download op itself refuses a traversing remoteRel and a relative localPath', () => {
      const { buildRcloneArgs } = require('../drime.js') as { buildRcloneArgs: (op: unknown, target: string) => string[] };
      for (const remoteRel of ['..', '../x', 'a/b', 'a:b']) {
        expect(() => buildRcloneArgs({ op: 'download', localPath: '/tmp/out/x', remoteRel }, 'dbbdrimecrypt:app')).toThrow();
      }
      expect(() => buildRcloneArgs({ op: 'download', localPath: 'out/x', remoteRel: 'x.db' }, 'dbbdrimecrypt:app')).toThrow('absolute localPath');
      expect(() => buildRcloneArgs({ op: 'download', localPath: '/tmp/out/x', remoteRel: 'x.db', flags: ['--x'] }, 'dbbdrimecrypt:app')).toThrow(/no extra fields/);
      expect(buildRcloneArgs({ op: 'download', localPath: '/tmp/out/x.db', remoteRel: 'x.db' }, 'dbbdrimecrypt:app')).toEqual(['copyto', 'dbbdrimecrypt:app/x.db', '/tmp/out/x.db']);
    });
  });

  it('size-mismatch canary: a short download is deleted and the fetch fails', async () => {
    const { envFile, outputDir } = fetchSetup();
    const fake = makeFetchRclone({ listing: [listed(MID)], written: BYTES.subarray(0, 5) });
    await expect(fetchFromDrime({ set: 'app', file: MID, outputDir, envFile, runtime: fake.runtime })).rejects.toThrow('Downloaded size does not match the Drime listing');
    expect(fs.existsSync(path.join(outputDir, MID))).toBe(false);
  });

  describe('an ambiguous listing refuses', () => {
    it.each([
      ['a duplicated name', [listed(NEWEST), listed(NEWEST), listed(MID)]],
      ['a file and a directory with one name', [listed(NEWEST), { Path: NEWEST, IsDir: true }]],
    ])('canary: %s means no fetch', async (_label, listing) => {
      const { envFile, outputDir } = fetchSetup();
      for (const pick of [{ latest: true }, { file: MID }]) {
        const fake = makeFetchRclone({ listing });
        await expect(fetchFromDrime({ set: 'app', outputDir, envFile, runtime: fake.runtime, ...pick })).rejects.toThrow(/ambiguous/);
        expect(fake.downloads()).toHaveLength(0);
      }
    });
  });

  describe('the download cannot target outside --output', () => {
    itOnPosix('canary: a symlink planted at the destination is not written through', async () => {
      const { envFile, outputDir } = fetchSetup();
      const victim = path.join(makeTempDir(), 'victim');
      fs.writeFileSync(victim, 'keep');
      fs.mkdirSync(outputDir, { recursive: true });
      fs.symlinkSync(victim, path.join(outputDir, MID));
      const fake = makeFetchRclone({ listing: [listed(MID)] });
      await expect(fetchFromDrime({ set: 'app', file: MID, outputDir, envFile, runtime: fake.runtime })).rejects.toThrow('Refusing to overwrite');
      expect(fake.downloads()).toHaveLength(0);
      expect(fs.readFileSync(victim, 'utf8')).toBe('keep');
    });

    it('canary: a listed name that would escape --output is refused before the download', async () => {
      const { envFile, outputDir } = fetchSetup();
      const fake = makeFetchRclone({ listing: [listed('../escape.db')] });
      const drime = require('../drime.js') as { drimeFetch: (o: Record<string, unknown>) => Promise<unknown> };
      await expect(
        drime.drimeFetch({ set: 'app', latest: true, outputDir, envFile, runtime: fake.runtime, pickLatest: (names: string[]) => names[0] }),
      ).rejects.toThrow('A drime download needs a plain file name');
      expect(fake.downloads()).toHaveLength(0);
      expect(fs.existsSync(path.join(path.dirname(outputDir), 'escape.db'))).toBe(false);
    });

    it('canary: an existing file is never overwritten', async () => {
      const { envFile, outputDir } = fetchSetup();
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, MID), 'old');
      const fake = makeFetchRclone({ listing: [listed(MID)] });
      await expect(fetchFromDrime({ set: 'app', file: MID, outputDir, envFile, runtime: fake.runtime })).rejects.toThrow('Refusing to overwrite');
      expect(fs.readFileSync(path.join(outputDir, MID), 'utf8')).toBe('old');
    });
  });

  describe('retry', () => {
    it('canary: a listing and a download that fail once each still succeed, with the audit backoff', async () => {
      const { envFile, outputDir } = fetchSetup();
      const fake = makeFetchRclone({ listing: [listed(MID)], failListing: 1, failDownload: 1 });
      await fetchFromDrime({ set: 'app', file: MID, outputDir, envFile, runtime: fake.runtime });
      expect(fake.sleeps).toEqual([1000, 1000]);
      expect(fake.downloads()).toHaveLength(2);
    });

    it('canary: a download that always fails is a fixed-string error after 3 attempts and leaves no file', async () => {
      const { envFile, outputDir } = fetchSetup();
      const fake = makeFetchRclone({ listing: [listed(MID)], failDownload: 99, leak: true });
      await expect(fetchFromDrime({ set: 'app', file: MID, outputDir, envFile, runtime: fake.runtime })).rejects.toThrow(
        'downloading file: rclone copyto failed (exit 5) after 3 attempt(s)',
      );
      expect(fake.sleeps).toEqual([1000, 3000]);
      expect(fs.existsSync(path.join(outputDir, MID))).toBe(false);
    });
  });

  it('canary: no secret appears in an error from a failing rclone', async () => {
    const { envFile, outputDir } = fetchSetup();
    const fake = makeFetchRclone({ listing: [listed(MID)], failListing: 99, leak: true });
    const error = await fetchFromDrime({ set: 'app', latest: true, outputDir, envFile, runtime: fake.runtime }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expectNoSecrets(`${(error as Error).message}\n${(error as Error).stack}\n${JSON.stringify(error)}`);
  });

  describe('through the CLI with a real rclone-shaped subprocess', () => {
    function installFetchRclone(listing: unknown[], mode: 'ok' | 'fail' = 'ok') {
      const dir = makeTempDir();
      fs.writeFileSync(path.join(dir, 'rclone'), [
        `#!${process.execPath}`,
        "const fs = require('fs');",
        'const args = process.argv.slice(2);',
        `if (${JSON.stringify(mode)} === 'fail') { process.stderr.write(${JSON.stringify(`token=${SECRETS.token} pass=${SECRETS.pass}`)}); process.exit(5); }`,
        `if (args[0] === 'lsjson') { process.stdout.write(${JSON.stringify(JSON.stringify(listing))}); process.exit(0); }`,
        `if (args[0] === 'copyto') { fs.writeFileSync(args[2], ${JSON.stringify(BYTES.toString())}); process.stderr.write('progress token=${SECRETS.token}'); process.exit(0); }`,
        'process.exit(9);',
      ].join('\n'), { mode: 0o755 });
      return dir;
    }
    const entries = [{ Path: OLD, Size: BYTES.length, IsDir: false }, { Path: NEWEST, Size: BYTES.length, IsDir: false }];

    itOnPosix('canary: stdout carries exactly the fetched path, alone on its line', async () => {
      const { cwd, envFile } = setup();
      const outputDir = path.join(cwd, 'drill');
      const result = await cli(installFetchRclone(entries), cwd, ['fetch', '--from', 'drime:app', '--latest', '--output', outputDir, '--drime-env-file', envFile]);
      expect(result.thrown).toBeNull();
      expect(result.out).toBe(path.join(fs.realpathSync(outputDir), NEWEST));
      expect(fs.readFileSync(result.out, 'utf8')).toBe(BYTES.toString());
      expectNoSecrets(result.out);
    });

    itOnPosix('--json prints {file, size, set} and --file fetches that object', async () => {
      const { cwd, envFile } = setup();
      const result = await cli(installFetchRclone(entries), cwd, ['fetch', '--from', 'drime:app', '--file', OLD, '--output', path.join(cwd, 'd'), '--drime-env-file', envFile, '--json']);
      expect(JSON.parse(result.out)).toEqual({ file: OLD, size: BYTES.length, set: 'app' });
    });

    itOnPosix('canary: a failing rclone exits non-zero through the CLI path and prints no secret', async () => {
      const { cwd, envFile } = setup();
      const result = await cli(installFetchRclone([], 'fail'), cwd, ['fetch', '--from', 'drime:app', '--latest', '--output', path.join(cwd, 'd'), '--drime-env-file', envFile]);
      expect(result.thrown).toBeInstanceOf(Error);
      expectNoSecrets(`${result.out}\n${result.thrown?.message}\n${String(result.thrown?.stderr ?? '')}`);
    }, 20000);

    itOnPosix('needs --from drime:<set> and exactly one of --latest or --file', async () => {
      const { cwd, envFile } = setup();
      const bin = installFetchRclone(entries);
      const base = ['fetch', '--output', path.join(cwd, 'd'), '--drime-env-file', envFile];
      expect((await cli(bin, cwd, [...base, '--latest'])).thrown?.message).toBe('fetch needs --from drime:<set>');
      expect((await cli(bin, cwd, [...base, '--from', 'drime:app'])).thrown?.message).toBe('fetch needs exactly one of --latest or --file');
    });
  });
});
