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

export interface BackupEncryption {
  /** Path to a file containing the symmetric passphrase. A file, never an
   * argument — a passphrase on the command line is visible in the process table. */
  passphraseFile: string;
  /** gpg `--cipher-algo`. Defaults to `DEFAULT_CIPHER_ALGO` (AES256). */
  cipher?: string;
}

export interface BackupRemote {
  /** rclone destination directory, e.g. `offsite:backups/app`. */
  target: string;
  /** Re-read the uploaded object and compare sizes. Default true. Turning this
   * off means the "backup" is unverified — prefer not to. */
  verify?: boolean;
  /** Remote objects to retain. Default 30, never fewer than 1. */
  keep?: number;
  /** RCLONE_CONFIG for the upload. */
  configFile?: string;
}

export interface BackupUploadResult {
  target: string;
  /** Verified byte count; null when `verify: false`. */
  sizeBytes: number | null;
}

export interface BackupFreshness {
  fresh: boolean;
  /** null when no successful backup has ever been recorded. */
  stampedAt: Date | null;
  ageHours: number | null;
  maxAgeHours: number;
}

export interface BackupEntry {
  fileName: string;
  fullPath: string;
  engine: 'sqlite' | 'postgres' | 'unknown';
  compressed: boolean;
  /** True when the artifact is gpg-encrypted (`.gpg` suffix). */
  encrypted?: boolean;
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
  /** Permit a plain byte copy when `sqlite3` is unavailable (default false). */
  allowUnsafeCopy?: boolean;
  /** Encrypt the backup at rest with gpg symmetric AES256. Required to restore
   * an encrypted backup. */
  encryption?: BackupEncryption | null;
  /** Discard and fail if the finished artifact is smaller than this. An empty or
   * truncated database passes `PRAGMA integrity_check`. 0 disables. */
  minBytes?: number;
  /** Write an ISO timestamp here ONLY after a fully successful run, so a
   * freshness monitor can tell a silent cron failure from a healthy one. */
  stampFile?: string | null;
  /** Replicate off-host via rclone and verify the uploaded object. Nothing is
   * pruned and no success is stamped until verification passes. */
  remote?: BackupRemote | null;
  /** Local-only run: skip the upload and the remote prune. */
  skipRemote?: boolean;
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

/** The injectable runtime. Every field is optional; `normalizeRuntime` fills the
 * gaps and returns a `ResolvedBackupRuntime`. */
export interface BackupRuntime {
  commandExists?: (command: string) => boolean;
  execFileSync?: (command: string, args: string[], options?: unknown) => unknown;
  sleep?: (ms: number) => void;
  now?: () => Date;
  randomId?: () => string;
  /** Process timeout applied to every external command. Overrides
   * `DB_BACKUP_COMMAND_TIMEOUT_MS`; defaults to `DEFAULT_COMMAND_TIMEOUT_MS`. */
  commandTimeoutMs?: number | string | null;
}

/** A fully-resolved runtime: every command it runs is bounded by a timeout. */
export interface ResolvedBackupRuntime {
  commandExists: (command: string) => boolean;
  execFileSync: (command: string, args: string[], options?: Record<string, unknown>) => unknown;
  sleep: (ms: number) => void;
  now: () => Date;
  randomId: () => string;
  commandTimeoutMs: number;
}

export interface BackupPlan {
  keep: BackupEntry[];
  remove: BackupEntry[];
  policy: RetentionPolicy;
}

export interface BackupJobResult {
  created: BackupEntry;
  /** Present when `remote` was configured and not skipped. */
  uploaded?: BackupUploadResult | null;
  /** Remote objects pruned after a verified upload. */
  removedRemote?: string[];
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

/** Default process timeout applied to every external command (10 minutes). */
export const DEFAULT_COMMAND_TIMEOUT_MS: number;

/** gpg `--cipher-algo` default: AES256. */
export const DEFAULT_CIPHER_ALGO: string;

/** Encrypt a finished backup in place, returning the `.gpg` entry. Removes the
 * plaintext artifact. Throws rather than leave an unencrypted backup if `gpg` is
 * unavailable. */
export function encryptBackupEntry(
  entry: BackupEntry,
  encryption: BackupEncryption,
  runtime: ResolvedBackupRuntime,
): BackupEntry;

/** Decrypt `sourcePath` to `destPath`. Throws if the backup is encrypted and no
 * passphrase file was supplied. */
export function decryptBackupToPath(
  sourcePath: string,
  destPath: string,
  encryption: BackupEncryption,
  runtime: ResolvedBackupRuntime,
): void;

/** Record a successful backup. Callers should write this only after the whole
 * pipeline succeeded. */
export function writeSuccessStamp(stampFile: string, now?: Date): string;
export function readSuccessStamp(stampFile: string): Date | null;

/** A missing or unparseable stamp is NOT fresh: absence of evidence is not
 * evidence of a backup. */
/** Upload a finished backup off-host and (unless `verify: false`) re-read it to
 * confirm the byte count. Throws rather than report success when `rclone` is
 * unavailable or the remote object cannot be verified. */
export function uploadBackupToRemote(
  entry: BackupEntry,
  remote: BackupRemote,
  runtime: ResolvedBackupRuntime,
): BackupUploadResult;

/** Best-effort remote retention. Never deletes `protectFileName` — the object
 * just uploaded and verified. Returns the names actually deleted. */
export function pruneRemoteBackups(
  remote: BackupRemote,
  protectFileName: string,
  runtime: ResolvedBackupRuntime,
): string[];

export function checkBackupFreshness(options: {
  stampFile: string;
  maxAgeHours?: number;
  now?: Date;
}): BackupFreshness;

/** Build a bounded runtime. Pass `commandTimeoutMs` (or set
 * `DB_BACKUP_COMMAND_TIMEOUT_MS`) to override the default bound. */
export function normalizeRuntime(runtime?: BackupRuntime): ResolvedBackupRuntime;

// ---------------------------------------------------------------------------
// SQLite engine primitives.
//
// The job API (runBackupJob / restoreBackup) owns env resolution, filenames, the
// manifest and retention. A consumer that needs its own naming or manifest, or
// that must not prune as a side effect, uses these directly rather than
// reimplementing `sqlite3 .backup`.
// ---------------------------------------------------------------------------

/** Take a WAL-safe, self-contained snapshot of a SQLite database at `destPath`
 * using SQLite's online backup API. Retries on `database is locked`, escapes the
 * destination path, and integrity-checks the result before keeping it.
 *
 * Throws rather than produce a silently-incomplete backup: if `sqlite3` is
 * unavailable and the database has a `-wal` sidecar, committed transactions
 * would be omitted from a plain copy. Returns `destPath`. */
export function createSqliteSnapshot(options: {
  sourcePath: string;
  destPath: string;
  runtime?: ResolvedBackupRuntime;
  /** Permit a plain byte copy when `sqlite3` is unavailable. A copy of a live
   * database is never guaranteed consistent, so this defaults to `false` and the
   * snapshot throws instead. */
  allowUnsafeCopy?: boolean;
}): string;

/** Run `PRAGMA integrity_check` on a SQLite file and throw if it is not `ok`.
 *
 * **Non-destructive by default.** Pass `deleteOnFailure: true` only when you own
 * the file being checked — `createSqliteSnapshot` does, to discard a snapshot it
 * just wrote. Verifying a file you did not create (an admin route vetting a
 * user-supplied path) must never delete it. */
export function verifySqliteBackupIntegrity(
  backupPath: string,
  runtime?: ResolvedBackupRuntime,
  options?: { deleteOnFailure?: boolean },
): void;

/** Atomically replace the database named by `databaseUrl` with `backupEntry`:
 * decompress/copy to a temp path, verify it there, discard the destination's
 * `-wal`/`-shm`/`-journal` sidecars, then rename into place. A corrupt backup
 * can never destroy a good database. */
export function restoreSqliteBackup(options?: {
  databaseUrl: string;
  backupEntry: Pick<BackupEntry, 'fullPath' | 'compressed'> & { encrypted?: boolean };
  cwd?: string;
  runtime?: ResolvedBackupRuntime;
  /** Required when `backupEntry.encrypted` is true. */
  encryption?: BackupEncryption | null;
}): { target: string };

/** Remove a SQLite database's `-wal`, `-shm` and `-journal` sidecars. They
 * describe the database they were created for, so they must be discarded
 * whenever that file is replaced wholesale. No-op when absent. */
export function removeSqliteSidecars(databasePath: string): void;

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
