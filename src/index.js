const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const zlib = require('zlib');
const { config: loadDotenv, parse: parseDotenv } = require('dotenv');
// Destructure into locals so module.exports can use shorthand keys — Node's
// cjs-module-lexer only detects named exports for identifier/shorthand forms, so
// `key: storage.fn` would be invisible to ESM `import { fn }` consumers.
const {
  MANIFEST_FILENAME,
  expandHome,
  isContainedWithin,
  resolveBackupDirectories,
  getBackupFallbackDirectory,
  resolveContainedBackupPath,
  readBackupManifest,
  appendBackupManifestEntry,
} = require('./storage');
const {
  resolveS3Credentials,
  signS3Request,
  uploadBackupToS3,
  verifyS3Object,
  pruneS3Backups,
  S3_SINGLE_PART_LIMIT_BYTES,
  DEFAULT_S3_KEEP,
  DEFAULT_S3_TIMEOUT_MS,
} = require('./s3-remote');

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_RETENTION_POLICY = {
  maxBackups: 6,
  dailySlots: 3,
  anchors: [
    {
      key: 'last_week',
      label: 'Last week',
      minAgeDays: 7,
      maxAgeDays: 20,
      targetAgeDays: 7,
    },
    {
      key: 'last_month',
      label: 'Last month',
      minAgeDays: 28,
      maxAgeDays: 59,
      targetAgeDays: 30,
    },
    {
      key: 'two_months_ago',
      label: '2 months ago',
      minAgeDays: 56,
      maxAgeDays: 89,
      targetAgeDays: 60,
    },
  ],
};

// Grandfather-father-son (GFS) tiers, expressed in the SAME "slots + anchors"
// vocabulary planRetention already speaks: `daily` is a literal slot count
// (identical mechanics to the legacy `dailySlots`), and `weekly`/`monthly`/
// `yearly` are generated as ANCHORS — one per bucket, each with
// targetAgeDays == minAgeDays so chooseAnchorCandidate's existing
// closest-to-target search degenerates into "pick the newest backup in this
// bucket". This is why GFS needs no parallel selection algorithm: it is the
// existing age-tier engine (selectSlotsAndAnchors below) fed a different
// slot count and a differently-generated anchor list. See selectGfs.
const GFS_TIER_PERIOD_DAYS = { weekly: 7, monthly: 30, yearly: 365 };

function buildGfsAnchors(policy) {
  const anchors = [];
  for (const unit of ['weekly', 'monthly', 'yearly']) {
    const count = policy[unit] || 0;
    const periodDays = GFS_TIER_PERIOD_DAYS[unit];
    for (let i = 0; i < count; i += 1) {
      const minAgeDays = i * periodDays;
      const maxAgeDays = (i + 1) * periodDays;
      anchors.push({
        key: `${unit}_${i + 1}`,
        label: `${unit.charAt(0).toUpperCase()}${unit.slice(1)} slot ${i + 1}`,
        minAgeDays,
        maxAgeDays,
        // The smallest age in the bucket wins the distance search below —
        // i.e. "the newest backup in this bucket", which is the GFS rule.
        targetAgeDays: minAgeDays,
      });
    }
  }
  return anchors;
}

const DEFAULT_ENV_FILES = {
  base: '.env',
  dev: '.env.local',
  prod: '.env.production',
};

const DEFAULT_OUTPUT_DIR = path.resolve(process.cwd(), 'backups', 'database');

// Strict non-negative integer parse: rejects fractional/suffixed strings that
// Number.parseInt would silently truncate ("1.5"->1, "3x"->3). Returns null for
// absent/empty/invalid input so callers own the error message.
function strictNonNegativeInt(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    return null;
  }
  return Number.parseInt(text, 10);
}

function parseArgs(argv) {
  const options = {
    command: 'backup',
    mode: process.env.NODE_ENV === 'production' ? 'prod' : 'dev',
    modeExplicit: false,
    outputDir: DEFAULT_OUTPUT_DIR,
    outputDirProvided: false,
    compressSqlite: true,
    json: false,
    hour: 3,
    minute: 0,
    backupFile: null,
    useLatest: false,
    createPreRestoreBackup: true,
    stopWritersCommand: null,
    startWritersCommand: null,
    allowOnlineRestore: false,
    skipVerify: false,
    allowMissing: false,
    maxBackups: null,
    dailySlots: null,
    keepLast: null,
    keepDays: null,
    retainDaily: null,
    retainWeekly: null,
    retainMonthly: null,
    retainYearly: null,
    retentionPolicyPath: null,
    destinations: [],
    dryRun: false,
    configPath: null,
    commandTimeoutMs: null,
    allowUnsafeCopy: false,
    passphraseFile: null,
    cipher: null,
    minBytes: null,
    stampFile: null,
    namePrefix: null,
    maxAgeHours: 36,
    remoteTarget: null,
    remoteKeep: null,
    rcloneConfig: null,
    s3Bucket: null,
    s3Prefix: null,
    s3Endpoint: null,
    s3Region: null,
    s3TimeoutMs: null,
    skipRemote: false,
    cronCommand: null,
    logPath: null,
    notifyCommand: null,
    notifyDiscord: null,
    notifyWebhook: null,
  };

  const commandArg = argv[0];
  if (
    commandArg === 'backup' ||
    commandArg === 'list' ||
    commandArg === 'prune' ||
    commandArg === 'cron' ||
    commandArg === 'restore' ||
    commandArg === 'freshness'
  ) {
    options.command = commandArg;
    argv = argv.slice(1);
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--prod') {
      options.mode = 'prod';
      options.modeExplicit = true;
      continue;
    }

    if (arg === '--dev') {
      options.mode = 'dev';
      options.modeExplicit = true;
      continue;
    }

    if (arg === '--output-dir') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('Missing value for --output-dir');
      }
      options.outputDir = path.resolve(process.cwd(), value);
      options.outputDirProvided = true;
      index += 1;
      continue;
    }

    if (arg === '--no-compress') {
      options.compressSqlite = false;
      continue;
    }

    if (arg === '--allow-missing') {
      options.allowMissing = true;
      continue;
    }

    if (arg === '--json') {
      options.json = true;
      continue;
    }

    if (arg === '--hour') {
      const value = Number.parseInt(argv[index + 1], 10);
      if (!Number.isInteger(value) || value < 0 || value > 23) {
        throw new Error('--hour must be an integer from 0 to 23');
      }
      options.hour = value;
      index += 1;
      continue;
    }

    if (arg === '--minute') {
      const value = Number.parseInt(argv[index + 1], 10);
      if (!Number.isInteger(value) || value < 0 || value > 59) {
        throw new Error('--minute must be an integer from 0 to 59');
      }
      options.minute = value;
      index += 1;
      continue;
    }

    if (arg === '--file' || arg === '--backup') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${arg}`);
      }
      options.backupFile = value;
      index += 1;
      continue;
    }

    if (arg === '--latest') {
      options.useLatest = true;
      continue;
    }

    if (arg === '--no-pre-backup') {
      options.createPreRestoreBackup = false;
      continue;
    }

    if (arg === '--stop-writers-cmd') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --stop-writers-cmd');
      options.stopWritersCommand = value;
      index += 1;
      continue;
    }

    if (arg === '--start-writers-cmd') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --start-writers-cmd');
      options.startWritersCommand = value;
      index += 1;
      continue;
    }

    // UNSAFE override: restore refuses by default when it cannot prove the
    // live SQLite database is quiescent. This forces it through anyway.
    if (arg === '--force-online') {
      options.allowOnlineRestore = true;
      continue;
    }

    // UNSAFE override: restore refuses by default when 'sqlite3' is
    // unavailable and the restored backup can't be integrity-checked. This
    // forces it through anyway, unverified.
    if (arg === '--skip-verify') {
      options.skipVerify = true;
      continue;
    }

    if (arg === '--max-backups') {
      const value = strictNonNegativeInt(argv[index + 1]);
      if (value === null || value < 1) {
        throw new Error('--max-backups must be an integer >= 1');
      }
      options.maxBackups = value;
      index += 1;
      continue;
    }

    if (arg === '--daily-slots') {
      const value = strictNonNegativeInt(argv[index + 1]);
      if (value === null) {
        throw new Error('--daily-slots must be an integer >= 0');
      }
      options.dailySlots = value;
      index += 1;
      continue;
    }

    if (arg === '--retain-daily') {
      const value = strictNonNegativeInt(argv[index + 1]);
      if (value === null) throw new Error('--retain-daily must be an integer >= 0');
      options.retainDaily = value;
      index += 1;
      continue;
    }

    if (arg === '--retain-weekly') {
      const value = strictNonNegativeInt(argv[index + 1]);
      if (value === null) throw new Error('--retain-weekly must be an integer >= 0');
      options.retainWeekly = value;
      index += 1;
      continue;
    }

    if (arg === '--retain-monthly') {
      const value = strictNonNegativeInt(argv[index + 1]);
      if (value === null) throw new Error('--retain-monthly must be an integer >= 0');
      options.retainMonthly = value;
      index += 1;
      continue;
    }

    if (arg === '--retain-yearly') {
      const value = strictNonNegativeInt(argv[index + 1]);
      if (value === null) throw new Error('--retain-yearly must be an integer >= 0');
      options.retainYearly = value;
      index += 1;
      continue;
    }

    if (arg === '--retention-policy') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --retention-policy');
      options.retentionPolicyPath = value;
      index += 1;
      continue;
    }

    if (arg === '--dest') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --dest');
      options.destinations.push(parseDestSpec(value));
      index += 1;
      continue;
    }

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--config') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --config');
      options.configPath = value;
      index += 1;
      continue;
    }

    if (arg === '--name-prefix') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --name-prefix');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
        throw new Error('--name-prefix must be alphanumeric with . _ - (it becomes part of a filename)');
      }
      options.namePrefix = value;
      index += 1;
      continue;
    }

    if (arg === '--remote') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --remote');
      options.remoteTarget = value;
      index += 1;
      continue;
    }

    if (arg === '--remote-keep') {
      const value = strictNonNegativeInt(argv[index + 1]);
      if (value === null || value < 1) throw new Error('--remote-keep must be an integer >= 1');
      options.remoteKeep = value;
      index += 1;
      continue;
    }

    if (arg === '--rclone-config') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --rclone-config');
      options.rcloneConfig = value;
      index += 1;
      continue;
    }

    if (arg === '--s3-bucket') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --s3-bucket');
      options.s3Bucket = value;
      index += 1;
      continue;
    }

    if (arg === '--s3-prefix') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --s3-prefix');
      options.s3Prefix = value;
      index += 1;
      continue;
    }

    if (arg === '--s3-endpoint') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --s3-endpoint');
      options.s3Endpoint = value;
      index += 1;
      continue;
    }

    if (arg === '--s3-region') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --s3-region');
      options.s3Region = value;
      index += 1;
      continue;
    }

    if (arg === '--s3-timeout') {
      const value = strictNonNegativeInt(argv[index + 1]);
      if (value === null || value < 1) throw new Error('--s3-timeout must be an integer >= 1 (seconds)');
      options.s3TimeoutMs = value * 1000;
      index += 1;
      continue;
    }

    if (arg === '--skip-remote') {
      options.skipRemote = true;
      continue;
    }

    if (arg === '--encrypt-passphrase-file') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --encrypt-passphrase-file');
      options.passphraseFile = value;
      index += 1;
      continue;
    }

    if (arg === '--cipher') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --cipher');
      options.cipher = value;
      index += 1;
      continue;
    }

    if (arg === '--min-bytes') {
      const value = strictNonNegativeInt(argv[index + 1]);
      if (value === null) throw new Error('--min-bytes must be an integer >= 0');
      options.minBytes = value;
      index += 1;
      continue;
    }

    if (arg === '--stamp-file') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --stamp-file');
      options.stampFile = value;
      index += 1;
      continue;
    }

    if (arg === '--max-age-hours') {
      const value = strictNonNegativeInt(argv[index + 1]);
      if (value === null || value < 1) throw new Error('--max-age-hours must be an integer >= 1');
      options.maxAgeHours = value;
      index += 1;
      continue;
    }

    if (arg === '--allow-unsafe-copy') {
      options.allowUnsafeCopy = true;
      continue;
    }

    if (arg === '--command-timeout') {
      const value = strictNonNegativeInt(argv[index + 1]);
      if (value === null || value < 1) {
        throw new Error('--command-timeout must be an integer >= 1 (seconds)');
      }
      options.commandTimeoutMs = value * 1000;
      index += 1;
      continue;
    }

    if (arg === '--keep-last') {
      const value = strictNonNegativeInt(argv[index + 1]);
      if (value === null || value < 1) {
        throw new Error('--keep-last must be an integer >= 1');
      }
      options.keepLast = value;
      index += 1;
      continue;
    }

    if (arg === '--keep-days') {
      const value = strictNonNegativeInt(argv[index + 1]);
      if (value === null || value < 1) {
        throw new Error('--keep-days must be an integer >= 1');
      }
      options.keepDays = value;
      index += 1;
      continue;
    }

    if (arg === '--command') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('Missing value for --command');
      }
      options.cronCommand = value;
      index += 1;
      continue;
    }

    if (arg === '--log-path') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('Missing value for --log-path');
      }
      options.logPath = value;
      index += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      options.command = 'help';
      continue;
    }

    if (arg === '--notify-discord') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --notify-discord');
      options.notifyDiscord = value;
      index += 1;
      continue;
    }

    if (arg === '--notify-webhook') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --notify-webhook');
      options.notifyWebhook = value;
      index += 1;
      continue;
    }

    if (arg === '--notify-command') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --notify-command');
      options.notifyCommand = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.remoteTarget && options.s3Bucket) {
    throw new Error(
      '--remote (rclone) and --s3-bucket (native S3/R2) are mutually exclusive; configure only one off-host remote.',
    );
  }

  return options;
}

function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function parseTimestampKey(timestampKey) {
  const match = timestampKey.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = match;
  return new Date(Date.UTC(
    Number.parseInt(year, 10),
    Number.parseInt(month, 10) - 1,
    Number.parseInt(day, 10),
    Number.parseInt(hour, 10),
    Number.parseInt(minute, 10),
    Number.parseInt(second, 10)
  ));
}

function commandExists(command, runner = execFileSync) {
  try {
    runner('sh', ['-lc', `command -v ${command}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Every external command this package runs (sqlite3, gzip, pg_dump, pg_restore)
// must be bounded: an unbounded execFileSync lets a hung binary block a nightly
// cron forever. The bound is injected once, here, rather than at each call site
// — a call site that forgets it is the failure mode we are eliminating.
// Generous by default because a large pg_dump is legitimately slow; tune with
// `runtime.commandTimeoutMs`, `DB_BACKUP_COMMAND_TIMEOUT_MS`, or
// `--command-timeout <seconds>`.
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

function resolveCommandTimeoutMs(value, env = process.env) {
  const read = (raw, label) => {
    if (raw === undefined || raw === null || raw === '') {
      return null;
    }
    const parsed = strictNonNegativeInt(raw);
    if (parsed === null || parsed < 1) {
      throw new Error(`${label} must be an integer >= 1 (milliseconds)`);
    }
    return parsed;
  };

  return (
    read(value, 'commandTimeoutMs') ??
    read(env.DB_BACKUP_COMMAND_TIMEOUT_MS, 'DB_BACKUP_COMMAND_TIMEOUT_MS') ??
    DEFAULT_COMMAND_TIMEOUT_MS
  );
}

function normalizeRuntime(runtime = {}) {
  const baseCommand = runtime.execFileSync || execFileSync;
  const commandTimeoutMs = resolveCommandTimeoutMs(runtime.commandTimeoutMs);

  // Defaults first, so an explicit per-call option still wins. `killSignal`
  // escalates past a SIGTERM the child may be ignoring.
  const runCommand = (command, args, options = {}) =>
    baseCommand(command, args, { timeout: commandTimeoutMs, killSignal: 'SIGKILL', ...options });

  return {
    execFileSync: runCommand,
    commandExists: runtime.commandExists || ((command) => commandExists(command, runCommand)),
    sleep: runtime.sleep || sleep,
    now: runtime.now || (() => new Date()),
    randomId: runtime.randomId || (() => `${Date.now()}-${Math.random().toString(16).slice(2)}`),
    commandTimeoutMs,
    // S3 remote seam: env is where S3 credentials are resolved from (never a
    // CLI flag — see resolveS3Credentials); fetchImpl is the injectable HTTP
    // layer tests use to avoid ever touching the network (defaults to the
    // real, async `fetch` in s3-remote.js — see runBackupJobAsync). The sync
    // `runBackupJob` never reaches this seam: it refuses an S3 remote outright.
    env: runtime.env || process.env,
    fetchImpl: runtime.fetchImpl || null,
    s3TimeoutMs: runtime.s3TimeoutMs ?? null,
  };
}

