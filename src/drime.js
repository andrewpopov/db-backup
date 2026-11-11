'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_DRIME_ENV_FILE = '/etc/db-backup/drime.env';
const DEFAULT_DRIME_BASE_REMOTE = 'drime';
const DEFAULT_DRIME_CRYPT_REMOTE = 'drimecrypt';
const DEFAULT_DRIME_KEEP = 10;
const DEFAULT_DRIME_MAX_BYTES = 5_000_000_000;

const PRIVATE_BASE = 'dbbdrimebase';
const PRIVATE_CRYPT = 'dbbdrimecrypt';

// rclone crypt file header: "RCLONE" + 0x00 0x00, then a 24-byte nonce.
const CRYPT_MAGIC = Buffer.from('RCLONE\0\0', 'latin1');
const CRYPT_MIN_FILE_BYTES = 32;

const BASE_ALLOWED_KEYS = ['TYPE', 'ACCESS_TOKEN'];
const CRYPT_ALLOWED_KEYS = [
  'TYPE',
  'REMOTE',
  'FILENAME_ENCRYPTION',
  'DIRECTORY_NAME_ENCRYPTION',
  'NO_DATA_ENCRYPTION',
  'PASSWORD',
  'PASSWORD2',
];

const CHILD_ENV_ALLOWLIST = ['PATH', 'HOME', 'TMPDIR', 'LANG'];

const WRAPPER_REMOTE_TYPES = ['alias', 'union', 'combine', 'chunker', 'hasher', 'compress', 'crypt', 'cache'];

const REMOTE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;
const ROOT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Secrets live here, never on a destination object: a destination is spread
// into results, markers and --json output.
const contexts = new WeakMap();

