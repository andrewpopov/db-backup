export interface RetentionAnchor {
  key: string;
  label: string;
  minAgeDays: number;
  maxAgeDays: number;
  targetAgeDays: number;
}

/** Default retention: keep `dailySlots` most-recent backups plus one per age
 * anchor, capped at `maxBackups`. `mode` is optional/absent for backward
 * compatibility and treated as 'age-tier'. */
export interface AgeTierRetentionPolicy {
  mode?: 'age-tier';
  maxBackups: number;
  dailySlots: number;
  anchors: RetentionAnchor[];
}

/** Flat count retention: keep the `keepLast` most-recent backups. */
export interface KeepLastRetentionPolicy {
  mode: 'keep-last';
  keepLast: number;
}

/** Flat age retention: keep backups younger than `keepDays` days, always
 * retaining at least the single most-recent backup. */
export interface KeepDaysRetentionPolicy {
  mode: 'keep-days';
  keepDays: number;
}

export type RetentionPolicy =
  | AgeTierRetentionPolicy
  | KeepLastRetentionPolicy
  | KeepDaysRetentionPolicy;

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
  /** sha256 hex digest of the backup file. Populated by createSqliteBackup /
   * createPostgresBackup; absent on entries derived from disk scans alone
   * (e.g. via getBackupEntryFromPath/listBackups) until re-hashed. */
  sha256?: string;
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

export const DEFAULT_RETENTION_POLICY: AgeTierRetentionPolicy;

export function buildDailyCronEntry(options?: {
  hour?: number;
  minute?: number;
  command?: string;
  logPath?: string;
}): string;

export function listBackupsWithPlan(options?: BackupOptions): BackupListResult;
export function pruneBackupsJob(options?: BackupOptions): PruneJobResult;
/** A numeric retention knob is always "present", so it pins the mode and a
 * flat-mode env var can never override it — the narrow return type holds.
 *
 * The discriminating field is `number`, not `number | string`, on purpose: an
 * empty string means "absent" at runtime, so a string-typed knob cannot promise
 * a narrow return and instead falls through to the union overload below. */
export function resolveRetentionPolicy(options: {
  maxBackups: number;
  dailySlots?: number | string | null;
  keepLast?: null;
  keepDays?: null;
  env?: NodeJS.ProcessEnv;
}): AgeTierRetentionPolicy;
export function resolveRetentionPolicy(options: {
  dailySlots: number;
  maxBackups?: number | string | null;
  keepLast?: null;
  keepDays?: null;
  env?: NodeJS.ProcessEnv;
}): AgeTierRetentionPolicy;
export function resolveRetentionPolicy(options: {
  keepLast: number;
  keepDays?: null;
  maxBackups?: null;
  dailySlots?: null;
  env?: NodeJS.ProcessEnv;
}): KeepLastRetentionPolicy;
export function resolveRetentionPolicy(options: {
  keepDays: number;
  keepLast?: null;
  maxBackups?: null;
  dailySlots?: null;
  env?: NodeJS.ProcessEnv;
}): KeepDaysRetentionPolicy;
/** Fallback: no retention option, or one whose presence can't be known
 * statically (a string may be empty, which means "absent"). The env may then
 * select any mode, so the caller gets the union and must narrow on `mode`.
 * Conflicting combinations type-check here but throw at runtime. */
export function resolveRetentionPolicy(options?: {
  maxBackups?: number | string | null;
  dailySlots?: number | string | null;
  keepLast?: number | string | null;
  keepDays?: number | string | null;
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
  /** sha256 hex digest of the backup file at manifest-write time. Verified by
   * restoreBackup before touching the live database, when present. */
  sha256?: string;
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