function parseSqlitePath(databaseUrl, cwd = process.cwd()) {
  const [withoutParams] = databaseUrl.split('?');
  let filePath = decodeURIComponent(withoutParams.slice('file:'.length));

  if (!filePath) {
    throw new Error('DATABASE_URL points to an empty SQLite file path.');
  }

  if (filePath.startsWith('///')) {
    filePath = filePath.slice(2);
  } else if (filePath.startsWith('//')) {
    filePath = filePath.slice(1);
  }

  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function detectDatabaseEngine(databaseUrl) {
  if (databaseUrl.startsWith('file:')) {
    return 'sqlite';
  }
  if (databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://')) {
    return 'postgres';
  }
  return 'unknown';
}

// The canonical prefixes. A consumer with an existing backup history under a
// different name (e.g. `myapp-<ts>.db.gpg`) sets `namePrefix` so the
// package adopts that history instead of orphaning it. The ENGINE is then read
// from the extension — `.db` is sqlite, `.dump` is postgres — which is
// unambiguous and independent of the prefix.
const CANONICAL_PREFIXES = { sqlite: 'sqlite-backup', postgres: 'postgres-backup' };

function resolveNamePrefix(engine, namePrefix) {
  return namePrefix || CANONICAL_PREFIXES[engine] || `db-backup-${engine}`;
}

function buildBackupFilename(engine, timestamp, compressSqlite, sequence = 1, namePrefix = null) {
  const suffix = sequence > 1 ? `-${sequence}` : '';
  const prefix = resolveNamePrefix(engine, namePrefix);
  if (engine === 'sqlite') {
    return `${prefix}-${timestamp}${suffix}.db${compressSqlite ? '.gz' : ''}`;
  }
  if (engine === 'postgres') {
    return `${prefix}-${timestamp}${suffix}.dump`;
  }
  return `${prefix}-${timestamp}${suffix}.bak`;
}

function buildUniqueBackupPath({ engine, timestamp, outputDir, compressSqlite = false, namePrefix = null }) {
  for (let sequence = 1; sequence < 1000; sequence += 1) {
    const fileName = buildBackupFilename(engine, timestamp, compressSqlite, sequence, namePrefix);
    const fullPath = path.join(outputDir, fileName);

    if (!fs.existsSync(fullPath)) {
      return { fileName, fullPath };
    }
  }

  throw new Error(`Unable to allocate a unique backup filename for ${engine} at ${timestamp}`);
}

function buildUniqueSqliteRawBackupPath({ timestamp, outputDir, compressSqlite, namePrefix = null }) {
  for (let sequence = 1; sequence < 1000; sequence += 1) {
    const rawFileName = buildBackupFilename('sqlite', timestamp, false, sequence, namePrefix);
    const rawFilePath = path.join(outputDir, rawFileName);
    const compressedFilePath = `${rawFilePath}.gz`;

    if (!fs.existsSync(rawFilePath) && (!compressSqlite || !fs.existsSync(compressedFilePath))) {
      return { rawFileName, rawFilePath };
    }
  }

  throw new Error(`Unable to allocate a unique SQLite backup filename for ${timestamp}`);
}

// `.gpg` is the outermost suffix: a backup is snapshotted, then optionally
// gzipped, then optionally encrypted. Restore unwinds in the reverse order.
//
// Engine comes from the EXTENSION, not the prefix, so a custom `namePrefix` still
// parses. Without an explicit prefix only the two canonical ones are accepted —
// widening the default would make an unrelated file in the backup directory (or
// another app's backups in a shared remote bucket) a prune candidate.
const BACKUP_NAME_PATTERN = /^(.+)-(\d{8}-\d{6}Z)(?:-(\d+))?\.(db|dump)(\.gz)?(\.gpg)?$/;

function parseBackupFileName(fileName, namePrefix = null) {
  const match = fileName.match(BACKUP_NAME_PATTERN);
  if (!match) {
    return null;
  }

  const [, prefix, timestampKey, sequence, extension, gz, gpg] = match;
  const engine = extension === 'db' ? 'sqlite' : 'postgres';
  const expected = namePrefix || CANONICAL_PREFIXES[engine];
  if (prefix !== expected) {
    return null;
  }

  return {
    prefix,
    engine,
    timestampKey,
    sequence: sequence ? Number.parseInt(sequence, 10) : 1,
    compressed: Boolean(gz),
    encrypted: Boolean(gpg),
  };
}

function loadEnvironment({
  mode = process.env.NODE_ENV === 'production' ? 'prod' : 'dev',
  cwd = process.cwd(),
  envFiles = DEFAULT_ENV_FILES,
  strictProductionEnv = true,
} = {}) {
  const initialDatabaseUrl = process.env.DATABASE_URL;
  const basePath = path.resolve(cwd, envFiles.base || DEFAULT_ENV_FILES.base);
  const modePath = path.resolve(cwd, mode === 'prod' ? (envFiles.prod || DEFAULT_ENV_FILES.prod) : (envFiles.dev || DEFAULT_ENV_FILES.dev));

  if (fs.existsSync(basePath)) {
    loadDotenv({ path: basePath });
  }

  if (fs.existsSync(modePath)) {
    loadDotenv({ path: modePath, override: true });
  }

  if (mode === 'prod' && strictProductionEnv && !initialDatabaseUrl) {
    const modeHasDatabaseUrl = fs.existsSync(modePath)
      ? Boolean(parseDotenv(fs.readFileSync(modePath, 'utf8')).DATABASE_URL)
      : false;

    if (!modeHasDatabaseUrl) {
      throw new Error('For production backups, set DATABASE_URL in .env.production (or export it in shell).');
    }
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(`DATABASE_URL is missing for mode "${mode}".`);
  }

  return {
    databaseUrl,
    mode,
    envPaths: {
      base: basePath,
      mode: modePath,
    },
  };
}

// Build a retention policy from CLI/env overrides, falling back to
// DEFAULT_RETENTION_POLICY. Retention has THREE exclusive shapes: the default
// age-tier (maxBackups/dailySlots over policy-owned anchors), the flat modes
// keep-last / keep-days, and GFS (retainDaily/Weekly/Monthly/Yearly, or a
// fully custom `retentionPolicyFile` object read from --retention-policy).
// The mode axis is resolved first — an explicit mode-selecting option wins
// over every other mode's knobs, and mixing two modes' options is an error
// rather than silently picking one. Precedence within a mode: explicit arg >
// env var > default.
function resolveRetentionPolicy({
  maxBackups,
  dailySlots,
  keepLast,
  keepDays,
  retainDaily,
  retainWeekly,
  retainMonthly,
  retainYearly,
  retentionPolicyFile,
  env = process.env,
} = {}) {
  const readInt = (value, label, min) => {
    if (value === undefined || value === null || value === '') {
      return null;
    }
    const parsed = strictNonNegativeInt(value);
    if (parsed === null || parsed < min) {
      throw new Error(`${label} must be an integer >= ${min}`);
    }
    return parsed;
  };

  // Mode axis, resolved before any numeric value. keepLast requires >= 1 so a
  // flat count can never mean "delete everything".
  const explicitKeepLast = readInt(keepLast, 'keepLast', 1);
  const explicitKeepDays = readInt(keepDays, 'keepDays', 1);
  const explicitAgeTier =
    readInt(maxBackups, 'maxBackups', 1) !== null || readInt(dailySlots, 'dailySlots', 0) !== null;
  const gfsCounts = [retainDaily, retainWeekly, retainMonthly, retainYearly];
  const explicitGfs = gfsCounts.some((value) => value !== undefined && value !== null && value !== '');
  const explicitPolicyFile = Boolean(retentionPolicyFile);
  const anyLegacyMode = explicitKeepLast !== null || explicitKeepDays !== null || explicitAgeTier;

  if (explicitPolicyFile && (anyLegacyMode || explicitGfs)) {
    throw new Error(
      '--retention-policy (a full custom policy file) cannot be combined with --retain-daily/' +
        '--retain-weekly/--retain-monthly/--retain-yearly, --keep-last, --keep-days, --max-backups, ' +
        'or --daily-slots; the file already specifies the entire policy.',
    );
  }
  if (explicitPolicyFile) {
    return retentionPolicyFile;
  }

  if (explicitGfs && anyLegacyMode) {
    throw new Error(
      '--retain-daily/--retain-weekly/--retain-monthly/--retain-yearly cannot be combined with ' +
        '--keep-last, --keep-days, --max-backups, or --daily-slots; choose one retention model.',
    );
  }
  if (explicitGfs) {
    return {
      mode: 'gfs',
      daily: readInt(retainDaily, 'retainDaily', 0) ?? 0,
      weekly: readInt(retainWeekly, 'retainWeekly', 0) ?? 0,
      monthly: readInt(retainMonthly, 'retainMonthly', 0) ?? 0,
      yearly: readInt(retainYearly, 'retainYearly', 0) ?? 0,
    };
  }

  if (explicitKeepLast !== null && explicitKeepDays !== null) {
    throw new Error('keep-last and keep-days are mutually exclusive');
  }
  if ((explicitKeepLast !== null || explicitKeepDays !== null) && explicitAgeTier) {
    throw new Error('keep-last/keep-days cannot be combined with maxBackups/dailySlots');
  }

  let resolvedKeepLast = explicitKeepLast;
  let resolvedKeepDays = explicitKeepDays;

  // An env var may select a flat mode only when NO explicit retention option was
  // given — otherwise a stale DB_BACKUP_KEEP_LAST would silently override an
  // explicit --max-backups, inverting the documented arg > env precedence.
  if (explicitKeepLast === null && explicitKeepDays === null && !explicitAgeTier) {
    const envKeepLast = readInt(env.DB_BACKUP_KEEP_LAST, 'DB_BACKUP_KEEP_LAST', 1);
    const envKeepDays = readInt(env.DB_BACKUP_KEEP_DAYS, 'DB_BACKUP_KEEP_DAYS', 1);
    if (envKeepLast !== null && envKeepDays !== null) {
      throw new Error('DB_BACKUP_KEEP_LAST and DB_BACKUP_KEEP_DAYS are mutually exclusive');
    }
    resolvedKeepLast = envKeepLast;
    resolvedKeepDays = envKeepDays;
  }

  if (resolvedKeepLast !== null) {
    return { mode: 'keep-last', keepLast: resolvedKeepLast };
  }
  if (resolvedKeepDays !== null) {
    return { mode: 'keep-days', keepDays: resolvedKeepDays };
  }

  // Age-tier axis (default).
  const resolvedMax =
    readInt(maxBackups, 'maxBackups', 1) ??
    readInt(env.DB_BACKUP_MAX_BACKUPS, 'DB_BACKUP_MAX_BACKUPS', 1);
  const resolvedDaily =
    readInt(dailySlots, 'dailySlots', 0) ??
    readInt(env.DB_BACKUP_DAILY_SLOTS, 'DB_BACKUP_DAILY_SLOTS', 0);

  if (resolvedMax === null && resolvedDaily === null) {
    return DEFAULT_RETENTION_POLICY;
  }

  return {
    ...DEFAULT_RETENTION_POLICY,
    maxBackups: resolvedMax ?? DEFAULT_RETENTION_POLICY.maxBackups,
    dailySlots: resolvedDaily ?? DEFAULT_RETENTION_POLICY.dailySlots,
  };
}

// ---------------------------------------------------------------------------
// Destinations: WHERE backups go, orthogonal to retention (HOW MANY/WHICH).
//
// Historically this package coupled the two: `--keep-last`/age-tier governed
// the local copy, and a completely separate flat `--remote-keep` count
// governed the remote copy — so local and remote could drift apart (a backup
// surviving on disk while already gone from S3, or vice versa). `destinations`
// is an explicit list of WHERE; the single `policy` resolved by
// resolveBackupOptions is WHICH — the same plan is applied at every
// destination once a GFS policy is configured (see resolveDestinationPolicy /
// runBackupJobAsync). Legacy `remote`/`s3`/`skipRemote` still work exactly as
// before: they map onto a `destinations` list under the hood (see
// resolveDestinations) so there is one engine, not two.
// ---------------------------------------------------------------------------
const DESTINATION_TYPES = ['local', 'rclone', 's3'];

function normalizeDestination(dest, cwd) {
  if (!dest || typeof dest !== 'object' || !DESTINATION_TYPES.includes(dest.type)) {
    throw new Error(
      `Invalid destination ${JSON.stringify(dest)}: "type" must be one of ${DESTINATION_TYPES.join(', ')}`,
    );
  }
  if (dest.type === 'local') {
    if (!dest.path) {
      throw new Error('A "local" destination requires "path"');
    }
    return { type: 'local', path: path.resolve(cwd, dest.path) };
  }
  if (dest.type === 'rclone') {
    const target = dest.target || dest.remote;
    if (!target) {
      throw new Error('A "rclone" destination requires "target" (or "remote")');
    }
    return {
      type: 'rclone',
      target,
      ...(dest.configFile ? { configFile: dest.configFile } : {}),
      ...(dest.keep ? { keep: dest.keep } : {}),
      verify: dest.verify !== false,
    };
  }
  // s3
  if (!dest.bucket) {
    throw new Error('An "s3" destination requires "bucket"');
  }
  return {
    type: 's3',
    bucket: dest.bucket,
    ...(dest.prefix ? { prefix: dest.prefix } : {}),
    ...(dest.endpoint ? { endpoint: dest.endpoint } : {}),
    ...(dest.region ? { region: dest.region } : {}),
    ...(dest.keep ? { keep: dest.keep } : {}),
  };
}

// CLI form: --dest <type:spec>, repeatable. `type` is everything before the
// FIRST colon (local|s3|rclone); `spec` is everything after — deliberately
// not split further on colons, since an rclone target is itself
// `remote:path` and contains its own colon (e.g. --dest rclone:r2:backups/app
// -> target "r2:backups/app").
//   local:<path>
//   s3:<bucket>[/<prefix>]
//   rclone:<remote-target>
function parseDestSpec(value) {
  const separatorIndex = value.indexOf(':');
  if (separatorIndex === -1) {
    throw new Error(
      `Invalid --dest value "${value}": expected type:spec, e.g. local:/path, s3:bucket/prefix, rclone:remote:path`,
    );
  }
  const type = value.slice(0, separatorIndex);
  const spec = value.slice(separatorIndex + 1);
  if (!spec) {
    throw new Error(`Invalid --dest value "${value}": missing spec after "${type}:"`);
  }
  if (type === 'local') {
    return { type: 'local', path: spec };
  }
  if (type === 's3') {
    const slashIndex = spec.indexOf('/');
    return slashIndex === -1
      ? { type: 's3', bucket: spec }
      : { type: 's3', bucket: spec.slice(0, slashIndex), prefix: spec.slice(slashIndex + 1) };
  }
  if (type === 'rclone') {
    return { type: 'rclone', target: spec };
  }
  throw new Error(`Invalid --dest type "${type}": expected local, s3, or rclone`);
}

function loadJsonFile(filePath, label, cwd = process.cwd()) {
  const resolvedPath = path.resolve(cwd, filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`${label} not found: ${resolvedPath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to parse ${label} at ${resolvedPath}: ${error.message}`);
  }
  return parsed;
}

const DEFAULT_CONFIG_FILENAME = 'db-backup.config.json';

// Keys that look like a credential. Credentials are ENV-ONLY (see
// resolveS3Credentials) — never accepted from a CLI flag OR a config file,
// both of which are far more likely to be committed to a repo or logged than
// an environment variable is.
const CONFIG_CREDENTIAL_KEYS = [
  'accessKeyId',
  'secretAccessKey',
  'awsAccessKeyId',
  'awsSecretAccessKey',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
];

function assertNoConfigCredentials(obj, where) {
  if (!obj || typeof obj !== 'object') return;
  for (const key of CONFIG_CREDENTIAL_KEYS) {
    if (key in obj) {
      throw new Error(
        `${where} must not set "${key}": credentials are environment-only (AWS_ACCESS_KEY_ID / ` +
          'AWS_SECRET_ACCESS_KEY, or the S3_* aliases) and are never accepted from a config file or CLI flag.',
      );
    }
  }
}

// `db-backup.config.json`: an app declares its whole backup setup
// declaratively (destinations, retention, encryption, timeouts, hooks) so a
// deploy invocation collapses to `db-backup backup --config <file>` instead
// of re-typing the same ~10 flags in a bash script per app. Resolution order
// (see runCli): explicit --config <path> > db-backup.config.json in cwd >
// none. CLI flags always override a config value; a config value always
// overrides the built-in default (see buildCliBaseOptions).
function loadDbBackupConfig(configPath, cwd) {
  const config = loadJsonFile(configPath, 'Config file', cwd);
  assertNoConfigCredentials(config, 'Config file');
  if (Array.isArray(config.destinations)) {
    for (const dest of config.destinations) {
      assertNoConfigCredentials(dest, 'A destination in the config file');
    }
  }
  return config;
}

