import fs from 'fs';
import path from 'path';
import os from 'os';
import { afterEach, describe, expect, it } from 'vitest';

import { dbBackup, fixedNow, tempDirs, makeTempDir, makeRuntime, cleanupTempDirs } from './helpers';

const {
  runCli,
  checkBackupFreshness,
  checkRemoteFreshness,
  notifyAlert,
  writeSuccessStamp,
  getOperationalStatus,
} = dbBackup;

afterEach(() => {
  cleanupTempDirs();
});

describe('@andrewpopov/db-backup — freshness (checkBackupFreshness/checkRemoteFreshness, notifyAlert, runCli freshness wiring)', () => {
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

describe('checkRemoteFreshness (off-host dead-man switch)', () => {
  const pad = (n: number) => String(n).padStart(2, '0');
  // A canonical sqlite backup filename dated `hoursFromNow` from fixedNow.
  const bkname = (hoursFromNow: number) => {
    const d = new Date(fixedNow.getTime() + hoursFromNow * 3600_000);
    const key = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
    return `sqlite-backup-${key}.db.gz`;
  };
  // Mirrors the real path: rclone lsf --files-only returns newline-joined names.
  const rcloneRuntime = (names: string[]) =>
    makeRuntime({
      commandExists: (c: string) => c === 'rclone',
      execFileSync: ((command: string, args: string[]) =>
        command === 'rclone' && args[0] === 'lsf'
          ? Buffer.from(names.join('\n') + '\n')
          : Buffer.from('')) as never,
    });

  it('is fresh when the newest backup is within the threshold', () => {
    const s = checkRemoteFreshness({
      remote: { target: 'r2:b/p' },
      runtime: rcloneRuntime([bkname(-30), bkname(-2)]),
      maxAgeHours: 24,
      now: fixedNow,
    });
    expect(s).toMatchObject({ fresh: true, clockSkew: false });
    expect(s.ageHours).toBeCloseTo(2, 5);
  });

  it('is not fresh when the newest backup is older than the threshold', () => {
    const s = checkRemoteFreshness({
      remote: { target: 'r2:b/p' },
      runtime: rcloneRuntime([bkname(-48)]),
      maxAgeHours: 24,
      now: fixedNow,
    });
    expect(s.fresh).toBe(false);
  });

  it('is not fresh (stampedAt null) when the remote has no backups', () => {
    const s = checkRemoteFreshness({
      remote: { target: 'r2:b/p' },
      runtime: rcloneRuntime([]),
      maxAgeHours: 24,
      now: fixedNow,
    });
    expect(s).toMatchObject({ fresh: false, stampedAt: null });
  });

  it('flags a future-dated backup as a clock problem, not fresh', () => {
    const s = checkRemoteFreshness({
      remote: { target: 'r2:b/p' },
      runtime: rcloneRuntime([bkname(2)]),
      maxAgeHours: 24,
      now: fixedNow,
    });
    expect(s).toMatchObject({ fresh: false, clockSkew: true });
  });

  it('ignores stray non-backup files (a fresh manifest cannot mask a stale backup)', () => {
    const s = checkRemoteFreshness({
      remote: { target: 'r2:b/p' },
      // a newer non-backup file plus a 40h-old real backup → stale
      runtime: rcloneRuntime(['backup-manifest.json', 'random.txt', bkname(-40)]),
      maxAgeHours: 24,
      now: fixedNow,
    });
    expect(s.fresh).toBe(false);
    expect(s.ageHours).toBeCloseTo(40, 5);
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

  it('throws when the listing itself fails (UNKNOWN is never fresh)', () => {
    expect(() =>
      checkRemoteFreshness({
        remote: { target: 'r2:b/p' },
        runtime: makeRuntime({
          commandExists: (c: string) => c === 'rclone',
          execFileSync: (() => {
            throw new Error('rclone: network unreachable');
          }) as never,
        }),
        maxAgeHours: 24,
        now: fixedNow,
      }),
    ).toThrow(/Could not list remote backups/i);
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
  it('requires --stamp-file or --remote', async () => {
    await expect(runCli(['freshness'])).rejects.toThrow(/--stamp-file .* or --remote/);
  });

  it('fires --notify-command and exits non-zero on a stale stamp (end-to-end)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-backup-notify-'));
    tempDirs.push(dir);
    const stamp = path.join(dir, '.last-success');
    const sentinel = path.join(dir, 'alert.txt');
    fs.writeFileSync(stamp, '2020-01-01T00:00:00.000Z\n'); // ancient → stale
    const prevExit = process.exitCode;
    process.exitCode = 0;
    await runCli([
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
});

// ---------------------------------------------------------------------------
// getOperationalStatus (PKG-28): combines checkBackupFreshness with the
// newest marker/backup state into the admin-kit AdminOperationalStatus feed.
// Precedence: failed marker beats fresh > clock skew > stale > healthy.
// ---------------------------------------------------------------------------
describe('getOperationalStatus (tone matrix)', () => {
  it('is healthy when the stamp is fresh and nothing has failed', () => {
    const dir = makeTempDir();
    const stampFile = path.join(dir, '.last-success');
    writeSuccessStamp(stampFile, fixedNow);

    const status = getOperationalStatus({
      stampFile,
      outputDir: dir,
      maxAgeHours: 36,
      now: fixedNow,
    });

    expect(status.tone).toBe('healthy');
    expect(status.stampedAt).toBe(fixedNow.toISOString());
  });

  it('is critical when the stamp is stale', () => {
    const dir = makeTempDir();
    const stampFile = path.join(dir, '.last-success');
    const staleAt = new Date(fixedNow.getTime() - 48 * 60 * 60 * 1000);
    writeSuccessStamp(stampFile, staleAt);

    const status = getOperationalStatus({
      stampFile,
      outputDir: dir,
      maxAgeHours: 36,
      now: fixedNow,
    });

    expect(status.tone).toBe('critical');
    expect(status.detail).toMatch(/old/i);
  });

  it('is critical when no successful backup has ever been recorded', () => {
    const dir = makeTempDir();
    const status = getOperationalStatus({
      stampFile: path.join(dir, '.last-success'),
      outputDir: dir,
      now: fixedNow,
    });

    expect(status.tone).toBe('critical');
    expect(status.detail).toMatch(/no successful backup/i);
    expect(status.stampedAt).toBeUndefined();
  });

  it('is a warning (not critical) when the stamp is dated in the future (clock skew)', () => {
    const dir = makeTempDir();
    const stampFile = path.join(dir, '.last-success');
    const futureAt = new Date(fixedNow.getTime() + 60 * 60 * 1000);
    writeSuccessStamp(stampFile, futureAt);

    const status = getOperationalStatus({
      stampFile,
      outputDir: dir,
      maxAgeHours: 36,
      now: fixedNow,
    });

    expect(status.tone).toBe('warning');
  });

  it('a failed marker beats a fresh stamp: critical, precedence documented on getOperationalStatus', () => {
    const dir = makeTempDir();
    const stampFile = path.join(dir, '.last-success');
    // The stamp is still fresh (an older run succeeded)...
    writeSuccessStamp(stampFile, fixedNow);
    // ...but the newest attempt, just now, failed.
    const outputDir = dir;
    fs.writeFileSync(
      path.join(outputDir, 'sqlite-backup-20260705-160000Z-abc123.failed'),
      JSON.stringify({ startedAt: fixedNow.toISOString(), failedAt: fixedNow.toISOString(), error: 'disk full' }),
    );

    const status = getOperationalStatus({
      stampFile,
      outputDir,
      maxAgeHours: 36,
      now: fixedNow,
    });

    expect(status.tone).toBe('critical');
    expect(status.detail).toMatch(/disk full/);
  });

  it('a run that failed AFTER producing its artifact is still critical (failedAt beats artifact recency)', () => {
    const dir = makeTempDir();
    const stampFile = path.join(dir, '.last-success');
    writeSuccessStamp(stampFile, fixedNow);

    // The failed run's snapshot artifact exists and is NEWER (by createdAt)
    // than the failure's startedAt — replication failed after the snapshot
    // was written. Ranking rows by createdAt alone would pick the artifact
    // and report healthy; the failedAt comparison must not.
    const startedAt = new Date(fixedNow.getTime() - 10 * 60 * 1000); // job started 10 min ago
    const artifactAt = '20260705-145500Z'; // snapshot written 14:55 (after start 14:50)
    fs.writeFileSync(path.join(dir, `sqlite-backup-${artifactAt}.db`), 'snapshot from the failed run');
    fs.writeFileSync(
      path.join(dir, 'sqlite-backup-20260705-145000Z-job001.failed'),
      JSON.stringify({
        startedAt: startedAt.toISOString(),
        failedAt: fixedNow.toISOString(), // replication failed just now — newest event
        error: 'remote size mismatch',
      }),
    );

    const status = getOperationalStatus({
      stampFile,
      outputDir: dir,
      maxAgeHours: 36,
      now: fixedNow,
    });

    expect(status.tone).toBe('critical');
    expect(status.detail).toMatch(/remote size mismatch/);
  });

  it('a failure older than a subsequent completed backup does NOT override health', () => {
    const dir = makeTempDir();
    const stampFile = path.join(dir, '.last-success');
    writeSuccessStamp(stampFile, fixedNow);

    // An old failure, then a newer successful backup: the success supersedes.
    const failedAt = new Date(fixedNow.getTime() - 2 * 24 * 60 * 60 * 1000);
    fs.writeFileSync(
      path.join(dir, 'sqlite-backup-20260703-150000Z-job001.failed'),
      JSON.stringify({ startedAt: failedAt.toISOString(), failedAt: failedAt.toISOString(), error: 'old news' }),
    );
    fs.writeFileSync(path.join(dir, 'sqlite-backup-20260705-150000Z.db'), 'the recovery backup');

    const status = getOperationalStatus({
      stampFile,
      outputDir: dir,
      maxAgeHours: 36,
      now: fixedNow,
    });

    expect(status.tone).toBe('healthy');
  });
});
