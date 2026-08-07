import fs from 'fs';
import path from 'path';
import os from 'os';
import { afterEach, describe, expect, it } from 'vitest';

import { dbBackup, fixedNow, tempDirs, makeTempDir, makeRuntime, cleanupTempDirs } from './helpers';

// These cases assert POSIX behaviour this package targets but Windows cannot
// provide: absolute paths like `/srv/app/backups` (path.resolve turns them
// into `D:\srvppackups` here), `~` expansion, cron lines built for a
// Linux host, notify commands run through a shell, and the external sqlite3 /
// gzip / rclone binaries. db-backup runs on a Linux server; these run there.
const itOnPosix = process.platform === 'win32' ? it.skip : it;


const {
  runCli,
  checkBackupFreshness,
  checkRemoteFreshness,
  notifyAlert,
  redactWebhookUrl,
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
describe('webhook URL redaction', () => {
  // The real leak, reproduced: a DNS failure on pitelite made curl fail, and
  // execFileSync put the ENTIRE command line -- including rouge's live #alerts
  // webhook -- into error.message, which was then console.warn'd straight into
  // journald in plaintext.
  const LIVE_SHAPE =
    'Command failed: curl -fsS -X POST -H Content-Type: application/json -d @- ' +
    'https://discord.com/api/webhooks/1525256591954415686/FSoes7Eddk3i8tlqwKXREXdg7U0LD35lZsY4gEAmKyI6Nhiawt57Td09qBtk7fkzZu0c';

  it('redacts the exact string shape that leaked into the journal', () => {
    const out = redactWebhookUrl(LIVE_SHAPE);
    expect(out).not.toContain('FSoes7Eddk3i8tlqwKXREXdg7U0LD35lZsY4gEAmKyI6Nhiawt57Td09qBtk7fkzZu0c');
    expect(out).not.toContain('1525256591954415686');
    expect(out).toContain('<redacted-webhook-url>');
    // The useful part of the diagnostic survives.
    expect(out).toContain('Command failed');
  });

  it('redacts a known URL by exact match even when it matches no pattern', () => {
    const odd = 'https://hooks.internal.example/relay/abc123';
    expect(redactWebhookUrl(`POST to ${odd} failed`, odd)).toBe(
      'POST to <redacted-webhook-url> failed',
    );
  });

  it('redacts any /webhooks/ URL and the discordapp.com alias', () => {
    expect(redactWebhookUrl('see https://example.com/api/webhooks/1/secret now')).toContain(
      '<redacted-webhook-url>',
    );
    expect(redactWebhookUrl('at discordapp.com/api/webhooks/9/tok')).not.toContain('tok');
  });

  it('leaves text with no webhook untouched', () => {
    expect(redactWebhookUrl('newest backup is 83.5h old (threshold 192h)')).toBe(
      'newest backup is 83.5h old (threshold 192h)',
    );
  });

  it('notifyAlert never logs the Discord webhook when the POST fails', () => {
    const url = 'https://discord.com/api/webhooks/1525256591954415686/FSoes7EddkSECRETtoken';
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...parts: unknown[]) => { warnings.push(parts.join(' ')); };
    try {
      notifyAlert('backup stale', {
        notifyDiscord: url,
        runtime: makeRuntime({
          commandExists: () => true,
          execFileSync: ((command: string, args: string[]) => {
            // Reproduce execFileSync's behaviour: the command line, URL included.
            throw new Error(`Command failed: ${command} ${args.join(' ')}`);
          }) as never,
        }),
      });
    } finally {
      console.warn = warn;
    }
    expect(warnings.join('\n')).not.toContain('FSoes7EddkSECRETtoken');
    expect(warnings.join('\n')).not.toContain(url);
    expect(warnings.join('\n')).toContain('<redacted-webhook-url>');
  });

  it('notifyAlert logs NOTHING derived from a failed notify-command', () => {
    // The command line is operator-supplied and may embed a webhook of any vendor
    // shape, or a credential that is not a webhook at all. redactWebhookUrl cannot
    // save this path (no known URL to exact-match), so nothing derived from the
    // error may be logged -- only the failure and the exit status.
    const secrets = [
      'https://hooks.slack.com/services/T0/B0/SLACKSECRET',
      'https://chat.googleapis.com/v1/spaces/A/messages?key=K&token=GCHATSECRET',
      'https://acme.webhook.office.com/webhookb2/a/IncomingWebhook/b/TEAMSSECRET',
      'PGPASSWORD=notawebhookatall',
    ];
    for (const secret of secrets) {
      const warnings: string[] = [];
      const warn = console.warn;
      console.warn = (...parts: unknown[]) => { warnings.push(parts.join(' ')); };
      try {
        notifyAlert('backup stale', {
          notifyCommand: `curl -X POST '${secret}'`,
          runtime: makeRuntime({
            commandExists: () => true,
            execFileSync: ((command: string, args: string[]) => {
              const error: any = new Error(`Command failed: ${command} ${args.join(' ')}`);
              error.status = 7;
              throw error;
            }) as never,
          }),
        });
      } finally {
        console.warn = warn;
      }
      const logged = warnings.join('\n');
      expect(logged).not.toContain(secret);
      expect(logged).not.toMatch(/SLACKSECRET|GCHATSECRET|TEAMSSECRET|notawebhookatall/);
      expect(logged).toContain('notify-command failed');
      expect(logged).toContain('exit 7');
    }
  });

  it('redactWebhookUrl exact-match makes vendor shape irrelevant', () => {
    // Pattern-matching cannot cover every vendor, which is WHY callers pass the URL.
    const slack = 'https://hooks.slack.com/services/T0/B0/SLACKSECRET';
    expect(redactWebhookUrl(`POST ${slack} failed`, slack)).not.toContain('SLACKSECRET');
    // Documented limitation, asserted so it is a known gap rather than a surprise:
    // with NO url passed, a non-Discord shape is not recognised.
    expect(redactWebhookUrl(`POST ${slack} failed`)).toContain('SLACKSECRET');
  });

  it('notifyAlert never logs a generic webhook URL when the POST fails', () => {
    const url = 'https://hooks.example.com/services/T000/B000/GENERICSECRET';
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...parts: unknown[]) => { warnings.push(parts.join(' ')); };
    try {
      notifyAlert('backup stale', {
        notifyWebhook: url,
        runtime: makeRuntime({
          commandExists: () => true,
          execFileSync: ((command: string, args: string[]) => {
            throw new Error(`Command failed: ${command} ${args.join(' ')}`);
          }) as never,
        }),
      });
    } finally {
      console.warn = warn;
    }
    expect(warnings.join('\n')).not.toContain('GENERICSECRET');
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

  itOnPosix('fires --notify-command and exits non-zero on a stale stamp (end-to-end)', async () => {
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

// ---------------------------------------------------------------------------
// Alert suppression (PKG-113). The state machine is alert-kit's `stepCheck`; what
// is tested here is db-backup's wiring of it — the mapping, the persistence, and
// above all the two invariants that must not regress.
// ---------------------------------------------------------------------------
describe('freshness alert suppression', () => {
  const staleStamp = (dir: string, hoursAgo = 100) => {
    const stampFile = path.join(dir, '.last-success');
    writeSuccessStamp(stampFile, new Date(Date.now() - hoursAgo * 60 * 60 * 1000));
    return stampFile;
  };
  const sink = (dir: string) => {
    const log = path.join(dir, 'notifications.log');
    return { log, command: `printf 'x\\n' >> ${log}`, count: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0) };
  };
  const readState = (stampFile: string) => JSON.parse(fs.readFileSync(`${stampFile}.alerts.json`, 'utf8')).check;

  const runFreshness = async (args: string[]) => {
    const previous = process.exitCode;
    process.exitCode = undefined;
    await runCli(args);
    const code = process.exitCode;
    process.exitCode = previous;
    return code;
  };

  itOnPosix('THE BUG: 12 consecutive stale runs notify ONCE, not 12 times', async () => {
    const dir = makeTempDir();
    const stampFile = staleStamp(dir);
    const s = sink(dir);
    for (let i = 0; i < 12; i += 1) {
      await runFreshness(['freshness', '--stamp-file', stampFile, '--max-age-hours', '36', '--notify-command', s.command]);
    }
    expect(s.count()).toBe(1);
    expect(readState(stampFile)).toMatchObject({ notif: 'alerted', failStreak: 12 });
  });

  itOnPosix('INVARIANT: a suppressed alert still exits 1 on every stale run', async () => {
    const dir = makeTempDir();
    const stampFile = staleStamp(dir);
    const s = sink(dir);
    const codes: (number | undefined)[] = [];
    for (let i = 0; i < 4; i += 1) {
      codes.push(await runFreshness(['freshness', '--stamp-file', stampFile, '--max-age-hours', '36', '--notify-command', s.command]));
    }
    // Suppression gates NOTIFICATION only. A quiet run is still a failing run.
    expect(codes).toEqual([1, 1, 1, 1]);
    expect(s.count()).toBe(1);
  });

  itOnPosix('reminds once the re-alert interval has elapsed', async () => {
    const dir = makeTempDir();
    const stampFile = staleStamp(dir);
    const s = sink(dir);
    await runFreshness(['freshness', '--stamp-file', stampFile, '--max-age-hours', '36', '--notify-command', s.command]);
    const state = JSON.parse(fs.readFileSync(`${stampFile}.alerts.json`, 'utf8'));
    state.check.lastAlertAtMs = Date.now() - 25 * 60 * 60 * 1000;
    fs.writeFileSync(`${stampFile}.alerts.json`, JSON.stringify(state));
    await runFreshness(['freshness', '--stamp-file', stampFile, '--max-age-hours', '36', '--notify-command', s.command]);
    expect(s.count()).toBe(2);
  });

  itOnPosix('--realert-after-hours 0 alerts once per incident and never reminds', async () => {
    const dir = makeTempDir();
    const stampFile = staleStamp(dir);
    const s = sink(dir);
    await runFreshness(['freshness', '--stamp-file', stampFile, '--max-age-hours', '36', '--realert-after-hours', '0', '--notify-command', s.command]);
    const state = JSON.parse(fs.readFileSync(`${stampFile}.alerts.json`, 'utf8'));
    state.check.lastAlertAtMs = Date.now() - 1000 * 60 * 60 * 1000;
    fs.writeFileSync(`${stampFile}.alerts.json`, JSON.stringify(state));
    expect(await runFreshness(['freshness', '--stamp-file', stampFile, '--max-age-hours', '36', '--realert-after-hours', '0', '--notify-command', s.command])).toBe(1);
    expect(s.count()).toBe(1);
  });

  itOnPosix('sends exactly one recovery notice when the backup comes back, then stays quiet', async () => {
    const dir = makeTempDir();
    const stampFile = staleStamp(dir);
    const s = sink(dir);
    await runFreshness(['freshness', '--stamp-file', stampFile, '--max-age-hours', '36', '--notify-command', s.command]);
    writeSuccessStamp(stampFile, new Date());
    expect(await runFreshness(['freshness', '--stamp-file', stampFile, '--max-age-hours', '36', '--notify-command', s.command])).toBeUndefined();
    expect(s.count()).toBe(2); // the alert, then the recovery
    for (let i = 0; i < 3; i += 1) {
      await runFreshness(['freshness', '--stamp-file', stampFile, '--max-age-hours', '36', '--notify-command', s.command]);
    }
    expect(s.count()).toBe(2); // healthy runs say nothing
    expect(readState(stampFile)).toMatchObject({ notif: 'healthy' });
  });

  itOnPosix('a check that CANNOT RUN is crit, not unknown — a permanently dead checker keeps alerting', async () => {
    const dir = makeTempDir();
    const stateFile = path.join(dir, 'remote.alerts.json');
    const s = sink(dir);
    // No rclone binary in this runtime: the remote check throws, which is the
    // dead-man's-switch case. Mapped to `unknown` it would HOLD forever and stay
    // silent; mapped to crit it alerts and reminds like any other failure.
    await runFreshness(['freshness', '--remote', 'r2:bucket/path', '--state-file', stateFile, '--realert-after-hours', '0', '--notify-command', s.command]);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')).check;
    expect(state.notif).toBe('alerted');
    expect(state.lastAlertedStatus).toBe('crit');
    expect(s.count()).toBe(1);
  });

  itOnPosix('a corrupt state file reads as a first run rather than crashing or going silent', async () => {
    const dir = makeTempDir();
    const stampFile = staleStamp(dir);
    const s = sink(dir);
    fs.writeFileSync(`${stampFile}.alerts.json`, '{not json at all');
    expect(await runFreshness(['freshness', '--stamp-file', stampFile, '--max-age-hours', '36', '--notify-command', s.command])).toBe(1);
    expect(s.count()).toBe(1);
  });

  itOnPosix('with no state file to derive, it warns and keeps the old alert-every-run behaviour', async () => {
    const dir = makeTempDir();
    const s = sink(dir);
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (msg?: unknown) => { warnings.push(String(msg)); };
    try {
      for (let i = 0; i < 3; i += 1) {
        await runFreshness(['freshness', '--remote', 'r2:bucket/path', '--notify-command', s.command]);
      }
    } finally {
      console.warn = warn;
    }
    expect(warnings.join('\n')).toMatch(/suppression disabled/);
    expect(s.count()).toBe(3); // unsuppressed, exactly as before this feature
  });

  itOnPosix('an undelivered alert is retried next run instead of being recorded as sent', async () => {
    const dir = makeTempDir();
    const stampFile = staleStamp(dir);
    const failing = 'exit 7'; // notify-command that always fails
    await runFreshness(['freshness', '--stamp-file', stampFile, '--max-age-hours', '36', '--notify-command', failing]);
    // Nothing got through, so the state must NOT claim we alerted.
    expect(readState(stampFile).notif).toBe('healthy');
    const s = sink(dir);
    await runFreshness(['freshness', '--stamp-file', stampFile, '--max-age-hours', '36', '--notify-command', s.command]);
    expect(s.count()).toBe(1); // re-fired rather than waiting out the interval
  });
});