function resolveConfigFile(configPath, cwd) {
  if (configPath) {
    return { path: path.resolve(cwd, configPath), config: loadDbBackupConfig(configPath, cwd) };
  }
  const defaultPath = path.resolve(cwd, DEFAULT_CONFIG_FILENAME);
  if (fs.existsSync(defaultPath)) {
    return { path: defaultPath, config: loadDbBackupConfig(defaultPath, cwd) };
  }
  return { path: null, config: null };
}

const OFFSITE_REQUIRED_MESSAGE =
  'Refusing to create a local-only backup: no --remote/--s3-bucket/--dest is configured and ' +
  '--skip-remote was not passed. A backup on the same disk as the database is not a backup — ' +
  'a single disk failure destroys both. Configure --remote <dest> (rclone), --s3-bucket <bucket> ' +
  '(native S3/R2), --dest <type:spec> (repeatable), or pass --skip-remote (skipRemote: true) to ' +
  'explicitly accept the same-disk risk.';

// Resolves the WHERE list. Two mutually exclusive shapes:
//  - `options.destinations` (new model): an explicit, non-empty array. Local
//    is NOT a privileged default here — a caller may choose s3-only.
//  - legacy `outputDir`/`remote`/`s3`/`skipRemote`: mapped onto the same
//    shape for back-compat. Local is always included (matches today's
//    behavior of always staging the backup on disk before any upload).
// Mixing the two throws — a caller must pick one model, not blend them.
//
// `requireOffsite` gates the fail-closed "you must configure somewhere
// off-host, or explicitly opt out" guard. It defaults to false because this
// function backs EVERY consumer of resolveBackupOptions — restore, list,
// prune — not just a backup run; only runBackupJob/runBackupJobAsync (the
// operations that actually create a new backup) pass `requireOffsite: true`.
// An explicit `destinations: []` is always rejected regardless — passing an
// empty list is never sensible for any consumer.
function resolveDestinations({ cwd, outputDir, destinations, remote, s3, skipRemote, requireOffsite = false }) {
  const legacyLocationUsed = Boolean(remote) || Boolean(s3) || skipRemote === true;

  if (destinations) {
    if (legacyLocationUsed) {
      throw new Error(
        'destinations cannot be combined with the legacy remote/s3/skipRemote options; configure only one model.',
      );
    }
    if (!Array.isArray(destinations) || destinations.length === 0) {
      throw new Error(
        'Refusing to run with zero destinations: configure at least one place backups should go ' +
          '(local, s3, or rclone) via destinations / --dest.',
      );
    }
    const resolved = destinations.map((dest) => normalizeDestination(dest, cwd));
    const localOnly = resolved.length === 1 && resolved[0].type === 'local';
    return { destinations: resolved, localOnly };
  }

  if (remote && s3) {
    throw new Error(
      'remote (rclone) and s3 are mutually exclusive; configure only one off-host remote type.',
    );
  }

  const legacyOutputDir = path.resolve(cwd, outputDir || path.relative(cwd, DEFAULT_OUTPUT_DIR));
  const resolved = [{ type: 'local', path: legacyOutputDir }];
  // `skipRemote` is an explicit override: even a configured remote/s3 is
  // skipped, exactly as today (it does not merely relax the "must configure
  // something" guard below — it actively excludes any configured remote).
  if (remote && !skipRemote) {
    resolved.push(normalizeDestination({ type: 'rclone', ...remote }, cwd));
  }
  if (s3 && !skipRemote) {
    resolved.push(normalizeDestination({ type: 's3', ...s3 }, cwd));
  }

  if (requireOffsite && !remote && !s3 && !skipRemote) {
    throw new Error(OFFSITE_REQUIRED_MESSAGE);
  }

  const localOnly = skipRemote === true && !remote && !s3;
  return { destinations: resolved, localOnly };
}

function resolveBackupOptions(options = {}) {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const mode = options.mode || (process.env.NODE_ENV === 'production' ? 'prod' : 'dev');
  const compressSqlite = options.compressSqlite !== false;
  const allowUnsafeCopy = options.allowUnsafeCopy === true;
  const encryption = options.encryption || null;
  const minBytes = Number(options.minBytes) > 0 ? Number(options.minBytes) : 0;
  const stampFile = options.stampFile || null;
  const namePrefix = options.namePrefix || null;
  const skipRemote = options.skipRemote === true;

  const { destinations, localOnly } = resolveDestinations({
    cwd,
    outputDir: options.outputDir,
    destinations: options.destinations || null,
    remote: options.remote || null,
    s3: options.s3 || null,
    skipRemote,
    requireOffsite: options.requireOffsite === true,
  });
  const outputDir = destinations.find((dest) => dest.type === 'local')?.path
    || path.resolve(cwd, options.outputDir || path.relative(cwd, DEFAULT_OUTPUT_DIR));

  // Encryption passphrase readability is validated HERE — before a backup is
  // ever created — regardless of whether it came from a CLI flag or a config
  // file. A passphrase file that exists but isn't readable (permissions,
  // wrong host) must fail loudly up front, not surface as a confusing gpg
  // error after the (now-wasted) snapshot work.
  if (encryption && encryption.passphraseFile) {
    if (!fs.existsSync(encryption.passphraseFile)) {
      throw new Error(`Encryption passphrase file not found: ${encryption.passphraseFile}`);
    }
    try {
      fs.accessSync(encryption.passphraseFile, fs.constants.R_OK);
    } catch {
      throw new Error(`Encryption passphrase file is not readable: ${encryption.passphraseFile}`);
    }
  }

  const policy = options.policy || options.retention || DEFAULT_RETENTION_POLICY;
  // Whether the SAME retention plan should drive every destination (the new
  // GFS model) vs. each destination keeping its own legacy count (age-tier/
  // keep-last/keep-days locally, a flat --remote-keep/dest.keep remotely —
  // exactly today's behavior, preserved for back-compat).
  const usingUnifiedRetention = policy.mode === 'gfs';
  const runtime = normalizeRuntime(options.runtime || options._runtime);

  // list/prune operate purely on the backup directory and never open the
  // database, so they opt out of DATABASE_URL resolution (requireDatabaseUrl:
  // false). backup/restore keep the default of requiring it.
  const requireDatabaseUrl = options.requireDatabaseUrl !== false;
  let databaseUrl = options.databaseUrl || null;
  if (!databaseUrl && requireDatabaseUrl) {
    databaseUrl = loadEnvironment({
      mode,
      cwd,
      envFiles: options.envFiles || DEFAULT_ENV_FILES,
      strictProductionEnv: options.strictProductionEnv !== false,
    }).databaseUrl;
  }

  return {
    cwd,
    mode,
    outputDir,
    compressSqlite,
    allowUnsafeCopy,
    encryption,
    minBytes,
    stampFile,
    namePrefix,
    destinations,
    localOnly,
    skipRemote,
    policy,
    usingUnifiedRetention,
    databaseUrl,
    runtime,
  };
}

// Run `PRAGMA integrity_check` on a SQLite file and throw if it is not `ok`.
//
// NON-DESTRUCTIVE by default. `deleteOnFailure` exists for the one caller that
// owns the file it is checking: createSqliteSnapshot discards a snapshot it just
// wrote, because a bad backup is worse than a loud failure. A consumer verifying
// a file it did not create — an admin route vetting a user-supplied path — must
// never have that file deleted underneath it, so the exported default is safe.
//
// `deleteOnFailure` must survive BOTH failure shapes. sqlite3 reports corruption
// two different ways, and only one of them returns output:
//
//   - a clean "not ok" verdict on stdout  -> execFileSync RETURNS
//   - `database disk image is malformed`  -> sqlite3 EXITS NON-ZERO, so
//                                            execFileSync THROWS
//
// The realistic corruption case — a valid header with torn interior pages, i.e.
// what failing storage actually produces — takes the throwing path. Handling only
// the returning path left `deleteOnFailure` dead exactly when it matters, so a
// corrupt snapshot survived in the output dir under a valid backup name, occupied
// a retention slot (evicting a GOOD backup), and was listed as a real backup.
function verifySqliteBackupIntegrity(backupPath, runtime = normalizeRuntime(), { deleteOnFailure = false } = {}) {
  let output;
  try {
    output = runtime.execFileSync('sqlite3', [backupPath, 'PRAGMA integrity_check;'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // sqlite3 could not read the file at all (unopenable, or malformed enough to
    // abort the check). That is still a failed verification — discard the snapshot
    // if we own it, then surface the original error.
    if (deleteOnFailure) {
      fs.rmSync(backupPath, { force: true });
    }
    throw err;
  }
  const firstLine = (output ? output.toString() : '').trim().split(/\r?\n/, 1)[0] || '';
  if (firstLine !== 'ok') {
    if (deleteOnFailure) {
      fs.rmSync(backupPath, { force: true });
    }
    throw new Error(`SQLite backup integrity check failed: ${firstLine || 'no output'}`);
  }
}

// Analog of verifySqliteBackupIntegrity for Postgres custom-format dumps:
// `pg_restore --list` reads the archive's TOC without touching any database, so
// it's a cheap structural sanity check that the dump isn't truncated/corrupt.
// Deletes the dump and throws on failure, mirroring the SQLite behavior.
function verifyPostgresBackupIntegrity(backupPath, runtime) {
  try {
    runtime.execFileSync('pg_restore', ['--list', backupPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const stdErr = error.stderr ? error.stderr.toString() : '';
    const firstLine = stdErr.trim().split(/\r?\n/, 1)[0] || 'no output';
    fs.rmSync(backupPath, { force: true });
    throw new Error(`PostgreSQL backup verification failed: ${firstLine}`);
  }
}

// Chunked (not whole-file) hashing so a large backup can't OOM the process right
// after it was written — a checksum step must never make a good backup unusable.
function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1 << 16); // 64 KiB
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

// A sqlite3 dot-command (`.backup <path>`) is not SQL: the shell tokenizes its
// arguments with SHELL-like quoting, not SQL string-literal quoting. Doubling a
// single quote — the SQL escape — does NOT work here; `.backup 'o''brien/x.db'`
// fails with `cannot open "brien/x.db"`.
//
// Verified against sqlite3: a double-quoted argument accepts `\"` and `\\`, and
// handles spaces and single quotes verbatim. So wrap in double quotes and escape
// backslashes and double quotes.
function quoteDotCommandArg(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}


// Encryption at rest. Without it, a backup writes plaintext snapshots to disk
// and leaves off-siting and secrecy entirely to the operator.
//
// gpg symmetric AES256 with a passphrase FILE — never a passphrase argument,
// which would be visible in the process table. The plaintext artifact is removed
// once the ciphertext is written and hashed, so it never lingers in the backup
// directory.

// A backup is a full copy of the database, and a restore scratch file is a
// plaintext copy of it sitting next to the live one. Neither should be readable
// by other local users. Node's fs mode argument is masked by the process umask,
// and gzip/gpg/pg_dump write through child processes that ignore it entirely —
// so restrict explicitly after each artifact lands, rather than trusting umask.
const ARTIFACT_MODE = 0o600;
const BACKUP_DIR_MODE = 0o700;

function restrictArtifact(filePath) {
  try {
    fs.chmodSync(filePath, ARTIFACT_MODE);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  return filePath;
}

// Only tighten a directory we just created; never re-mode one the operator set.
function ensureBackupDir(dirPath) {
  const existed = fs.existsSync(dirPath);
  fs.mkdirSync(dirPath, { recursive: true });
  if (!existed) {
    try {
      fs.chmodSync(dirPath, BACKUP_DIR_MODE);
    } catch {
      // Best effort: a restrictive umask may already have done it.
    }
  }
  return dirPath;
}

const DEFAULT_CIPHER_ALGO = 'AES256';

function encryptBackupEntry(entry, encryption, runtime) {
  const { passphraseFile, cipher = DEFAULT_CIPHER_ALGO } = encryption;
  if (!passphraseFile) {
    throw new Error('encryption.passphraseFile is required to encrypt a backup');
  }
  if (!fs.existsSync(passphraseFile)) {
    throw new Error(`Encryption passphrase file not found: ${passphraseFile}`);
  }
  if (!runtime.commandExists('gpg')) {
    throw new Error(
      'Refusing to write an unencrypted backup: encryption was requested but the ' +
        "'gpg' binary is unavailable."
    );
  }

  const destPath = `${entry.fullPath}.gpg`;
  runtime.execFileSync(
    'gpg',
    [
      '--batch',
      '--yes',
      '--symmetric',
      '--cipher-algo',
      cipher,
      '--passphrase-file',
      passphraseFile,
      '-o',
      destPath,
      entry.fullPath,
    ],
    { stdio: 'pipe' }
  );

  if (!fs.existsSync(destPath)) {
    throw new Error(`gpg reported success but produced no output at ${destPath}`);
  }
  restrictArtifact(destPath);

  // The plaintext snapshot must not survive alongside the ciphertext.
  fs.rmSync(entry.fullPath, { force: true });

  const stats = fs.statSync(destPath);
  return {
    ...entry,
    fileName: path.basename(destPath),
    fullPath: destPath,
    encrypted: true,
    sizeBytes: stats.size,
    sha256: sha256File(destPath),
  };
}

function decryptBackupToPath(sourcePath, destPath, encryption, runtime) {
  const { passphraseFile } = encryption || {};
  if (!passphraseFile) {
    throw new Error(
      `Backup ${path.basename(sourcePath)} is encrypted; encryption.passphraseFile is required to restore it`
    );
  }
  if (!runtime.commandExists('gpg')) {
    throw new Error(`Backup ${path.basename(sourcePath)} is encrypted but the 'gpg' binary is unavailable`);
  }
  runtime.execFileSync(
    'gpg',
    ['--batch', '--yes', '--decrypt', '--passphrase-file', passphraseFile, '-o', destPath, sourcePath],
    { stdio: 'pipe' }
  );
  restrictArtifact(destPath);
}

// A snapshot far smaller than expected is a failure, not a backup: an empty or
// truncated database sails through `integrity_check`. A minimum-size floor
// catches this. Disabled (0) unless the consumer sets it.
function assertMinimumBackupSize(entry, minBytes) {
  if (!minBytes || minBytes <= 0) {
    return;
  }
  if (entry.sizeBytes < minBytes) {
    fs.rmSync(entry.fullPath, { force: true });
    throw new Error(
      `Backup ${entry.fileName} is ${entry.sizeBytes} bytes, below the ${minBytes}-byte minimum; discarded`
    );
  }
}

// The SQLite snapshot ENGINE, decoupled from filename/manifest/retention policy.
// Consumers that need to choose their own destination path (an admin "back up
// now" route, a pre-deploy hook) should call this directly rather than
// reimplementing `sqlite3 .backup` — it carries the lock retries, the quote
// escaping, the WAL guard, and the post-write integrity check.
//
// Writes a single self-contained database at `destPath`: SQLite's online backup
// API checkpoints WAL frames into it, so the snapshot needs no sidecars.
function createSqliteSnapshot({
  sourcePath,
  destPath,
  runtime = normalizeRuntime(),
  allowUnsafeCopy = false,
}) {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`SQLite database file not found: ${sourcePath}`);
  }

  if (!runtime.commandExists('sqlite3')) {
    // Without sqlite3 the only option is a byte copy of the main database file,
    // and a byte copy of a LIVE database is never guaranteed consistent: in WAL
    // mode it omits committed transactions still in the -wal, and in any mode it
    // can tear under a concurrent writer. Inspecting the sidecars first would
    // not fix this — a writer can create one between the check and the copy.
    //
    // So there is no "safe cp" to detect. Refuse, and make the caller opt in to
    // an explicitly-inconsistent copy. A bad backup is worse than a loud failure.
    if (!allowUnsafeCopy) {
      throw new Error(
        `Refusing to back up ${sourcePath}: the 'sqlite3' binary is unavailable, so no ` +
          `consistent snapshot can be taken. A plain file copy may omit committed ` +
          `transactions held in the -wal and can tear under a concurrent writer. ` +
          `Install sqlite3, or pass allowUnsafeCopy / --allow-unsafe-copy to accept an ` +
          `inconsistent copy.`
      );
    }

    // Opted in: an inconsistent copy is better than nothing for the caller's
    // purposes. It cannot be integrity-checked either, since that needs sqlite3.
    fs.copyFileSync(sourcePath, destPath);
    return restrictArtifact(destPath);
  }

  // `.backup` is the online backup API: WAL-safe, consistent, and it will not
  // tear under a concurrent writer. Single quotes are doubled because the path
  // is interpolated into a sqlite3 dot-command, not passed as an argv element.
  const sqliteArgs = ['-cmd', '.timeout 5000', sourcePath, `.backup ${quoteDotCommandArg(destPath)}`];
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      runtime.execFileSync('sqlite3', sqliteArgs, { stdio: 'pipe' });
      break;
    } catch (error) {
      const stdOut = error.stdout ? error.stdout.toString() : '';
      const stdErr = error.stderr ? error.stderr.toString() : '';
      const combined = `${stdOut}\n${stdErr}\n${error.message}`;
      const isLockError = /database is locked/i.test(combined);

      if (!isLockError || attempt === maxAttempts) {
        throw error;
      }

      runtime.sleep(attempt * 1000);
    }
  }

  // Verify the snapshot before we keep it: a `.backup` can succeed yet leave a
  // corrupt file. A bad backup is worse than a loud failure, so delete it and
  // throw. We own destPath — we just wrote it — hence deleteOnFailure.
  verifySqliteBackupIntegrity(destPath, runtime, { deleteOnFailure: true });
  return restrictArtifact(destPath);
}

