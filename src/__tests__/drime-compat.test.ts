// Compatibility contract for the Drime destination (PKG-336 slice 1). These pin
// today's public Drime behaviour with explicit, snapshot-free assertions so the
// encrypted-rclone / backend-registry refactor can prove it changed nothing.
// Behaviour already pinned with exact assertions in drime.test.ts is not repeated.
import fs from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dbBackup, fixedNow, makeTempDir, makeRuntime, cleanupTempDirs } from './helpers';

const itOnPosix = process.platform === 'win32' ? it.skip : it;

const { runBackupJob, runCli, normalizeDestination } = dbBackup;

afterEach(() => {
  cleanupTempDirs();
  vi.restoreAllMocks();
});

// Every value differs, so a crossed base/crypt, password/password2 or
// default/custom mapping changes an asserted string.
const DEFAULT_SECTION = { token: 'COMPAT_DEFAULT_TOKEN_a1', pass: 'COMPAT_DEFAULT_PASS_b2', pass2: 'COMPAT_DEFAULT_PASS2_c3', root: 'backups-encrypted' };
const CUSTOM_SECTION = { token: 'COMPAT_CUSTOM_TOKEN_d4', pass: 'COMPAT_CUSTOM_PASS_e5', pass2: 'COMPAT_CUSTOM_PASS2_f6', root: 'custom-root' };

function sectionLines(base: string, crypt: string, section: typeof DEFAULT_SECTION): string[] {
  const b = `RCLONE_CONFIG_${base.toUpperCase()}_`;
  const c = `RCLONE_CONFIG_${crypt.toUpperCase()}_`;
  return [
    `${b}TYPE=drime`,
    `${b}ACCESS_TOKEN=${section.token}`,
    `${c}TYPE=crypt`,
    `${c}REMOTE=${base}:${section.root}`,
    `${c}FILENAME_ENCRYPTION=standard`,
    `${c}DIRECTORY_NAME_ENCRYPTION=true`,
    `${c}PASSWORD=${section.pass}`,
    `${c}PASSWORD2=${section.pass2}`,
  ];
}

function setup() {
  const cwd = makeTempDir();
  const outputDir = path.join(cwd, 'backups');
  fs.writeFileSync(path.join(cwd, 'app.db'), 'database bytes');
  const envFile = path.join(cwd, 'drime.env');
  fs.writeFileSync(envFile, [...sectionLines('drime', 'drimecrypt', DEFAULT_SECTION), ...sectionLines('mybase', 'mycrypt', CUSTOM_SECTION)].join('\n') + '\n', { mode: 0o600 });
  return { cwd, outputDir, envFile };
}

const ARTIFACT_BYTES = 14;
const NEW_NAME = 'sqlite-backup-20260705-150000Z.db';
const SEEDED = Array.from({ length: 12 }, (_v, i) => `sqlite-backup-202606${String(i + 10).padStart(2, '0')}-150000Z.db`);
// keep 10 over 12 seeded + the new object: the 3 oldest go, reported newest-first.
const DOOMED_NEWEST_FIRST = SEEDED.slice(0, 3).reverse();

function defaultDestination(envFile: string, overrides: Record<string, unknown> = {}) {
  return { type: 'drime', path: 'app', envFile, baseRemote: 'drime', cryptRemote: 'drimecrypt', keep: 10, maxBytes: 5_000_000_000, target: 'drimecrypt:app', ...overrides };
}

interface Call { args: string[]; env: Record<string, string> }

function leakyError() {
  const stderr = `Failed: token=${DEFAULT_SECTION.token} pass=${DEFAULT_SECTION.pass}`;
  return Object.assign(new Error(`Command failed: rclone ${stderr}`), { status: 1, stderr: Buffer.from(stderr) });
}

// In-process fake rclone: copyto/stat/list/deletefile against one object bag.
function fakeRclone(options: { seeded?: string[]; statBody?: string; fail?: (args: string[]) => Error | null } = {}) {
  const objects = [...(options.seeded ?? [])];
  const deleted: string[] = [];
  const calls: Call[] = [];
  let lastUploadSize = 0;
  const execFileSync = (_command: string, args: string[], opts?: { env?: Record<string, string> }) => {
    calls.push({ args, env: opts?.env ?? {} });
    const failure = options.fail?.(args);
    if (failure) throw failure;
    if (args[0] === 'copyto') {
      objects.push(String(args[2]).split('/').pop()!);
      lastUploadSize = fs.statSync(args[1]).size;
    } else if (args[0] === 'lsjson' && args.includes('--stat')) {
      return Buffer.from(options.statBody ?? JSON.stringify({ Size: lastUploadSize }));
    } else if (args[0] === 'lsjson') {
      return Buffer.from(JSON.stringify(objects.map((n) => ({ Path: n, Name: n, IsDir: false }))));
    } else if (args[0] === 'deletefile') {
      const name = String(args[1]).split('/').pop()!;
      deleted.push(name);
      objects.splice(objects.indexOf(name), 1);
    }
    return Buffer.from('');
  };
  return { objects, deleted, calls, execFileSync };
}

function captureConsole() {
  const lines: Record<'log' | 'warn' | 'error', string[]> = { log: [], warn: [], error: [] };
  for (const method of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { lines[method].push(parts.join(' ')); });
  }
  return lines;
}