function parseEnvFile(text) {
  const values = new Map();
  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    const match = line.replace(/^export\s+/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
    if (!match) {
      throw new Error(`Drime env file line ${index + 1} is not KEY=VALUE`);
    }
    const [, key, rawValue] = match;
    const quoted = rawValue.length >= 2 && /^(['"]).*\1$/s.test(rawValue);
    if (values.has(key)) {
      throw new Error(`Drime env file sets ${key} more than once`);
    }
    values.set(key, quoted ? rawValue.slice(1, -1) : rawValue);
  });
  return values;
}

function sectionOf(values, remoteName) {
  const prefix = `RCLONE_CONFIG_${remoteName.toUpperCase()}_`;
  const section = new Map();
  for (const [key, value] of values) {
    if (key.startsWith(prefix)) section.set(key.slice(prefix.length), value);
  }
  return section;
}

function refuseUnknownKeys(section, allowed, label) {
  for (const key of section.keys()) {
    if (!allowed.includes(key)) {
      throw new Error(`Drime env file ${label} remote sets unsupported option ${key}; only ${allowed.join(', ')} are allowed`);
    }
  }
}

function isTruthyFlag(value) {
  return /^(1|t|true|y|yes|on)$/i.test(value);
}

function isFalsyFlag(value) {
  return /^(0|f|false|n|no|off)$/i.test(value);
}

function requireNonEmpty(section, key, label) {
  const value = section.get(key);
  if (!value) {
    throw new Error(`Drime env file ${label} remote must set a non-empty ${key}`);
  }
  return value;
}

function readDrimeCredentials({ envFile, baseRemote, cryptRemote }) {
  let text;
  try {
    text = fs.readFileSync(envFile, 'utf8');
  } catch (error) {
    throw new Error(`Drime env file ${envFile} is not readable (${error && error.code ? error.code : 'error'})`);
  }
  const values = parseEnvFile(text);

  const base = sectionOf(values, baseRemote);
  refuseUnknownKeys(base, BASE_ALLOWED_KEYS, `base "${baseRemote}"`);
  if (base.get('TYPE') !== 'drime') {
    throw new Error(`Drime env file base remote "${baseRemote}" must have TYPE=drime`);
  }
  const accessToken = requireNonEmpty(base, 'ACCESS_TOKEN', `base "${baseRemote}"`);

  const crypt = sectionOf(values, cryptRemote);
  refuseUnknownKeys(crypt, CRYPT_ALLOWED_KEYS, `crypt "${cryptRemote}"`);
  const label = `crypt "${cryptRemote}"`;
  if (crypt.has('TYPE') && crypt.get('TYPE') !== 'crypt') {
    throw new Error(`Drime env file ${label} remote must have TYPE=crypt`);
  }
  if (crypt.has('FILENAME_ENCRYPTION') && crypt.get('FILENAME_ENCRYPTION') !== 'standard') {
    throw new Error(`Drime env file ${label} remote must use FILENAME_ENCRYPTION=standard`);
  }
  if (crypt.has('DIRECTORY_NAME_ENCRYPTION') && !isTruthyFlag(crypt.get('DIRECTORY_NAME_ENCRYPTION'))) {
    throw new Error(`Drime env file ${label} remote must use DIRECTORY_NAME_ENCRYPTION=true`);
  }
  if (crypt.has('NO_DATA_ENCRYPTION') && !isFalsyFlag(crypt.get('NO_DATA_ENCRYPTION'))) {
    throw new Error(`Drime env file ${label} remote must not set NO_DATA_ENCRYPTION`);
  }
  const password = requireNonEmpty(crypt, 'PASSWORD', label);
  const password2 = requireNonEmpty(crypt, 'PASSWORD2', label);

  const remote = requireNonEmpty(crypt, 'REMOTE', label);
  const rootPrefix = `${baseRemote}:`;
  const root = remote.startsWith(rootPrefix) ? remote.slice(rootPrefix.length) : null;
  if (root === null || !ROOT_PATTERN.test(root) || root.endsWith('.')) {
    throw new Error(
      `Drime env file ${label} remote REMOTE must be "${baseRemote}:<root>" with one safe, non-empty path component`,
    );
  }

  return { accessToken, password, password2, root };
}

function buildRemoteVars(credentials) {
  const base = `RCLONE_CONFIG_${PRIVATE_BASE.toUpperCase()}_`;
  const crypt = `RCLONE_CONFIG_${PRIVATE_CRYPT.toUpperCase()}_`;
  return {
    [`${base}TYPE`]: 'drime',
    [`${base}ACCESS_TOKEN`]: credentials.accessToken,
    [`${crypt}TYPE`]: 'crypt',
    [`${crypt}REMOTE`]: `${PRIVATE_BASE}:${credentials.root}`,
    [`${crypt}FILENAME_ENCRYPTION`]: 'standard',
    [`${crypt}DIRECTORY_NAME_ENCRYPTION`]: 'true',
    [`${crypt}NO_DATA_ENCRYPTION`]: 'false',
    [`${crypt}PASSWORD`]: credentials.password,
    [`${crypt}PASSWORD2`]: credentials.password2,
  };
}

function buildChildEnv(sourceEnv, configPath, remoteVars) {
  const env = {};
  for (const [key, value] of Object.entries(sourceEnv || {})) {
    if (value === undefined) continue;
    if (CHILD_ENV_ALLOWLIST.includes(key) || key.startsWith('LC_')) env[key] = value;
  }
  return { ...env, ...remoteVars, RCLONE_CONFIG: configPath };
}

function loadContext({ envFile, baseRemote, cryptRemote }) {
  assertSafeRemoteName(baseRemote, 'baseRemote');
  assertSafeRemoteName(cryptRemote, 'cryptRemote');
  const credentials = readDrimeCredentials({ envFile, baseRemote, cryptRemote });
  return { root: credentials.root, remoteVars: buildRemoteVars(credentials), baseRemote, cryptRemote };
}

// Refuses (throws) when the env file is unreadable or violates the contract.
function loadDrimeContext(destination) {
  let ctx = contexts.get(destination);
  if (!ctx) {
    ctx = loadContext(destination);
    contexts.set(destination, ctx);
  }
  return ctx;
}

const DESTINATION_OPERATION_KEYS = {
  copyto: ['op', 'localPath', 'remoteRel'],
  stat: ['op', 'remoteRel'],
  list: ['op'],
  deletefile: ['op', 'remoteRel'],
};

function assertSafeRemoteRel(value) {
  const bad =
    typeof value !== 'string' ||
    value.startsWith('/') ||
    value.includes('\\') ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f]/.test(value) ||
    value.split('/').some((segment) => !segment || segment === '.' || segment === '..');
  if (bad) throw new Error('A drime destination operation needs a plain relative remoteRel');
  return value;
}

