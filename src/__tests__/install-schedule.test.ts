import { describe, expect, it, vi } from 'vitest';

import { dbBackup } from './helpers';

const { validateSchedule, renderScheduleBlock, replaceCrontabBlock, installSchedule, runCli } = dbBackup;

const BACKUP_JOB = {
  id: 'backup',
  cron: '58 0 * * 0',
  command: 'set -a && . /etc/db-backup/s3.env && set +a && npm run backup',
  log: '/srv/app-backups/backup.log',
};
const DRILL_JOB = {
  id: 'drill',
  cron: '30 4 * * 0',
  command: 'npm run ops:restore-drill -- --latest',
  log: '/srv/app-backups/drill.log',
  after: 'backup',
};
const SCHEDULE = { name: 'app', cwd: '/srv/app', jobs: [BACKUP_JOB, DRILL_JOB] };

const BLOCK_LINES = [
  '# db-backup:app',
  "58 0 * * 0 cd '/srv/app' && set -a && . /etc/db-backup/s3.env && set +a && npm run backup >> '/srv/app-backups/backup.log' 2>&1",
  "30 4 * * 0 cd '/srv/app' && npm run ops:restore-drill -- --latest >> '/srv/app-backups/drill.log' 2>&1",
  '# /db-backup:app',
];

const MONITOR_BLOCK = [
  '# app-monitor-5m',
  '*/5 * * * * /srv/app/run-monitor.sh >> /var/log/app-monitor.log 2>&1',
  '# /app-monitor-5m',
];

// A host crontab's shape: header, a legacy bare backup line, then PATH set mid-file for later entries.
const HOST_CRONTAB = [
  '# m h dom mon dow command',
  'MAILTO=""',
  '0 3 * * * cd /srv/app && npm run backup >> /var/log/app-backup.log 2>&1 # db-backup-nightly',
  'PATH=/usr/local/bin:/usr/bin:/bin',
  ...MONITOR_BLOCK,
  '',
].join('\n');

const TOWERPOWER_CRONTAB = [
  '# towerpower-backup-daily',
  '0 3 * * * cd /srv/app && npm run backup >> /b/backup.log 2>&1',
  '# /towerpower-backup-daily',
  'SHELL=/bin/bash',
  ...MONITOR_BLOCK,
  '# towerpower-restore-drill-weekly',
  '30 4 * * 0 cd /srv/app && npm run ops:restore-drill >> /b/drill.log 2>&1',
  '# /towerpower-restore-drill-weekly',
  '',
].join('\n');

const OLD_BLOCKS = [
  { start: '# towerpower-backup-daily', end: '# /towerpower-backup-daily' },
  { start: '# towerpower-restore-drill-weekly', end: '# /towerpower-restore-drill-weekly' },
];

function block() {
  return renderScheduleBlock(SCHEDULE);
}

function fakeCrontab(initial: string) {
  const state = { text: initial, writes: [] as string[] };
  return {
    state,
    read: () => state.text,
    write: (content: string) => {
      state.writes.push(content);
      state.text = content;
    },
  };
}

function install(
  initial: string,
  options: Record<string, unknown> = {},
  deps: Record<string, unknown> = {},
  schedule: unknown = SCHEDULE,
) {
  const crontab = fakeCrontab(initial);
  const run = () =>
    installSchedule(options, {
      readFile: () => JSON.stringify(schedule),
      exists: () => true,
      getUid: () => 1000,
      read: crontab.read,
      write: crontab.write,
      ...deps,
    });
  return { crontab, run };
}

