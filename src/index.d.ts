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

/** Grandfather-father-son (GFS) retention: `daily` most-recent backups as
 * literal slots (identical mechanics to `AgeTierRetentionPolicy.dailySlots`),
 * then one backup per week/month/year bucket, generated as anchors (see
 * `buildGfsAnchors`) unless `anchors` is supplied directly for full custom
 * control — the same `--retention-policy` JSON-file escape hatch. This is
 * the SAME selection engine as `AgeTierRetentionPolicy` (slots + anchors),
 * not a parallel retention system.
 *
 * Applying `{ mode: 'gfs', ... }` as `BackupOptions.policy` (or via
 * `--retain-daily`/`--retain-weekly`/`--retain-monthly`/`--retain-yearly`/
 * `--retention-policy`) also makes every configured destination (local,
 * rclone, S3 alike) follow this SAME plan — see `resolveDestinationPolicy`. */
export interface GfsRetentionPolicy {
  mode: 'gfs';
  /** Keep the N most-recent backups as literal slots. */
  daily?: number;
  /** Keep one backup per week, for N weeks (generated anchor buckets). */
  weekly?: number;
  /** Keep one backup per month, for N months (generated anchor buckets). */
  monthly?: number;
  /** Keep one backup per year, for N years (generated anchor buckets). */
  yearly?: number;
  /** Full custom control: supplied anchors REPLACE the generated
   * weekly/monthly/yearly buckets entirely. `daily` still applies. */
  anchors?: RetentionAnchor[];
}

export type RetentionPolicy =
  | AgeTierRetentionPolicy
  | KeepLastRetentionPolicy
  | KeepDaysRetentionPolicy
  | GfsRetentionPolicy;

/** WHERE a backup is written/replicated to — orthogonal to `RetentionPolicy`
 * (HOW MANY/WHICH survive). A `local` destination is not privileged: a
 * caller may configure `destinations: [{ type: 's3', ... }]` alone for an
 * S3-only backup. See `resolveDestinations` / `BackupOptions.destinations`. */
export interface LocalDestination {
  type: 'local';
  path: string;
}

export interface RcloneDestination {
  type: 'rclone';
  /** rclone destination directory, e.g. `offsite:backups/app`. */
  target: string;
  /** Re-read the uploaded object and compare sizes. Default true. */
  verify?: boolean;
  /** Legacy per-destination flat count, used ONLY when no unified (GFS)
   * policy is configured. Default 30, never fewer than 1. */
  keep?: number;
  /** RCLONE_CONFIG for the upload. */
  configFile?: string;
  /** Set false to never attempt remote retention pruning for this destination
   *  (e.g. an append-only / immutable bucket where DELETE is denied). Default: pruning runs. */
  prune?: boolean;
}

export interface S3Destination {
  type: 's3';
  bucket: string;
  prefix?: string;
  endpoint?: string;
  region?: string;
  /** Legacy per-destination flat count, used ONLY when no unified (GFS)
   * policy is configured. Default 30, never fewer than 1. */
  keep?: number;
  /** Set false to never attempt remote retention pruning for this destination
   *  (e.g. an append-only / immutable bucket where DELETE is denied). Default: pruning runs. */
  prune?: boolean;
}

export type BackupDestination = LocalDestination | RcloneDestination | S3Destination;

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

/** Native S3-compatible off-host remote (AWS S3 or Cloudflare R2 — R2 speaks
 * the S3 API). AWS Signature V4, signed with node:crypto, sent over `fetch` —
 * no rclone binary required. Mutually exclusive with `remote` (rclone). */
export interface BackupS3Remote {
  bucket: string;
  /** Key prefix under the bucket. Default: none (objects at the bucket root). */
  prefix?: string;
  /** S3-compatible endpoint override, e.g. Cloudflare R2:
   * `https://<account>.r2.cloudflarestorage.com`. Omit for AWS S3. */
  endpoint?: string;
  /** SigV4 signing region. Default: `auto` when `endpoint` is set (R2's own
   * convention), otherwise `us-east-1`. */
  region?: string;
  /** Remote objects to retain. Default 30, never fewer than 1. */
  keep?: number;
}

