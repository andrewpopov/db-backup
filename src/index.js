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
      continue;
    }

    if (arg === '--dev') {
      options.mode = 'dev';
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
// DEFAULT_RETENTION_POLICY. Retention has two exclusive shapes: the default
// age-tier (maxBackups/dailySlots over policy-owned anchors) and the flat modes
// keep-last / keep-days. The mode axis is resolved first — an explicit keep-*
// option selects a flat mode and wins over the age-tier knobs; keep-last and
// keep-days are mutually exclusive. Precedence within a mode: explicit arg > env
// var > default.
function resolveRetentionPolicy({ maxBackups, dailySlots, keepLast, keepDays, env = process.env } = {}) {
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

function resolveBackupOptions(options = {}) {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const mode = options.mode || (process.env.NODE_ENV === 'production' ? 'prod' : 'dev');
  const outputDir = path.resolve(cwd, options.outputDir || path.relative(cwd, DEFAULT_OUTPUT_DIR));
  const compressSqlite = options.compressSqlite !== false;
  const allowUnsafeCopy = options.allowUnsafeCopy === true;
  const encryption = options.encryption || null;
  const minBytes = Number(options.minBytes) > 0 ? Number(options.minBytes) : 0;
  const stampFile = options.stampFile || null;
  const namePrefix = options.namePrefix || null;
  const remote = options.remote || null;
  const s3 = options.s3 || null;
  if (remote && s3) {
    throw new Error(
      'remote (rclone) and s3 are mutually exclusive; configure only one off-host remote type.',
    );
  }
  const skipRemote = options.skipRemote === true;
  const policy = options.policy || DEFAULT_RETENTION_POLICY;
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
    remote,
    s3,
    skipRemote,
    policy,
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

// Age-tier selection (the default policy): `dailySlots` most-recent backups,
// then one backup per age anchor, capped at `maxBackups`.
function selectAgeTier(sorted, policy, now) {
  const selected = [];
  const selectedNames = new Set();

  const dailyCount = Math.min(policy.dailySlots, policy.maxBackups);
  sorted.slice(0, dailyCount).forEach((backup, index) => {
    selected.push({
      ...backup,
      retentionReason: 'daily',
      retentionLabel: `Daily slot ${index + 1}`,
    });
    selectedNames.add(backup.fileName);
  });

  for (const anchor of policy.anchors) {
    if (selected.length >= policy.maxBackups) {
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
  } else {
    selected = selectAgeTier(sorted, policy, now);
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

// Keep the newest `keep` remote objects, never fewer than 1, and never the object
// we just uploaded and verified — same clock-rollback protection as the local
// prune. A prune failure is a cleanup miss, not a data-safety issue: the new
// backup is already verified on both ends, so warn and carry on.
function pruneRemoteBackups(remote, protectFileName, runtime, namePrefix = null) {
  const keep = Math.max(1, Number(remote.keep) > 0 ? Number(remote.keep) : DEFAULT_REMOTE_KEEP);
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

  const candidates = listing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((name) => name && name !== protectFileName && parseBackupFileName(name, namePrefix))
    .sort()
    .reverse();

  const doomed = candidates.slice(keep - 1);
  const deleted = [];
  for (const name of doomed) {
    try {
      runtime.execFileSync('rclone', ['deletefile', remoteObjectPath(remote, name)], {
        stdio: 'pipe',
        env: rcloneEnv(remote),
      });
      deleted.push(name);
    } catch (error) {
      console.warn(`[db-backup] Failed to prune remote backup ${name} (leaving it in place): ${error.message}`);
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

// Fail closed on a silent same-disk-only "backup". A backup that lives only
// on the disk that holds the database is not a backup — one disk failure
// loses both copies. This must be a DELIBERATE choice, so the caller has to
// either configure offsite replication or explicitly opt in to the risk.
// No file is created and nothing is left implying success. See rouge's
// deploy/backup-rouge-db.sh (ROG-1138): a hand-rolled wrapper already learned
// this the hard way — "no offsite" produced nine silent nights of local-only
// backups before anyone noticed.
// A remote is configured whether it's the rclone target OR the native S3
// (AWS/R2) config — either satisfies the "not local-only" requirement. Shared
// by runBackupJob and runBackupJobAsync so the guard can't drift between them.
function assertOffsiteRemoteConfigured(resolved) {
  const hasRemote = Boolean(resolved.remote) || Boolean(resolved.s3);
  const localOnly = resolved.skipRemote === true && !hasRemote;
  if (!hasRemote && !resolved.skipRemote) {
    throw new Error(
      'Refusing to create a local-only backup: no --remote/--s3-bucket is configured and ' +
      '--skip-remote was not passed. A backup on the same disk as the database is not a ' +
      'backup — a single disk failure destroys both. Configure --remote <dest> (offsite ' +
      'replication via rclone) or --s3-bucket <bucket> (native AWS S3 / Cloudflare R2), or ' +
      'pass --skip-remote (skipRemote: true) to explicitly accept the same-disk risk.',
    );
  }
  return { hasRemote, localOnly };
}

// Shared bottom half of a backup run, once the (already-uploaded-and-verified,
// or intentionally skipped) remote copy is known: local retention, manifest,
// and the success stamp. Entirely synchronous — no network I/O here — so both
// runBackupJob and runBackupJobAsync call it the same way.
function finalizeBackupResult(resolved, created, now, uploaded, removedRemote, localOnly) {
  const backups = listBackups({ outputDir: resolved.outputDir, now, namePrefix: resolved.namePrefix });
  const plan = planRetention(backups, resolved.policy, now);

  // NEVER prune the backup we just created and verified, whatever the plan
  // says. A host whose clock jumped backward at boot gives the new file an
  // older timestamp than existing ones, and a retention policy that trusts the
  // ordering would then delete the only known-good backup.
  const doomed = plan.remove.filter((entry) => entry.fileName !== created.fileName);
  const removed = pruneBackups(doomed);

  // Best-effort: a manifest write failure must never fail the backup itself.
  // Safety/pre-restore backups (created via createBackup outside this job)
  // are intentionally NOT manifested — they're transient.
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

  // Stamped only after the backup exists, passed its integrity check, cleared
  // the size floor, was encrypted if configured, and retention completed. A
  // failure anywhere above leaves the previous stamp untouched, so a freshness
  // monitor reads the run as stale rather than silently "successful".
  if (resolved.stampFile) {
    writeSuccessStamp(resolved.stampFile, now);
  }

  return {
    created,
    removed,
    removedRemote,
    uploaded,
    kept: plan.keep,
    mode: resolved.mode,
    outputDir: resolved.outputDir,
    policy: resolved.policy,
    localOnly,
  };
}

const S3_SYNC_REFUSAL_MESSAGE =
  'runBackupJob (the synchronous API) cannot use an S3 remote: uploading it would block the ' +
  'Node event loop for the entire upload, which is fine for a one-shot CLI process but freezes ' +
  'an in-process/library host (e.g. every request an app server is handling) for as long as the ' +
  'upload takes. Use runBackupJobAsync(options) (await it — its S3 upload runs on the normal ' +
  'async `fetch`, not the event loop) or the `db-backup` CLI, which already awaits it. ' +
  'runBackupJob remains fully supported for --remote (rclone) and local-only (skipRemote) backups.';

// Synchronous backup job. Supports the rclone remote and local-only
// (skipRemote) backups exactly as before. Deliberately REFUSES an S3 remote —
// see S3_SYNC_REFUSAL_MESSAGE — rather than silently blocking the event loop
// or silently falling back to some other behavior. Use runBackupJobAsync for
// S3.
function runBackupJob(options = {}) {
  const resolved = resolveBackupOptions(options);

  if (resolved.s3) {
    throw new Error(S3_SYNC_REFUSAL_MESSAGE);
  }

  const { localOnly } = assertOffsiteRemoteConfigured(resolved);

  ensureBackupDir(resolved.outputDir);

  return withBackupLock(resolved.outputDir, resolved.runtime, () => {
    const created = createBackup(resolved);
    const now = resolved.runtime.now();

    // Replicate off-host BEFORE anything is pruned or stamped. A local-only
    // backup dies with the disk it sits on; an unverified remote copy is not a
    // backup. If the upload or its verification fails we throw here, so the
    // previous good backups and the previous stamp both survive untouched.
    let uploaded = null;
    if (resolved.remote && !resolved.skipRemote) {
      uploaded = uploadBackupToRemote(created, resolved.remote, resolved.runtime);
    } else if (localOnly) {
      console.warn(
        '[db-backup] WARNING: local-only backup (skipRemote explicitly set, no remote ' +
        'configured). This backup exists only on the same disk as the database.',
      );
    }

    // Remote retention is best-effort: the new object is verified on both ends,
    // so a stray old copy is a cleanup miss, not a data-safety issue.
    const removedRemote =
      uploaded && resolved.remote
        ? pruneRemoteBackups(resolved.remote, created.fileName, resolved.runtime, resolved.namePrefix)
        : [];

    return finalizeBackupResult(resolved, created, now, uploaded, removedRemote, localOnly);
  });
}

// Async backup job — the correct entry point for any in-process/library
// caller whose S3 remote must not block its event loop (e.g. a Next.js API
// route). Supports everything runBackupJob supports (rclone, local-only)
// PLUS a native S3/R2 remote, uploaded via the real async `fetch` (see
// s3-remote.js) with no worker thread and no Atomics.wait anywhere in the
// call chain. The CLI awaits this for every `backup` invocation.
async function runBackupJobAsync(options = {}) {
  const resolved = resolveBackupOptions(options);

  const { localOnly } = assertOffsiteRemoteConfigured(resolved);

  ensureBackupDir(resolved.outputDir);

  return withBackupLockAsync(resolved.outputDir, resolved.runtime, async () => {
    const created = createBackup(resolved);
    const now = resolved.runtime.now();

    // Replicate off-host BEFORE anything is pruned or stamped. A local-only
    // backup dies with the disk it sits on; an unverified remote copy is not a
    // backup. If the upload or its verification fails we throw (reject) here,
    // so the previous good backups and the previous stamp both survive
    // untouched.
    let uploaded = null;
    if (resolved.remote && !resolved.skipRemote) {
      uploaded = uploadBackupToRemote(created, resolved.remote, resolved.runtime);
    } else if (resolved.s3 && !resolved.skipRemote) {
      uploaded = await uploadBackupToS3(created, resolved.s3, resolved.runtime);
    } else if (localOnly) {
      console.warn(
        '[db-backup] WARNING: local-only backup (skipRemote explicitly set, no remote ' +
        'configured). This backup exists only on the same disk as the database.',
      );
    }

    // Remote retention is best-effort: the new object is verified on both ends,
    // so a stray old copy is a cleanup miss, not a data-safety issue.
    const removedRemote =
      uploaded && resolved.remote
        ? pruneRemoteBackups(resolved.remote, created.fileName, resolved.runtime, resolved.namePrefix)
        : uploaded && resolved.s3
          ? await pruneS3Backups(resolved.s3, created.fileName, resolved.runtime, resolved.namePrefix, parseBackupFileName)
          : [];

    return finalizeBackupResult(resolved, created, now, uploaded, removedRemote, localOnly);
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
  --output-dir <path>     Backup directory (default: backups/database)
  --max-backups <n>       Age-tier: max backups to retain (env: DB_BACKUP_MAX_BACKUPS)
  --daily-slots <n>       Age-tier: recent daily slots before age tiers (env: DB_BACKUP_DAILY_SLOTS)
  --keep-last <n>         Flat retention: keep the N most-recent backups (env: DB_BACKUP_KEEP_LAST)
  --keep-days <n>         Flat retention: keep backups younger than N days (env: DB_BACKUP_KEEP_DAYS)
  --command-timeout <s>   Bound every external command (env: DB_BACKUP_COMMAND_TIMEOUT_MS)
  --allow-unsafe-copy     Permit a byte copy when sqlite3 is absent (inconsistent)
  --encrypt-passphrase-file <path>  Encrypt the backup (gpg symmetric AES256)
  --cipher <algo>         gpg cipher algorithm (default: AES256)
  --min-bytes <n>         Discard and fail if the backup is smaller than n bytes
  --name-prefix <name>    Filename prefix (default sqlite-backup / postgres-backup)
  --stamp-file <path>     Write .last-success only after a fully successful run
  --max-age-hours <n>     Freshness threshold (command: freshness, default 36)
  --remote <dest>         Upload off-host via rclone and verify (e.g. remote:path)
  --remote-keep <n>       Remote backups to retain (default 30; applies to --remote or --s3-bucket)
  --rclone-config <path>  RCLONE_CONFIG for the upload (and remote freshness check)
  --s3-bucket <name>      Upload off-host to S3/R2 natively (SigV4, no rclone) and verify.
                          Mutually exclusive with --remote. Credentials come from the
                          environment ONLY: AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY (or
                          S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY) — never a flag.
  --s3-prefix <path>      Key prefix under the bucket (default: none)
  --s3-endpoint <url>     S3-compatible endpoint, e.g. Cloudflare R2:
                          https://<account>.r2.cloudflarestorage.com (default: AWS S3)
  --s3-region <region>    Signing region (default: auto for R2/--s3-endpoint, us-east-1 for AWS)
  --s3-timeout <s>        Bound every S3 HTTP request (env: DB_BACKUP_S3_TIMEOUT_MS, default 300)
  --skip-remote           Local-only run: no upload, no remote prune
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

  const baseOptions = {
    mode: options.mode,
    outputDir: options.outputDir,
    compressSqlite: options.compressSqlite,
    allowUnsafeCopy: options.allowUnsafeCopy,
    encryption: options.passphraseFile
      ? { passphraseFile: options.passphraseFile, ...(options.cipher ? { cipher: options.cipher } : {}) }
      : null,
    minBytes: options.minBytes,
    stampFile: options.stampFile,
    namePrefix: options.namePrefix,
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
    runtime: { commandTimeoutMs: options.commandTimeoutMs, s3TimeoutMs: options.s3TimeoutMs },
    policy: resolveRetentionPolicy({
      maxBackups: options.maxBackups,
      dailySlots: options.dailySlots,
      keepLast: options.keepLast,
      keepDays: options.keepDays,
    }),
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
      stopWriters: options.stopWritersCommand,
      startWriters: options.startWritersCommand,
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
  buildDailyCronEntry,
  listBackupsWithPlan,
  pruneBackupsJob,
  resolveRetentionPolicy,
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