function createSqliteBackup({ databaseUrl, outputDir, compressSqlite, now, cwd = process.cwd(), runtime = normalizeRuntime(), allowUnsafeCopy = false, namePrefix = null }) {
  now = now || runtime.now();
  const sourcePath = parseSqlitePath(databaseUrl, cwd);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`SQLite database file not found: ${sourcePath}`);
  }

  const timestamp = formatTimestamp(now);
  const { rawFilePath } = buildUniqueSqliteRawBackupPath({ timestamp, outputDir, compressSqlite, namePrefix });

  createSqliteSnapshot({ sourcePath, destPath: rawFilePath, runtime, allowUnsafeCopy });

  let finalPath = rawFilePath;
  let compressed = false;
  if (compressSqlite && runtime.commandExists('gzip')) {
    runtime.execFileSync('gzip', ['-f', rawFilePath], { stdio: 'inherit' });
    finalPath = `${rawFilePath}.gz`;
    compressed = true;
    restrictArtifact(finalPath);
  }

  const stats = fs.statSync(finalPath);
  return {
    fileName: path.basename(finalPath),
    fullPath: finalPath,
    engine: 'sqlite',
    compressed,
    createdAt: now.toISOString(),
    sizeBytes: stats.size,
    sha256: sha256File(finalPath),
  };
}

function createPostgresBackup({ databaseUrl, outputDir, now, runtime = normalizeRuntime(), namePrefix = null }) {
  now = now || runtime.now();
  if (!runtime.commandExists('pg_dump')) {
    throw new Error('pg_dump is required for PostgreSQL backups but is not installed.');
  }

  const timestamp = formatTimestamp(now);
  const { fileName, fullPath } = buildUniqueBackupPath({
    engine: 'postgres',
    timestamp,
    outputDir,
    namePrefix,
  });
  runtime.execFileSync('pg_dump', ['--format=custom', `--file=${fullPath}`, databaseUrl], { stdio: 'inherit' });
  restrictArtifact(fullPath);

  // Verify the dump before we keep it, mirroring the SQLite integrity check.
  // Only possible when pg_restore is present; skip like the SQLite cp-fallback.
  if (runtime.commandExists('pg_restore')) {
    verifyPostgresBackupIntegrity(fullPath, runtime);
  }

  const stats = fs.statSync(fullPath);

  return {
    fileName,
    fullPath,
    engine: 'postgres',
    compressed: false,
    createdAt: now.toISOString(),
    sizeBytes: stats.size,
    sha256: sha256File(fullPath),
  };
}

function createBackup(options = {}) {
  const resolved = resolveBackupOptions(options);
  const now = resolved.runtime.now();
  ensureBackupDir(resolved.outputDir);

  const finalize = (entry) => {
    assertMinimumBackupSize(entry, resolved.minBytes);
    return resolved.encryption ? encryptBackupEntry(entry, resolved.encryption, resolved.runtime) : entry;
  };

  const engine = detectDatabaseEngine(resolved.databaseUrl);
  if (engine === 'sqlite') {
    return finalize(createSqliteBackup({
      databaseUrl: resolved.databaseUrl,
      outputDir: resolved.outputDir,
      compressSqlite: resolved.compressSqlite,
      cwd: resolved.cwd,
      now,
      runtime: resolved.runtime,
      allowUnsafeCopy: resolved.allowUnsafeCopy,
      namePrefix: resolved.namePrefix,
    }));
  }

  if (engine === 'postgres') {
    return finalize(
      createPostgresBackup({
        databaseUrl: resolved.databaseUrl,
        outputDir: resolved.outputDir,
        now,
        runtime: resolved.runtime,
        namePrefix: resolved.namePrefix,
      })
    );
  }

  throw new Error('Unsupported DATABASE_URL scheme. Expected file:, postgres://, or postgresql://');
}