export interface BackupUploadResult {
  target: string;
  /** Verified byte count; null when `verify: false` (rclone remote only —
   * the S3 remote always verifies). */
  sizeBytes: number | null;
  /** S3 remote only: the verified object's ETag (unquoted). */
  etag?: string | null;
}

export interface BackupFreshness {
  fresh: boolean;
  /** The stamp is dated in the future — a clock problem, not a stale backup.
   * `fresh` is false. Reported separately so an operator can tell them apart. */
  clockSkew: boolean;
  /** null when no successful backup has ever been recorded. */
  stampedAt: Date | null;
  ageHours: number | null;
  maxAgeHours: number;
}

/** Lifecycle state of a `BackupEntry`. `'completed'` is any entry backed by a
 * real on-disk artifact (the only state that existed before this field was
 * added). `'running'`/`'failed'` back a job's lifecycle marker instead —
 * `<prefix>-<startedAt>-<jobId>.inprogress` / `.failed`, named by JOB
 * IDENTITY, never by the artifact the job might have produced (see
 * {@link listBackupMarkers}). `'running'` means a job started and is not
 * known to have finished — in flight, or the process died without reaching
 * its failure handler. Markers carry no size requirement and are always
 * excluded from retention SELECTION (planRetention never sees them); a stale
 * `'failed'` marker can still appear in a `BackupPlan.remove` for cleanup —
 * see `listBackupsWithPlan`. */
export type BackupEntryState = 'completed' | 'running' | 'failed';

export interface BackupEntry {
  fileName: string;
  /** The filename prefix this backup was written under. */
  prefix?: string;
  fullPath: string;
  engine: 'sqlite' | 'postgres' | 'unknown';
  compressed: boolean;
  /** True when the artifact is gpg-encrypted (`.gpg` suffix). */
  encrypted?: boolean;
  /** Defaults to `'completed'` for every entry backed by a real artifact.
   * `'running'`/`'failed'` only appear on marker-derived rows (see
   * {@link listBackupMarkers}), which is only ever true for the newest
   * entries surfaced by `listBackupsWithPlan`/`getOperationalStatus`. */
  state?: BackupEntryState;
  /** `'failed'` marker rows only: the truncated error message from the run
   * that failed (see `MARKER_ERROR_TRUNCATE_LENGTH` in the implementation). */
  error?: string;
  /** Marker rows only: ISO time the job started. */
  startedAt?: string;
  /** `'failed'` marker rows only: ISO time the job failed — a job can fail
   * long after it started, and the failure's recency (not the start's) is
   * what freshness/eviction logic compares against. Doubles as the row's
   * `createdAt`. */
  failedAt?: string;
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
   * pruned and no success is stamped until verification passes. Mutually
   * exclusive with `s3`. */
  remote?: BackupRemote | null;
  /** Replicate off-host to S3 (AWS or R2, native SigV4 — no rclone) and
   * verify the uploaded object the same way `remote` does. Mutually
   * exclusive with `remote`. Credentials come from the environment only
   * (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, or the `S3_*` aliases) —
   * there is no credential field here on purpose. */
  s3?: BackupS3Remote | null;
  /** Local-only run: skip the upload and the remote prune. */
  skipRemote?: boolean;
  /** NEW location model: an explicit, non-empty list of where backups go.
   * Local is not a privileged default here. Mutually exclusive with the
   * legacy `remote`/`s3`/`skipRemote` fields — mixing them throws. An empty
   * array throws ("you must choose where backups go"). */
  destinations?: BackupDestination[];
  /** Filename prefix. Defaults to `sqlite-backup` / `postgres-backup`. Set this
   * to adopt an existing backup history written under another name. The engine is
   * read from the extension (`.db` / `.dump`), not the prefix.
   *
   * list/prune/restore are SCOPED to this prefix, so one app's job can never see
   * or prune another app's backups in a shared directory or remote bucket. */
  namePrefix?: string | null;
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

/** The response shape `fetchImpl` must (eventually) produce. The S3 remote's
 * whole call chain is async (see s3-remote.js) and always `await`s this, so a
 * `fetchImpl` may return either the value directly or a `Promise` of it —
 * production's default is the real, async `fetch`; tests may inject either a
 * synchronous mock or an async one. */
export interface S3FetchResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export type S3FetchImpl = (
  url: string,
  options: { method: string; headers: Record<string, string>; body?: Buffer },
  timeoutMs: number,
) => S3FetchResponse | Promise<S3FetchResponse>;

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
  /** Where S3 credentials and `DB_BACKUP_S3_TIMEOUT_MS` are read from. Default
   * `process.env`; override to test credential resolution without mutating
   * the real environment. */
  env?: NodeJS.ProcessEnv;
  /** The S3 remote's injectable HTTP layer. Default: the real, async global
   * `fetch`. Tests inject a mock here so no test ever touches the network. */
  fetchImpl?: S3FetchImpl | null;
  /** Bound every S3 HTTP request (PUT/HEAD/GET/DELETE). Overrides
   * `DB_BACKUP_S3_TIMEOUT_MS`; defaults to `DEFAULT_S3_TIMEOUT_MS`. */
  s3TimeoutMs?: number | string | null;
}

