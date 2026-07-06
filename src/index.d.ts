export interface RetentionAnchor {
  key: string;
  label: string;
  minAgeDays: number;
  maxAgeDays: number;
  targetAgeDays: number;
}

export interface RetentionPolicy {
  maxBackups: number;
  dailySlots: number;
  anchors: RetentionAnchor[];
}

export interface BackupEntry {
  fileName: string;
  fullPath: string;
  engine: 'sqlite' | 'postgres' | 'unknown';
  compressed: boolean;
  createdAt: string;
  sizeBytes: number;
  ageDays?: number;
  keep?: boolean;
  retentionReason?: string;
  retentionLabel?: string;
}

export interface BackupOptions {
  mode?: 'dev' | 'prod';
  cwd?: string;
  outputDir?: string;
  databaseUrl?: string;
  compressSqlite?: boolean;
  policy?: RetentionPolicy;
  runtime?: BackupRuntime;
  strictProductionEnv?: boolean;
  /** list/prune set this false: they never open the DB, so DATABASE_URL is not required. */
  requireDatabaseUrl?: boolean;
  envFiles?: {
    base?: string;
    dev?: string;
    prod?: string;
  };
}

export interface BackupRuntime {
  commandExists?: (command: string) => boolean;
  execFileSync?: (command: string, args: string[], options?: unknown) => unknown;
  sleep?: (ms: number) => void;
  now?: () => Date;
  randomId?: () => string;
}

export interface BackupPlan {
  keep: BackupEntry[];
  remove: BackupEntry[];
  policy: RetentionPolicy;
}

export interface BackupJobResult {
  created: BackupEntry;
  removed: BackupEntry[];
  kept: BackupEntry[];
  mode: string;
  outputDir: string;
  policy: RetentionPolicy;
}

export interface BackupListResult {
  backups: BackupEntry[];
  plan: BackupPlan;
  mode: string;
  outputDir: string;
  policy: RetentionPolicy;
}

export interface PruneJobResult {
  removed: BackupEntry[];
  kept: BackupEntry[];
  mode: string;
  outputDir: string;
  policy: RetentionPolicy;
}

export interface RestoreOptions extends BackupOptions {
  backupFile?: string;
  useLatest?: boolean;
  createPreRestoreBackup?: boolean;
}

export interface RestoreResult {
  restored: BackupEntry;
  preRestoreBackup: BackupEntry | null;
  mode: string;
  outputDir: string;
  engine: 'sqlite' | 'postgres' | 'unknown';
  restoredAt: string;
  target: string;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy;

export function buildDailyCronEntry(options?: {
  hour?: number;
  minute?: number;
  command?: string;
  logPath?: string;
}): string;

export function listBackupsWithPlan(options?: BackupOptions): BackupListResult;
export function pruneBackupsJob(options?: BackupOptions): PruneJobResult;
export function resolveRetentionPolicy(options?: {
  maxBackups?: number | string | null;
  dailySlots?: number | string | null;
  env?: NodeJS.ProcessEnv;
}): RetentionPolicy;
export function planRetention(backups: BackupEntry[], policy?: RetentionPolicy, now?: Date): BackupPlan;
export function restoreBackup(options?: RestoreOptions): RestoreResult;
export function runBackupJob(options?: BackupOptions): BackupJobResult;
export function runCli(argv?: string[]): void;

// --- Backup-storage helpers (generalized from stoki/pantry) ---

export interface BackupManifestEntry {
  name: string;
  path: string;
  createdAt: string;
  sizeBytes: number;
  databaseSizeBytes?: number;
  label?: string;
  source?: string;
  [key: string]: unknown;
}

export interface BackupManifest {
  version: 1;
  entries: BackupManifestEntry[];
}

export const MANIFEST_FILENAME: string;

export function expandHome(dir: string, home?: string): string;
export function isContainedWithin(parent: string, candidate: string): boolean;

export function resolveBackupDirectories(options?: {
  env?: NodeJS.ProcessEnv;
  envVar?: string;
  candidates?: string[] | (() => string[]);
  home?: string;
}): string[];

export function getBackupFallbackDirectory(options?: { cwd?: string }): string;

export function resolveContainedBackupPath(
  candidate: string,
  options?: { directories?: string[]; home?: string },
): string | null;

export function readBackupManifest(directory: string): BackupManifest;
export function appendBackupManifestEntry(
  directory: string,
  entry: BackupManifestEntry,
): BackupManifest;