function getBackupEntryFromPath(backupPath, now = new Date(), namePrefix = null) {
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`);
  }

  const fileName = path.basename(backupPath);
  const parsed = parseBackupFileName(fileName, namePrefix);
  if (!parsed) {
    throw new Error(`Unsupported backup filename format: ${fileName}`);
  }

  const stats = fs.statSync(backupPath);
  const timestampDate = parseTimestampKey(parsed.timestampKey);
  const createdAt = timestampDate || stats.mtime;
  // Clamp to zero: a future-dated backup (clock skew) must never read as
  // "negative age" for display/consumers. createdAt itself stays truthful.
  const ageDays = Math.max(0, (now.getTime() - createdAt.getTime()) / DAY_MS);

  return {
    fileName,
    fullPath: backupPath,
    engine: parsed.engine,
    compressed: parsed.compressed,
    encrypted: Boolean(parsed.encrypted),
    createdAt: createdAt.toISOString(),
    sizeBytes: stats.size,
    ageDays,
  };
}

function resolveRestoreBackup({
  backupFile,
  useLatest = false,
  outputDir = DEFAULT_OUTPUT_DIR,
  now = new Date(),
  namePrefix = null,
} = {}) {
  const absoluteOutputDir = path.resolve(outputDir);

  if (backupFile) {
    const candidatePath = path.isAbsolute(backupFile)
      ? backupFile
      : path.resolve(absoluteOutputDir, backupFile);
    return getBackupEntryFromPath(candidatePath, now, namePrefix);
  }

  if (useLatest) {
    const backups = listBackups({ outputDir: absoluteOutputDir, now, namePrefix });
    if (backups.length === 0) {
      throw new Error(`No backups found in: ${absoluteOutputDir}`);
    }
    return backups[0];
  }

  throw new Error('Restore requires --file <backup-file> or --latest.');
}

// Distinct from verifySqliteBackupIntegrity: that helper deletes the file it
// checks on failure, which is correct for a freshly-created backup snapshot but
// would DESTROY the live database if reused here. This one only checks and
// throws — the caller (restoreSqliteBackup) is responsible for cleaning up its
// own temp file, and the live destination is never touched by this function.
function redactDatabaseUrl(databaseUrl) {
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return 'postgres://<redacted>';
  }
}

// SQLite writes its journal beside the database file. `-wal`/`-shm` are used in
// WAL mode, `-journal` in the default rollback mode. They describe the database
// they were created for, so they must be discarded whenever that database file
// is replaced wholesale.
const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'];

function removeSqliteSidecars(databasePath) {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    fs.rmSync(`${databasePath}${suffix}`, { force: true });
  }
}

// Runs a `stopWriters`/`startWriters` hook. Accepts either a synchronous
// function (called directly) or a shell command string (run via `sh -lc`,
// bounded by the same runtime.execFileSync timeout as every other external
// command this package runs). Deliberately synchronous-only: the rest of this
// package (and restoreBackup/runCli) is a fully synchronous call chain, and
// accepting an async hook here would force that all the way up through the
// CLI. A consumer whose stop/start logic is inherently async should wrap it in
// a small synchronous shell command (or a sync wrapper that blocks) instead.
function runWriterHook(hook, label, runtime) {
  if (typeof hook === 'function') {
    hook();
    return;
  }
  if (typeof hook === 'string') {
    runtime.execFileSync('sh', ['-lc', hook], { stdio: 'inherit' });
    return;
  }
  throw new Error(`${label} must be a function or a shell command string`);
}

// Attempts to prove the live SQLite database has no active writer (or reader
// holding a lock that would block a writer) before we destroy it. `BEGIN
// EXCLUSIVE; COMMIT;` only succeeds when sqlite3 can take the database's
// reserved+exclusive locks, which fails immediately (bounded by `.timeout`,
// so a hung connection can't hang restore forever) if another connection —
// app or otherwise — holds so much as a shared read lock in a transaction, or
// any write lock.
//
// Fails CLOSED: if the destination doesn't exist yet there is nothing to
// protect (quiescent by definition), but if sqlite3 itself is unavailable we
// cannot prove anything, so this reports NOT quiescent rather than assuming
// the best.
const QUIESCENCE_CHECK_TIMEOUT_MS = 3000;

function detectSqliteQuiescence(destinationPath, runtime) {
  if (!fs.existsSync(destinationPath)) {
    return { quiescent: true, reason: 'no existing database at destination' };
  }
  if (!runtime.commandExists('sqlite3')) {
    return { quiescent: false, reason: "cannot verify: the 'sqlite3' binary is unavailable" };
  }
  try {
    runtime.execFileSync(
      'sqlite3',
      ['-cmd', `.timeout ${QUIESCENCE_CHECK_TIMEOUT_MS}`, destinationPath, 'BEGIN EXCLUSIVE; COMMIT;'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return { quiescent: true, reason: 'acquired an exclusive lock on the live database' };
  } catch (error) {
    const stdErr = error && error.stderr ? error.stderr.toString() : '';
    const message = (stdErr || (error && error.message) || 'unknown error').trim();
    return { quiescent: false, reason: `could not acquire an exclusive lock (a writer may be active): ${message}` };
  }
}

function rescueSidecarPath(rescueMainPath, suffix) {
  return `${rescueMainPath}${suffix}`;
}

// Plain byte copy (main file + whatever sidecars currently exist) of the LIVE
// database into `<outputDir>/.rescue/` before restore ever unlinks it. This is
// deliberately NOT a `sqlite3 .backup` (which would consolidate the WAL into a
// single file): the goal here is to be able to put the live database back
// EXACTLY as it was if anything goes wrong after this point, not to produce a
// clean standalone snapshot. No sqlite3 dependency, so it always works.
function createRescueSnapshot({ destinationPath, outputDir, runtime }) {
  const rescueDir = path.join(outputDir, '.rescue');
  ensureBackupDir(rescueDir);
  const dbName = path.basename(destinationPath, path.extname(destinationPath));
  const iso = runtime.now().toISOString().replace(/[:.]/g, '-');
  const rescueMainPath = path.join(rescueDir, `${dbName}-${iso}.db`);

  fs.copyFileSync(destinationPath, rescueMainPath);
  restrictArtifact(rescueMainPath);

  const sidecarSuffixes = [];
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const sourceSidecar = `${destinationPath}${suffix}`;
    if (fs.existsSync(sourceSidecar)) {
      const destSidecar = rescueSidecarPath(rescueMainPath, suffix);
      fs.copyFileSync(sourceSidecar, destSidecar);
      restrictArtifact(destSidecar);
      sidecarSuffixes.push(suffix);
    }
  }

  return { mainPath: rescueMainPath, sidecarSuffixes };
}

// The auto-rollback counterpart to createRescueSnapshot: puts the live
// database back exactly as it was captured, including only the sidecars that
// existed at capture time (any sidecar NOT captured is removed, since it
// belongs to whatever half-installed state the failed restore left behind).
function restoreFromRescueSnapshot(rescue, destinationPath) {
  removeSqliteSidecars(destinationPath);
  fs.copyFileSync(rescue.mainPath, destinationPath);
  for (const suffix of rescue.sidecarSuffixes) {
    fs.copyFileSync(rescueSidecarPath(rescue.mainPath, suffix), `${destinationPath}${suffix}`);
  }
}

function restoreSqliteBackup({
  databaseUrl,
  backupEntry,
  cwd = process.cwd(),
  runtime = normalizeRuntime(),
  encryption = null,
  outputDir = null,
  stopWriters = null,
  startWriters = null,
  allowOnlineRestore = false,
  skipVerify = false,
} = {}) {
  const destinationPath = parseSqlitePath(databaseUrl, cwd);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

  const tempPath = path.join(
    path.dirname(destinationPath),
    `.restore-${runtime.randomId()}.db`
  );
  // Decryption lands here first; `.gpg` is the outermost layer, so unwind it
  // before gunzip. Cleaned up alongside tempPath on any failure.
  const decryptedPath = `${tempPath}.decrypted`;

  let writersStopped = false;
  let rescue = null;

  try {
    // Unwind the layers in reverse: decrypt -> decompress -> verify -> replace.
    let sourcePath = backupEntry.fullPath;
    if (backupEntry.encrypted) {
      decryptBackupToPath(sourcePath, decryptedPath, encryption, runtime);
      sourcePath = decryptedPath;
    }

    if (backupEntry.compressed) {
      const compressed = fs.readFileSync(sourcePath);
      const decompressed = zlib.gunzipSync(compressed);
      fs.writeFileSync(tempPath, decompressed);
    } else {
      fs.copyFileSync(sourcePath, tempPath);
    }
    restrictArtifact(tempPath);

    // The decrypted plaintext has served its purpose; don't leave it beside the
    // live database.
    fs.rmSync(decryptedPath, { force: true });

    // Validate the restored file on the TEMP path, BEFORE it ever replaces the
    // live database: if this throws, the catch below cleans up tempPath only —
    // destinationPath is never touched, so a bad backup can't destroy a good DB.
    //
    // Absence of sqlite3 used to silently SKIP this check (fail-open, on a
    // destructive operation). It now aborts instead, unless the caller
    // explicitly opts out with skipVerify/--skip-verify.
    if (runtime.commandExists('sqlite3')) {
      verifySqliteBackupIntegrity(tempPath, runtime);
    } else if (!skipVerify) {
      throw new Error(
        "Refusing to restore: the 'sqlite3' binary is unavailable, so the restored " +
          'backup cannot be integrity-checked before it replaces the live database. ' +
          'Install sqlite3, or pass skipVerify / --skip-verify to restore UNVERIFIED ' +
          '(a corrupt backup could then destroy a good database).'
      );
    } else {
      console.warn(
        `[db-backup] WARNING: restoring ${path.basename(backupEntry.fullPath)} without integrity ` +
          "verification ('sqlite3' unavailable, skipVerify set). UNSAFE."
      );
    }

    if (fs.existsSync(destinationPath)) {
      // Writer quiescence: refuse to destroy a database that may still be
      // written to. This is the fix for the data-loss defect where restore
      // unlinked a live, open database out from under a running app — the app
      // kept writing to the now-unlinked inode, and every write made after the
      // restore was silently lost on next open.
      if (stopWriters) {
        runWriterHook(stopWriters, 'stopWriters', runtime);
        writersStopped = true;
      }

      const quiescence = detectSqliteQuiescence(destinationPath, runtime);
      if (!quiescence.quiescent) {
        if (!allowOnlineRestore) {
          throw new Error(
            `Refusing to restore over ${destinationPath}: could not prove no writer is ` +
              `active (${quiescence.reason}). Restoring over a live database can silently ` +
              'destroy writes made after the restore. Pass stopWriters (config) so this ' +
              'package can quiesce the database itself, or allowOnlineRestore / ' +
              '--force-online to override at your own risk (UNSAFE).'
          );
        }
        console.warn(
          `[db-backup] WARNING: restoring over ${destinationPath} without proof it is quiescent ` +
            `(${quiescence.reason}); allowOnlineRestore is set. This can silently lose writes ` +
            'made after the restore. UNSAFE.'
        );
      }

      // Rescue snapshot: ALWAYS taken (not gated behind createPreRestoreBackup)
      // right before the live file is touched. If anything fails from here on,
      // the catch below puts this back so the live database is never left
      // destroyed — this is what converts "silent data loss" into "recoverable".
      rescue = createRescueSnapshot({
        destinationPath,
        outputDir: outputDir || path.dirname(destinationPath),
        runtime,
      });
    }

    try {
      if (fs.existsSync(destinationPath)) {
        fs.unlinkSync(destinationPath);
      }

      // The `-wal`/`-shm`/`-journal` sidecars belong to the database we just
      // deleted. Left in place, SQLite replays the old WAL's frames onto the
      // restored file on the next open — silently resurrecting pre-restore rows
      // while `PRAGMA integrity_check` still reports "ok". The snapshot is a
      // complete database, so the old sidecars are never wanted.
      removeSqliteSidecars(destinationPath);

      fs.renameSync(tempPath, destinationPath);
    } catch (swapError) {
      if (rescue) {
        restoreFromRescueSnapshot(rescue, destinationPath);
      }
      throw swapError;
    }
  } catch (error) {
    for (const scratch of [tempPath, decryptedPath]) {
      try {
        fs.rmSync(scratch, { force: true });
      } catch {
        // Best effort cleanup.
      }
    }
    throw error;
  } finally {
    if (writersStopped && startWriters) {
      try {
        runWriterHook(startWriters, 'startWriters', runtime);
      } catch (startError) {
        // Never let a failed restart mask the restore's real outcome (success
        // or the original error) — but never swallow it silently either. The
        // app may need a manual restart.
        console.error(
          `[db-backup] WARNING: startWriters failed after restore: ${startError.message}. ` +
            'The application may need to be restarted manually.'
        );
      }
    }
  }

  return {
    target: destinationPath,
    rescuePath: rescue ? rescue.mainPath : null,
  };
}

function restorePostgresBackup({
  databaseUrl,
  backupEntry,
  runtime = normalizeRuntime(),
} = {}) {
  if (!runtime.commandExists('pg_restore')) {
    throw new Error('pg_restore is required for PostgreSQL restores but is not installed.');
  }

  runtime.execFileSync(
    'pg_restore',
    [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      '--single-transaction',
      '--dbname',
      databaseUrl,
      backupEntry.fullPath,
    ],
    { stdio: 'inherit' }
  );

  return {
    target: redactDatabaseUrl(databaseUrl),
  };
}

// Checksum guard, run BEFORE anything touches the live DB (pre-restore backup
// creation or the restore itself). Reads the manifest from the backup file's
// OWN directory (path.dirname(backupEntry.fullPath)) rather than
// resolved.outputDir: a `--file` argument may be an absolute path outside
// outputDir, and the manifest that recorded it lives alongside it. Matches the
// LAST manifest entry whose `name` equals the backup's filename, to tolerate a
// recreated same-timestamp file. Older backups (no manifest, or a manifest
// entry with no sha256) skip the check entirely.
function verifyBackupChecksum(backupEntry) {
  const manifest = readBackupManifest(path.dirname(backupEntry.fullPath));
  const matches = manifest.entries.filter((entry) => entry.name === backupEntry.fileName);
  const matched = matches[matches.length - 1];

  if (!matched || !matched.sha256) {
    return;
  }

  const actual = sha256File(backupEntry.fullPath);
  if (actual !== matched.sha256) {
    throw new Error(`Backup checksum mismatch for ${backupEntry.fileName}`);
  }
}

function restoreBackup(options = {}) {
  const resolved = resolveBackupOptions(options);
  const now = resolved.runtime.now();

  const runRestore = () => {
    const backupEntry = resolveRestoreBackup({
      backupFile: options.backupFile,
      useLatest: options.useLatest,
      outputDir: resolved.outputDir,
      now,
      namePrefix: resolved.namePrefix,
    });
    const databaseEngine = detectDatabaseEngine(resolved.databaseUrl);

    if (databaseEngine === 'unknown') {
      throw new Error('Unsupported DATABASE_URL for restore. Expected file:, postgres://, or postgresql://');
    }

    if (backupEntry.engine !== databaseEngine) {
      throw new Error(
        `Backup engine mismatch. Selected backup is "${backupEntry.engine}" but DATABASE_URL uses "${databaseEngine}".`
      );
    }

    // Before touching the live DB at all (not even the pre-restore safety
    // backup): verify the selected backup's bytes against its manifest checksum,
    // if one was recorded.
    verifyBackupChecksum(backupEntry);

    let preRestoreBackup = null;
    if (options.createPreRestoreBackup !== false) {
      preRestoreBackup = createBackup({
        ...resolved,
        databaseUrl: resolved.databaseUrl,
        mode: resolved.mode,
        outputDir: resolved.outputDir,
        compressSqlite: resolved.compressSqlite,
        cwd: resolved.cwd,
        runtime: resolved.runtime,
      });
    }

    let restoreResult;
    if (databaseEngine === 'sqlite') {
      restoreResult = restoreSqliteBackup({
        databaseUrl: resolved.databaseUrl,
        backupEntry,
        cwd: resolved.cwd,
        runtime: resolved.runtime,
        encryption: resolved.encryption,
        // Only anchor the rescue snapshot under outputDir when it already
        // exists — mirrors the advisory-lock behavior just below: a `--file`
        // backup outside outputDir (which may not exist at all) must not
        // create it as a side effect. restoreSqliteBackup falls back to the
        // live database's own directory when this is null.
        outputDir: fs.existsSync(resolved.outputDir) ? resolved.outputDir : null,
        stopWriters: options.stopWriters || null,
        startWriters: options.startWriters || null,
        allowOnlineRestore: options.allowOnlineRestore === true,
        skipVerify: options.skipVerify === true,
      });
    } else {
      restoreResult = restorePostgresBackup({
        databaseUrl: resolved.databaseUrl,
        backupEntry,
        runtime: resolved.runtime,
      });
    }

    return {
      restored: backupEntry,
      preRestoreBackup,
      mode: resolved.mode,
      outputDir: resolved.outputDir,
      engine: databaseEngine,
      restoredAt: now.toISOString(),
      target: restoreResult.target,
      rescuePath: restoreResult.rescuePath || null,
    };
  };

  // Mutually exclude with runBackupJob/pruneBackupsJob on the same outputDir —
  // a scheduled backup or prune must never run while a restore is replacing the
  // database. As in pruneBackupsJob, don't attempt to create a lock file inside
  // a directory that doesn't exist: a `--file`/backupFile may be an absolute
  // path in a directory other than outputDir, and outputDir may legitimately
  // not exist at all in that case. There is nothing local to protect there, so
  // restore proceeds unlocked exactly as before.
  if (!fs.existsSync(resolved.outputDir)) {
    return runRestore();
  }

  return withBackupLock(resolved.outputDir, resolved.runtime, runRestore);
}

function listBackups({ outputDir = DEFAULT_OUTPUT_DIR, now = new Date(), namePrefix = null } = {}) {
  const absoluteOutputDir = path.resolve(outputDir);
  if (!fs.existsSync(absoluteOutputDir)) {
    return [];
  }

  const files = fs.readdirSync(absoluteOutputDir)
    .map((fileName) => {
      const parsed = parseBackupFileName(fileName, namePrefix);
      if (!parsed) {
        return null;
      }

      const timestampDate = parseTimestampKey(parsed.timestampKey);
      const fullPath = path.join(absoluteOutputDir, fileName);
      const fileStats = fs.statSync(fullPath);
      const createdAt = timestampDate || fileStats.mtime;
      // Clamp to zero: a future-dated backup (clock skew) must never read as
      // "negative age" for display/consumers. createdAt itself stays truthful.
      const ageDays = Math.max(0, (now.getTime() - createdAt.getTime()) / DAY_MS);

      return {
        fileName,
        fullPath,
        engine: parsed.engine,
        compressed: parsed.compressed,
        createdAt: createdAt.toISOString(),
        sizeBytes: fileStats.size,
        ageDays,
        _sortSequence: parsed.sequence,
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      const createdAtDiff = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
      return createdAtDiff || right._sortSequence - left._sortSequence || right.fileName.localeCompare(left.fileName);
    })
    .map(({ _sortSequence, ...entry }) => entry);

  return files;
}

function chooseAnchorCandidate(backups, anchor, now, excludedNames) {
  const candidates = backups
    .filter((backup) => !excludedNames.has(backup.fileName))
    .map((backup) => ({
      ...backup,
      // Clamp to zero: a future-dated (clock-skewed) backup must not read as
      // younger-than-zero when matched against an anchor's age window.
      ageDays: Math.max(0, (now.getTime() - new Date(backup.createdAt).getTime()) / DAY_MS),
    }))
    .filter((backup) => backup.ageDays >= anchor.minAgeDays && backup.ageDays <= anchor.maxAgeDays);

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => {
    const leftDistance = Math.abs(left.ageDays - anchor.targetAgeDays);
    const rightDistance = Math.abs(right.ageDays - anchor.targetAgeDays);
    if (leftDistance !== rightDistance) {
      return leftDistance - rightDistance;
    }

    return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
  });

  return candidates[0];
}

// Sort backups newest-first by an EFFECTIVE time (raw createdAt clamped to
// "now"), so a future-dated backup (clock skew) can't sort ahead of a
// legitimately-recent one. Shared by every retention mode.
function sortByEffectiveTime(backups, now) {
  const nowMs = now.getTime();
  return [...backups].sort(
    (left, right) =>
      Math.min(new Date(right.createdAt).getTime(), nowMs) -
      Math.min(new Date(left.createdAt).getTime(), nowMs)
  );
}

// Shared by both age-tier (legacy default) and GFS: `dailyCount` most-recent
// backups fill literal "slots" first (no age bucketing — just the N newest),
// then `anchors` are matched in order via chooseAnchorCandidate, each
// claiming at most one backup and excluding whatever earlier slots/anchors
// already claimed. `maxBackups` caps the total (age-tier only; GFS passes
// Infinity since its total is already bounded by daily+weekly+monthly+yearly).
//
// This is the ONE selection engine behind both modes — GFS is not a parallel
// system, it is age-tier's mechanics fed a generated anchor list (see
// buildGfsAnchors / selectGfs).
function selectSlotsAndAnchors(sorted, { dailyCount = 0, anchors = [], maxBackups = Infinity, now }) {
  const selected = [];
  const selectedNames = new Set();

  const cappedDaily = Math.min(dailyCount, maxBackups);
  sorted.slice(0, cappedDaily).forEach((backup, index) => {
    selected.push({
      ...backup,
      retentionReason: 'daily',
      retentionLabel: `Daily slot ${index + 1}`,
    });
    selectedNames.add(backup.fileName);
  });

  for (const anchor of anchors) {
    if (selected.length >= maxBackups) {
      break;
    }

    const match = chooseAnchorCandidate(sorted, anchor, now, selectedNames);
    if (!match) {
      continue;
    }

    selected.push({
      ...match,
      retentionReason: anchor.key,
      retentionLabel: anchor.label,
    });
    selectedNames.add(match.fileName);
  }

  return selected;
}

// Age-tier selection (the legacy default policy): `dailySlots` most-recent
// backups, then one backup per age anchor, capped at `maxBackups`.
function selectAgeTier(sorted, policy, now) {
  return selectSlotsAndAnchors(sorted, {
    dailyCount: policy.dailySlots,
    anchors: policy.anchors,
    maxBackups: policy.maxBackups,
    now,
  });
}

// GFS selection: `daily` most-recent backups as literal slots, then one
// backup per weekly/monthly/yearly bucket (generated anchors — see
// buildGfsAnchors), unless the policy supplies its own `anchors` for full
// custom control (the --retention-policy JSON file escape hatch).
function selectGfs(sorted, policy, now) {
  const anchors = policy.anchors || buildGfsAnchors(policy);
  return selectSlotsAndAnchors(sorted, {
    dailyCount: policy.daily || 0,
    anchors,
    now,
  });
}

// Flat count retention: keep the N most-recent backups.
function selectKeepLast(sorted, policy) {
  return sorted.slice(0, policy.keepLast).map((backup) => ({
    ...backup,
    retentionReason: 'keep_last',
    retentionLabel: 'Recent',
  }));
}

// Flat age retention: keep every backup younger than `keepDays` days. Always
// keep at least the single most-recent backup regardless of age, so a long gap
// between runs can never delete every backup.
function selectKeepDays(sorted, policy, now) {
  const nowMs = now.getTime();
  const cutoffMs = policy.keepDays * DAY_MS;
  const selected = sorted
    .filter((backup) => {
      const effective = Math.min(new Date(backup.createdAt).getTime(), nowMs);
      return nowMs - effective < cutoffMs;
    })
    .map((backup) => ({
      ...backup,
      retentionReason: 'keep_days',
      retentionLabel: 'Within window',
    }));

  if (selected.length === 0 && sorted.length > 0) {
    selected.push({
      ...sorted[0],
      retentionReason: 'newest',
      retentionLabel: 'Most recent (age guard)',
    });
  }

  return selected;
}

function planRetention(backups, policy = DEFAULT_RETENTION_POLICY, now = new Date()) {
  // Absent mode means age-tier, so legacy policy objects (and the shared
  // DEFAULT_RETENTION_POLICY, which carries no `mode`) behave unchanged.
  const mode = policy.mode || 'age-tier';
  const sorted = sortByEffectiveTime(backups, now);

  let selected;
  if (mode === 'keep-last') {
    selected = selectKeepLast(sorted, policy);
  } else if (mode === 'keep-days') {
    selected = selectKeepDays(sorted, policy, now);
  } else if (mode === 'gfs') {
    selected = selectGfs(sorted, policy, now);
  } else {
    selected = selectAgeTier(sorted, policy, now);
  }

  // DESTRUCTIVE-OPERATION SAFETY GUARD (1/2): a policy whose own selection
  // keeps NOTHING, while backups exist, is a bug in the policy (e.g. every
  // anchor's age window missed, or every count is 0) — refuse rather than
  // silently emptying the backup directory.
  if (sorted.length > 0 && selected.length === 0) {
    throw new Error(
      `Retention policy (mode "${mode}") would prune every one of ${sorted.length} backup(s); refusing. ` +
        'Adjust the policy so at least one backup survives.',
    );
  }

  // DESTRUCTIVE-OPERATION SAFETY GUARD (2/2): the newest backup is NEVER
  // pruned, whatever the policy computed — even a policy that keeps other
  // backups can, through a misconfigured anchor window, exclude the newest
  // one specifically. Force it into the keep set rather than let that happen.
  if (sorted.length > 0 && !selected.some((entry) => entry.fileName === sorted[0].fileName)) {
    selected = [
      ...selected,
      { ...sorted[0], retentionReason: 'newest', retentionLabel: 'Newest backup (safety guard)' },
    ];
  }

  const keepMap = new Map(selected.map((item) => [item.fileName, item]));
  const keep = sorted.filter((backup) => keepMap.has(backup.fileName)).map((backup) => keepMap.get(backup.fileName));
  const remove = sorted
    .filter((backup) => !keepMap.has(backup.fileName))
    .map((backup) => ({
      ...backup,
      retentionReason: 'rotate_out',
      retentionLabel: 'Rotate out',
    }));

  return {
    keep,
    remove,
    policy,
  };
}

function pruneBackups(backupsToRemove = []) {
  const deleted = [];

  backupsToRemove.forEach((backup) => {
    if (fs.existsSync(backup.fullPath)) {
      fs.unlinkSync(backup.fullPath);
      deleted.push(backup);
    }
  });

  return deleted;
}

function listBackupsWithPlan(options = {}) {
  const resolved = resolveBackupOptions({ ...options, requireDatabaseUrl: false });
  const now = resolved.runtime.now();
  const backups = listBackups({ outputDir: resolved.outputDir, now, namePrefix: resolved.namePrefix });
  const plan = planRetention(backups, resolved.policy, now);

  const keepNames = new Set(plan.keep.map((entry) => entry.fileName));
  const backupRows = backups.map((backup) => {
    const keepEntry = plan.keep.find((entry) => entry.fileName === backup.fileName);

    return {
      ...backup,
      keep: keepNames.has(backup.fileName),
      retentionReason: keepEntry ? keepEntry.retentionReason : 'rotate_out',
      retentionLabel: keepEntry ? keepEntry.retentionLabel : 'Rotate out',
    };
  });

  return {
    backups: backupRows,
    plan,
    mode: resolved.mode,
    outputDir: resolved.outputDir,
    policy: resolved.policy,
  };
}

const LOCK_FILENAME = '.db-backup.lock';

// Advisory, cooperative lock so a scheduled backup/prune run doesn't clobber a
// concurrent one in the same outputDir. Not a substitute for filesystem-level
// locking — it only protects db-backup runs against each other.
//
// - Acquire atomically via O_EXCL (`wx`): only one process can create the file.
// - On EEXIST, read the existing lock's `at` (an ISO string — age is computed
//   with Date.parse + getTime(), never by subtracting the string itself). If
//   it's unreadable/invalid (NaN) or older than `staleMs`, re-read the file once
//   and only steal (delete) it if the token we just re-read still matches the
//   token we originally saw — this avoids racing a newer run that stole the
//   lock a moment earlier. Then retry the atomic open exactly once.
// - Otherwise (a live, non-stale lock), throw.
// - In `finally`, only remove the lock file if its token still matches ours —
//   a run that stole our (stale) lock after us owns it now, and must not have
//   its lock deleted out from under it.
function readLockFile(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

// Shared by withBackupLock (sync) and withBackupLockAsync (async): acquires
// the lock file and returns { lockPath, token }, or throws. All the file-level
// mechanics (O_EXCL acquire, stale-lock steal, corrupt-leftover recovery) live
// here exactly once; the two wrappers differ only in whether `fn` is awaited.
function acquireBackupLock(outputDir, runtime, { staleMs = 30 * 60 * 1000 } = {}) {
  const lockPath = path.join(outputDir, LOCK_FILENAME);
  const token = runtime.randomId();

  const lockedError = () =>
    new Error(`Another db-backup run holds the lock (${lockPath}, pid ${process.pid}).`);

  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }

    const existing = readLockFile(lockPath);
    const age = existing ? runtime.now().getTime() - Date.parse(existing.at) : NaN;

    if (!(Number.isFinite(age) && age <= staleMs)) {
      // Steal a lock that is either (a) stale and still owned by the same token,
      // or (b) a corrupt/zero-byte leftover from a crash between openSync('wx')
      // and writeFileSync — otherwise an unparsable lock would deadlock every
      // future run forever. (Best-effort advisory lock on a single host: a rare
      // concurrent run is tolerated by unique filenames + idempotent prune.)
      const reread = readLockFile(lockPath);
      const sameStaleOwner = existing && reread && reread.token === existing.token;
      const corruptLeftover = !existing && !reread;
      if (sameStaleOwner || corruptLeftover) {
        fs.rmSync(lockPath, { force: true });
      }

      try {
        fd = fs.openSync(lockPath, 'wx');
      } catch (retryError) {
        if (retryError.code === 'EEXIST') {
          throw lockedError();
        }
        throw retryError;
      }
    } else {
      throw lockedError();
    }
  }

  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: runtime.now().toISOString(), token }));
  fs.closeSync(fd);

  return { lockPath, token };
}