function backupOnce(destinations: Record<string, unknown>[], rclone: ReturnType<typeof fakeRclone>, cwd: string, outputDir: string) {
  return runBackupJob({
    allowUnsafeCopy: true,
    cwd,
    databaseUrl: 'file:./app.db',
    compressSqlite: false,
    now: fixedNow,
    outputDir,
    destinations,
    runtime: makeRuntime({ commandExists: (c: string) => c === 'rclone', execFileSync: rclone.execFileSync }),
  } as never);
}

type Failed = Error & { destinationResults?: unknown[] };

function backupFailure(destinations: Record<string, unknown>[], rclone: ReturnType<typeof fakeRclone>, cwd: string, outputDir: string): Failed {
  try {
    backupOnce(destinations, rclone, cwd, outputDir);
  } catch (error) {
    return error as Failed;
  }
  throw new Error('expected the backup to fail');
}

function failedMarker(outputDir: string) {
  const marker = fs.readdirSync(outputDir).find((f) => f.endsWith('.failed'))!;
  return JSON.parse(fs.readFileSync(path.join(outputDir, marker), 'utf8')) as Record<string, unknown>;
}

const MARKER_TIMES = { startedAt: fixedNow.toISOString(), failedAt: fixedNow.toISOString() };

// Rclone-shaped subprocess on PATH, for runCli.
function installFakeRclone(rules: unknown[]) {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'rclone'), [
    `#!${process.execPath}`,
    "const fs = require('fs'); const path = require('path');",
    'const args = process.argv.slice(2);',
    "const rules = JSON.parse(fs.readFileSync(path.join(__dirname, 'rules.json'), 'utf8'));",
    "const rule = rules.find((r) => args.join(' ').startsWith(r.match));",
    'if (rule && rule.stderr) process.stderr.write(rule.stderr);',
    "if (rule && rule.stdoutBase64) process.stdout.write(Buffer.from(rule.stdoutBase64, 'base64'));",
    'process.exit(rule && rule.exit ? rule.exit : 0);',
  ].join('\n'), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify(rules));
  return dir;
}

const b64 = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64');

