// Consumer-side type contract for src/index.d.ts. This file is NOT run — it is
// type-checked by `npm run verify:types` (tsc --noEmit). If the hand-written
// declarations drift from the JS surface, this fails to compile in CI.
//
// It exercises the public API the way a real consumer (bewks, sano, sano-os)
// does.
import {
  runBackupJob,
  restoreBackup,
  listBackupsWithPlan,
  pruneBackupsJob,
  resolveRetentionPolicy,
  planRetention,
  createSqliteSnapshot,
  verifySqliteBackupIntegrity,
  checkBackupFreshness,
  writeSuccessStamp,
  uploadBackupToRemote,
  pruneRemoteBackups,
  DEFAULT_CIPHER_ALGO,
  restoreSqliteBackup,
  removeSqliteSidecars,
  normalizeRuntime,
  DEFAULT_COMMAND_TIMEOUT_MS,
  buildDailyCronEntry,
  runCli,
  DEFAULT_RETENTION_POLICY,
  resolveBackupDirectories,
  resolveContainedBackupPath,
  readBackupManifest,
  appendBackupManifestEntry,
  type BackupEntry,
  type BackupJobResult,
  type RestoreResult,
  type BackupListResult,
  type PruneJobResult,
  type RetentionPolicy,
  type AgeTierRetentionPolicy,
  type KeepLastRetentionPolicy,
  type KeepDaysRetentionPolicy,
  type BackupPlan,
  type BackupManifest,
  type ResolvedBackupRuntime,
  type BackupEncryption,
  type BackupFreshness,
  type BackupRemote,
} from '../src/index';

// Retention policy + the three job entry points.
const policy: RetentionPolicy = resolveRetentionPolicy({ maxBackups: 6, dailySlots: 3 });

// Explicit age-tier knobs must keep narrowing to the age-tier shape, so existing
// consumers can still read maxBackups/dailySlots off the result without a guard.
const ageTier: AgeTierRetentionPolicy = resolveRetentionPolicy({ maxBackups: 6, dailySlots: 3 });
const _maxBackups: number = ageTier.maxBackups;
const _defaultMax: number = DEFAULT_RETENTION_POLICY.maxBackups;

// Flat modes narrow to their own shapes.
const keepLastPolicy: KeepLastRetentionPolicy = resolveRetentionPolicy({ keepLast: 8 });
const _keepLast: number = keepLastPolicy.keepLast;
const keepDaysPolicy: KeepDaysRetentionPolicy = resolveRetentionPolicy({ keepDays: 30 });
const _keepDays: number = keepDaysPolicy.keepDays;

// A STRING knob may be empty (== absent at runtime), so it must NOT narrow: it
// falls through to the union overload. This guard fails if someone widens the
// narrow overloads back to `number | string`.
// @ts-expect-error string-typed maxBackups cannot promise AgeTierRetentionPolicy
const _unsound: AgeTierRetentionPolicy = resolveRetentionPolicy({ maxBackups: '6' });

// Conflicting options are a runtime error; the union overload accepts them.
const _conflicting: RetentionPolicy = resolveRetentionPolicy({ keepLast: 2, maxBackups: 4 });

// With no explicit option the env decides, so the caller gets the union and must
// narrow on `mode` before touching mode-specific fields.
const resolved: RetentionPolicy = resolveRetentionPolicy();
const _described: string =
  resolved.mode === 'keep-last'
    ? `keep-last ${resolved.keepLast}`
    : resolved.mode === 'keep-days'
      ? `keep-days ${resolved.keepDays}`
      : `age-tier ${resolved.maxBackups}`;

// Every policy shape is accepted by planRetention.
planRetention([], keepLastPolicy);
planRetention([], keepDaysPolicy);
planRetention([], ageTier);

// The SQLite engine seam, as savoro's admin "back up now" route consumes it:
// its own destination filename, its own manifest, no pruning side-effect.
const boundedRuntime: ResolvedBackupRuntime = normalizeRuntime({ commandTimeoutMs: 30_000 });
const _timeout: number = boundedRuntime.commandTimeoutMs;
const _bound: number = DEFAULT_COMMAND_TIMEOUT_MS;

const snapshotPath: string = createSqliteSnapshot({
  sourcePath: '/srv/app/data/app.db',
  destPath: '/srv/app/backups/pantry_backup_2026-07-09.db',
  runtime: boundedRuntime,
});

verifySqliteBackupIntegrity(snapshotPath, boundedRuntime);
removeSqliteSidecars('/srv/app/data/app.db');

