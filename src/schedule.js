const fs = require('fs');
const path = require('path');
const {
  normalizeCrontab,
  planCrontabBlock,
  crontabDiff,
  findTimezoneLines,
  readCrontab,
  writeCrontab,
} = require('./crontab');

const DEFAULT_SCHEDULE_FILENAME = 'db-backup.schedule.json';
const IDENTIFIER_PATTERN = /^[a-z0-9-]+$/;
const SCHEDULE_KEYS = ['name', 'cwd', 'jobs'];
const JOB_KEYS = ['id', 'cron', 'command', 'log', 'after'];
const CRON_FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
];

function fail(field, message) {
  throw new Error(`${field}: ${message}`);
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') fail(field, 'must be a non-empty string');
  return value;
}

function rejectUnknownKeys(object, allowed, field) {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail(field, `unknown key(s) ${unknown.join(', ')}; allowed: ${allowed.join(', ')}`);
}

function requireAbsolutePath(value, field) {
  requireString(value, field);
  if (!path.posix.isAbsolute(value)) fail(field, 'must be an absolute path');
  if (/[\r\n%\\]/.test(value)) fail(field, 'must not contain a newline, % or backslash');
  return value;
}

function expandCronField(text, { name, min, max }, jobField) {
  const values = new Set();
  for (const part of text.split(',')) {
    const match = /^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    const isStar = part.startsWith('*');
    if (!match || (!isStar && match[2] === undefined && match[3] !== undefined)) {
      fail(jobField, `${name} field "${text}" is not valid cron (digits, *, comma, range, step)`);
    }
    const low = isStar ? min : Number(match[1]);
    const high = isStar ? max : Number(match[2] ?? match[1]);
    const step = match[3] === undefined ? 1 : Number(match[3]);
    if (low < min || high > max || low > high || step < 1) {
      fail(jobField, `${name} field "${text}" is outside ${min}-${max}`);
    }
    for (let value = low; value <= high; value += step) values.add(name === 'day-of-week' ? value % 7 : value);
  }
  return values;
}

function parseCron(cron, jobField) {
  requireString(cron, jobField);
  if (/[^0-9*,\-/\s]/.test(cron)) fail(jobField, 'must be 5 fields of digits, *, comma, - and / (no @ shortcuts or names)');
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) fail(jobField, `must have exactly 5 fields, got ${parts.length}`);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = CRON_FIELDS.map((field, index) =>
    expandCronField(parts[index], field, jobField),
  );
  return { text: parts.join(' '), raw: parts, minute, hour, dayOfMonth, month, dayOfWeek };
}

function requireSafeCommand(command, field) {
  if (/\r|\n/.test(command)) fail(field, 'must be a single line');
  if (/(^|\s)#/.test(command)) fail(field, 'has a # starting a word (cron would comment out the rest of the line)');
  const unescaped = [...command.matchAll(/(\\*)%/g)].some((match) => match[1].length % 2 === 0);
  if (unescaped) fail(field, 'has an unescaped % (cron turns it into a newline); write \\%');
}

function onlyValue(values, label, field) {
  if (values.size !== 1) fail(field, `cannot prove the ordering: ${label} is not a single fixed value`);
  return [...values][0];
}

function assertRunsStrictlyLater(job, earlier, jobField) {
  const later = parseCron(job.cron, jobField);
  const before = parseCron(earlier.cron, `jobs[${earlier.id}].cron`);
  const literalStars = (cron) => cron.raw[2] === '*' && cron.raw[3] === '*';
  if (!literalStars(later) || !literalStars(before)) {
    fail(jobField, `cannot prove the ordering against "${earlier.id}": day-of-month and month must be a literal * on both jobs (cron ORs day-of-month with day-of-week otherwise)`);
  }
  const sharedDays = [...later.dayOfWeek].filter((day) => before.dayOfWeek.has(day));
  if (sharedDays.length === 0) return;
  const laterMinutes = onlyValue(later.hour, 'hour', jobField) * 60 + onlyValue(later.minute, 'minute', jobField);
  const earlierMinutes = onlyValue(before.hour, `${earlier.id} hour`, jobField) * 60 + onlyValue(before.minute, `${earlier.id} minute`, jobField);
  if (laterMinutes <= earlierMinutes) {
    fail(jobField, `"${job.id}" (${job.cron}) must run strictly later than "${earlier.id}" (${earlier.cron}) on every day both run`);
  }
}

function validateJob(raw, index) {
  const field = `jobs[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(field, 'must be an object');
  rejectUnknownKeys(raw, JOB_KEYS, field);
  const id = requireString(raw.id, `${field}.id`);
  if (!IDENTIFIER_PATTERN.test(id)) fail(`${field}.id`, 'must match [a-z0-9-]+');
  const cron = parseCron(raw.cron, `${field}.cron`).text;
  const command = requireString(raw.command, `${field}.command`).trim();
  requireSafeCommand(command, `${field}.command`);
  const log = requireAbsolutePath(raw.log, `${field}.log`);
  if (raw.after !== undefined) requireString(raw.after, `${field}.after`);
  return { id, cron, command, log, ...(raw.after === undefined ? {} : { after: raw.after }) };
}

function validateSchedule(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('schedule', 'must be a JSON object');
  rejectUnknownKeys(raw, SCHEDULE_KEYS, 'schedule');
  const name = requireString(raw.name, 'name');
  if (!IDENTIFIER_PATTERN.test(name)) fail('name', 'must match [a-z0-9-]+');
  const cwd = requireAbsolutePath(raw.cwd, 'cwd');
  if (!Array.isArray(raw.jobs) || raw.jobs.length === 0) fail('jobs', 'must be a non-empty array');
  const jobs = raw.jobs.map(validateJob);
  const byId = new Map();
  jobs.forEach((job, index) => {
    if (byId.has(job.id)) fail(`jobs[${index}].id`, `duplicate id "${job.id}"`);
    byId.set(job.id, job);
  });
  jobs.forEach((job, index) => {
    if (job.after === undefined) return;
    const field = `jobs[${index}].after`;
    if (job.after === job.id) fail(field, 'a job cannot run after itself');
    const earlier = byId.get(job.after);
    if (!earlier) fail(field, `no job with id "${job.after}"`);
    assertRunsStrictlyLater(job, earlier, field);
  });
  return { name, cwd, jobs };
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function renderScheduleBlock(schedule) {
  const { name, cwd, jobs } = validateSchedule(schedule);
  return {
    start: `# db-backup:${name}`,
    end: `# /db-backup:${name}`,
    lines: jobs.map((job) => `${job.cron} cd ${shellQuote(cwd)} && ( ${job.command} ) >> ${shellQuote(job.log)} 2>&1`),
  };
}