// The one place rclone arguments for a destination are built: callers pass a
// structured operation, never argv, so no flag (an rclone flag beats the
// remote's encryption settings) can be added. `target` is `<remote>:<path>`.
function buildRcloneArgs(operation, target) {
  const allowedKeys = operation && DESTINATION_OPERATION_KEYS[operation.op];
  if (!allowedKeys || Object.keys(operation).some((key) => !allowedKeys.includes(key))) {
    throw new Error('A drime destination operation must be one of copyto, stat, list, deletefile, with no extra fields');
  }
  const objectTarget = () => `${target.replace(/\/+$/, '')}/${assertSafeRemoteRel(operation.remoteRel)}`;
  switch (operation.op) {
    case 'copyto':
      if (typeof operation.localPath !== 'string' || !path.isAbsolute(operation.localPath)) {
        throw new Error('A drime copyto needs an absolute localPath');
      }
      return ['copyto', operation.localPath, objectTarget()];
    case 'stat':
      return ['lsjson', '--stat', objectTarget()];
    case 'list':
      return ['lsjson', target];
    default:
      return ['deletefile', objectTarget()];
  }
}

// The ONLY place an rclone child for Drime is spawned. Returns the raw output,
// or a failure that keeps the child's stderr internal (for classification by
// the audit only); it is never put on an error or printed.
function execContext(ctx, runtime, args, maxBuffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-backup-rclone-'));
  try {
    const configPath = path.join(dir, 'rclone.conf');
    fs.writeFileSync(configPath, '', { mode: 0o600 });
    try {
      const output = runtime.execFileSync('rclone', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildChildEnv(runtime.env, configPath, ctx.remoteVars),
        ...(maxBuffer ? { maxBuffer } : {}),
      });
      return { ok: true, output: output == null ? Buffer.alloc(0) : output };
    } catch (error) {
      return {
        ok: false,
        status: error && error.status != null ? error.status : null,
        code: error && error.code ? error.code : null,
        stderr: String(error && error.stderr ? error.stderr : ''),
      };
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A failure is a fixed string: child stderr can echo credentials, and nothing
// from the child error (stderr, stdout, cause) is carried on the thrown error.
function runWithContext(ctx, runtime, args, maxBuffer) {
  const result = execContext(ctx, runtime, args, maxBuffer);
  if (!result.ok) {
    throw new Error(`rclone ${args[0]} failed (exit ${result.status === null ? 'unknown' : result.status})`);
  }
  return result.output;
}

function privateCryptTarget(destination) {
  return `${PRIVATE_CRYPT}:${assertSafeDrimePath(destination.path)}`;
}

function runDrimeOperation(destination, runtime, operation) {
  const ctx = loadDrimeContext(destination);
  const maxBuffer = operation.op === 'list' ? LISTING_MAX_BYTES : undefined;
  return runWithContext(ctx, runtime, buildRcloneArgs(operation, privateCryptTarget(destination)), maxBuffer);
}

// Every Drime write target is derived from the validated path, never from a
// caller-supplied target string.
function drimeTargetOf(destination) {
  const ctx = loadDrimeContext(destination);
  return `${ctx.cryptRemote}:${assertSafeDrimePath(destination.path)}`;
}

function assertSafeRemoteName(value, label) {
  if (typeof value !== 'string' || !REMOTE_NAME_PATTERN.test(value)) {
    throw new Error(`Invalid "${label}" for drime destination: must be letters and digits only (got ${JSON.stringify(value)})`);
  }
}

function assertSafeDrimePath(value) {
  const segments = typeof value === 'string' ? value.replace(/\/+$/, '').split('/') : [];
  const bad =
    typeof value !== 'string' ||
    value.startsWith('/') ||
    value.includes(':') ||
    value.includes('\\') ||
    /[\u0000-\u001f]/.test(value) ||
    segments.some((segment) => !segment || segment === '.' || segment === '..');
  if (bad) {
    throw new Error(
      `Invalid "path" for drime destination ${JSON.stringify(value)}: must be a relative path without "..", ":", or empty segments`,
    );
  }
  return segments.join('/');
}

function normalizeDrimeDestination(dest, cwd) {
  const drimePath = assertSafeDrimePath(dest.path);
  const baseRemote = dest.baseRemote === undefined ? DEFAULT_DRIME_BASE_REMOTE : dest.baseRemote;
  const cryptRemote = dest.cryptRemote === undefined ? DEFAULT_DRIME_CRYPT_REMOTE : dest.cryptRemote;
  assertSafeRemoteName(baseRemote, 'baseRemote');
  assertSafeRemoteName(cryptRemote, 'cryptRemote');
  const lowered = [baseRemote, cryptRemote].map((name) => name.toLowerCase());
  if (lowered[0] === lowered[1] || lowered.some((name) => name === PRIVATE_BASE || name === PRIVATE_CRYPT)) {
    throw new Error('Invalid drime destination: baseRemote and cryptRemote must be different, non-reserved names');
  }
  const keep = dest.keep === undefined || dest.keep === null ? DEFAULT_DRIME_KEEP : dest.keep;
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`Invalid "keep" for drime destination "${drimePath}": must be an integer >= 1 (got ${JSON.stringify(dest.keep)})`);
  }
  const maxBytes = dest.maxBytes === undefined || dest.maxBytes === null ? DEFAULT_DRIME_MAX_BYTES : dest.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error(`Invalid "maxBytes" for drime destination "${drimePath}": must be a positive safe integer (got ${JSON.stringify(dest.maxBytes)})`);
  }
  return {
    type: 'drime',
    path: drimePath,
    envFile: path.resolve(cwd, dest.envFile || DEFAULT_DRIME_ENV_FILE),
    baseRemote,
    cryptRemote,
    keep,
    maxBytes,
    target: `${cryptRemote}:${drimePath}`,
  };
}