describe('validateSchedule', () => {
  const withJob = (job: Record<string, unknown>) => ({ ...SCHEDULE, jobs: [{ ...BACKUP_JOB, ...job }] });

  it('accepts the documented shape', () => {
    expect(validateSchedule(SCHEDULE).jobs.map((job) => job.id)).toEqual(['backup', 'drill']);
  });

  it.each([
    ['name', { ...SCHEDULE, name: 'My App' }, /name: must match/],
    ['cwd', { ...SCHEDULE, cwd: 'srv/app' }, /cwd: must be an absolute path/],
    ['jobs', { ...SCHEDULE, jobs: [] }, /jobs: must be a non-empty array/],
    ['unknown key', { ...SCHEDULE, jobz: [] }, /schedule: unknown key\(s\) jobz/],
    ['job unknown key', withJob({ afer: 'x' }), /jobs\[0\]: unknown key\(s\) afer/],
    ['cron shortcut', withJob({ cron: '@daily' }), /jobs\[0\]\.cron: must be 5 fields/],
    ['cron field count', withJob({ cron: '0 3 * *' }), /jobs\[0\]\.cron: must have exactly 5 fields, got 4/],
    ['cron range', withJob({ cron: '75 3 * * *' }), /jobs\[0\]\.cron: minute field "75" is outside 0-59/],
    ['cron weekday name', withJob({ cron: '0 3 * * sun' }), /jobs\[0\]\.cron/],
    ['empty command', withJob({ command: '  ' }), /jobs\[0\]\.command: must be a non-empty string/],
    ['percent in command', withJob({ command: "date +%F" }), /jobs\[0\]\.command: has an unescaped %/],
    ['relative log', withJob({ log: 'backup.log' }), /jobs\[0\]\.log: must be an absolute path/],
    ['missing log', withJob({ log: undefined }), /jobs\[0\]\.log: must be a non-empty string/],
    ['after unknown id', withJob({ after: 'nope' }), /jobs\[0\]\.after: no job with id "nope"/],
    ['after self', withJob({ after: 'backup' }), /jobs\[0\]\.after: a job cannot run after itself/],
  ])('rejects %s naming the field', (_label, schedule, message) => {
    expect(() => validateSchedule(schedule)).toThrow(message);
  });

  it('accepts an escaped percent', () => {
    expect(() => validateSchedule(withJob({ command: 'date +\\%F' }))).not.toThrow();
  });

  it('rejects duplicate ids', () => {
    const duplicated = { ...SCHEDULE, jobs: [BACKUP_JOB, { ...DRILL_JOB, id: 'backup', after: undefined }] };
    expect(() => validateSchedule(duplicated)).toThrow(/jobs\[1\]\.id: duplicate id "backup"/);
  });

  describe('after ordering', () => {
    const ordered = (backupCron: string, drillCron: string) => ({
      ...SCHEDULE,
      jobs: [
        { ...BACKUP_JOB, cron: backupCron },
        { ...DRILL_JOB, cron: drillCron },
      ],
    });

    it.each([
      ['same minute', '30 4 * * 0', '30 4 * * 0'],
      ['earlier the same day', '30 4 * * 0', '0 4 * * 0'],
      ['drill daily, backup Sunday later', '0 5 * * 0', '0 4 * * *'],
      ['overlapping weekday sets', '0 4 * * 1-5', '0 3 * * 5,6'],
    ])('refuses a drill at or before the backup: %s', (_label, backupCron, drillCron) => {
      expect(() => validateSchedule(ordered(backupCron, drillCron))).toThrow(
        /jobs\[1\]\.after: "drill" .* must run strictly later than "backup"/,
      );
    });

    it('accepts a later drill, including daily weekday sets and weekday 7 as Sunday', () => {
      expect(() => validateSchedule(ordered('58 0 * * 0', '0 1 * * 7'))).not.toThrow();
      expect(() => validateSchedule(ordered('0 3 * * *', '30 4 * * *'))).not.toThrow();
    });

    it('accepts days that never coincide', () => {
      expect(() => validateSchedule(ordered('0 5 * * 0', '0 4 * * 1'))).not.toThrow();
    });

    it.each([
      ['a range in the minute field', '0-30 3 * * 0', '0 4 * * 0'],
      ['a step in the hour field', '0 */2 * * 0', '0 4 * * 0'],
      ['a day-of-month restriction', '0 3 1 * 0', '0 4 * * 0'],
      ['a month restriction', '0 3 * 1 0', '0 4 * * 0'],
    ])('refuses rather than guesses with %s', (_label, backupCron, drillCron) => {
      expect(() => validateSchedule(ordered(backupCron, drillCron))).toThrow(/cannot prove the ordering/);
    });
  });
});