function loadScheduleFile(filePath, readFile) {
  let text;
  try {
    text = readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(`cannot read schedule file ${filePath}: ${error.message}`);
  }
  try {
    return validateSchedule(JSON.parse(text));
  } catch (error) {
    throw new Error(`${filePath}: ${error.message}`);
  }
}

function isExistingDirectory(directory) {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function installSchedule(options = {}, deps = {}) {
  const {
    configPath = null,
    dryRun = false,
    replaceLines = [],
    replaceBlocks = [],
    strict = false,
    cwd = process.cwd(),
  } = options;
  const {
    readFile = fs.readFileSync,
    isDirectory = isExistingDirectory,
    getUid = () => process.getuid?.(),
    read = readCrontab,
    write = writeCrontab,
  } = deps;

  const filePath = path.resolve(cwd, configPath || DEFAULT_SCHEDULE_FILENAME);
  const schedule = loadScheduleFile(filePath, readFile);
  if (getUid() === 0) throw new Error('install-schedule edits the invoking user crontab and must not run as root; run it as the app service user');

  const warnings = [];
  const missingPaths = [
    ...(isDirectory(schedule.cwd) ? [] : [`cwd ${schedule.cwd} is not an existing directory`]),
    ...[...new Set(schedule.jobs.map((job) => path.posix.dirname(job.log)))]
      .filter((directory) => !isDirectory(directory))
      .map((directory) => `log directory ${directory} is not an existing directory`),
  ];
  if (missingPaths.length > 0 && !dryRun) {
    throw new Error(`${missingPaths.join('; ')}; refusing to install a schedule that cannot run (use --dry-run to preview)`);
  }
  warnings.push(...missingPaths);

  const current = read();
  const timezoneLines = findTimezoneLines(current);
  if (timezoneLines.length > 0) {
    const message = `crontab sets ${timezoneLines.map((line) => line.trim()).join(', ')}; Debian cron ignores TZ/CRON_TZ, so schedules run in host local time`;
    if (strict) throw new Error(`${message} (--strict)`);
    warnings.push(message);
  }

  const plan = planCrontabBlock(current, renderScheduleBlock(schedule), { lines: replaceLines, blocks: replaceBlocks });
  const next = plan.text;
  warnings.push(...plan.warnings);
  const changed = next !== normalizeCrontab(current);
  const diff = changed ? `--- crontab (current)\n+++ crontab (new)\n${crontabDiff(current, next)}` : '';
  const result = { name: schedule.name, dryRun, changed, written: false, diff, warnings };
  if (!changed || dryRun) return result;

  if (normalizeCrontab(read()) !== normalizeCrontab(current)) {
    throw new Error('crontab changed while the new schedule was being planned; nothing written, rerun to plan against the current crontab');
  }
  write(next);
  if (normalizeCrontab(read()) !== next) throw new Error('crontab was written but re-reading it does not match; check `crontab -l`');
  return { ...result, written: true };
}

module.exports = {
  DEFAULT_SCHEDULE_FILENAME,
  validateSchedule,
  renderScheduleBlock,
  installSchedule,
};