function overCapOutcome(destination, size) {
  return size > destination.maxBytes ? { status: 'skipped-over-cap', size, maxBytes: destination.maxBytes } : null;
}

// ---------------------------------------------------------------------------
// Generic rclone destinations must never reach Drime unencrypted.
// ---------------------------------------------------------------------------

function remoteNameOfTarget(target) {
  const colon = target.indexOf(':');
  if (colon === -1) return null;
  const name = target.slice(0, colon);
  if (target.startsWith(':') || /[,'"{}]/.test(name)) {
    throw new Error('Refusing rclone target: connection-string targets cannot be checked for Drime; use a named remote');
  }
  if (/[\\/]/.test(name)) return null;
  return name;
}

function parseListRemotes(output) {
  let parsed;
  try {
    parsed = JSON.parse((output || '').toString());
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const remotes = [];
  for (const entry of parsed) {
    if (!entry || typeof entry.name !== 'string' || typeof entry.type !== 'string') return null;
    remotes.push({ name: entry.name, type: entry.type });
  }
  return remotes;
}

// `env` must be exactly the environment the destination's copy/verify uses, so
// the type is resolved from the same config.
function assertGenericRcloneTarget(target, runtime, env) {
  const name = remoteNameOfTarget(target);
  if (name === null) return;

  let output;
  try {
    output = runtime.execFileSync('rclone', ['listremotes', '--long', '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
  } catch {
    throw new Error(`Refusing rclone target "${name}:": could not resolve its type (rclone listremotes failed)`);
  }
  const remotes = parseListRemotes(output);
  if (remotes === null) {
    throw new Error(`Refusing rclone target "${name}:": could not parse rclone listremotes output`);
  }
  const matches = remotes.filter((remote) => remote.name.toLowerCase() === name.toLowerCase());
  if (matches.length === 0) {
    throw new Error(`Refusing rclone target "${name}:": no remote with that name is defined in the rclone config in use`);
  }
  for (const { type } of matches) {
    if (type === 'drime') {
      throw new Error(
        `Refusing rclone target "${name}:": it is a Drime remote, and a generic rclone destination would write unencrypted. Use a "drime" destination.`,
      );
    }
    if (WRAPPER_REMOTE_TYPES.includes(type)) {
      throw new Error(
        `Refusing rclone target "${name}:": type "${type}" is a wrapper that may point at Drime. Use the underlying remote directly.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// db-backup drime-audit
// ---------------------------------------------------------------------------

class DrimeAuditError extends Error {}

// rclone crypt's name-decoding errors (backend/crypt/cipher.go). A credential
// or crypt-initialisation failure ("failed to decrypt password", "illegal
// base64") is deliberately not matched.
const NAME_DECRYPT_FAILURE = new RegExp(
  [
    'undecryptable',
    'illegal base32',
    'bad base32 filename encoding',
    'bad decryption - utf-8 invalid',
    'bad decryption - contains control chars',
    'too short after base32 decode',
    'too long after base32 decode',
    'not a multiple of blocksize',
    'bad PKCS#7 padding',
  ].join('|'),
  'i',
);

// Past this bound a listing is "cannot audit", never a truncated parse.
const LISTING_MAX_BYTES = 256 * 1024 * 1024;
const AUDIT_LISTING_OPS = ['listTop', 'listRaw', 'listCrypt'];

// Read-only audit operations. Raw names are always placed after `--`.
function buildAuditArgs(ctx, operation) {
  const rawBase = `${PRIVATE_BASE}:`;
  const crypt = `${PRIVATE_CRYPT}:`;
  switch (operation.op) {
    case 'probeCrypt':
      return ['backend', 'features', crypt];
    case 'listTop':
      return ['lsjson', rawBase];
    case 'listRaw':
      return ['lsjson', '-R', `${rawBase}${ctx.root}`];
    case 'listCrypt':
      return ['lsjson', '-R', '--encrypted', '--crypt-strict-names', crypt];
    case 'decode':
      return ['backend', 'decode', crypt, '--', operation.rawPath];
    case 'catHead':
      return ['cat', '--count', String(CRYPT_MAGIC.length), `${rawBase}${ctx.root}/${operation.rawPath}`];
    default:
      throw new Error(`Unknown audit operation ${operation.op}`);
  }
}

function parseJsonList(buffer, what) {
  try {
    const parsed = JSON.parse(buffer.toString());
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // fall through
  }
  throw new DrimeAuditError(`could not parse ${what}`);
}

function failureText(args, result) {
  if (result.code === 'ENOBUFS') {
    return `rclone ${args[0]} output exceeded the ${LISTING_MAX_BYTES}-byte listing limit`;
  }
  return `rclone ${args[0]} failed (exit ${result.status === null ? 'unknown' : result.status})`;
}

function auditExec(ctx, runtime, operation) {
  const args = buildAuditArgs(ctx, operation);
  const maxBuffer = AUDIT_LISTING_OPS.includes(operation.op) ? LISTING_MAX_BYTES : undefined;
  return { args, result: execContext(ctx, runtime, args, maxBuffer) };
}

function auditRun(ctx, runtime, operation, what) {
  const { args, result } = auditExec(ctx, runtime, operation);
  if (!result.ok) throw new DrimeAuditError(`${what}: ${failureText(args, result)}`);
  return result.output;
}

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) (seen.has(value) ? repeated : seen).add(value);
  return [...repeated];
}

// Names the raw entries (files and directories) whose names rclone-crypt
// cannot decrypt. Only a per-name decrypt failure is a violation; any other
// failure means the audit could not complete.
function findUndecryptable(ctx, runtime, rawPaths) {
  return rawPaths.filter((rawPath) => {
    const { args, result } = auditExec(ctx, runtime, { op: 'decode', rawPath });
    if (result.ok) return false;
    if (NAME_DECRYPT_FAILURE.test(result.stderr)) return true;
    throw new DrimeAuditError(`decoding names: ${failureText(args, result)}`);
  });
}

function auditReport(objects, findings) {
  const unique = new Map(findings.map((finding) => [`${finding.kind}\0${finding.path}`, finding]));
  return { objects, findings: [...unique.values()] };
}

// Namespace + format audit. Proves rclone-crypt format, not restorability.
// Demonstrated violations are findings (exit 1). Anything that stops the audit
// from completing throws (exit 2), and an ambiguous inventory is never clean:
// Drime allows duplicate names, and a path-addressed read cannot tell which
// object it reached.
function drimeAudit({ envFile, baseRemote, cryptRemote, runtime }) {
  const ctx = loadContext({
    envFile: envFile || DEFAULT_DRIME_ENV_FILE,
    baseRemote: baseRemote || DEFAULT_DRIME_BASE_REMOTE,
    cryptRemote: cryptRemote || DEFAULT_DRIME_CRYPT_REMOTE,
  });
  const base = ctx.baseRemote;
  const rawName = (rawPath) => `${base}:${ctx.root}/${rawPath}`;
  const findings = [];

  const topLevel = parseJsonList(auditRun(ctx, runtime, { op: 'listTop' }, 'listing base remote'), 'base remote listing');
  for (const entry of topLevel) {
    if (entry.Path !== ctx.root) {
      findings.push({ kind: 'unexpected-top-level', path: `${base}:${entry.Path}`, detail: 'not the crypt root' });
    }
  }
  const rootEntries = topLevel.filter((entry) => entry.Path === ctx.root);
  if (rootEntries.length > 1 || rootEntries.some((entry) => !entry.IsDir)) {
    findings.push({ kind: 'ambiguous-path', path: `${base}:${ctx.root}`, detail: 'the crypt root is duplicated or not a directory' });
  }
  if (rootEntries.length !== 1 || !rootEntries[0].IsDir) {
    return auditReport(0, findings);
  }
  auditRun(ctx, runtime, { op: 'probeCrypt' }, 'initialising crypt remote');

  const raw = parseJsonList(auditRun(ctx, runtime, { op: 'listRaw' }, 'listing raw objects'), 'raw listing');
  const rawPaths = [...new Set(raw.map((entry) => entry.Path))];
  const ambiguous = new Set(duplicates(raw.map((entry) => entry.Path)));
  for (const rawPath of ambiguous) {
    findings.push({ kind: 'ambiguous-path', path: rawName(rawPath), detail: 'more than one raw entry has this path' });
  }

  const { args: strictArgs, result: strict } = auditExec(ctx, runtime, { op: 'listCrypt' });
  if (strict.ok) {
    const mapped = parseJsonList(strict.output, 'crypt listing');
    const mappedPaths = mapped.map((entry) => entry.EncryptedPath);
    const decryptable = new Set(mappedPaths);
    for (const rawPath of rawPaths) {
      if (!decryptable.has(rawPath)) {
        findings.push({ kind: 'undecryptable', path: rawName(rawPath), detail: 'raw entry has no crypt identity' });
      }
    }
    for (const mappedPath of new Set(mappedPaths)) {
      if (!rawPaths.includes(mappedPath)) {
        findings.push({ kind: 'missing-raw', path: rawName(mappedPath), detail: 'crypt lists it but the raw listing does not' });
      }
    }
    for (const mappedPath of duplicates(mappedPaths)) {
      findings.push({ kind: 'ambiguous-path', path: rawName(mappedPath), detail: 'more than one crypt entry has this raw path' });
    }
  } else if (NAME_DECRYPT_FAILURE.test(strict.stderr)) {
    const offenders = findUndecryptable(ctx, runtime, rawPaths);
    if (offenders.length === 0) {
      throw new DrimeAuditError('strict crypt listing failed and no undecryptable name could be identified');
    }
    for (const rawPath of offenders) {
      findings.push({ kind: 'undecryptable', path: rawName(rawPath), detail: 'name does not decrypt through the crypt remote' });
    }
  } else {
    throw new DrimeAuditError(`strict crypt listing: ${failureText(strictArgs, strict)}`);
  }

  for (const entry of raw.filter((candidate) => !candidate.IsDir && !ambiguous.has(candidate.Path))) {
    if (typeof entry.Size === 'number' && entry.Size < CRYPT_MIN_FILE_BYTES) {
      findings.push({ kind: 'not-crypt-format', path: rawName(entry.Path), detail: `only ${entry.Size} bytes` });
      continue;
    }
    const head = auditRun(ctx, runtime, { op: 'catHead', rawPath: entry.Path }, 'reading object header');
    if (Buffer.from(head).length < CRYPT_MAGIC.length) {
      throw new DrimeAuditError('reading object header: rclone cat returned fewer bytes than requested');
    }
    if (!Buffer.from(head).subarray(0, CRYPT_MAGIC.length).equals(CRYPT_MAGIC)) {
      findings.push({ kind: 'not-crypt-format', path: rawName(entry.Path), detail: 'missing rclone crypt header' });
    }
  }

  return auditReport(raw.filter((entry) => !entry.IsDir).length, findings);
}

module.exports = {
  DEFAULT_DRIME_ENV_FILE,
  DEFAULT_DRIME_BASE_REMOTE,
  DEFAULT_DRIME_CRYPT_REMOTE,
  DEFAULT_DRIME_KEEP,
  DEFAULT_DRIME_MAX_BYTES,
  CRYPT_MAGIC,
  DrimeAuditError,
  normalizeDrimeDestination,
  loadDrimeContext,
  runDrimeOperation,
  buildRcloneArgs,
  drimeTargetOf,
  overCapOutcome,
  assertGenericRcloneTarget,
  drimeAudit,
  LISTING_MAX_BYTES,
};