function releaseBackupLock(lockPath, token) {
  const current = readLockFile(lockPath);
  if (current && current.token === token) {
    fs.rmSync(lockPath, { force: true });
  }
}

function withBackupLock(outputDir, runtime, fn, options = {}) {
  const { lockPath, token } = acquireBackupLock(outputDir, runtime, options);
  try {
    return fn();
  } finally {
    releaseBackupLock(lockPath, token);
  }
}

// Async twin of withBackupLock: awaits `fn` (which performs the S3 upload)
// before releasing the lock in `finally`, so the lock is held for the whole
// async operation rather than being dropped the instant fn() returns its
// (still-pending) promise.
async function withBackupLockAsync(outputDir, runtime, fn, options = {}) {
  const { lockPath, token } = acquireBackupLock(outputDir, runtime, options);
  try {
    return await fn();
  } finally {
    releaseBackupLock(lockPath, token);
  }
}

// Apply the retention policy to an existing backup directory without creating a
// new snapshot — a standalone cleanup pass. Like list, it never opens the
// database, so DATABASE_URL is not required.
function pruneBackupsJob(options = {}) {
  const resolved = resolveBackupOptions({ ...options, requireDatabaseUrl: false });
  const now = resolved.runtime.now();

  // Preserve today's no-op-on-missing-dir behavior, and don't attempt to
  // create a lock file inside a directory that doesn't exist.
  if (!fs.existsSync(resolved.outputDir)) {
    return {
      removed: [],
      kept: [],
      mode: resolved.mode,
      outputDir: resolved.outputDir,
      policy: resolved.policy,
    };
  }

  return withBackupLock(resolved.outputDir, resolved.runtime, () => {
    const backups = listBackups({ outputDir: resolved.outputDir, now, namePrefix: resolved.namePrefix });
    const plan = planRetention(backups, resolved.policy, now);
    const removed = pruneBackups(plan.remove);

    return {
      removed,
      kept: plan.keep,
      mode: resolved.mode,
      outputDir: resolved.outputDir,
      policy: resolved.policy,
    };
  });
}


// ---------------------------------------------------------------------------
// Off-host replication.
//
// A local-only backup dies with the disk it sits on — the same-disk durability
// gap. A verified off-host copy closes it.
//
// The invariant that makes it safe: NOTHING is pruned and NO success is stamped
// until the remote object has been re-read and its size matched. A failed or
// unverified upload leaves the previous good backups — and the previous stamp —
// exactly where they were.
// ---------------------------------------------------------------------------
const DEFAULT_REMOTE_KEEP = 30;

function rcloneEnv(remote) {
  return remote.configFile ? { ...process.env, RCLONE_CONFIG: remote.configFile } : undefined;
}

function remoteObjectPath(remote, fileName) {
  return `${remote.target.replace(/\/+$/, '')}/${fileName}`;
}

// Re-read the uploaded object and compare its size to the local artifact. rclone
// reports either an object or a single-element array depending on version, so
// accept both. An unparseable response is a verification FAILURE, not a pass.
function verifyRemoteObject(entry, remote, runtime) {
  const target = remoteObjectPath(remote, entry.fileName);
  const output = runtime.execFileSync('rclone', ['lsjson', '--stat', target], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: rcloneEnv(remote),
  });

  let remoteSize = null;
  try {
    const parsed = JSON.parse((output || '').toString());
    const size = Array.isArray(parsed) ? parsed[0] && parsed[0].Size : parsed && parsed.Size;
    if (typeof size === 'number') {
      remoteSize = size;
    }
  } catch {
    remoteSize = null;
  }

  if (remoteSize === null) {
    throw new Error(`Could not determine remote object size for ${target}; refusing to prune or stamp`);
  }

  const localSize = fs.statSync(entry.fullPath).size;
  if (remoteSize !== localSize) {
    throw new Error(
      `Remote size mismatch for ${target}: local=${localSize} remote=${remoteSize}; refusing to prune or stamp`
    );
  }

  return { target, sizeBytes: remoteSize };
}

function uploadBackupToRemote(entry, remote, runtime) {
  if (!remote.target) {
    throw new Error('remote.target is required to upload a backup');
  }
  if (!runtime.commandExists('rclone')) {
    throw new Error("Refusing to report success: remote upload was requested but the 'rclone' binary is unavailable");
  }

  const target = remoteObjectPath(remote, entry.fileName);
  runtime.execFileSync('rclone', ['copyto', entry.fullPath, target], {
    stdio: 'pipe',
    env: rcloneEnv(remote),
  });

  return remote.verify === false ? { target, sizeBytes: null } : verifyRemoteObject(entry, remote, runtime);
}

// Turn a bare remote/S3 filename listing into the minimal shape planRetention
// needs ({ fileName, createdAt }) — recency comes from the filename's own
// embedded timestamp (parseTimestampKey), the same identity the rest of the
// package uses, never from a listing API's mtime. Filters out anything that
// doesn't parse as one of this package's own backups (a stray file, a
// manifest, a manually-nested layout).
function remoteBackupEntries(names, namePrefix) {
  return names
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => {
      const parsed = parseBackupFileName(name, namePrefix);
      if (!parsed) return null;
      const when = parseTimestampKey(parsed.timestampKey);
      return when ? { fileName: name, createdAt: when.toISOString() } : null;
    })
    .filter(Boolean);
}

// Keep the newest remote objects per `policy` (same planRetention engine as
// local retention — see resolveDestinationPolicy for how the policy is
// chosen), never fewer than 1, and never the object we just uploaded and
// verified. A prune failure — whether listing, planning, or an individual
// delete — is a cleanup miss, not a data-safety issue: the new backup is
// already verified on both ends, so warn and carry on rather than fail the
// whole backup job.
//
// The just-uploaded/protected file is handled two different ways depending
// on whether `policy` is the SAME unified plan local retention uses
// (`usingUnifiedPolicy`):
//  - unified (GFS): included in the planning pool (like local's
//    finalizeBackupResult does with `created`) so slot/anchor budgets are
//    counted accurately — matching "the same plan, everywhere" exactly — and
//    then excluded from the resulting delete list.
//  - legacy flat count (policy omitted): excluded from the pool BEFORE
//    planning, exactly as today — preserved for back-compat so
//    `--remote-keep N` still means "keep N OTHER objects", not "N total
//    including the brand new one".
function pruneRemoteBackups(remote, protectFileName, runtime, namePrefix = null, policy = null, now = new Date()) {
  let listing = '';
  try {
    listing = runtime
      .execFileSync('rclone', ['lsf', remote.target, '--files-only'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: rcloneEnv(remote),
      })
      .toString();
  } catch (error) {
    console.warn(`[db-backup] Could not list remote backups for pruning: ${error.message}`);
    return [];
  }

  const usingUnifiedPolicy = Boolean(policy);
  const rawEntries = remoteBackupEntries(listing.split(/\r?\n/), namePrefix);
  const effectivePolicy =
    policy || { mode: 'keep-last', keepLast: Math.max(1, Number(remote.keep) > 0 ? Number(remote.keep) : DEFAULT_REMOTE_KEEP) };

  let entries;
  if (usingUnifiedPolicy) {
    entries = rawEntries.some((entry) => entry.fileName === protectFileName)
      ? rawEntries
      : [...rawEntries, { fileName: protectFileName, createdAt: now.toISOString() }];
  } else {
    entries = rawEntries.filter((entry) => entry.fileName !== protectFileName);
  }

  let plan;
  try {
    plan = planRetention(entries, effectivePolicy, now);
  } catch (error) {
    console.warn(`[db-backup] Retention planning failed for remote backups (leaving them in place): ${error.message}`);
    return [];
  }

  const doomed = usingUnifiedPolicy ? plan.remove.filter((entry) => entry.fileName !== protectFileName) : plan.remove;

  const deleted = [];
  for (const entry of doomed) {
    try {
      runtime.execFileSync('rclone', ['deletefile', remoteObjectPath(remote, entry.fileName)], {
        stdio: 'pipe',
        env: rcloneEnv(remote),
      });
      deleted.push(entry.fileName);
    } catch (error) {
      console.warn(`[db-backup] Failed to prune remote backup ${entry.fileName} (leaving it in place): ${error.message}`);
    }
  }
  return deleted;
}

// `.last-success` is the liveness signal a cron-driven backup otherwise lacks:
// a job that silently stops producing backups is invisible without one.
function writeSuccessStamp(stampFile, now = new Date()) {
  const dir = path.dirname(stampFile);
  fs.mkdirSync(dir, { recursive: true });
  // Write-then-rename: a crash mid-write must never leave a truncated stamp that
  // a freshness monitor would misread.
  const tempPath = path.join(dir, `.last-success.tmp-${process.pid}`);
  fs.writeFileSync(tempPath, `${now.toISOString()}\n`, { mode: ARTIFACT_MODE });
  restrictArtifact(tempPath);
  fs.renameSync(tempPath, stampFile);
  return stampFile;
}

