import { createRequire } from 'module';
import { describe, expect, it, vi } from 'vitest';

import { dbBackup } from './helpers';

const { readCrontab, planCrontabBlock } = createRequire(import.meta.url)('../crontab.js') as {
  readCrontab: (run?: (...args: unknown[]) => unknown) => string;
  planCrontabBlock: (
    text: string,
    block: { start: string; end: string; lines: string[] },
    replacements?: { lines?: string[]; blocks?: Array<{ start: string; end: string }> },
  ) => { text: string; warnings: string[] };
};
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
  "58 0 * * 0 cd '/srv/app' && ( set -a && . /etc/db-backup/s3.env && set +a && npm run backup ) >> '/srv/app-backups/backup.log' 2>&1",
  "30 4 * * 0 cd '/srv/app' && ( npm run ops:restore-drill -- --latest ) >> '/srv/app-backups/drill.log' 2>&1",
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
      isDirectory: () => true,
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
    ['even backslashes before percent', withJob({ command: 'date +\\\\%F' }), /jobs\[0\]\.command: has an unescaped %/],
    ['word-leading hash', withJob({ command: 'npm run backup # nightly' }), /jobs\[0\]\.command: has a # starting a word/],
    ['backslash in cwd', { ...SCHEDULE, cwd: '/srv/a\\b' }, /cwd: must not contain a newline, % or backslash/],
    ['percent in log', withJob({ log: '/var/log/%d.log' }), /jobs\[0\]\.log: must not contain/],
    ['backslash in log', withJob({ log: '/var/log/a\\b.log' }), /jobs\[0\]\.log: must not contain/],
    ['relative log', withJob({ log: 'backup.log' }), /jobs\[0\]\.log: must be an absolute path/],
    ['missing log', withJob({ log: undefined }), /jobs\[0\]\.log: must be a non-empty string/],
    ['after unknown id', withJob({ after: 'nope' }), /jobs\[0\]\.after: no job with id "nope"/],
    ['after self', withJob({ after: 'backup' }), /jobs\[0\]\.after: a job cannot run after itself/],
  ])('rejects %s naming the field', (_label, schedule, message) => {
    expect(() => validateSchedule(schedule)).toThrow(message);
  });

  it('accepts an escaped percent and a mid-word hash', () => {
    expect(() => validateSchedule(withJob({ command: 'date +\\%F' }))).not.toThrow();
    expect(() => validateSchedule(withJob({ command: 'echo a#b "$#"' }))).not.toThrow();
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
      ['a full-range day-of-month on the drill', '0 3 * * 0', '0 5 1-31 * 0'],
      ['a full-range month on the backup', '0 3 * 1-12 0', '0 5 * * 0'],
    ])('refuses rather than guesses with %s', (_label, backupCron, drillCron) => {
      expect(() => validateSchedule(ordered(backupCron, drillCron))).toThrow(/cannot prove the ordering/);
    });
  });
});