/** A fully-resolved runtime: every command it runs is bounded by a timeout. */
export interface ResolvedBackupRuntime {
  commandExists: (command: string) => boolean;
  execFileSync: (command: string, args: string[], options?: Record<string, unknown>) => unknown;
  sleep: (ms: number) => void;
  now: () => Date;
  randomId: () => string;
  commandTimeoutMs: number;
  env: NodeJS.ProcessEnv;
  fetchImpl: S3FetchImpl | null;
  s3TimeoutMs: number | string | null;
}

export interface BackupPlan {
  keep: BackupEntry[];
  remove: BackupEntry[];
  policy: RetentionPolicy;
}

/** Per-destination upload/prune result — one entry per non-local destination
 * in `BackupOptions.destinations` (or the legacy `remote`/`s3` mapped onto
 * it). `uploaded`/`removedRemote` on `BackupJobResult` mirror the FIRST
 * entry here, for back-compat with the single-remote era. */
export interface BackupDestinationResult {
  destination: BackupDestination;
  uploaded: BackupUploadResult;
  /** Filenames pruned at this destination after its verified upload. */
  removed: string[];
}

export interface BackupJobResult {
  created: BackupEntry;
  /** Stable machine-readable identifier for this run's backup — equal to
   * `created.fileName`. Always present at the top level (both in the
   * programmatic result and the CLI's `--json` output) since a backup is
   * always created by the time this result exists; downstream tooling (e.g.
   * deploy-kit's hook-output correlation) should key off this field rather
   * than reaching into `created.fileName` or `created.fullPath`. Not present
   * on the CLI's `--allow-missing` skipped-run JSON shape (`{ skipped: true,
   * reason, mode }`), which is a distinct, backup-less result. */
  backupId: string;
  /** Back-compat: the first non-local destination's upload result (present
   * when at least one remote/S3 destination was configured and uploaded to). */
  uploaded?: BackupUploadResult | null;
  /** Back-compat: the first non-local destination's pruned filenames. */
  removedRemote?: string[];
  /** Full per-destination detail, for callers using more than one remote
   * destination. */
  destinationResults?: BackupDestinationResult[];
  removed: BackupEntry[];
  kept: BackupEntry[];
  mode: string;
  outputDir: string;
  policy: RetentionPolicy;
  /** True when this run deliberately skipped offsite replication (`skipRemote`, no `remote` configured, or a single `local` destination). */
  localOnly: boolean;
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

/** A hook run around a live SQLite restore: either a synchronous function
 * (called directly) or a shell command string (run via `sh -lc`, bounded by
 * the same command timeout as every other external command this package
 * runs). Deliberately synchronous-only — `restoreBackup` itself is
 * synchronous (it never touches S3; only a backup job's upload step can). */
export type WriterHook = (() => void) | string;

export interface RestoreOptions extends BackupOptions {
  backupFile?: string;
  useLatest?: boolean;
  createPreRestoreBackup?: boolean;
  /** Run before a SQLite restore unlinks the live database, to quiesce
   * writers (e.g. stop the app). Quiescence is then PROVEN (an exclusive
   * lock is attempted) regardless of whether this is provided. */
  stopWriters?: WriterHook | null;
  /** Run after a SQLite restore installs the new database (in a `finally`,
   * so it also runs on the failure path) to bring writers back up. Only
   * invoked if `stopWriters` actually ran. */
  startWriters?: WriterHook | null;
  /** UNSAFE. Restore even when writer quiescence cannot be proven (no
   * `stopWriters`, or `stopWriters` ran but an exclusive lock still can't be
   * acquired). Restoring over a database with an active writer can silently
   * lose every write made after the restore. Default: false (refuse). */
  allowOnlineRestore?: boolean;
  /** UNSAFE. Restore a SQLite backup without integrity verification when the
   * `sqlite3` binary is unavailable, instead of aborting. Default: false
   * (abort). Does not affect `backup`, which already tolerates a missing
   * `sqlite3` for `pg_restore`-style verification. */
  skipVerify?: boolean;
}

export interface RestoreResult {
  restored: BackupEntry;
  preRestoreBackup: BackupEntry | null;
  mode: string;
  outputDir: string;
  engine: 'sqlite' | 'postgres' | 'unknown';
  restoredAt: string;
  target: string;
  /** Path to the always-taken rescue copy of the pre-restore live SQLite
   * database (under `<outputDir>/.rescue/`), or null for a Postgres restore
   * or a SQLite restore where no live database existed yet. If restore fails
   * after this point, the live database is automatically restored from here. */
  rescuePath: string | null;
}

export const DEFAULT_RETENTION_POLICY: AgeTierRetentionPolicy;

/** Generate the weekly/monthly/yearly anchor buckets a GFS policy implies —
 * see `GfsRetentionPolicy`. Exported so a consumer can inspect/compose the
 * generated anchors (e.g. to build a custom `anchors` list that extends them). */
export function buildGfsAnchors(policy: {
  weekly?: number;
  monthly?: number;
  yearly?: number;
}): RetentionAnchor[];

/** Resolve the WHERE list — see `BackupDestination`. Pure; throws on an
 * empty/invalid `destinations` array, on mixing `destinations` with the
 * legacy `remote`/`s3`/`skipRemote` fields, and (only when `requireOffsite`
 * is true — set by `runBackupJob`/`runBackupJobAsync`, never by
 * restore/list/prune) on a legacy call with no remote/s3/skipRemote configured. */
export function resolveDestinations(options: {
  cwd: string;
  outputDir?: string | null;
  destinations?: BackupDestination[] | null;
  remote?: BackupRemote | null;
  s3?: BackupS3Remote | null;
  skipRemote?: boolean;
  requireOffsite?: boolean;
}): { destinations: BackupDestination[]; localOnly: boolean };

/** Validate and canonicalize one destination (resolving a `local` path
 * against `cwd`). Throws on an invalid shape. */
export function normalizeDestination(destination: unknown, cwd: string): BackupDestination;

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
export function resolveRetentionPolicy(options: {
  retainDaily?: number | string | null;
  retainWeekly?: number | string | null;
  retainMonthly?: number | string | null;
  retainYearly?: number | string | null;
  env?: NodeJS.ProcessEnv;
}): GfsRetentionPolicy;
/** A full custom policy file (`--retention-policy`), passed through as-is.
 * Cannot be combined with any other retention option — mixing throws. */
export function resolveRetentionPolicy(options: {
  retentionPolicyFile: RetentionPolicy;
}): RetentionPolicy;
/** Fallback: no retention option, or one whose presence can't be known
 * statically (a string may be empty, which means "absent"). The env may then
 * select any mode, so the caller gets the union and must narrow on `mode`.
 * Conflicting combinations type-check here but throw at runtime. */
export function resolveRetentionPolicy(options?: {
  maxBackups?: number | string | null;
  dailySlots?: number | string | null;
  keepLast?: number | string | null;
  keepDays?: number | string | null;
  retainDaily?: number | string | null;
  retainWeekly?: number | string | null;
  retainMonthly?: number | string | null;
  retainYearly?: number | string | null;
  retentionPolicyFile?: RetentionPolicy | null;
  env?: NodeJS.ProcessEnv;
}): RetentionPolicy;
/** Parse a backup filename. Without `namePrefix`, only the canonical
 * `sqlite-backup` / `postgres-backup` prefixes are accepted — the default is
 * deliberately not widened. Returns null for anything else. */
export function parseBackupFileName(
  fileName: string,
  namePrefix?: string | null,
): { prefix: string; engine: 'sqlite' | 'postgres'; timestampKey: string; sequence: number; compressed: boolean; encrypted: boolean } | null;

export function planRetention(backups: BackupEntry[], policy?: RetentionPolicy, now?: Date): BackupPlan;
export function restoreBackup(options?: RestoreOptions): RestoreResult;
/** Synchronous backup job. Supports `remote` (rclone) and local-only
 * (`skipRemote`) backups. THROWS if `s3` is configured — uploading it would
 * block the event loop for the whole upload. Use `runBackupJobAsync` (or the
 * CLI) for an S3/R2 remote. */
export function runBackupJob(options?: BackupOptions): BackupJobResult;
/** Async backup job. Supports everything `runBackupJob` supports plus a
 * native S3/R2 remote (`s3`), uploaded over the real async `fetch` — no
 * worker thread, no event-loop block. This is the correct entry point for
 * any in-process/library caller (e.g. a Next.js API route) that may have an
 * S3 remote configured; the CLI awaits this for every `backup` run. */
export function runBackupJobAsync(options?: BackupOptions): Promise<BackupJobResult>;
export function runCli(argv?: string[]): Promise<void>;

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

// ---------------------------------------------------------------------------
// Native S3-compatible remote (AWS S3 + Cloudflare R2). See BackupS3Remote.
// ---------------------------------------------------------------------------

/** Default remote objects retained under an S3 remote (30, mirrors
 * `DEFAULT_REMOTE_KEEP` for rclone). */
export const DEFAULT_S3_KEEP: number;

/** Default bound on every S3 HTTP request: 5 minutes. */
export const DEFAULT_S3_TIMEOUT_MS: number;

/** S3's own single-part PUT ceiling (5 GiB). `uploadBackupToS3` throws before
 * reading the file if it exceeds this — this package does not implement
 * multipart upload. */
export const S3_SINGLE_PART_LIMIT_BYTES: number;

/** Resolve S3 credentials from the environment: `AWS_ACCESS_KEY_ID` /
 * `AWS_SECRET_ACCESS_KEY`, or the `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`
 * aliases. Never accepts a CLI flag. Throws a message naming the env vars
 * when absent. */
export function resolveS3Credentials(
  env?: NodeJS.ProcessEnv,
): { accessKeyId: string; secretAccessKey: string };

/** The AWS Signature Version 4 primitive. `service` defaults to `s3` — every
 * production caller in this package uses that default; it is only a
 * parameter so the algorithm can be exercised against AWS's published
 * "get-vanilla" (service: "service") test vector. */
export function signS3Request(options: {
  method: string;
  host: string;
  canonicalPath: string;
  query?: Record<string, string>;
  payloadHash: string;
  region: string;
  service?: string;
  accessKeyId: string;
  secretAccessKey: string;
  date?: Date;
}): { amzDate: string; authorization: string; signedHeaders: string; canonicalRequest: string; stringToSign: string };

/** Buffered PUT of `entry.fullPath` to the S3 remote, then HEAD-verify it
 * (size, and ETag for a single-part upload) before resolving. Async — no
 * worker thread, no event-loop block; uses the real `fetch`. Rejects — never
 * resolves as success — if credentials are absent, the file exceeds
 * `S3_SINGLE_PART_LIMIT_BYTES`, the PUT is not 2xx, or verification fails. */
export function uploadBackupToS3(
  entry: BackupEntry,
  s3: BackupS3Remote,
  runtime: ResolvedBackupRuntime,
): Promise<BackupUploadResult>;

/** Re-read an already-uploaded object and compare it to `entry`. Async.
 * Exposed for direct use (e.g. verifying a backup uploaded out of band);
 * `uploadBackupToS3` calls this itself after every PUT. */
export function verifyS3Object(
  entry: BackupEntry,
  s3: BackupS3Remote,
  runtime: ResolvedBackupRuntime,
  expectedMd5Hex?: string,
): Promise<BackupUploadResult>;

/** Best-effort S3 retention: keep the newest `s3.keep` objects under the
 * bucket/prefix, protecting `protectFileName` (the object just uploaded and
 * verified). Async. A listing or delete failure is a cleanup miss (warns),
 * never a data-safety issue — mirrors `pruneRemoteBackups`. */
export function pruneS3Backups(
  s3: BackupS3Remote,
  protectFileName: string,
  runtime: ResolvedBackupRuntime,
  namePrefix?: string | null,
  parseBackupFileNameFn?: typeof parseBackupFileName,
): Promise<string[]>;

export function checkBackupFreshness(options: {
  stampFile: string;
  maxAgeHours?: number;
  now?: Date;
}): BackupFreshness;

/** Remote sibling of {@link checkBackupFreshness}: the newest object under the
 * rclone remote stands in for the stamp, so a host that is NOT the backup host
 * can verify the off-site copy (the dead-man's switch a local stamp can't be).
 * Returns the same shape; throws when `rclone` is unavailable or its listing is
 * unparseable — "couldn't tell" is never "fresh". */
export function checkRemoteFreshness(options: {
  remote: BackupRemote;
  maxAgeHours?: number;
  now?: Date;
  runtime?: BackupRuntime;
  /** Restrict to backups written under this filename prefix (matches the
   * backup job's `--name-prefix`). Default: the canonical sqlite/postgres names. */
  namePrefix?: string | null;
}): BackupFreshness;

/** Surfaces every `<prefix>-<startedAt>-<jobId>.inprogress` / `.failed`
 * lifecycle marker in `outputDir` as a `BackupEntry`-shaped row
 * (`state: 'running' | 'failed'`), newest first — a `'failed'` row is ranked
 * by its `failedAt`, a `'running'` row by its `startedAt`. `sizeBytes` is
 * always 0 — markers are not backups and carry no size requirement.
 * `'failed'` rows carry the truncated `error` message and `failedAt`.
 * See the implementation's lifecycle-marker doc comment for the on-disk
 * marker format and the stale-marker cleanup rules (including the two
 * evidence-preservation exemptions). */
export function listBackupMarkers(
  outputDir: string,
  now?: Date,
  namePrefix?: string | null,
): BackupEntry[];

export interface OperationalStatus {
  tone: 'healthy' | 'warning' | 'critical';
  detail: string;
  /** ISO timestamp of the last successful backup, when known. */
  stampedAt?: string;
}

/** Admin-surface feed: combines {@link checkBackupFreshness} with the
 * lifecycle markers in `outputDir` (see {@link listBackupMarkers}) into one
 * `OperationalStatus`, the natural input for admin-kit's
 * `AdminOperationalStatus`.
 *
 * Precedence, most to least urgent:
 *   1. Any `'failed'` marker whose `failedAt` is newer than the newest
 *      COMPLETED backup's `createdAt` (or any failed marker at all when no
 *      completed backup exists) -> `'critical'`. A failed run beats a fresh
 *      stamp — the stamp only proves a PAST success. The comparison is
 *      failedAt-vs-artifact, not "is the newest row a failure": a run that
 *      fails AFTER creating its artifact (replication/finalize) must not be
 *      masked by that artifact's newer-looking createdAt.
 *   2. The stamp is dated in the future (clock skew) -> `'warning'`.
 *   3. The stamp is stale (not fresh, no clock skew) -> `'critical'`.
 *   4. Otherwise -> `'healthy'`.
 */
export function getOperationalStatus(options: {
  stampFile: string;
  /** When provided, failed markers in this directory are compared against
   * the newest completed backup for the precedence rule above. */
  outputDir?: string;
  maxAgeHours?: number;
  now?: Date;
  namePrefix?: string | null;
}): OperationalStatus;

/** Best-effort alert delivery for the `freshness` command. NEVER throws and
 * NEVER changes the exit code. Synchronous (POSTs via curl / runs a command),
 * so it adds no dependency and does not make callers async. `notifyCommand`
 * receives the message in `$DB_BACKUP_ALERT`. */
export function notifyAlert(
  message: string,
  options?: {
    notifyDiscord?: string | null;
    notifyWebhook?: string | null;
    notifyCommand?: string | null;
    runtime?: BackupRuntime;
  },
): void;

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
 * can never destroy a good database.
 *
 * Safety, in order, when a live database exists at the destination:
 *   1. `sqlite3` missing -> ABORTS unless `skipVerify` (backup unverified).
 *   2. `stopWriters` (if given) runs, then quiescence is PROVEN via an
 *      exclusive-lock attempt -> ABORTS unless proven (or `allowOnlineRestore`).
 *   3. A rescue copy of the live database (+ sidecars) is ALWAYS taken under
 *      `<outputDir>/.rescue/` before the live file is touched. Any failure
 *      from that point on restores it automatically.
 *   4. `startWriters` (if `stopWriters` ran) runs in a `finally`, including
 *      on the failure path. */
export function restoreSqliteBackup(options?: {
  databaseUrl: string;
  backupEntry: Pick<BackupEntry, 'fullPath' | 'compressed'> & { encrypted?: boolean };
  cwd?: string;
  runtime?: ResolvedBackupRuntime;
  /** Required when `backupEntry.encrypted` is true. */
  encryption?: BackupEncryption | null;
  /** Directory under which `.rescue/` is created. Defaults to the live
   * database's own directory. */
  outputDir?: string | null;
  stopWriters?: WriterHook | null;
  startWriters?: WriterHook | null;
  allowOnlineRestore?: boolean;
  skipVerify?: boolean;
}): { target: string; rescuePath: string | null };

/** Remove a SQLite database's `-wal`, `-shm` and `-journal` sidecars. They
 * describe the database they were created for, so they must be discarded
 * whenever that file is replaced wholesale. No-op when absent. */
export function removeSqliteSidecars(databasePath: string): void;

/** Attempts to prove no writer (or blocking reader) currently holds a lock on
 * `destinationPath`, via a bounded `BEGIN EXCLUSIVE; COMMIT;`. Fails CLOSED:
 * a missing database is trivially quiescent, but a missing `sqlite3` binary
 * or a held lock both report `quiescent: false`. Used by `restoreSqliteBackup`
 * to decide whether a restore may proceed. */
export function detectSqliteQuiescence(
  destinationPath: string,
  runtime?: ResolvedBackupRuntime,
): { quiescent: boolean; reason: string };

// --- Backup-storage helpers ---

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