function readSuccessStamp(stampFile) {
  if (!fs.existsSync(stampFile)) {
    return null;
  }
  const parsed = new Date(fs.readFileSync(stampFile, 'utf8').trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Returns { fresh, clockSkew, stampedAt, ageHours, maxAgeHours }.
//
// A missing or unparseable stamp is NOT fresh — absence of evidence is not
// evidence of a backup.
//
// A stamp dated in the FUTURE is not fresh either, and is reported distinctly as
// a clock problem. Otherwise its negative age would always sit under the
// threshold and the monitor would report "fresh" forever, even with backups
// stopped. That is not hypothetical: it is the same clock-rollback failure mode
// this package already guards against in retention. A host whose clock jumps
// forward once stamps a future date and blinds the monitor permanently.
function checkBackupFreshness({ stampFile, maxAgeHours = 36, now = new Date() } = {}) {
  if (!stampFile) {
    throw new Error('stampFile is required to check backup freshness');
  }
  const stampedAt = readSuccessStamp(stampFile);
  if (!stampedAt) {
    return { fresh: false, clockSkew: false, stampedAt: null, ageHours: null, maxAgeHours };
  }
  const ageHours = (now.getTime() - stampedAt.getTime()) / (60 * 60 * 1000);
  if (ageHours < 0) {
    return { fresh: false, clockSkew: true, stampedAt, ageHours, maxAgeHours };
  }
  return { fresh: ageHours <= maxAgeHours, clockSkew: false, stampedAt, ageHours, maxAgeHours };
}

// Newest backup time under an rclone remote, or null if none. Mirrors
// pruneRemoteBackups exactly: `rclone lsf --files-only`, keep only files that
// parse as THIS package's backups (parseBackupFileName — so a stray file, a
// manifest, or a manually-nested layout can't be mistaken for a backup), and
// take recency from the filename's embedded timestamp (parseTimestampKey), the
// same backup identity the rest of the package uses. A failed listing is
// UNKNOWN — never "fresh" — so it throws (unlike prune, which is best-effort).
function remoteNewestBackupTime(remote, runtime, namePrefix = null) {
  if (!runtime.commandExists('rclone')) {
    throw new Error('rclone is unavailable — cannot check remote backup freshness');
  }
  let listing;
  try {
    listing = runtime
      .execFileSync('rclone', ['lsf', remote.target, '--files-only'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: rcloneEnv(remote),
      })
      .toString();
  } catch (err) {
    throw new Error(
      `Could not list remote backups at ${remote.target}: ${err && err.message ? err.message : err}`
    );
  }
  let newest = null;
  for (const line of listing.split(/\r?\n/)) {
    const name = line.trim();
    if (!name) continue;
    const parsed = parseBackupFileName(name, namePrefix);
    if (!parsed) continue;
    const when = parseTimestampKey(parsed.timestampKey);
    if (when && (!newest || when.getTime() > newest.getTime())) {
      newest = when;
    }
  }
  return newest;
}

// Remote sibling of checkBackupFreshness: the newest backup under the rclone
// remote stands in for the stamp. Returns the SAME { fresh, clockSkew,
// stampedAt, ageHours, maxAgeHours } shape so the CLI print/exit/notify path is
// uniform. Lets a host that is NOT the backup host verify the off-site copy —
// the dead-man's switch the local stamp check can't be (it dies with the host).
function checkRemoteFreshness({ remote, runtime = normalizeRuntime(), maxAgeHours = 36, now = new Date(), namePrefix = null } = {}) {
  if (!remote || !remote.target) {
    throw new Error('remote.target is required to check remote backup freshness');
  }
  const stampedAt = remoteNewestBackupTime(remote, runtime, namePrefix);
  if (!stampedAt) {
    return { fresh: false, clockSkew: false, stampedAt: null, ageHours: null, maxAgeHours };
  }
  const ageHours = (now.getTime() - stampedAt.getTime()) / (60 * 60 * 1000);
  if (ageHours < 0) {
    return { fresh: false, clockSkew: true, stampedAt, ageHours, maxAgeHours };
  }
  return { fresh: ageHours <= maxAgeHours, clockSkew: false, stampedAt, ageHours, maxAgeHours };
}

// Best-effort alert delivery. NEVER throws and NEVER changes the exit code — a
// failing webhook must not mask (or manufacture) a stale-backup verdict. Stays
// synchronous (no fetch) so runCli's contract and every consumer's
// `try { runCli() } catch` are unaffected. Zero new deps: POSTs via curl (the
// discord/webhook helpers), or runs an arbitrary command with the message in
// $DB_BACKUP_ALERT (the fully generic escape hatch).
function notifyAlert(message, { notifyDiscord, notifyWebhook, notifyCommand, runtime = normalizeRuntime() } = {}) {
  const postJson = (url, body) => {
    if (!runtime.commandExists('curl')) {
      console.warn('[db-backup] notify skipped: curl is unavailable');
      return;
    }
    // Body over stdin (`-d @-`) so the message never lands in argv/ps output.
    runtime.execFileSync('curl', ['-fsS', '-X', 'POST', '-H', 'Content-Type: application/json', '-d', '@-', url], {
      input: JSON.stringify(body),
      stdio: ['pipe', 'ignore', 'pipe'],
    });
  };
  if (notifyDiscord) {
    try { postJson(notifyDiscord, { content: message }); }
    catch (err) { console.warn(`[db-backup] Discord notify failed: ${err && err.message ? err.message : err}`); }
  }
  if (notifyWebhook) {
    try { postJson(notifyWebhook, { text: message }); }
    catch (err) { console.warn(`[db-backup] webhook notify failed: ${err && err.message ? err.message : err}`); }
  }
  if (notifyCommand) {
    try {
      runtime.execFileSync('/bin/sh', ['-c', notifyCommand], {
        env: { ...process.env, DB_BACKUP_ALERT: message },
        stdio: ['ignore', 'inherit', 'inherit'],
      });
    } catch (err) { console.warn(`[db-backup] notify-command failed: ${err && err.message ? err.message : err}`); }
  }
}

// The retention policy applied AT a given destination. Local always uses
// `resolved.policy` directly. A remote (rclone/s3) destination follows the
// SAME unified plan too, once a GFS policy is configured (usingUnifiedRetention)
// — that is the whole point of the destinations+retention split: one plan,
// every destination. Absent that, a remote destination keeps its legacy,
// independent flat count (dest.keep, defaulting per-type) exactly as before,
// so an existing `--remote-keep`-only deployment behaves unchanged.
function resolveDestinationPolicy(destination, resolved) {
  if (destination.type === 'local') {
    return resolved.policy;
  }
  if (resolved.usingUnifiedRetention) {
    return resolved.policy;
  }
  const defaultKeep = destination.type === 's3' ? DEFAULT_S3_KEEP : DEFAULT_REMOTE_KEEP;
  const keep = Math.max(1, Number(destination.keep) > 0 ? Number(destination.keep) : defaultKeep);
  return { mode: 'keep-last', keepLast: keep };
}

// Shared bottom half of a backup run, once every destination's upload (if
// any) is known-uploaded-and-verified: local retention, per-destination
// remote retention, manifest, and the success stamp. `distributions` is a
// per-non-local-destination `{ destination, uploaded, removed }` list.
// Entirely synchronous — no network I/O here — so both the sync and async
// distribute paths below call it identically.
function finalizeBackupResult(resolved, created, now, distributions) {
  const localDestination = resolved.destinations.find((dest) => dest.type === 'local');
  let removed = [];
  let kept = [];

  if (localDestination) {
    const backups = listBackups({ outputDir: resolved.outputDir, now, namePrefix: resolved.namePrefix });
    const plan = planRetention(backups, resolved.policy, now);

    // NEVER prune the backup we just created and verified, whatever the plan
    // says. A host whose clock jumped backward at boot gives the new file an
    // older timestamp than existing ones, and a retention policy that trusts
    // the ordering would then delete the only known-good backup.
    const doomed = plan.remove.filter((entry) => entry.fileName !== created.fileName);
    removed = pruneBackups(doomed);
    kept = plan.keep;
  } else {
    // Local was not a chosen destination: the staged file was only ever
    // scratch space for the upload(s) above. It must not linger as a silent,
    // untracked local copy once every configured destination has confirmed
    // it — remove it now that finalize is running only after every upload
    // above succeeded and verified.
    fs.rmSync(created.fullPath, { force: true });
  }

  // Best-effort: a manifest write failure must never fail the backup itself.
  // Safety/pre-restore backups (created via createBackup outside this job)
  // are intentionally NOT manifested — they're transient. Only written when
  // local is a destination — a manifest with no corresponding local file is
  // misleading, and checksums are re-verifiable from the destination anyway.
  if (localDestination) {
    try {
      appendBackupManifestEntry(resolved.outputDir, {
        name: created.fileName,
        path: created.fullPath,
        createdAt: created.createdAt,
        sizeBytes: created.sizeBytes,
        engine: created.engine,
        compressed: created.compressed,
        sha256: created.sha256,
      });
    } catch (error) {
      console.warn(`[db-backup] Failed to append manifest entry: ${error.message}`);
    }
  }

  // Stamped only after the backup exists, passed its integrity check, cleared
  // the size floor, was encrypted if configured, and retention completed. A
  // failure anywhere above leaves the previous stamp untouched, so a freshness
  // monitor reads the run as stale rather than silently "successful".
  if (resolved.stampFile) {
    writeSuccessStamp(resolved.stampFile, now);
  }

  const remoteDistributions = distributions.filter((d) => d.destination.type !== 'local');
  return {
    created,
    removed,
    // Back-compat singular fields: the (only) remote's upload/prune result,
    // exactly as before this package supported more than one remote.
    uploaded: remoteDistributions[0] ? remoteDistributions[0].uploaded : null,
    removedRemote: remoteDistributions[0] ? remoteDistributions[0].removed : [],
    // Full per-destination detail, for callers using more than one remote.
    destinationResults: distributions,
    kept,
    mode: resolved.mode,
    outputDir: resolved.outputDir,
    policy: resolved.policy,
    localOnly: resolved.localOnly,
  };
}

const S3_SYNC_REFUSAL_MESSAGE =
  'runBackupJob (the synchronous API) cannot use an S3 destination: uploading it would block the ' +
  'Node event loop for the entire upload, which is fine for a one-shot CLI process but freezes ' +
  'an in-process/library host (e.g. every request an app server is handling) for as long as the ' +
  'upload takes. Use runBackupJobAsync(options) (await it — its S3 upload runs on the normal ' +
  'async `fetch`, not the event loop) or the `db-backup` CLI, which already awaits it. ' +
  'runBackupJob remains fully supported for rclone and local-only backups.';

function warnIfLocalOnly(resolved, remoteDestinations) {
  if (remoteDestinations.length === 0 && resolved.localOnly) {
    console.warn(
      '[db-backup] WARNING: local-only backup (no remote/off-host destination configured). ' +
      'This backup exists only on the same disk as the database.',
    );
  }
}

// Synchronous backup job. Supports rclone and local-only destinations
// exactly as before. Deliberately REFUSES an S3 destination — see
// S3_SYNC_REFUSAL_MESSAGE — rather than silently blocking the event loop or
// silently falling back to some other behavior. Use runBackupJobAsync for S3.
//
// Fully synchronous top to bottom (no async/await, no Promise) — this is
// what lets it stay a plain, non-async function that any sync caller can use
// without ever touching a Promise. runBackupJobAsync is the async twin that
// additionally supports S3; the two share resolveBackupOptions,
// resolveDestinationPolicy, and finalizeBackupResult, and differ only in how
// they upload/prune each destination (sync execFileSync vs. async fetch).
function runBackupJob(options = {}) {
  const resolved = resolveBackupOptions({ ...options, requireOffsite: true });

  const remoteDestinations = resolved.destinations.filter((dest) => dest.type !== 'local');
  if (remoteDestinations.some((dest) => dest.type === 's3')) {
    throw new Error(S3_SYNC_REFUSAL_MESSAGE);
  }

  ensureBackupDir(resolved.outputDir);

  return withBackupLock(resolved.outputDir, resolved.runtime, () => {
    // createBackup re-derives via resolveBackupOptions; `destinations` is
    // already fully resolved here, so pass skipRemote:false to avoid it
    // reading as a second, conflicting location model on re-entry.
    const created = createBackup({ ...resolved, skipRemote: false });
    const now = resolved.runtime.now();

    warnIfLocalOnly(resolved, remoteDestinations);

    // Replicate off-host BEFORE anything is pruned or stamped. A local-only
    // backup dies with the disk it sits on; an unverified remote copy is not
    // a backup. If any upload or its verification fails we throw here, so
    // the previous good backups and the previous stamp both survive
    // untouched at every destination, local included.
    const distributions = remoteDestinations.map((destination) => ({
      destination,
      uploaded: uploadBackupToRemote(created, destination, resolved.runtime),
      removed: [],
    }));

    // Retention is applied per destination only after EVERY destination has
    // a verified copy — a prune must never run ahead of replication. The
    // SAME policy drives every destination once a GFS policy is configured
    // (resolveDestinationPolicy); otherwise each keeps its legacy count.
    for (const distribution of distributions) {
      const policy = resolveDestinationPolicy(distribution.destination, resolved);
      distribution.removed = pruneRemoteBackups(
        distribution.destination,
        created.fileName,
        resolved.runtime,
        resolved.namePrefix,
        policy,
        now,
      );
    }

    return finalizeBackupResult(resolved, created, now, distributions);
  });
}

// Async backup job — the correct entry point for any in-process/library
// caller whose S3 destination must not block its event loop (e.g. a Next.js
// API route). Supports everything runBackupJob supports (rclone, local-only)
// PLUS a native S3/R2 destination, uploaded via the real async `fetch` (see
// s3-remote.js) with no worker thread and no Atomics.wait anywhere in the
// call chain. The CLI awaits this for every `backup` invocation.
async function runBackupJobAsync(options = {}) {
  const resolved = resolveBackupOptions({ ...options, requireOffsite: true });

  ensureBackupDir(resolved.outputDir);

  return withBackupLockAsync(resolved.outputDir, resolved.runtime, async () => {
    // createBackup re-derives via resolveBackupOptions; `destinations` is
    // already fully resolved here, so pass skipRemote:false to avoid it
    // reading as a second, conflicting location model on re-entry.
    const created = createBackup({ ...resolved, skipRemote: false });
    const now = resolved.runtime.now();

    const remoteDestinations = resolved.destinations.filter((dest) => dest.type !== 'local');
    warnIfLocalOnly(resolved, remoteDestinations);

    // Replicate off-host BEFORE anything is pruned or stamped — see
    // runBackupJob for the full rationale. Uploads run in order (not
    // parallel) so a failure on destination N leaves destinations after it
    // untouched, and the ones before it already verified.
    const distributions = [];
    for (const destination of remoteDestinations) {
      const uploaded =
        destination.type === 's3'
          ? await uploadBackupToS3(created, destination, resolved.runtime)
          : uploadBackupToRemote(created, destination, resolved.runtime);
      distributions.push({ destination, uploaded, removed: [] });
    }

    // Retention is applied per destination only after EVERY destination has
    // a verified copy — a prune must never run ahead of replication.
    for (const distribution of distributions) {
      const policy = resolveDestinationPolicy(distribution.destination, resolved);
      distribution.removed =
        distribution.destination.type === 's3'
          ? await pruneS3Backups(
              distribution.destination,
              created.fileName,
              resolved.runtime,
              resolved.namePrefix,
              parseBackupFileName,
              planRetention,
              policy,
              now,
            )
          : pruneRemoteBackups(
              distribution.destination,
              created.fileName,
              resolved.runtime,
              resolved.namePrefix,
              policy,
              now,
            );
    }

    return finalizeBackupResult(resolved, created, now, distributions);
  });
}

function buildDailyCronEntry({
  hour = 3,
  minute = 0,
  command = "cd /path/to/app && npm run db:backup:prod",
  logPath = "/var/log/db-backup.log",
} = {}) {
  // The whole invocation is the argument to `bash -lc`, wrapped in single
  // quotes. Escape any single quote inside it ('\'' is the standard trick) so a
  // quote in a command or path can't break out of — or malform — the entry.
  const inner = `${command} >> "${logPath}" 2>&1`;
  const quoted = `'${inner.replace(/'/g, "'\\''")}'`;
  return `${minute} ${hour} * * * /usr/bin/env bash -lc ${quoted}`;
}

function formatBytes(sizeBytes) {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = sizeBytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

function showHelp() {
  console.log(`
Usage:
  db-backup [backup|list|prune|cron|restore] [options]

Commands:
  backup                  Create a backup and apply retention policy (default)
  list                    List backups with keep/rotate decisions (no DB needed)
  prune                   Apply retention now without taking a backup (no DB needed)
  cron                    Print a daily cron entry
  restore                 Restore database from backup file
  freshness               Exit non-zero if the last success is older than the threshold
                          (checks --stamp-file, or --remote for an off-host monitor)

Options:
  --prod                  Use production env files (.env + .env.production)
  --dev                   Use development env files (.env + .env.local)
  --config <path>         Load db-backup.config.json (declarative destinations +
                          retention). Default: db-backup.config.json in cwd, if present.
                          CLI flags always override the config; the config overrides
                          built-in defaults. Never put credentials in this file.
  --dest <type:spec>      Destination, repeatable: local:<path>, s3:<bucket>[/<prefix>],
                          rclone:<remote:path>. The NEW location model — an explicit,
                          non-empty list of where backups go. Cannot be combined with the
                          legacy --remote/--s3-bucket/--skip-remote/--output-dir flags.
  --output-dir <path>     [legacy] Backup directory (default: backups/database)
  --retain-daily <n>      GFS: keep the N most-recent backups
  --retain-weekly <n>     GFS: keep one backup per week, for N weeks
  --retain-monthly <n>    GFS: keep one backup per month, for N months
  --retain-yearly <n>     GFS: keep one backup per year, for N years
                          --retain-* apply the SAME plan to every destination (local
                          and remote alike). Cannot mix with --max-backups/--daily-slots/
                          --keep-last/--keep-days (legacy, local-only retention).
  --retention-policy <file.json>  Full custom policy (anchors, GFS, or legacy shape) —
                          the escape hatch for anything --retain-* can't express.
  --max-backups <n>       [legacy] Age-tier: max backups to retain (env: DB_BACKUP_MAX_BACKUPS)
  --daily-slots <n>       [legacy] Age-tier: recent daily slots before age tiers (env: DB_BACKUP_DAILY_SLOTS)
  --keep-last <n>         [legacy] Flat retention: keep the N most-recent backups (env: DB_BACKUP_KEEP_LAST)
  --keep-days <n>         [legacy] Flat retention: keep backups younger than N days (env: DB_BACKUP_KEEP_DAYS)
  --command-timeout <s>   Bound every external command (env: DB_BACKUP_COMMAND_TIMEOUT_MS)
  --allow-unsafe-copy     Permit a byte copy when sqlite3 is absent (inconsistent)
  --encrypt-passphrase-file <path>  Encrypt the backup (gpg symmetric AES256)
  --cipher <algo>         gpg cipher algorithm (default: AES256)
  --min-bytes <n>         Discard and fail if the backup is smaller than n bytes
  --name-prefix <name>    Filename prefix (default sqlite-backup / postgres-backup)
  --stamp-file <path>     Write .last-success only after a fully successful run
  --max-age-hours <n>     Freshness threshold (command: freshness, default 36)
  --remote <dest>         [legacy] Upload off-host via rclone and verify (e.g. remote:path)
  --remote-keep <n>       [legacy] Remote backups to retain (default 30) when no GFS
                          policy is configured; ignored (the unified plan wins) once
                          --retain-*/--retention-policy/config.retention is set.
  --rclone-config <path>  RCLONE_CONFIG for the upload (and remote freshness check)
  --s3-bucket <name>      [legacy] Upload off-host to S3/R2 natively (SigV4, no rclone) and
                          verify. Mutually exclusive with --remote. Credentials come from
                          the environment ONLY: AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY (or
                          S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY) — never a flag or config file.
  --s3-prefix <path>      Key prefix under the bucket (default: none)
  --s3-endpoint <url>     S3-compatible endpoint, e.g. Cloudflare R2:
                          https://<account>.r2.cloudflarestorage.com (default: AWS S3)
  --s3-region <region>    Signing region (default: auto for R2/--s3-endpoint, us-east-1 for AWS)
  --s3-timeout <s>        Bound every S3 HTTP request (env: DB_BACKUP_S3_TIMEOUT_MS, default 300)
  --skip-remote           [legacy] Local-only run: no upload, no remote prune
  --dry-run               (command: prune) Print the keep/delete plan with a reason per
                          survivor; delete nothing.
  --notify-discord <url>  freshness: POST an alert to a Discord webhook on failure
  --notify-webhook <url>  freshness: POST {"text":...} to a webhook on failure
  --notify-command <cmd>  freshness: run cmd on failure ($DB_BACKUP_ALERT = message)
  --no-compress           Disable gzip for SQLite backups
  --allow-missing         Skip (don't fail) when the SQLite database is absent
  --json                  Print JSON output
  --hour <0-23>           Hour for cron output (command: cron)
  --minute <0-59>         Minute for cron output (command: cron)
  --command <str>         Override the command in cron output (command: cron)
  --log-path <path>       Log path for cron output (command: cron)
  --file <name|path>      Backup file to restore (command: restore)
  --latest                Restore latest backup in output-dir (command: restore)
  --no-pre-backup         Skip safety backup before restore (command: restore)
  --stop-writers-cmd <c>  Shell command run to quiesce writers before restore
                          replaces a live SQLite DB (command: restore)
  --start-writers-cmd <c> Shell command run after restore to bring writers
                          back up, incl. on failure (command: restore)
  --force-online          UNSAFE: restore even if writer quiescence cannot be
                          proven (command: restore). Can silently lose writes.
  --skip-verify           UNSAFE: restore without integrity verification when
                          'sqlite3' is unavailable (command: restore)
  --help                  Show help
`);
}

// Async: a CLI is a batch process, so it can freely await the S3-capable
// runBackupJobAsync at the top level. cli.js (the bin entry) awaits this
// promise and reports a rejection the same way it used to report a thrown
// error.
async function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);

  if (options.command === 'help') {
    showHelp();
    return;
  }

  if (options.command === 'freshness') {
    if (!options.stampFile && !options.remoteTarget) {
      throw new Error('freshness requires --stamp-file <path> or --remote <dest>');
    }
    const notifyOpts = {
      notifyDiscord: options.notifyDiscord,
      notifyWebhook: options.notifyWebhook,
      notifyCommand: options.notifyCommand,
      runtime: normalizeRuntime({ commandTimeoutMs: options.commandTimeoutMs }),
    };
    // Remote check wins when --remote is given: an off-host monitor verifies the
    // off-site copy directly (the dead-man's switch the local stamp can't be).
    const source = options.remoteTarget
      ? `remote ${options.remoteTarget}`
      : `stamp ${options.stampFile}`;

    let status;
    try {
      status = options.remoteTarget
        ? checkRemoteFreshness({
            remote: {
              target: options.remoteTarget,
              ...(options.rcloneConfig ? { configFile: options.rcloneConfig } : {}),
            },
            runtime: notifyOpts.runtime,
            maxAgeHours: options.maxAgeHours,
            namePrefix: options.namePrefix,
          })
        : checkBackupFreshness({ stampFile: options.stampFile, maxAgeHours: options.maxAgeHours });
    } catch (err) {
      // A check that cannot run (rclone missing, unparseable listing) is itself an
      // alert condition — the backup's health is UNKNOWN, which we treat as bad.
      const msg = `🔴 ${source}: backup freshness check FAILED (${err && err.message ? err.message : err})`;
      console.error(`[db-backup] ${msg}`);
      notifyAlert(msg, notifyOpts);
      process.exitCode = 1;
      return;
    }

    let alertMessage = null;
    if (options.json) {
      console.log(JSON.stringify(status, null, 2));
      if (!status.fresh) alertMessage = `🔴 ${source}: backup not fresh — ${JSON.stringify(status)}`;
    } else if (!status.stampedAt) {
      alertMessage = `🔴 ${source}: no successful backup found — the backup may have stopped`;
      console.error(`[db-backup] ${alertMessage}`);
    } else if (status.clockSkew) {
      alertMessage = `🔴 ${source}: CLOCK PROBLEM — newest backup is dated in the future (${status.stampedAt.toISOString()}); refusing to report fresh`;
      console.error(`[db-backup] ${alertMessage}`);
    } else {
      const age = status.ageHours.toFixed(1);
      const line = `newest backup is ${age}h old (threshold ${status.maxAgeHours}h), stamped ${status.stampedAt.toISOString()}`;
      if (status.fresh) {
        console.log(`[db-backup] ${source}: ${line}`);
      } else {
        alertMessage = `🔴 ${source}: STALE — ${line}`;
        console.error(`[db-backup] ${alertMessage}`);
      }
    }

    if (!status.fresh) {
      if (alertMessage) notifyAlert(alertMessage, notifyOpts);
      // Non-zero so a cron wrapper or monitor treats staleness as a failure.
      process.exitCode = 1;
    }
    return;
  }

  if (options.command === 'cron') {
    const outputDir = options.outputDirProvided ? options.outputDir : null;
    let command = options.cronCommand;
    if (!command) {
      // A copy-pasteable default that resolves the locally-installed bin
      // (npx checks node_modules/.bin first, so it works under npm and pnpm)
      // and mirrors the flags passed to `cron` onto the emitted `backup` call.
      const parts = [`cd "${process.cwd()}" &&`, 'npx db-backup backup'];
      if (options.mode === 'prod') {
        parts.push('--prod');
      }
      if (outputDir) {
        parts.push(`--output-dir "${outputDir}"`);
      }
      if (options.allowMissing) {
        parts.push('--allow-missing');
      }
      command = parts.join(' ');
    }
    const logPath = options.logPath
      ? path.resolve(process.cwd(), options.logPath)
      : path.resolve(outputDir || path.join(process.cwd(), 'backups', 'database'), 'backup.log');
    const cronLine = buildDailyCronEntry({
      hour: options.hour,
      minute: options.minute,
      command,
      logPath,
    });
    console.log(cronLine);
    return;
  }

  // Config file: an app declares its whole setup once instead of re-typing
  // flags in a bash script per app. Resolution: --config <path> >
  // db-backup.config.json in cwd > none. Every value below is CLI-flag- >
  // config- > built-in-default, so a config never silently overrides an
  // explicit flag.
  const { config } = resolveConfigFile(options.configPath, process.cwd());

  // Location model: CLI --dest > config.destinations > legacy flags. Mixing
  // --dest (or a config destinations list) with a legacy location flag
  // (--remote/--s3-bucket/--skip-remote/--output-dir) is an error — resolved
  // here, once, rather than left to resolveDestinations to reject deep
  // inside resolveBackupOptions where the message would lack CLI context.
  const cliDestinations = options.destinations.length > 0 ? options.destinations : null;
  const configDestinations = !cliDestinations && config && config.destinations ? config.destinations : null;
  const newModelDestinations = cliDestinations || configDestinations;
  const legacyLocationFlagsUsed =
    Boolean(options.remoteTarget) || Boolean(options.s3Bucket) || options.skipRemote === true;
  if (newModelDestinations && legacyLocationFlagsUsed) {
    throw new Error(
      '--dest (or a config file destinations list) cannot be combined with the legacy --remote/' +
        '--s3-bucket/--skip-remote flags; configure only one location model.',
    );
  }

  // Retention model: CLI --retain-*/--retention-policy > config.retention >
  // legacy flags/env/default. A config `retention` object is either a GFS
  // shape ({daily,weekly,monthly,yearly}) or a fully custom policy object
  // (has its own `mode`) — either is passed straight through, mirroring the
  // --retention-policy JSON file escape hatch.
  const retentionPolicyFile = options.retentionPolicyPath
    ? loadJsonFile(options.retentionPolicyPath, '--retention-policy file')
    : null;
  const cliRetentionUsed =
    retentionPolicyFile ||
    [options.retainDaily, options.retainWeekly, options.retainMonthly, options.retainYearly].some(
      (v) => v !== null,
    );
  const legacyRetentionFlagsUsed =
    options.maxBackups !== null || options.dailySlots !== null || options.keepLast !== null || options.keepDays !== null;
  let policy;
  if (cliRetentionUsed) {
    if (legacyRetentionFlagsUsed) {
      throw new Error(
        '--retain-daily/--retain-weekly/--retain-monthly/--retain-yearly/--retention-policy cannot be ' +
          'combined with --keep-last/--keep-days/--max-backups/--daily-slots; choose one retention model.',
      );
    }
    policy = resolveRetentionPolicy({
      retainDaily: options.retainDaily,
      retainWeekly: options.retainWeekly,
      retainMonthly: options.retainMonthly,
      retainYearly: options.retainYearly,
      retentionPolicyFile,
    });
  } else if (config && config.retention && !legacyRetentionFlagsUsed) {
    policy = config.retention.mode
      ? config.retention
      : {
          mode: 'gfs',
          daily: config.retention.daily || 0,
          weekly: config.retention.weekly || 0,
          monthly: config.retention.monthly || 0,
          yearly: config.retention.yearly || 0,
        };
  } else {
    policy = resolveRetentionPolicy({
      maxBackups: options.maxBackups,
      dailySlots: options.dailySlots,
      keepLast: options.keepLast,
      keepDays: options.keepDays,
    });
  }

  // `mode` from the config file. Without this, a config declaring "mode": "prod"
  // was silently IGNORED — db-backup fell back to NODE_ENV and resolved DEV env
  // files while the operator believed they were running prod. A config key that is
  // accepted and does nothing is worse than one that errors.
  // Precedence stays CLI > config > default: options.mode is only non-default when
  // --prod/--dev was passed, so we only consult the config when it wasn't.
  if (!options.modeExplicit && config && config.mode) {
    if (config.mode !== 'prod' && config.mode !== 'dev') {
      throw new Error(`config "mode" must be "prod" or "dev" (got ${JSON.stringify(config.mode)})`);
    }
    options.mode = config.mode;
  }

  const passphraseFile = options.passphraseFile || (config && config.encryptPassphraseFile) || null;
  const cipher = options.cipher || (config && config.cipher) || null;
  const minBytes = options.minBytes !== null ? options.minBytes : (config && config.minBytes) || null;
  const stampFile = options.stampFile || (config && config.stampFile) || null;
  const commandTimeoutMs =
    options.commandTimeoutMs !== null
      ? options.commandTimeoutMs
      : config && config.commandTimeoutSeconds
        ? config.commandTimeoutSeconds * 1000
        : null;
  const stopWritersCommand = options.stopWritersCommand || (config && config.stopWritersCmd) || null;
  const startWritersCommand = options.startWritersCommand || (config && config.startWritersCmd) || null;
  const configDatabaseUrl = !process.env.DATABASE_URL && config && config.databaseUrl ? config.databaseUrl : null;

  const baseOptions = {
    mode: options.mode,
    outputDir: options.outputDir,
    compressSqlite: options.compressSqlite,
    allowUnsafeCopy: options.allowUnsafeCopy,
    ...(configDatabaseUrl ? { databaseUrl: configDatabaseUrl } : {}),
    encryption: passphraseFile ? { passphraseFile, ...(cipher ? { cipher } : {}) } : null,
    minBytes,
    stampFile,
    namePrefix: options.namePrefix,
    ...(newModelDestinations
      ? { destinations: newModelDestinations }
      : {
          remote: options.remoteTarget
            ? {
                target: options.remoteTarget,
                ...(options.remoteKeep ? { keep: options.remoteKeep } : {}),
                ...(options.rcloneConfig ? { configFile: options.rcloneConfig } : {}),
              }
            : null,
          s3: options.s3Bucket
            ? {
                bucket: options.s3Bucket,
                ...(options.s3Prefix ? { prefix: options.s3Prefix } : {}),
                ...(options.s3Endpoint ? { endpoint: options.s3Endpoint } : {}),
                ...(options.s3Region ? { region: options.s3Region } : {}),
                ...(options.remoteKeep ? { keep: options.remoteKeep } : {}),
              }
            : null,
          skipRemote: options.skipRemote,
        }),
    runtime: { commandTimeoutMs, s3TimeoutMs: options.s3TimeoutMs },
    policy,
  };

  if (options.command === 'list') {
    const result = listBackupsWithPlan(baseOptions);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`[db-backup] Mode: ${result.mode}`);
    console.log(`[db-backup] Output directory: ${result.outputDir}`);
    console.log(`[db-backup] Total backups: ${result.backups.length}`);

    result.backups.forEach((backup) => {
      const marker = backup.keep ? 'KEEP' : 'DROP';
      console.log(`  ${marker} | ${backup.fileName} | ${backup.retentionLabel} | ${formatBytes(backup.sizeBytes)}`);
    });
    return;
  }

  if (options.command === 'prune') {
    // --dry-run: compute and print the exact same plan prune would apply,
    // with a reason per survivor, and delete NOTHING. This is the sanity
    // check an operator runs before trusting a policy — see listBackupsWithPlan,
    // which is pure (never touches the filesystem beyond reading it).
    if (options.dryRun) {
      const result = listBackupsWithPlan(baseOptions);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`[db-backup] DRY RUN — nothing will be deleted.`);
      console.log(`[db-backup] Mode: ${result.mode}`);
      console.log(`[db-backup] Output directory: ${result.outputDir}`);
      result.backups.forEach((backup) => {
        const marker = backup.keep ? 'KEEP   ' : 'DELETE ';
        console.log(`  ${marker}| ${backup.fileName} | ${backup.retentionLabel} | ${formatBytes(backup.sizeBytes)}`);
      });
      const toDelete = result.backups.filter((backup) => !backup.keep).length;
      console.log(
        `[db-backup] Would keep ${result.backups.length - toDelete} backup(s), would remove ${toDelete} backup(s).`,
      );
      return;
    }

    const result = pruneBackupsJob(baseOptions);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`[db-backup] Mode: ${result.mode}`);
    console.log(`[db-backup] Output directory: ${result.outputDir}`);
    console.log(
      `[db-backup] Removed ${result.removed.length} backup(s), keeping ${result.kept.length} backup(s).`,
    );
    if (result.removed.length > 0) {
      console.log(`[db-backup] Removed: ${result.removed.map((entry) => entry.fileName).join(', ')}`);
    }
    return;
  }

  if (options.command === 'restore') {
    const restoreResult = restoreBackup({
      ...baseOptions,
      backupFile: options.backupFile,
      useLatest: options.useLatest,
      createPreRestoreBackup: options.createPreRestoreBackup,
      stopWriters: stopWritersCommand,
      startWriters: startWritersCommand,
      allowOnlineRestore: options.allowOnlineRestore,
      skipVerify: options.skipVerify,
    });

    if (options.json) {
      console.log(JSON.stringify(restoreResult, null, 2));
      return;
    }

    console.log(`[db-backup] Mode: ${restoreResult.mode}`);
    console.log(`[db-backup] Output directory: ${restoreResult.outputDir}`);
    console.log(`[db-backup] Restored backup: ${restoreResult.restored.fileName}`);
    if (restoreResult.preRestoreBackup) {
      console.log(`[db-backup] Safety backup created: ${restoreResult.preRestoreBackup.fileName}`);
    }
    if (restoreResult.rescuePath) {
      console.log(`[db-backup] Rescue snapshot of the pre-restore live database: ${restoreResult.rescuePath}`);
    }
    console.log(`[db-backup] Restore target: ${restoreResult.target}`);
    console.log('[db-backup] Restore completed. Restart your application before serving traffic.');
    return;
  }

  let result;
  try {
    result = await runBackupJobAsync(baseOptions);
  } catch (error) {
    // On a fresh install the database file may not exist yet; --allow-missing
    // lets a scheduled/deploy backup no-op instead of failing the whole run.
    if (
      options.allowMissing &&
      error instanceof Error &&
      /^SQLite database file not found:/.test(error.message)
    ) {
      const skipped = { skipped: true, reason: error.message, mode: baseOptions.mode };
      if (options.json) {
        console.log(JSON.stringify(skipped, null, 2));
      } else {
        console.log(`[db-backup] ${error.message}; skipping backup.`);
      }
      return;
    }
    throw error;
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`[db-backup] Mode: ${result.mode}`);
  console.log(`[db-backup] Output directory: ${result.outputDir}`);
  console.log(`[db-backup] Backup created: ${result.created.fileName}`);
  console.log(`[db-backup] Keeping ${result.kept.length} backup(s), removed ${result.removed.length} backup(s).`);

  if (result.removed.length > 0) {
    console.log(`[db-backup] Removed: ${result.removed.map((entry) => entry.fileName).join(', ')}`);
  }
  if (result.localOnly) {
    console.log(
      '[db-backup] WARNING: local-only backup — no remote configured, --skip-remote was set explicitly.',
    );
  }
}

