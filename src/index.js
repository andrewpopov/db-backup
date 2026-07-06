const fs = require('fs');
const path = require('path');
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
    allowMissing: false,
    maxBackups: null,
    dailySlots: null,
    cronCommand: null,
    logPath: null,
  };

  const commandArg = argv[0];
  if (
    commandArg === 'backup' ||
    commandArg === 'list' ||
    commandArg === 'prune' ||
    commandArg === 'cron' ||
    commandArg === 'restore'
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

    throw new Error(`Unknown argument: ${arg}`);
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

function normalizeRuntime(runtime = {}) {
  const runCommand = runtime.execFileSync || execFileSync;

  return {
    execFileSync: runCommand,
    commandExists: runtime.commandExists || ((command) => commandExists(command, runCommand)),
    sleep: runtime.sleep || sleep,
    now: runtime.now || (() => new Date()),
    randomId: runtime.randomId || (() => `${Date.now()}-${Math.random().toString(16).slice(2)}`),
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

function buildBackupFilename(engine, timestamp, compressSqlite, sequence = 1) {
  const suffix = sequence > 1 ? `-${sequence}` : '';
  if (engine === 'sqlite') {
    return `sqlite-backup-${timestamp}${suffix}.db${compressSqlite ? '.gz' : ''}`;
  }
  if (engine === 'postgres') {
    return `postgres-backup-${timestamp}${suffix}.dump`;
  }
  return `db-backup-${engine}-${timestamp}${suffix}.bak`;
}

function buildUniqueBackupPath({ engine, timestamp, outputDir, compressSqlite = false }) {
  for (let sequence = 1; sequence < 1000; sequence += 1) {
    const fileName = buildBackupFilename(engine, timestamp, compressSqlite, sequence);
    const fullPath = path.join(outputDir, fileName);

    if (!fs.existsSync(fullPath)) {
      return { fileName, fullPath };
    }
  }

  throw new Error(`Unable to allocate a unique backup filename for ${engine} at ${timestamp}`);
}

function buildUniqueSqliteRawBackupPath({ timestamp, outputDir, compressSqlite }) {
  for (let sequence = 1; sequence < 1000; sequence += 1) {
    const rawFileName = buildBackupFilename('sqlite', timestamp, false, sequence);
    const rawFilePath = path.join(outputDir, rawFileName);
    const compressedFilePath = `${rawFilePath}.gz`;

    if (!fs.existsSync(rawFilePath) && (!compressSqlite || !fs.existsSync(compressedFilePath))) {
      return { rawFileName, rawFilePath };
    }
  }

  throw new Error(`Unable to allocate a unique SQLite backup filename for ${timestamp}`);
}

function parseBackupFileName(fileName) {
  const sqliteMatch = fileName.match(/^sqlite-backup-(\d{8}-\d{6}Z)(?:-(\d+))?\.db(\.gz)?$/);
  if (sqliteMatch) {
    return {
      engine: 'sqlite',
      timestampKey: sqliteMatch[1],
      sequence: sqliteMatch[2] ? Number.parseInt(sqliteMatch[2], 10) : 1,
      compressed: Boolean(sqliteMatch[3]),
    };
  }

  const postgresMatch = fileName.match(/^postgres-backup-(\d{8}-\d{6}Z)(?:-(\d+))?\.dump$/);
  if (postgresMatch) {
    return {
      engine: 'postgres',
      timestampKey: postgresMatch[1],
      sequence: postgresMatch[2] ? Number.parseInt(postgresMatch[2], 10) : 1,
      compressed: false,
    };
  }

  return null;
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
// DEFAULT_RETENTION_POLICY. Only maxBackups/dailySlots are tunable from the
// operational surface; the age-tier anchors stay policy-owned. Precedence:
// explicit argument > env var > default.
function resolveRetentionPolicy({ maxBackups, dailySlots, env = process.env } = {}) {
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
    policy,
    databaseUrl,
    runtime,
  };
}

function verifySqliteBackupIntegrity(backupPath, runtime) {
  const output = runtime.execFileSync('sqlite3', [backupPath, 'PRAGMA integrity_check;'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const firstLine = (output ? output.toString() : '').trim().split(/\r?\n/, 1)[0] || '';
  if (firstLine !== 'ok') {
    fs.rmSync(backupPath, { force: true });
    throw new Error(`SQLite backup integrity check failed: ${firstLine || 'no output'}`);
  }
}

function createSqliteBackup({ databaseUrl, outputDir, compressSqlite, now, cwd = process.cwd(), runtime = normalizeRuntime() }) {
  now = now || runtime.now();
  const sourcePath = parseSqlitePath(databaseUrl, cwd);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`SQLite database file not found: ${sourcePath}`);
  }

  const timestamp = formatTimestamp(now);
  const { rawFilePath } = buildUniqueSqliteRawBackupPath({ timestamp, outputDir, compressSqlite });

  if (runtime.commandExists('sqlite3')) {
    const escapedBackupPath = rawFilePath.replace(/'/g, "''");
    const sqliteArgs = ['-cmd', '.timeout 5000', sourcePath, `.backup '${escapedBackupPath}'`];
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
    // throw. Only possible when sqlite3 is present (the cp fallback can't verify).
    verifySqliteBackupIntegrity(rawFilePath, runtime);
  } else {
    fs.copyFileSync(sourcePath, rawFilePath);
  }

  let finalPath = rawFilePath;
  let compressed = false;
  if (compressSqlite && runtime.commandExists('gzip')) {
    runtime.execFileSync('gzip', ['-f', rawFilePath], { stdio: 'inherit' });
    finalPath = `${rawFilePath}.gz`;
    compressed = true;
  }

  const stats = fs.statSync(finalPath);
  return {
    fileName: path.basename(finalPath),
    fullPath: finalPath,
    engine: 'sqlite',
    compressed,
    createdAt: now.toISOString(),
    sizeBytes: stats.size,
  };
}

function createPostgresBackup({ databaseUrl, outputDir, now, runtime = normalizeRuntime() }) {
  now = now || runtime.now();
  if (!runtime.commandExists('pg_dump')) {
    throw new Error('pg_dump is required for PostgreSQL backups but is not installed.');
  }

  const timestamp = formatTimestamp(now);
  const { fileName, fullPath } = buildUniqueBackupPath({
    engine: 'postgres',
    timestamp,
    outputDir,
  });
  runtime.execFileSync('pg_dump', ['--format=custom', `--file=${fullPath}`, databaseUrl], { stdio: 'inherit' });
  const stats = fs.statSync(fullPath);

  return {
    fileName,
    fullPath,
    engine: 'postgres',
    compressed: false,
    createdAt: now.toISOString(),
    sizeBytes: stats.size,
  };
}

function createBackup(options = {}) {
  const resolved = resolveBackupOptions(options);
  const now = resolved.runtime.now();
  fs.mkdirSync(resolved.outputDir, { recursive: true });

  const engine = detectDatabaseEngine(resolved.databaseUrl);
  if (engine === 'sqlite') {
    return createSqliteBackup({
      databaseUrl: resolved.databaseUrl,
      outputDir: resolved.outputDir,
      compressSqlite: resolved.compressSqlite,
      cwd: resolved.cwd,
      now,
      runtime: resolved.runtime,
    });
  }

  if (engine === 'postgres') {
    return createPostgresBackup({
      databaseUrl: resolved.databaseUrl,
      outputDir: resolved.outputDir,
      now,
      runtime: resolved.runtime,
    });
  }

  throw new Error('Unsupported DATABASE_URL scheme. Expected file:, postgres://, or postgresql://');
}

function getBackupEntryFromPath(backupPath, now = new Date()) {
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`);
  }

  const fileName = path.basename(backupPath);
  const parsed = parseBackupFileName(fileName);
  if (!parsed) {
    throw new Error(`Unsupported backup filename format: ${fileName}`);
  }

  const stats = fs.statSync(backupPath);
  const timestampDate = parseTimestampKey(parsed.timestampKey);
  const createdAt = timestampDate || stats.mtime;
  const ageDays = (now.getTime() - createdAt.getTime()) / DAY_MS;

  return {
    fileName,
    fullPath: backupPath,
    engine: parsed.engine,
    compressed: parsed.compressed,
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
} = {}) {
  const absoluteOutputDir = path.resolve(outputDir);

  if (backupFile) {
    const candidatePath = path.isAbsolute(backupFile)
      ? backupFile
      : path.resolve(absoluteOutputDir, backupFile);
    return getBackupEntryFromPath(candidatePath, now);
  }

  if (useLatest) {
    const backups = listBackups({ outputDir: absoluteOutputDir, now });
    if (backups.length === 0) {
      throw new Error(`No backups found in: ${absoluteOutputDir}`);
    }
    return backups[0];
  }

  throw new Error('Restore requires --file <backup-file> or --latest.');
}

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

function restoreSqliteBackup({
  databaseUrl,
  backupEntry,
  cwd = process.cwd(),
  runtime = normalizeRuntime(),
} = {}) {
  const destinationPath = parseSqlitePath(databaseUrl, cwd);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

  const tempPath = path.join(
    path.dirname(destinationPath),
    `.restore-${runtime.randomId()}.db`
  );

  try {
    if (backupEntry.compressed) {
      const compressed = fs.readFileSync(backupEntry.fullPath);
      const decompressed = zlib.gunzipSync(compressed);
      fs.writeFileSync(tempPath, decompressed);
    } else {
      fs.copyFileSync(backupEntry.fullPath, tempPath);
    }

    if (fs.existsSync(destinationPath)) {
      fs.unlinkSync(destinationPath);
    }

    fs.renameSync(tempPath, destinationPath);
  } catch (error) {
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Best effort cleanup.
      }
    }
    throw error;
  }

  return {
    target: destinationPath,
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

function restoreBackup(options = {}) {
  const resolved = resolveBackupOptions(options);
  const now = resolved.runtime.now();
  const backupEntry = resolveRestoreBackup({
    backupFile: options.backupFile,
    useLatest: options.useLatest,
    outputDir: resolved.outputDir,
    now,
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
  };
}

function listBackups({ outputDir = DEFAULT_OUTPUT_DIR, now = new Date() } = {}) {
  const absoluteOutputDir = path.resolve(outputDir);
  if (!fs.existsSync(absoluteOutputDir)) {
    return [];
  }

  const files = fs.readdirSync(absoluteOutputDir)
    .map((fileName) => {
      const parsed = parseBackupFileName(fileName);
      if (!parsed) {
        return null;
      }

      const timestampDate = parseTimestampKey(parsed.timestampKey);
      const fullPath = path.join(absoluteOutputDir, fileName);
      const fileStats = fs.statSync(fullPath);
      const createdAt = timestampDate || fileStats.mtime;
      const ageDays = (now.getTime() - createdAt.getTime()) / DAY_MS;

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
      ageDays: (now.getTime() - new Date(backup.createdAt).getTime()) / DAY_MS,
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

function planRetention(backups, policy = DEFAULT_RETENTION_POLICY, now = new Date()) {
  const selected = [];
  const selectedNames = new Set();

  const sorted = [...backups].sort(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
  );

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
  const backups = listBackups({ outputDir: resolved.outputDir, now });
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

// Apply the retention policy to an existing backup directory without creating a
// new snapshot — a standalone cleanup pass. Like list, it never opens the
// database, so DATABASE_URL is not required.
function pruneBackupsJob(options = {}) {
  const resolved = resolveBackupOptions({ ...options, requireDatabaseUrl: false });
  const now = resolved.runtime.now();
  const backups = listBackups({ outputDir: resolved.outputDir, now });
  const plan = planRetention(backups, resolved.policy, now);
  const removed = pruneBackups(plan.remove);

  return {
    removed,
    kept: plan.keep,
    mode: resolved.mode,
    outputDir: resolved.outputDir,
    policy: resolved.policy,
  };
}

function runBackupJob(options = {}) {
  const resolved = resolveBackupOptions(options);
  const created = createBackup(resolved);
  const now = resolved.runtime.now();
  const backups = listBackups({ outputDir: resolved.outputDir, now });
  const plan = planRetention(backups, resolved.policy, now);
  const removed = pruneBackups(plan.remove);

  return {
    created,
    removed,
    kept: plan.keep,
    mode: resolved.mode,
    outputDir: resolved.outputDir,
    policy: resolved.policy,
  };
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
  db-backup-manager [backup|list|prune|cron|restore] [options]

Commands:
  backup                  Create a backup and apply retention policy (default)
  list                    List backups with keep/rotate decisions (no DB needed)
  prune                   Apply retention now without taking a backup (no DB needed)
  cron                    Print a daily cron entry
  restore                 Restore database from backup file

Options:
  --prod                  Use production env files (.env + .env.production)
  --dev                   Use development env files (.env + .env.local)
  --output-dir <path>     Backup directory (default: backups/database)
  --max-backups <n>       Max backups to retain (env: DB_BACKUP_MAX_BACKUPS)
  --daily-slots <n>       Recent daily slots before age tiers (env: DB_BACKUP_DAILY_SLOTS)
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
  --help                  Show help
`);
}

function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);

  if (options.command === 'help') {
    showHelp();
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
    policy: resolveRetentionPolicy({
      maxBackups: options.maxBackups,
      dailySlots: options.dailySlots,
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
    console.log(`[db-backup] Restore target: ${restoreResult.target}`);
    console.log('[db-backup] Restore completed. Restart your application before serving traffic.');
    return;
  }

  let result;
  try {
    result = runBackupJob(baseOptions);
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
  runCli,
  // Backup-storage helpers (BWK-85, generalized from stoki/pantry):
  MANIFEST_FILENAME,
  expandHome,
  isContainedWithin,
  resolveBackupDirectories,
  getBackupFallbackDirectory,
  resolveContainedBackupPath,
  readBackupManifest,
  appendBackupManifestEntry,
};