async function cli(binDir: string, cwd: string, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  vi.spyOn(console, 'log').mockImplementation((...p: unknown[]) => { out.push(p.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...p: unknown[]) => { err.push(p.join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation((...p: unknown[]) => { err.push(p.join(' ')); });
  vi.stubEnv('DATABASE_URL', 'file:./app.db');
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  const previousExit = process.exitCode;
  process.exitCode = undefined;
  let thrown: Error | null = null;
  try { await runCli(argv); } catch (error) { thrown = error as Error; } finally { process.env.PATH = previousPath; }
  const exitCode = process.exitCode as number | undefined;
  process.exitCode = previousExit;
  return { stdout: out.join('\n'), stderr: err.join('\n'), thrown, exitCode };
}

// The CLI path runs the real sqlite3 snapshot, so the artifact is the size of a real (empty-table) database.
function setupForCli() {
  const fixture = setup();
  const dbPath = path.join(fixture.cwd, 'app.db');
  fs.rmSync(dbPath);
  try {
    execFileSync('sqlite3', [dbPath, 'create table t(x);'], { stdio: 'ignore' });
  } catch {
    fs.writeFileSync(dbPath, 'database bytes');
  }
  return { ...fixture, dbSize: fs.statSync(dbPath).size };
}

const BACKUP_FLAGS = ['backup', '--allow-unsafe-copy', '--no-compress'];

describe('drime compat: normalizeDestination', () => {
  it('default options: the full output object', () => {
    const cwd = makeTempDir();
    expect(normalizeDestination({ type: 'drime', path: 'app' } as never, cwd)).toEqual({
      type: 'drime',
      path: 'app',
      envFile: '/etc/db-backup/drime.env',
      baseRemote: 'drime',
      cryptRemote: 'drimecrypt',
      keep: 10,
      maxBytes: 5_000_000_000,
      target: 'drimecrypt:app',
    });
  });

  it('custom options: the full output object, relative envFile resolved against cwd, path trailing slash stripped', () => {
    const cwd = makeTempDir();
    expect(normalizeDestination({ type: 'drime', path: 'nested/set/', baseRemote: 'mybase', cryptRemote: 'mycrypt', envFile: 'conf/my.env', keep: 3, maxBytes: 1234 } as never, cwd)).toEqual({
      type: 'drime',
      path: 'nested/set',
      envFile: path.resolve(cwd, 'conf/my.env'),
      baseRemote: 'mybase',
      cryptRemote: 'mycrypt',
      keep: 3,
      maxBytes: 1234,
      target: 'mycrypt:nested/set',
    });
  });

  it('null keep/maxBytes fall back to the defaults and unknown fields are dropped', () => {
    const cwd = makeTempDir();
    expect(normalizeDestination({ type: 'drime', path: 'app', keep: null, maxBytes: null, verify: false, prune: false, bucket: 'x' } as never, cwd)).toEqual({
      type: 'drime',
      path: 'app',
      envFile: '/etc/db-backup/drime.env',
      baseRemote: 'drime',
      cryptRemote: 'drimecrypt',
      keep: 10,
      maxBytes: 5_000_000_000,
      target: 'drimecrypt:app',
    });
  });
});

describe('drime compat: backup run results', () => {
  it('success: exact destinationResults entry, target strings, back-compat singular fields, and the 3 oldest pruned (newest of them first)', () => {
    const { cwd, outputDir, envFile } = setup();
    const rclone = fakeRclone({ seeded: SEEDED });
    const result = backupOnce([{ type: 'drime', path: 'app', envFile }], rclone, cwd, outputDir);
    const uploaded = { target: `drimecrypt:app/${NEW_NAME}`, sizeBytes: ARTIFACT_BYTES };
    expect(result.destinationResults).toEqual([
      { destination: defaultDestination(envFile), uploaded, outcome: { status: 'uploaded', size: ARTIFACT_BYTES }, removed: DOOMED_NEWEST_FIRST },
    ]);
    expect(result.uploaded).toEqual(uploaded);
    expect(result.removedRemote).toEqual(DOOMED_NEWEST_FIRST);
    expect(rclone.deleted).toEqual(DOOMED_NEWEST_FIRST);
    expect(rclone.objects).toHaveLength(10);
  });

  it('the rclone calls of a success, in order, address only the private crypt remote', () => {
    const { cwd, outputDir, envFile } = setup();
    const rclone = fakeRclone({ seeded: SEEDED.slice(0, 2) });
    backupOnce([{ type: 'drime', path: 'app', envFile }], rclone, cwd, outputDir);
    expect(rclone.calls.map((c) => c.args)).toEqual([
      ['copyto', path.resolve(outputDir, NEW_NAME), `dbbdrimecrypt:app/${NEW_NAME}`],
      ['lsjson', '--stat', `dbbdrimecrypt:app/${NEW_NAME}`],
      ['lsjson', 'dbbdrimecrypt:app'],
    ]);
  });

  it('default remotes map base token, crypt passwords and root from the default sections, never the custom ones', () => {
    const { cwd, outputDir, envFile } = setup();
    const rclone = fakeRclone();
    backupOnce([{ type: 'drime', path: 'app', envFile }], rclone, cwd, outputDir);
    for (const { env } of rclone.calls) {
      expect(env.RCLONE_CONFIG_DBBDRIMEBASE_ACCESS_TOKEN).toBe(DEFAULT_SECTION.token);
      expect(env.RCLONE_CONFIG_DBBDRIMECRYPT_PASSWORD).toBe(DEFAULT_SECTION.pass);
      expect(env.RCLONE_CONFIG_DBBDRIMECRYPT_PASSWORD2).toBe(DEFAULT_SECTION.pass2);
      expect(env.RCLONE_CONFIG_DBBDRIMECRYPT_REMOTE).toBe('dbbdrimebase:backups-encrypted');
    }
  });

  it('custom baseRemote/cryptRemote/keep/maxBytes: target, results and credentials come from the custom sections', () => {
    const { cwd, outputDir, envFile } = setup();
    const rclone = fakeRclone({ seeded: SEEDED.slice(0, 3) });
    const destination = { type: 'drime', path: 'nested/set', envFile, baseRemote: 'mybase', cryptRemote: 'mycrypt', keep: 2, maxBytes: 1000 };
    const result = backupOnce([destination], rclone, cwd, outputDir);
    expect(result.destinationResults).toEqual([
      {
        destination: { ...destination, target: 'mycrypt:nested/set' },
        uploaded: { target: `mycrypt:nested/set/${NEW_NAME}`, sizeBytes: ARTIFACT_BYTES },
        outcome: { status: 'uploaded', size: ARTIFACT_BYTES },
        removed: SEEDED.slice(0, 2).reverse(),
      },
    ]);
    for (const { env, args } of rclone.calls) {
      expect(env.RCLONE_CONFIG_DBBDRIMEBASE_ACCESS_TOKEN).toBe(CUSTOM_SECTION.token);
      expect(env.RCLONE_CONFIG_DBBDRIMECRYPT_PASSWORD).toBe(CUSTOM_SECTION.pass);
      expect(env.RCLONE_CONFIG_DBBDRIMECRYPT_PASSWORD2).toBe(CUSTOM_SECTION.pass2);
      expect(env.RCLONE_CONFIG_DBBDRIMECRYPT_REMOTE).toBe('dbbdrimebase:custom-root');
      expect(args.join(' ')).toContain('dbbdrimecrypt:nested/set');
    }
  });

  it('upload verification failure (size mismatch): exact entry, error, marker, log line, and nothing pruned', () => {
    const { cwd, outputDir, envFile } = setup();
    const logs = captureConsole();
    const rclone = fakeRclone({ seeded: SEEDED, statBody: JSON.stringify({ Size: 3 }) });
    const error = backupFailure([{ type: 'drime', path: 'app', envFile }], rclone, cwd, outputDir);
    const message = `Remote size mismatch for drimecrypt:app/${NEW_NAME}: local=14 remote=3; refusing to prune or stamp`;
    expect(error.message).toBe(message);
    expect(error.destinationResults).toEqual([{ destination: defaultDestination(envFile), uploaded: null, uploadFailed: true, removed: [] }]);
    expect(failedMarker(outputDir)).toEqual({ ...MARKER_TIMES, error: message });
    expect(logs.error).toEqual(['[db-backup] upload to drime:app failed']);
    expect(rclone.deleted).toEqual([]);
  });

  it('upload verification failure (unparseable size): the error names the target', () => {
    const { cwd, outputDir, envFile } = setup();
    captureConsole();
    const rclone = fakeRclone({ statBody: 'not json' });
    const error = backupFailure([{ type: 'drime', path: 'app', envFile }], rclone, cwd, outputDir);
    const message = `Could not determine remote object size for drimecrypt:app/${NEW_NAME}; refusing to prune or stamp`;
    expect(error.message).toBe(message);
    expect(failedMarker(outputDir)).toEqual({ ...MARKER_TIMES, error: message });
  });

  it('upload failure: fixed error string, exact entry and marker', () => {
    const { cwd, outputDir, envFile } = setup();
    captureConsole();
    const rclone = fakeRclone({ fail: (args) => (args[0] === 'copyto' ? leakyError() : null) });
    const error = backupFailure([{ type: 'drime', path: 'app', envFile }], rclone, cwd, outputDir);
    expect(error.message).toBe('rclone copyto failed (exit 1)');
    expect(error.destinationResults).toEqual([{ destination: defaultDestination(envFile), uploaded: null, uploadFailed: true, removed: [] }]);
    expect(failedMarker(outputDir)).toEqual({ ...MARKER_TIMES, error: 'rclone copyto failed (exit 1)' });
  });

  it('over-cap skip: exact entry, error string and marker string; nothing uploaded', () => {
    const { cwd, outputDir, envFile } = setup();
    const rclone = fakeRclone();
    const error = backupFailure([{ type: 'drime', path: 'app', envFile, maxBytes: 13 }], rclone, cwd, outputDir);
    const message = `Drime upload skipped because the backup is over its size cap (app: ${NEW_NAME} is 14 bytes, over maxBytes 13). Other destinations were uploaded; nothing was pruned or stamped.`;
    expect(error.message).toBe(message);
    expect(error.destinationResults).toEqual([
      { destination: defaultDestination(envFile, { maxBytes: 13 }), uploaded: null, outcome: { status: 'skipped-over-cap', size: 14, maxBytes: 13 }, removed: [] },
    ]);
    expect(failedMarker(outputDir)).toEqual({ ...MARKER_TIMES, error: message });
    expect(rclone.calls.filter((c) => c.args[0] === 'copyto')).toEqual([]);
  });

  it('two over-cap sets join their details with "; "', () => {
    const { cwd, outputDir, envFile } = setup();
    const rclone = fakeRclone();
    const error = backupFailure([{ type: 'drime', path: 'app', envFile, maxBytes: 1 }, { type: 'drime', path: 'other/sub', envFile, maxBytes: 2 }], rclone, cwd, outputDir);
    expect(error.message).toBe(
      `Drime upload skipped because the backup is over its size cap (app: ${NEW_NAME} is 14 bytes, over maxBytes 1; other/sub: ${NEW_NAME} is 14 bytes, over maxBytes 2). Other destinations were uploaded; nothing was pruned or stamped.`,
    );
  });

  it('two failing uploads: the aggregate error names both destination labels and the marker holds it', () => {
    const { cwd, outputDir, envFile } = setup();
    captureConsole();
    const rclone = fakeRclone({ fail: (args) => (args[0] === 'copyto' ? leakyError() : null) });
    const error = backupFailure([{ type: 'drime', path: 'app', envFile }, { type: 'drime', path: 'other/sub', envFile }], rclone, cwd, outputDir);
    expect(error.message).toBe('2 destinations failed to upload: drime:app, drime:other/sub');
    expect(failedMarker(outputDir)).toEqual({ ...MARKER_TIMES, error: '2 destinations failed to upload: drime:app, drime:other/sub' });
  });

  it('prune failure (delete fails): the run succeeds, the entry carries pruneFailed, and the ALERT and warn lines are exact', () => {
    const { cwd, outputDir, envFile } = setup();
    const logs = captureConsole();
    const rclone = fakeRclone({ seeded: SEEDED, fail: (args) => (args[0] === 'deletefile' ? leakyError() : null) });
    const result = backupOnce([{ type: 'drime', path: 'app', envFile }], rclone, cwd, outputDir);
    expect(result.destinationResults).toEqual([
      {
        destination: defaultDestination(envFile),
        uploaded: { target: `drimecrypt:app/${NEW_NAME}`, sizeBytes: ARTIFACT_BYTES },
        outcome: { status: 'uploaded', size: ARTIFACT_BYTES },
        removed: [],
        pruneFailed: { overKeep: 3, reason: 'delete-failed' },
      },
    ]);
    expect(logs.error).toEqual(['[db-backup] ALERT drime prune failed for app: 3 objects over keep 10 (delete-failed)']);
    expect(logs.warn).toEqual(DOOMED_NEWEST_FIRST.map((name) => `[db-backup] Failed to prune remote backup ${name} (leaving it in place): rclone deletefile failed (exit 1)`));
  });

  it('prune failure (listing fails): the ALERT text names an unknown count and the entry has overKeep null', () => {
    const { cwd, outputDir, envFile } = setup();
    const logs = captureConsole();
    const rclone = fakeRclone({ fail: (args) => (args[0] === 'lsjson' && !args.includes('--stat') ? leakyError() : null) });
    const result = backupOnce([{ type: 'drime', path: 'nested/set', envFile, keep: 4 }], rclone, cwd, outputDir);
    expect(logs.error).toEqual(['[db-backup] ALERT drime prune failed for nested/set: an unknown number of objects over keep 4 (list-failed)']);
    expect(result.destinationResults?.[0]).toEqual({
      destination: defaultDestination(envFile, { path: 'nested/set', keep: 4, target: 'drimecrypt:nested/set' }),
      uploaded: { target: `drimecrypt:nested/set/${NEW_NAME}`, sizeBytes: ARTIFACT_BYTES },
      outcome: { status: 'uploaded', size: ARTIFACT_BYTES },
      removed: [],
      pruneFailed: { overKeep: null, reason: 'list-failed' },
    });
  });
});

describe('drime compat: backup through the CLI (--json and notifications)', () => {
  itOnPosix('--json success: destinationResults, top-level back-compat fields', async () => {
    const { cwd, outputDir, envFile, dbSize } = setupForCli();
    const bin = installFakeRclone([
      { match: 'lsjson --stat', stdoutBase64: b64({ Size: dbSize }) },
      { match: 'lsjson dbbdrimecrypt:', stdoutBase64: b64(SEEDED.map((n) => ({ Path: n, Name: n, IsDir: false }))) },
    ]);
    const { stdout, thrown, exitCode } = await cli(bin, cwd, [...BACKUP_FLAGS, '--dest', 'drime:app', '--drime-env-file', envFile, '--output-dir', outputDir, '--json']);
    expect(thrown).toBeNull();
    expect(exitCode).toBeUndefined();
    const json = JSON.parse(stdout);
    const name = json.created.fileName as string;
    const uploaded = { target: `drimecrypt:app/${name}`, sizeBytes: dbSize };
    expect(json.destinationResults).toEqual([
      { destination: defaultDestination(envFile), uploaded, outcome: { status: 'uploaded', size: dbSize }, removed: DOOMED_NEWEST_FIRST },
    ]);
    expect(json.uploaded).toEqual(uploaded);
    expect(json.removedRemote).toEqual(DOOMED_NEWEST_FIRST);
  });

  itOnPosix('--json upload-verification failure: {ok:false, error, destinationResults} and the alert label', async () => {
    const { cwd, outputDir, envFile, dbSize } = setupForCli();
    const sink = path.join(cwd, 'alerts.log');
    const notify = `printf '%s\\n' "$DB_BACKUP_ALERT" >> ${JSON.stringify(sink)}`;
    const bin = installFakeRclone([{ match: 'lsjson --stat', stdoutBase64: b64({ Size: 3 }) }]);
    const { stdout, stderr, thrown } = await cli(bin, cwd, [...BACKUP_FLAGS, '--dest', 'drime:app', '--drime-env-file', envFile, '--output-dir', outputDir, '--json', '--notify-command', notify]);
    const json = JSON.parse(stdout);
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(new RegExp(`^Remote size mismatch for drimecrypt:app/sqlite-backup-\\d{8}-\\d{6}Z\\.db: local=${dbSize} remote=3; refusing to prune or stamp$`));
    expect(json.destinationResults).toEqual([{ destination: defaultDestination(envFile), uploaded: null, uploadFailed: true, removed: [] }]);
    expect(thrown?.message).toBe(json.error);
    expect(stderr).toBe('[db-backup] upload to drime:app failed');
    expect(fs.readFileSync(sink, 'utf8')).toBe('🔴 db-backup FAILED: drime:app (upload failed). Nothing was pruned or stamped\n');
  });

  itOnPosix('--json over-cap: {ok:false, error, destinationResults} with the exact skipped entry', async () => {
    const { cwd, outputDir, envFile, dbSize } = setupForCli();
    const cfg = path.join(cwd, 'db-backup.config.json');
    fs.writeFileSync(cfg, JSON.stringify({ databaseUrl: 'file:./app.db', destinations: [{ type: 'drime', path: 'app', envFile, maxBytes: 3 }] }));
    const { stdout, thrown } = await cli(installFakeRclone([]), cwd, [...BACKUP_FLAGS, '--config', cfg, '--json', '--output-dir', outputDir]);
    const json = JSON.parse(stdout);
    expect(json.destinationResults).toEqual([
      { destination: defaultDestination(envFile, { maxBytes: 3 }), uploaded: null, outcome: { status: 'skipped-over-cap', size: dbSize, maxBytes: 3 }, removed: [] },
    ]);
    expect(Object.keys(json)).toEqual(['ok', 'error', 'destinationResults']);
    expect(thrown?.message).toBe(json.error);
    expect(json.error).toMatch(new RegExp(`^Drime upload skipped because the backup is over its size cap \\(app: sqlite-backup-\\d{8}-\\d{6}Z\\.db is ${dbSize} bytes, over maxBytes 3\\)\\. Other destinations were uploaded; nothing was pruned or stamped\\.$`));
  });

  itOnPosix('two over-cap sets alert with both labels, a nested path included', async () => {
    const { cwd, outputDir, envFile, dbSize } = setupForCli();
    const sink = path.join(cwd, 'alerts.log');
    const notify = `printf '%s\\n' "$DB_BACKUP_ALERT" >> ${JSON.stringify(sink)}`;
    const cfg = path.join(cwd, 'db-backup.config.json');
    fs.writeFileSync(cfg, JSON.stringify({ databaseUrl: 'file:./app.db', destinations: [{ type: 'drime', path: 'app', envFile, maxBytes: 3 }, { type: 'drime', path: 'other/sub', envFile, maxBytes: 3 }] }));
    await cli(installFakeRclone([]), cwd, [...BACKUP_FLAGS, '--config', cfg, '--output-dir', outputDir, '--notify-command', notify]);
    expect(fs.readFileSync(sink, 'utf8')).toBe('🔴 db-backup FAILED: drime:app (over its size cap), drime:other/sub (over its size cap). Nothing was pruned or stamped\n');
  });

  itOnPosix('a prune failure sends the exact retention-failed alert and prints the ALERT line to stderr, exit 0', async () => {
    const { cwd, outputDir, envFile, dbSize } = setupForCli();
    const sink = path.join(cwd, 'alerts.log');
    const notify = `printf '%s\\n' "$DB_BACKUP_ALERT" >> ${JSON.stringify(sink)}`;
    const bin = installFakeRclone([
      { match: 'lsjson --stat', stdoutBase64: b64({ Size: dbSize }) },
      { match: 'lsjson dbbdrimecrypt:', stdoutBase64: b64(SEEDED.map((n) => ({ Path: n, Name: n, IsDir: false }))) },
      { match: 'deletefile', exit: 1 },
    ]);
    const { stderr, thrown, exitCode } = await cli(bin, cwd, [...BACKUP_FLAGS, '--dest', 'drime:app', '--drime-env-file', envFile, '--output-dir', outputDir, '--notify-command', notify]);
    expect(thrown).toBeNull();
    expect(exitCode).toBeUndefined();
    expect(stderr).toContain('[db-backup] ALERT drime prune failed for app: 3 objects over keep 10 (delete-failed)');
    expect(fs.readFileSync(sink, 'utf8')).toBe('🟠 db-backup: the backup succeeded but retention failed on drime:app (delete-failed). Old backups were left in place\n');
  });
});

describe('drime compat: drime-audit CLI', () => {
  const TOP_OK = [{ Path: 'backups-encrypted', IsDir: true }];
  const RAW = [{ Path: 'd', IsDir: true }, { Path: 'd/f1', Size: 100, IsDir: false }];
  const CRYPT = [{ Path: 'dec', EncryptedPath: 'd', IsDir: true }, { Path: 'dec/f1', EncryptedPath: 'd/f1', IsDir: false }];
  const MAGIC_HEAD = Buffer.from('RCLONE\0\0', 'latin1').toString('base64');
  const storeRules = (top: unknown[], head: string) => [
    { match: 'lsjson dbbdrimebase:', stdoutBase64: b64(top) },
    { match: 'lsjson -R dbbdrimebase:', stdoutBase64: b64(RAW) },
    { match: 'lsjson -R --encrypted', stdoutBase64: b64(CRYPT) },
    { match: 'cat', stdoutBase64: head },
  ];

  itOnPosix('clean store, text: one summary line on stdout, exit 0', async () => {
    const { envFile } = setup();
    const result = await cli(installFakeRclone(storeRules(TOP_OK, MAGIC_HEAD)), makeTempDir(), ['drime-audit', '--env-file', envFile]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('[db-backup] drime-audit: clean, 1 object(s) checked, 0 changed during audit');
    expect(result.stderr).toBe('');
  });

  itOnPosix('clean store, --json: exact text, key order and scope null, exit 0', async () => {
    const { envFile } = setup();
    const result = await cli(installFakeRclone(storeRules(TOP_OK, MAGIC_HEAD)), makeTempDir(), ['drime-audit', '--env-file', envFile, '--json']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(JSON.stringify({ status: 'clean', objects: 1, findings: [], changedDuringAudit: [], scope: null }, null, 2));
  });

  itOnPosix('findings, text: finding paths and details on stderr, summary on stdout, exit 1', async () => {
    const { envFile } = setup();
    const top = [...TOP_OK, { Path: 'plain', IsDir: true }];
    const result = await cli(installFakeRclone(storeRules(top, b64('SQLite f'))), makeTempDir(), ['drime-audit', '--env-file', envFile]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('[db-backup] drime-audit: findings, 1 object(s) checked, 0 changed during audit');
    expect(result.stderr.split('\n')).toEqual([
      '[db-backup] FINDING unexpected-top-level: drime:plain (not the crypt root)',
      '[db-backup] FINDING not-crypt-format: drime:backups-encrypted/d/f1 (missing rclone crypt header)',
    ]);
  });

  itOnPosix('findings, --json: exact object with finding paths, kinds and details, exit 1', async () => {
    const { envFile } = setup();
    const top = [...TOP_OK, { Path: 'plain', IsDir: true }];
    const result = await cli(installFakeRclone(storeRules(top, b64('SQLite f'))), makeTempDir(), ['drime-audit', '--env-file', envFile, '--json']);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      status: 'findings',
      objects: 1,
      findings: [
        { kind: 'unexpected-top-level', path: 'drime:plain', detail: 'not the crypt root' },
        { kind: 'not-crypt-format', path: 'drime:backups-encrypted/d/f1', detail: 'missing rclone crypt header' },
      ],
      changedDuringAudit: [],
      scope: null,
    });
    expect(Object.keys(JSON.parse(result.stdout))).toEqual(['status', 'objects', 'findings', 'changedDuringAudit', 'scope']);
  });

  itOnPosix('cannot audit, text: the stderr line and exit 2, nothing on stdout', async () => {
    const { cwd } = setup();
    const missing = path.join(cwd, 'missing.env');
    const result = await cli(installFakeRclone([]), makeTempDir(), ['drime-audit', '--env-file', missing]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`[db-backup] drime-audit cannot audit: Drime env file ${missing} is not readable (ENOENT)`);
  });

  itOnPosix('cannot audit, --json: {status:"error", error} on stdout, the stderr line, exit 2', async () => {
    const { cwd } = setup();
    const missing = path.join(cwd, 'missing.env');
    const result = await cli(installFakeRclone([]), makeTempDir(), ['drime-audit', '--env-file', missing, '--json']);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe(JSON.stringify({ status: 'error', error: `Drime env file ${missing} is not readable (ENOENT)` }, null, 2));
    expect(result.stderr).toBe(`[db-backup] drime-audit cannot audit: Drime env file ${missing} is not readable (ENOENT)`);
  });

  itOnPosix('custom --base-remote/--crypt-remote select the custom env sections', async () => {
    const { envFile } = setup();
    const result = await cli(installFakeRclone(storeRules([{ Path: 'custom-root', IsDir: true }], MAGIC_HEAD)), makeTempDir(), ['drime-audit', '--env-file', envFile, '--base-remote', 'mybase', '--crypt-remote', 'mycrypt']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('[db-backup] drime-audit: clean, 1 object(s) checked, 0 changed during audit');
  });
});

describe('drime compat: fetch --from drime', () => {
  const BYTES = 'decrypted backup bytes';
  const OLD = 'sqlite-backup-20260701-030000Z.db.gz';
  const NEWEST = 'sqlite-backup-20260709-030000Z.db.gz';
  const entries = [{ Path: OLD, Size: BYTES.length, IsDir: false }, { Path: NEWEST, Size: BYTES.length, IsDir: false }];

  function installFetchRclone(listing: unknown[], written: string = BYTES) {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'rclone'), [
      `#!${process.execPath}`,
      "const fs = require('fs');",
      'const args = process.argv.slice(2);',
      `if (args[0] === 'lsjson') { process.stdout.write(${JSON.stringify(JSON.stringify(listing))}); process.exit(0); }`,
      `if (args[0] === 'copyto') { fs.writeFileSync(args[2], ${JSON.stringify(written)}); process.exit(0); }`,
      'process.exit(9);',
    ].join('\n'), { mode: 0o755 });
    return dir;
  }

  itOnPosix('--json: the exact single-line {file,size,set} on stdout, the file inside the realpath of --output', async () => {
    const { cwd, envFile } = setup();
    const outputDir = path.join(cwd, 'nested', 'drill');
    const result = await cli(installFetchRclone(entries), cwd, ['fetch', '--from', 'drime:app', '--latest', '--output', outputDir, '--drime-env-file', envFile, '--json']);
    expect(result.thrown).toBeNull();
    expect(result.stdout).toBe(JSON.stringify({ file: NEWEST, size: BYTES.length, set: 'app' }));
    expect(fs.readdirSync(outputDir)).toEqual([NEWEST]);
    expect(fs.readFileSync(path.join(fs.realpathSync(outputDir), NEWEST), 'utf8')).toBe(BYTES);
  });

  itOnPosix('--file with a custom --base-remote/--crypt-remote fetches that object and prints its path', async () => {
    const { cwd, envFile } = setup();
    const outputDir = path.join(cwd, 'd');
    const result = await cli(installFetchRclone(entries), cwd, ['fetch', '--from', 'drime:app', '--file', OLD, '--output', outputDir, '--env-file', envFile, '--base-remote', 'mybase', '--crypt-remote', 'mycrypt']);
    expect(result.thrown).toBeNull();
    expect(result.stdout).toBe(path.join(fs.realpathSync(outputDir), OLD));
  });

  itOnPosix('a short download fails with the size-mismatch error, prints nothing, and leaves --output empty', async () => {
    const { cwd, envFile } = setup();
    const outputDir = path.join(cwd, 'drill');
    const result = await cli(installFetchRclone(entries, 'short'), cwd, ['fetch', '--from', 'drime:app', '--file', OLD, '--output', outputDir, '--drime-env-file', envFile]);
    expect(result.thrown?.message).toBe('Downloaded size does not match the Drime listing');
    expect(result.stdout).toBe('');
    expect(fs.readdirSync(outputDir)).toEqual([]);
  });

  itOnPosix('an existing file is never overwritten', async () => {
    const { cwd, envFile } = setup();
    const outputDir = path.join(cwd, 'drill');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, OLD), 'precious');
    const result = await cli(installFetchRclone(entries), cwd, ['fetch', '--from', 'drime:app', '--file', OLD, '--output', outputDir, '--drime-env-file', envFile]);
    expect(result.thrown?.message).toContain('Refusing to overwrite');
    expect(fs.readFileSync(path.join(outputDir, OLD), 'utf8')).toBe('precious');
  });

  itOnPosix('a listed name that would escape --output is refused and nothing is written outside it', async () => {
    const { cwd, envFile } = setup();
    const outputDir = path.join(cwd, 'drill');
    const result = await cli(installFetchRclone([{ Path: '../escape.db', Size: 3, IsDir: false }]), cwd, ['fetch', '--from', 'drime:app', '--file', '../escape.db', '--output', outputDir, '--drime-env-file', envFile]);
    expect(result.thrown).toBeInstanceOf(Error);
    expect(fs.existsSync(path.join(cwd, 'escape.db'))).toBe(false);
    expect(fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : []).toEqual([]);
  });
});

describe('drime compat: public API surface', () => {
  // [name, typeof, function arity] of everything `require('../index')` exports today.
  const INDEX_EXPORTS: [string, string, number?][] = [
    ['DEFAULT_CIPHER_ALGO', 'string'], ['DEFAULT_COMMAND_TIMEOUT_MS', 'number'], ['DEFAULT_RETENTION_POLICY', 'object'], ['DEFAULT_S3_KEEP', 'number'],
    ['DEFAULT_S3_TIMEOUT_MS', 'number'], ['MANIFEST_FILENAME', 'string'], ['S3_SINGLE_PART_LIMIT_BYTES', 'number'],
    ['appendBackupManifestEntry', 'function', 2], ['buildDailyCronEntry', 'function', 0], ['buildGfsAnchors', 'function', 1], ['checkBackupFreshness', 'function', 0],
    ['checkRemoteFreshness', 'function', 0], ['createSqliteSnapshot', 'function', 1], ['decryptBackupToPath', 'function', 4], ['detectSqliteQuiescence', 'function', 2],
    ['encryptBackupEntry', 'function', 3], ['expandHome', 'function', 1], ['fetchFromDrime', 'function', 1], ['getBackupFallbackDirectory', 'function', 0],
    ['getOperationalStatus', 'function', 0], ['installSchedule', 'function', 0], ['isContainedWithin', 'function', 2], ['listBackupMarkers', 'function', 1],
    ['listBackupsWithPlan', 'function', 0], ['normalizeDestination', 'function', 2], ['normalizeRuntime', 'function', 0], ['notifyAlert', 'function', 1],
    ['parseBackupFileName', 'function', 1], ['planRetention', 'function', 1], ['pruneBackupsJob', 'function', 0], ['pruneRemoteBackups', 'function', 3],
    ['pruneS3Backups', 'function', 3], ['readAlertState', 'function', 1], ['readBackupManifest', 'function', 1], ['readSuccessStamp', 'function', 1],
    ['redactWebhookUrl', 'function', 2], ['removeSqliteSidecars', 'function', 1], ['renderScheduleBlock', 'function', 1], ['replaceCrontabBlock', 'function', 2],
    ['resolveBackupDirectories', 'function', 0], ['resolveContainedBackupPath', 'function', 1], ['resolveDestinations', 'function', 1],
    ['resolveRetentionPolicy', 'function', 0], ['resolveS3Credentials', 'function', 0], ['restoreBackup', 'function', 0], ['restoreSqliteBackup', 'function', 0],
    ['runBackupJob', 'function', 0], ['runBackupJobAsync', 'function', 0], ['runCli', 'function', 0], ['signS3Request', 'function', 1],
    ['uploadBackupToRemote', 'function', 3], ['uploadBackupToS3', 'function', 3], ['validateSchedule', 'function', 1], ['verifyS3Object', 'function', 4],
    ['verifySqliteBackupIntegrity', 'function', 1], ['writeAlertState', 'function', 2], ['writeSuccessStamp', 'function', 1],
  ];

  // [name, typeof, function arity] of everything `require('../drime')` exports today.
  const DRIME_EXPORTS: [string, string, number?][] = [
    ['CRYPT_MAGIC', 'object'], ['DEFAULT_AUDIT_CONCURRENCY', 'number'], ['DEFAULT_AUDIT_MAX_CHANGED', 'number'], ['DEFAULT_DRIME_BASE_REMOTE', 'string'],
    ['DEFAULT_DRIME_CRYPT_REMOTE', 'string'], ['DEFAULT_DRIME_ENV_FILE', 'string'], ['DEFAULT_DRIME_KEEP', 'number'], ['DEFAULT_DRIME_MAX_BYTES', 'number'],
    ['DrimeAuditError', 'function', 0], ['LISTING_MAX_BYTES', 'number'], ['assertGenericRcloneTarget', 'function', 3], ['buildRcloneArgs', 'function', 2],
    ['drimeAudit', 'function', 1], ['drimeFetch', 'function', 1], ['drimeTargetOf', 'function', 1], ['loadDrimeContext', 'function', 1],
    ['normalizeDrimeDestination', 'function', 2], ['overCapOutcome', 'function', 2], ['runDrimeOperation', 'function', 3],
  ];

  const surfaceOf = (moduleExports: Record<string, unknown>) =>
    Object.keys(moduleExports).sort().map((name) => {
      const value = moduleExports[name];
      return typeof value === 'function' ? [name, 'function', value.length] : [name, typeof value];
    });

  it("index exports exactly today's names, types and function arities, fetchFromDrime included", () => {
    expect(surfaceOf(dbBackup as unknown as Record<string, unknown>)).toEqual(INDEX_EXPORTS);
  });

  it("the drime module exports exactly today's names, types and function arities, drimeAudit included", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect(surfaceOf(require('../drime.js') as Record<string, unknown>)).toEqual(DRIME_EXPORTS);
  });

  it('drimeAudit is the drime module export, not an index export (today)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const drime = require('../drime.js') as Record<string, unknown>;
    expect((dbBackup as unknown as Record<string, unknown>).drimeAudit).toBeUndefined();
    expect(typeof drime.drimeAudit).toBe('function');
  });

  it('the drime defaults and limits keep their values', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const drime = require('../drime.js') as Record<string, unknown>;
    expect({
      concurrency: drime.DEFAULT_AUDIT_CONCURRENCY,
      maxChanged: drime.DEFAULT_AUDIT_MAX_CHANGED,
      keep: drime.DEFAULT_DRIME_KEEP,
      maxBytes: drime.DEFAULT_DRIME_MAX_BYTES,
      envFile: drime.DEFAULT_DRIME_ENV_FILE,
      baseRemote: drime.DEFAULT_DRIME_BASE_REMOTE,
      cryptRemote: drime.DEFAULT_DRIME_CRYPT_REMOTE,
      listingMaxBytes: drime.LISTING_MAX_BYTES,
      magic: (drime.CRYPT_MAGIC as Buffer).toString('hex'),
    }).toEqual({
      concurrency: 8,
      maxChanged: 50,
      keep: 10,
      maxBytes: 5_000_000_000,
      envFile: '/etc/db-backup/drime.env',
      baseRemote: 'drime',
      cryptRemote: 'drimecrypt',
      listingMaxBytes: 268435456,
      magic: '52434c4f4e450000',
    });
  });
});