const restored: { target: string } = restoreSqliteBackup({
  databaseUrl: 'file:./data/app.db',
  backupEntry: { fullPath: snapshotPath, compressed: false },
  runtime: boundedRuntime,
});
const _restoredTarget: string = restored.target;

const jobResult: BackupJobResult = runBackupJob({
  mode: 'prod',
  outputDir: '/var/backups/myapp',
  policy,
});

// sha256 is optional on BackupEntry: populated by create*Backup, absent on
// entries derived purely from a disk scan.
const createdSha256: string | undefined = jobResult.created.sha256;

const restoreResult: RestoreResult = restoreBackup({
  outputDir: '/var/backups/myapp',
  backupFile: 'sqlite-backup-20260705-150000Z.db.gz',
  createPreRestoreBackup: false,
});

const listResult: BackupListResult = listBackupsWithPlan({ outputDir: '/var/backups/myapp' });
const pruneResult: PruneJobResult = pruneBackupsJob({ outputDir: '/var/backups/myapp' });

const plan: BackupPlan = planRetention(listResult.backups as BackupEntry[], DEFAULT_RETENTION_POLICY, new Date());

const cronLine: string = buildDailyCronEntry({ hour: 3, minute: 0 });

// Backup-storage helpers.
const dirs: string[] = resolveBackupDirectories({
  env: { BACKUP_DIRS: '~/backups' },
  candidates: ['/srv/app/backups'],
});
const contained: string | null = resolveContainedBackupPath('/srv/app/backups/db.gz', {
  directories: dirs,
});
const manifest: BackupManifest = readBackupManifest('/var/backups/myapp');
const manifestEntrySha256: string | undefined = manifest.entries[0]?.sha256;
const updatedManifest: BackupManifest = appendBackupManifestEntry('/var/backups/myapp', {
  name: 'sqlite-backup-20260705-150000Z.db.gz',
  path: '/var/backups/myapp/sqlite-backup-20260705-150000Z.db.gz',
  createdAt: new Date().toISOString(),
  sizeBytes: 128,
  sha256: 'deadbeef',
});

runCli(['list', '--output-dir', '/var/backups/myapp']);

// Reference the values so tsc doesn't prune the imports as unused.
export const _contract = {
  jobResult,
  createdSha256,
  restoreResult,
  listResult,
  pruneResult,
  plan,
  cronLine,
  dirs,
  contained,
  manifest,
  manifestEntrySha256,
  updatedManifest,
};

// Encryption at rest + backup liveness (BWK-131), as smarthome's cron will use it.
const encryption: BackupEncryption = { passphraseFile: '/var/lib/app/secrets/backup.pass' };
const _cipher: string = DEFAULT_CIPHER_ALGO;

runBackupJob({
  mode: 'prod',
  outputDir: '/var/lib/app/backups',
  encryption,
  minBytes: 32_768,
  stampFile: '/var/lib/app/backups/.last-success',
});

const stamped: string = writeSuccessStamp('/var/lib/app/backups/.last-success');
const freshness: BackupFreshness = checkBackupFreshness({
  stampFile: stamped,
  maxAgeHours: 36,
});
const _stale: boolean = !freshness.fresh;
const _age: number | null = freshness.ageHours;

// An encrypted backup needs the passphrase to restore.
restoreBackup({
  outputDir: '/var/lib/app/backups',
  backupFile: 'sqlite-backup-20260705-150000Z.db.gz.gpg',
  createPreRestoreBackup: false,
  encryption,
});

export const _encryptionContract = { encryption, freshness, _stale, _age, _cipher };

// Off-host replication with verification (BWK-131), as smarthome's cron uses it.
const remote: BackupRemote = { target: 'offsite:backups/app', keep: 30, configFile: '/var/lib/app/secrets/rclone.conf' };
const offsiteJob = runBackupJob({
  mode: 'prod',
  outputDir: '/var/lib/app/backups',
  encryption,
  remote,
  stampFile: '/var/lib/app/backups/.last-success',
});
const _uploadedTo: string | undefined = offsiteJob.uploaded?.target;
const _prunedRemote: string[] | undefined = offsiteJob.removedRemote;

// A pre-deploy hook wants the fast local-only path.
runBackupJob({ mode: 'prod', outputDir: '/var/lib/app/backups', remote, skipRemote: true });

export const _remoteContract = { remote, _uploadedTo, _prunedRemote };