describe('renderScheduleBlock', () => {
  it('renders marked lines with shell-quoted cwd and log', () => {
    expect(renderScheduleBlock(SCHEDULE).lines).toEqual(BLOCK_LINES.slice(1, 3));
  });

  it("escapes a single quote in cwd and log", () => {
    const rendered = renderScheduleBlock({
      name: 'app',
      cwd: "/srv/o'brien",
      jobs: [{ ...BACKUP_JOB, log: "/var/log/it's.log" }],
    });
    expect(rendered.lines[0]).toContain(`cd '/srv/o'\\''brien' &&`);
    expect(rendered.lines[0]).toContain(`>> '/var/log/it'\\''s.log' 2>&1`);
  });
});

describe('replaceCrontabBlock', () => {
  it('appends to an empty crontab', () => {
    expect(replaceCrontabBlock('', block())).toBe(`${BLOCK_LINES.join('\n')}\n`);
  });

  it('appends after a blank line to a crontab without a block, keeping the rest byte-exact', () => {
    const current = HOST_CRONTAB;
    const next = replaceCrontabBlock(current, block());
    expect(next.startsWith(current)).toBe(true);
    expect(next.endsWith(`${BLOCK_LINES.join('\n')}\n`)).toBe(true);
  });

  it('replaces a legacy line in place so a mid-file PATH= stays below the block', () => {
    const next = replaceCrontabBlock(HOST_CRONTAB, block(), { lines: ['# db-backup-nightly'] });
    expect(next).toBe(
      [
        '# m h dom mon dow command',
        'MAILTO=""',
        ...BLOCK_LINES,
        'PATH=/usr/local/bin:/usr/bin:/bin',
        ...MONITOR_BLOCK,
        '',
      ].join('\n'),
    );
  });

  it('migrates towerpower-style marked blocks with --replace-block at the first one, leaving the monitor block byte-exact', () => {
    const next = replaceCrontabBlock(TOWERPOWER_CRONTAB, block(), { blocks: OLD_BLOCKS });
    expect(next).toBe([...BLOCK_LINES, 'SHELL=/bin/bash', ...MONITOR_BLOCK, ''].join('\n'));
  });

  it('replaces its own existing block in place and is idempotent', () => {
    const first = replaceCrontabBlock(HOST_CRONTAB, block(), { lines: ['db-backup-nightly'] });
    expect(replaceCrontabBlock(first, block())).toBe(first);
    const edited = renderScheduleBlock({ ...SCHEDULE, jobs: [{ ...BACKUP_JOB, cron: '1 1 * * 0' }] });
    const second = replaceCrontabBlock(first, edited);
    expect(second).toContain("1 1 * * 0 cd '/srv/app'");
    expect(second).not.toContain('ops:restore-drill');
    expect(second.indexOf('# db-backup:app')).toBe(first.indexOf('# db-backup:app'));
  });

  it('puts the block at the earliest removed item even when a later one is listed first', () => {
    const next = replaceCrontabBlock(TOWERPOWER_CRONTAB, block(), {
      blocks: [...OLD_BLOCKS].reverse(),
    });
    expect(next.indexOf('# db-backup:app')).toBe(0);
  });

  it('does not match --replace-line against lines inside its own block', () => {
    const installed = replaceCrontabBlock(HOST_CRONTAB, block(), { lines: ['db-backup-nightly'] });
    expect(() => replaceCrontabBlock(installed, block(), { lines: ['npm run backup'] })).toThrow(/matched 0 crontab entry lines/);
  });

  describe('fails closed', () => {
    const closeTo = (text: string, replacements = {}) => () => replaceCrontabBlock(text, block(), replacements);

    it('on a duplicate block', () => {
      const text = `${BLOCK_LINES.join('\n')}\n${BLOCK_LINES.join('\n')}\n`;
      expect(closeTo(text)).toThrow(/duplicate # db-backup:app markers/);
    });

    it('on an unpaired start or end', () => {
      expect(closeTo('# db-backup:app\n0 1 * * * x\n')).toThrow(/do not pair/);
      expect(closeTo('0 1 * * * x\n# /db-backup:app\n')).toThrow(/do not pair/);
    });

    it('on an end before its start', () => {
      expect(closeTo('# /db-backup:app\n# db-backup:app\n')).toThrow(/appears before/);
    });

    it('on another db-backup marker nested inside its block', () => {
      const text = '# db-backup:app\n# db-backup:other\n# /db-backup:other\n# /db-backup:app\n';
      expect(closeTo(text)).toThrow(/contains another db-backup marker/);
    });

    it('on a --replace-block that overlaps its own block', () => {
      const text = '# db-backup:app\n# old\n# /db-backup:app\n# /old\n';
      expect(closeTo(text, { blocks: [{ start: '# old', end: '# /old' }] })).toThrow(/overlap or nest/);
    });

    it('on a --replace-block with no block, duplicates, or no pair', () => {
      const old = { blocks: [{ start: '# old', end: '# /old' }] };
      expect(closeTo('0 1 * * * x\n', old)).toThrow(/matched no block/);
      expect(closeTo('# old\n# /old\n# old\n# /old\n', old)).toThrow(/duplicate/);
      expect(closeTo('# old\n0 1 * * * x\n', old)).toThrow(/do not pair/);
    });

    it('on a --replace-line matching no line', () => {
      expect(closeTo(HOST_CRONTAB, { lines: ['no-such-job'] })).toThrow(/matched 0 crontab entry lines, expected exactly 1/);
    });

    it('on a --replace-line matching two lines', () => {
      const text = '0 3 * * * npm run backup\n0 4 * * * npm run backup\n';
      expect(closeTo(text, { lines: ['npm run backup'] })).toThrow(/matched 2 crontab entry lines, expected exactly 1/);
    });

    it('on a --replace-line that only matches a comment', () => {
      expect(closeTo('# npm run backup\n', { lines: ['npm run backup'] })).toThrow(/matched 0/);
    });

    it('on two --replace-line values naming the same line', () => {
      expect(closeTo(HOST_CRONTAB, { lines: ['db-backup-nightly', 'npm run backup'] })).toThrow(/same crontab line/);
    });
  });
});

describe('installSchedule', () => {
  it('writes the block, re-reads it, and leaves unrelated lines byte-exact', () => {
    const { crontab, run } = install(HOST_CRONTAB, { replaceLines: ['db-backup-nightly'] });
    const result = run();
    expect(result).toMatchObject({ name: 'app', changed: true, written: true, dryRun: false });
    expect(crontab.state.writes).toHaveLength(1);
    expect(crontab.state.text).toContain(`${MONITOR_BLOCK.join('\n')}\n`);
    expect(result.diff).toContain('-0 3 * * * cd /srv/app && npm run backup');
    expect(result.diff).toContain('+# db-backup:app');
  });

  it('migrates towerpower blocks through --replace-block', () => {
    const { crontab, run } = install(TOWERPOWER_CRONTAB, { replaceBlocks: OLD_BLOCKS });
    run();
    expect(crontab.state.text).not.toContain('towerpower-backup-daily');
    expect(crontab.state.text).not.toContain('towerpower-restore-drill-weekly');
    expect(crontab.state.text.split('\n')[0]).toBe('# db-backup:app');
  });

  it('a rerun with no change does not write', () => {
    const { crontab, run } = install(HOST_CRONTAB, { replaceLines: ['db-backup-nightly'] });
    run();
    const rerun = installSchedule({}, {
      readFile: () => JSON.stringify(SCHEDULE),
      exists: () => true,
      getUid: () => 1000,
      read: crontab.read,
      write: crontab.write,
    });
    expect(rerun).toMatchObject({ changed: false, written: false, diff: '' });
    expect(crontab.state.writes).toHaveLength(1);
  });

  it('treats a missing crontab as empty', () => {
    const { crontab, run } = install('');
    run();
    expect(crontab.state.text).toBe(`${BLOCK_LINES.join('\n')}\n`);
  });

  it('dry run prints a diff and writes nothing', () => {
    const { crontab, run } = install(HOST_CRONTAB, { dryRun: true, replaceLines: ['db-backup-nightly'] });
    const result = run();
    expect(result).toMatchObject({ changed: true, written: false, dryRun: true });
    expect(result.diff.startsWith('--- crontab (current)\n+++ crontab (new)\n')).toBe(true);
    expect(crontab.state.writes).toEqual([]);
    expect(crontab.state.text).toBe(HOST_CRONTAB);
  });

  it('fails when the write does not read back as written', () => {
    const { crontab } = install(HOST_CRONTAB);
    expect(() =>
      installSchedule({}, {
        readFile: () => JSON.stringify(SCHEDULE),
        exists: () => true,
        getUid: () => 1000,
        read: crontab.read,
        write: () => undefined,
      }),
    ).toThrow(/re-reading it does not match/);
  });

  it('refuses to run as root before touching the crontab', () => {
    const read = vi.fn(() => '');
    const { run } = install('', {}, { getUid: () => 0, read });
    expect(run).toThrow(/must not run as root/);
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses a real install when cwd is missing, and only warns on a dry run', () => {
    const missing = { exists: () => false };
    const real = install('', {}, missing);
    expect(real.run).toThrow(/cwd \/srv\/app does not exist/);
    expect(real.crontab.state.writes).toEqual([]);
    const dry = install('', { dryRun: true }, missing).run();
    expect(dry.warnings).toEqual(['cwd /srv/app does not exist']);
  });

  describe('timezone lines', () => {
    const withTimezone = ['CRON_TZ=UTC', HOST_CRONTAB].join('\n');

    it('warn by default and still install', () => {
      const { crontab, run } = install(withTimezone);
      const result = run();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatch(/CRON_TZ=UTC.*Debian cron ignores/);
      expect(crontab.state.writes).toHaveLength(1);
    });

    it('fail under --strict with nothing written', () => {
      const { crontab, run } = install(withTimezone, { strict: true });
      expect(run).toThrow(/CRON_TZ=UTC.*--strict/);
      expect(crontab.state.writes).toEqual([]);
    });

    it('catch a TZ= line too', () => {
      expect(install('TZ=America/Denver\n', { strict: true }).run).toThrow(/TZ=America\/Denver/);
    });
  });

  it('names the schedule file in a validation failure', () => {
    const bad = install('', {}, {}, { ...SCHEDULE, cwd: 'relative' });
    expect(bad.run).toThrow(/db-backup\.schedule\.json: cwd: must be an absolute path/);
  });

  it('rejects an unreadable schedule file', () => {
    const unreadable = install('', {}, { readFile: () => { throw new Error('ENOENT'); } });
    expect(unreadable.run).toThrow(/cannot read schedule file .*db-backup\.schedule\.json: ENOENT/);
  });
});

describe('install-schedule CLI', () => {
  it('fails on a missing schedule file before reading any crontab', async () => {
    await expect(runCli(['install-schedule', '--config', '/nonexistent/db-backup.schedule.json'])).rejects.toThrow(
      /cannot read schedule file/,
    );
  });

  it('requires two different markers for --replace-block', async () => {
    await expect(runCli(['install-schedule', '--replace-block', '# only'])).rejects.toThrow(/--replace-block requires/);
    await expect(runCli(['install-schedule', '--replace-block', 'a=a'])).rejects.toThrow(/--replace-block requires/);
  });
});