module.exports = {
  DEFAULT_RETENTION_POLICY,
  buildGfsAnchors,
  buildDailyCronEntry,
  listBackupsWithPlan,
  pruneBackupsJob,
  resolveRetentionPolicy,
  resolveDestinations,
  normalizeDestination,
  planRetention,
  restoreBackup,
  runBackupJob,
  runBackupJobAsync,
  runCli,
  // SQLite engine primitives. The job API above owns env resolution,
  // filenames, the manifest and retention; a consumer that needs its own naming,
  // manifest, or no pruning side-effect uses these instead of reimplementing
  // `sqlite3 .backup` — they carry the lock retries, quote escaping, WAL guard,
  // integrity verification, atomic replace, and sidecar cleanup.
  createSqliteSnapshot,
  parseBackupFileName,
  verifySqliteBackupIntegrity,
  restoreSqliteBackup,
  removeSqliteSidecars,
  detectSqliteQuiescence,
  normalizeRuntime,
  DEFAULT_COMMAND_TIMEOUT_MS,
  // Encryption at rest + backup liveness.
  encryptBackupEntry,
  decryptBackupToPath,
  writeSuccessStamp,
  readSuccessStamp,
  checkBackupFreshness,
  checkRemoteFreshness,
  notifyAlert,
  uploadBackupToRemote,
  pruneRemoteBackups,
  DEFAULT_CIPHER_ALGO,
  // Native S3-compatible remote (AWS S3 + Cloudflare R2). rclone-free: AWS
  // SigV4 signed with node:crypto, sent over fetch. See s3-remote.js.
  resolveS3Credentials,
  signS3Request,
  uploadBackupToS3,
  verifyS3Object,
  pruneS3Backups,
  S3_SINGLE_PART_LIMIT_BYTES,
  DEFAULT_S3_KEEP,
  DEFAULT_S3_TIMEOUT_MS,
  // Backup-storage helpers:
  MANIFEST_FILENAME,
  expandHome,
  isContainedWithin,
  resolveBackupDirectories,
  getBackupFallbackDirectory,
  resolveContainedBackupPath,
  readBackupManifest,
  appendBackupManifestEntry,
};