describe('renderScheduleBlock', () => {
  it('renders marked lines with shell-quoted cwd and log', () => {
    expect(renderScheduleBlock(SCHEDULE).lines).toEqual(BLOCK_LINES.slice(1, 3));
  });

  it.each(['a || b', 'a; b'])('keeps the cd guard and the log for %s', (command) => {
    const [line] = renderScheduleBlock({ name: 'app', cwd: '/srv/app', jobs: [{ ...BACKUP_JOB, command }] }).lines;
    expect(line).toBe(`58 0 * * 0 cd '/srv/app' && ( ${command} ) >> '/srv/app-backups/backup.log' 2>&1`);
  });

  it("escapes a single quote in cwd and log", () => {
    const rendered = renderScheduleBlock({
      name: 'app',
      cwd: "/srv/o'brien",
      jobs: [{ ...BACKUP_JOB, log: "/var/log/it's.log" }],
    });
    expect(rendered.lines[0]).toContain(`cd '/srv/o'\\''brien' && (`);
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

  it('ignores --replace-line matches inside its own block, so the same flag keeps working on every deploy', () => {
    const installed = replaceCrontabBlock(HOST_CRONTAB, block(), { lines: ['npm run backup'] });
    const plan = planCrontabBlock(installed, block(), { lines: ['npm run backup'] });
    expect(plan.text).toBe(installed);
    expect(plan.warnings.join('\n')).toMatch(/matched no line \(already migrated\)/);
  });

  it("refuses a --replace-line that matches inside another app's marked block", () => {
    const other = ['# db-backup:other', "0 1 * * 0 cd '/srv/other' && ( npm run backup ) >> '/l' 2>&1", '# /db-backup:other'];
    const text = `${HOST_CRONTAB}${other.join('\n')}\n`;
    expect(() => replaceCrontabBlock(text, block(), { lines: ['# db-backup-nightly', 'srv/other'] })).toThrow(
      /matches a line inside block db-backup:other/,
    );
  });

  it('refuses a --replace-line that matches inside a generic marked block', () => {
    expect(() => replaceCrontabBlock(HOST_CRONTAB, block(), { lines: ['run-monitor.sh'] })).toThrow(
      /matches a line inside block app-monitor-5m/,
    );
  });

  it('never matches an environment line, so PATH= survives a matching substring', () => {
    const next = replaceCrontabBlock(HOST_CRONTAB, block(), { lines: ['db-backup-nightly'] });
    expect(next).toContain('PATH=/usr/local/bin:/usr/bin:/bin');
    expect(() => replaceCrontabBlock('PATH=/usr/bin\n', block(), { lines: ['/usr/bin'] })).toThrow(/matched no crontab entry line/);
  });

  it('treats zero matches as a warning once its block is installed, and an error before', () => {
    const installed = replaceCrontabBlock(HOST_CRONTAB, block(), { lines: ['db-backup-nightly'] });
    const replacements = { lines: ['db-backup-nightly'], blocks: OLD_BLOCKS.slice(0, 1) };
    const plan = planCrontabBlock(installed, block(), replacements);
    expect(plan.text).toBe(installed);
    expect(plan.warnings).toHaveLength(2);
    expect(() => replaceCrontabBlock(HOST_CRONTAB, block(), { lines: ['db-backup-nighlty'] })).toThrow(
      /matched no crontab entry line and the schedule is not installed yet/,
    );
    expect(() => replaceCrontabBlock(HOST_CRONTAB, block(), { blocks: OLD_BLOCKS })).toThrow(
      /matched no block and the schedule is not installed yet/,
    );
  });

  it('still removes a single match and fails on two once its block is installed', () => {
    const installed = replaceCrontabBlock(HOST_CRONTAB, block(), { lines: ['db-backup-nightly'] });
    const withLegacy = `${installed}0 3 * * * npm run backup # old-tag\n`;
    expect(replaceCrontabBlock(withLegacy, block(), { lines: ['old-tag'] })).toBe(installed);
    const twice = `${withLegacy}0 4 * * * npm run backup # old-tag\n`;
    expect(() => replaceCrontabBlock(twice, block(), { lines: ['old-tag'] })).toThrow(/matched 2 crontab entry lines, expected at most 1/);
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
      expect(closeTo(HOST_CRONTAB, { lines: ['no-such-job'] })).toThrow(/matched no crontab entry line/);
    });

    it('on a --replace-line matching two lines', () => {
      const text = '0 3 * * * npm run backup\n0 4 * * * npm run backup\n';
      expect(closeTo(text, { lines: ['npm run backup'] })).toThrow(/matched 2 crontab entry lines, expected at most 1/);
    });

    it('on a --replace-line that only matches a comment', () => {
      expect(closeTo('# npm run backup\n', { lines: ['npm run backup'] })).toThrow(/matched no crontab entry line/);
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
      isDirectory: () => true,
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
        isDirectory: () => true,
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
    const missing = { isDirectory: (directory: string) => directory !== '/srv/app' };
    const real = install('', {}, missing);
    expect(real.run).toThrow(/cwd \/srv\/app is not an existing directory/);
    expect(real.crontab.state.writes).toEqual([]);
    const dry = install('', { dryRun: true }, missing).run();
    expect(dry.warnings).toEqual(['cwd /srv/app is not an existing directory']);
  });

  it('refuses a real install when a log directory is missing, and only warns on a dry run', () => {
    const missing = { isDirectory: (directory: string) => directory !== '/srv/app-backups' };
    const real = install('', {}, missing);
    expect(real.run).toThrow(/log directory \/srv\/app-backups is not an existing directory/);
    expect(real.crontab.state.writes).toEqual([]);
    const dry = install('', { dryRun: true }, missing).run();
    expect(dry.warnings).toEqual(['log directory /srv/app-backups is not an existing directory']);
  });

  it('keeps --replace-line and --replace-block in the hook: the rerun is a no-op that writes nothing', () => {
    const options = { replaceLines: ['db-backup-nightly'], replaceBlocks: OLD_BLOCKS };
    const crontab = fakeCrontab(`${HOST_CRONTAB}${TOWERPOWER_CRONTAB}`);
    const deps = {
      readFile: () => JSON.stringify(SCHEDULE),
      isDirectory: () => true,
      getUid: () => 1000,
      read: crontab.read,
      write: crontab.write,
    };
    expect(installSchedule(options, deps)).toMatchObject({ changed: true, written: true });
    const rerun = installSchedule(options, deps);
    expect(rerun).toMatchObject({ changed: false, written: false });
    expect(rerun.warnings).toHaveLength(3);
    expect(crontab.state.writes).toHaveLength(1);
  });

  it('refuses to write when the crontab changed after it was planned against', () => {
    const crontab = fakeCrontab(HOST_CRONTAB);
    let reads = 0;
    const racing = () => {
      reads += 1;
      return reads === 1 ? HOST_CRONTAB : `${HOST_CRONTAB}0 9 * * * someone-else\n`;
    };
    const run = () =>
      installSchedule({}, {
        readFile: () => JSON.stringify(SCHEDULE),
        isDirectory: () => true,
        getUid: () => 1000,
        read: racing,
        write: crontab.write,
      });
    expect(run).toThrow(/crontab changed while the new schedule was being planned/);
    expect(crontab.state.writes).toEqual([]);
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

describe('readCrontab', () => {
  const failing = (fields: Record<string, unknown>) => () => {
    throw Object.assign(new Error('Command failed'), fields);
  };

  it('returns the text crontab -l prints', () => {
    expect(readCrontab(() => HOST_CRONTAB)).toBe(HOST_CRONTAB);
  });

  it('treats exit 1 with "no crontab for x" as empty', () => {
    expect(readCrontab(failing({ status: 1, stderr: 'no crontab for app\n' }))).toBe('');
  });

  it('throws on exit 1 with "not allowed"', () => {
    expect(() => readCrontab(failing({ status: 1, stderr: 'You (app) are not allowed to use this program (crontab)\n' }))).toThrow(
      /Command failed/,
    );
  });

  it('throws when the crontab binary is missing', () => {
    expect(() => readCrontab(failing({ code: 'ENOENT', errno: -2 }))).toThrow(/Command failed/);
  });

  it.each([
    ['a literal \\r at the end of a line', '0 3 * * * x\\r\n'],
    ['a literal \\b', '0 3 * * * grep \\bfoo\n'],
  ])('refuses %s', (_label, text) => {
    expect(() => readCrontab(() => text)).toThrow('crontab contains escaped control characters; fix by hand');
  });

  it('keeps a real carriage return as ordinary text rather than normalising it', () => {
    expect(readCrontab(() => '0 3 * * * x\r\n')).toBe('0 3 * * * x\r\n');
  });
});
