// Shared test fixtures for the split test-suite (see PKG-28). Every file below
// imports what it needs from here rather than redeclaring it — keep this file
// the single source of truth for makeTempDir/makeRuntime/fixedNow/backupEntry
// and the `require('../index.js')` module handle.
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

// A single untyped require of the whole module. Each test file destructures
// only the exports it actually uses from this, e.g.:
//   const { runBackupJob, planRetention } = dbBackup;
export const dbBackup = require('../index.js') as typeof import('../index');

export const fixedNow = new Date('2026-07-05T15:00:00.000Z');

// Every temp dir created via makeTempDir across a test file is removed by
// that file's own `afterEach` (see the boilerplate each spec file repeats —
// tempDirs itself is per-module-instance since vitest gives each test file
// its own module graph).
export const tempDirs: string[] = [];

export function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-backup-'));
  tempDirs.push(dir);
  return dir;
}

export interface FakeRemote { name: string; type: string }

// What the fake `rclone listremotes --long --json` reports. Pass `remotes: null`
// to let the test's own execFileSync answer it instead.
export const DEFAULT_TEST_REMOTES: FakeRemote[] = ['offsite', 'r2', 'r'].map((name) => ({ name, type: 's3' }));

export function makeRuntime(overrides: Partial<{
  commandExists: (command: string) => boolean;
  execFileSync: (command: string, args: string[], options?: unknown) => unknown;
  sleep: (ms: number) => void;
  now: () => Date;
  randomId: () => string;
  env: Record<string, string | undefined>;
  remotes: FakeRemote[] | null;
}> = {}) {
  const { remotes = DEFAULT_TEST_REMOTES, ...rest } = overrides;
  return {
    commandExists: () => false,
    sleep: () => undefined,
    now: () => fixedNow,
    randomId: () => 'fixed-restore-id',
    ...rest,
    execFileSync: (command: string, args: string[], options?: unknown) =>
      remotes && command === 'rclone' && args[0] === 'listremotes'
        ? Buffer.from(JSON.stringify(remotes))
        : rest.execFileSync?.(command, args, options),
  };
}

export function backupEntry(fileName: string, ageDays: number) {
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

export function cleanupTempDirs() {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
