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
  type BackupPlan,
  type BackupManifest,
} from '../src/index';

// Retention policy + the three job entry points.
const policy: RetentionPolicy = resolveRetentionPolicy({ maxBackups: 6, dailySlots: 3 });

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
