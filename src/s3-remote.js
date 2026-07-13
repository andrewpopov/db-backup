'use strict';

// Native S3-compatible off-host remote: AWS Signature Version 4, signed with
// node:crypto, sent over the global `fetch` — the real, async `fetch`, awaited
// normally. Zero runtime dependencies, same as the rest of this package.
// Covers both AWS S3 and Cloudflare R2 (R2 speaks the S3 API), selected by
// whether `endpoint` is set.
//
// Every function in this module is async and must be awaited by its caller.
// That is deliberate: an S3 upload/verify/list/delete is a real network round
// trip, and this package used to make it "synchronous" by blocking the event
// loop with worker_threads + Atomics.wait (see git history / CHANGELOG for
// v0.16.0) — which is fine for the CLI (a batch process) but freezes an
// in-process/library host for the whole upload. There is now exactly one S3
// code path, and it is async; `runBackupJobAsync` in index.js is the only
// production caller. The sync `runBackupJob` refuses an S3 remote outright
// rather than reach this module at all.
//
// Mirrors the rclone remote's invariant exactly: NOTHING is pruned and NO
// success is reported until the uploaded object has been re-read (HEAD) and
// its size — and, for a single-part PUT, its ETag — verified against the
// local artifact. A failed or unverified upload throws (rejects), leaving
// prior good backups untouched. See uploadBackupToS3 / verifyS3Object.

const fs = require('fs');
const crypto = require('crypto');

const DEFAULT_S3_KEEP = 30; // mirrors DEFAULT_REMOTE_KEEP in index.js
const DEFAULT_S3_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per HTTP request

// A single-part PUT is the S3-enforced ceiling. Above this, S3 requires the
// multipart upload API, which this package deliberately does not implement
// (see README) — a backup that has grown past 5 GiB must fail loudly here,
// not be silently truncated or corrupted by a PUT that S3 itself will reject.
const S3_SINGLE_PART_LIMIT_BYTES = 5 * 1024 * 1024 * 1024;

const EMPTY_PAYLOAD_HASH = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function md5Hex(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

// AWS's URI-encoding rules deviate from encodeURIComponent only in the set of
// characters it additionally escapes (`! ' ( ) *`) and in tilde, which AWS
// requires literal.
function awsUriEncode(value) {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%7E/g, '~');
}

// A key like `app/prefix/sqlite-backup-....db.gz` must have each path segment
// encoded on its own — encoding the whole string would turn its `/`
// separators into `%2F`, breaking the object path.
function encodeS3Key(key) {
  return key
    .split('/')
    .map((segment) => awsUriEncode(segment))
    .join('/');
}

function canonicalQueryString(query) {
  return Object.keys(query)
    .sort()
    .map((key) => `${awsUriEncode(key)}=${awsUriEncode(String(query[key]))}`)
    .join('&');
}

// Never let a thrown error carry the secret access key (or, defensively, the
// access key id) into a log line — a sibling package once leaked a bearer
// token into an error message via exactly this path.
function redactSecrets(text, credentials) {
  let redacted = text;
  if (credentials && credentials.secretAccessKey) {
    redacted = redacted.split(credentials.secretAccessKey).join('***');
  }
  if (credentials && credentials.accessKeyId) {
    redacted = redacted.split(credentials.accessKeyId).join('***');
  }
  return redacted;
}

// Credentials come from the environment ONLY — never a CLI flag, which would
// leak into `ps`/shell history. AWS_* is canonical; S3_* is honored as an
// alias for consumers that already use that naming (e.g. some R2 tooling).
function resolveS3Credentials(env = process.env) {
  const accessKeyId = env.AWS_ACCESS_KEY_ID || env.S3_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY || env.S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'S3 remote requires credentials in the environment: set AWS_ACCESS_KEY_ID and ' +
        'AWS_SECRET_ACCESS_KEY (or S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY). Credentials are ' +
        'never accepted as CLI flags — they would leak into `ps` output and shell history.',
    );
  }
  return { accessKeyId, secretAccessKey };
}

// No endpoint -> AWS, path-style against the regional endpoint. An endpoint
// (e.g. `https://<account>.r2.cloudflarestorage.com`) overrides it -> R2 (or
// any other S3-compatible provider), also path-style. Path-style is used in
// both cases because it removes an entire axis of variation (bucket-name/DNS
// interaction with virtual-hosted-style) and is what the constrained "endpoint
// or https://s3.{region}.amazonaws.com" contract this package documents calls
// for.
function resolveS3Endpoint(s3) {
  if (s3.endpoint) {
    const parsed = new URL(s3.endpoint);
    return { host: parsed.host, protocol: parsed.protocol };
  }
  const region = resolveS3Region(s3);
  return { host: `s3.${region}.amazonaws.com`, protocol: 'https:' };
}

// `auto` is R2's own documented region value (it ignores the region and
// resolves the bucket's actual location); AWS has no such shortcut, so a
// request with no explicit endpoint defaults to `us-east-1`, the SigV4-legal
// region every AWS account can reach every bucket through.
function resolveS3Region(s3) {
  if (s3.region) return s3.region;
  return s3.endpoint ? 'auto' : 'us-east-1';
}

function s3ObjectKey(s3, fileName) {
  const prefix = String(s3.prefix || '').replace(/^\/+|\/+$/g, '');
  return prefix ? `${prefix}/${fileName}` : fileName;
}

// service is a parameter (not hardcoded) purely so the SigV4 math can be
// exercised against AWS's own published "get-vanilla" test vector, which uses
// service "service" rather than "s3" — production callers never pass it.
function signS3Request({
  method,
  host,
  canonicalPath,
  query = {},
  payloadHash,
  region,
  service = 's3',
  accessKeyId,
  secretAccessKey,
  date = new Date(),
}) {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const signedHeaders = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const signedHeaderNames = Object.keys(signedHeaders).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${String(signedHeaders[name]).trim()}\n`).join('');
  const signedHeadersList = signedHeaderNames.join(';');

  const canonicalRequest = [
    method,
    canonicalPath,
    canonicalQueryString(query),
    canonicalHeaders,
    signedHeadersList,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(Buffer.from(canonicalRequest, 'utf8')),
  ].join('\n');

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeadersList}, Signature=${signature}`;

  return { amzDate, authorization, signedHeaders: signedHeadersList, canonicalRequest, stringToSign };
}

function resolveS3TimeoutMs(value, env = process.env) {
  const read = (raw) => {
    if (raw === undefined || raw === null || raw === '') return null;
    const parsed = Number.parseInt(String(raw), 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error('s3TimeoutMs must be an integer >= 1 (milliseconds)');
    }
    return parsed;
  };
  return read(value) ?? read(env.DB_BACKUP_S3_TIMEOUT_MS) ?? DEFAULT_S3_TIMEOUT_MS;
}

// The production HTTP layer: real, async `fetch`, bounded by an
// AbortController tied to the per-request timeout. Returns the same shape
// tests' `runtime.fetchImpl` mocks return: { status, headers, body: Buffer }.
async function defaultAsyncFetch(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });
    const bodyBuf = Buffer.from(await res.arrayBuffer());
    const headers = {};
    for (const [key, value] of res.headers) headers[key] = value;
    return { status: res.status, headers, body: bodyBuf };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`S3 request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Every S3 call goes through here: sign, dispatch (via runtime.fetchImpl —
// tests inject a mock, production defaults to the real async `fetch`), and
// redact credentials from any thrown error. Async: callers must await it.
async function s3Request({ method, s3, runtime, canonicalPath, query = {}, body = null, extraHeaders = {} }) {
  const { host, protocol } = resolveS3Endpoint(s3);
  const region = resolveS3Region(s3);
  const credentials = resolveS3Credentials(runtime.env);
  const payloadHash = body ? sha256Hex(body) : EMPTY_PAYLOAD_HASH;
  const date = runtime.now ? runtime.now() : new Date();

  const { amzDate, authorization } = signS3Request({
    method,
    host,
    canonicalPath,
    query,
    payloadHash,
    region,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    date,
  });

  const queryString = Object.keys(query).length ? `?${canonicalQueryString(query)}` : '';
  const url = `${protocol}//${host}${canonicalPath}${queryString}`;
  const headers = {
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    authorization,
    ...extraHeaders,
  };

  const fetchImpl = runtime.fetchImpl || defaultAsyncFetch;
  const timeoutMs = resolveS3TimeoutMs(runtime.s3TimeoutMs, runtime.env);

  try {
    return await fetchImpl(url, { method, headers, body: body || undefined }, timeoutMs);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    throw new Error(redactSecrets(`S3 ${method} ${url} failed: ${message}`, credentials));
  }
}

function bodyText(response) {
  try {
    return response.body ? Buffer.from(response.body).toString('utf8').slice(0, 500) : '';
  } catch {
    return '';
  }
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

// Re-read the uploaded object and compare it to the local artifact. Fail
// closed: any ambiguity (missing/unparseable Content-Length, a status outside
// 2xx) is a verification FAILURE, never a pass — mirrors verifyRemoteObject
// for the rclone path.
async function verifyS3Object(entry, s3, runtime, expectedMd5Hex) {
  const canonicalPath = `/${s3.bucket}/${encodeS3Key(s3ObjectKey(s3, entry.fileName))}`;
  const response = await s3Request({ method: 'HEAD', s3, runtime, canonicalPath });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `S3 verification failed for ${entry.fileName}: HEAD returned ${response.status}; refusing to prune or stamp`,
    );
  }

  const remoteSizeRaw = headerValue(response.headers, 'content-length');
  const remoteSize = remoteSizeRaw === undefined ? NaN : Number.parseInt(remoteSizeRaw, 10);
  const localSize = fs.statSync(entry.fullPath).size;

  if (!Number.isInteger(remoteSize)) {
    throw new Error(
      `Could not determine remote object size for ${entry.fileName} (missing/invalid Content-Length); refusing to prune or stamp`,
    );
  }
  if (remoteSize !== localSize) {
    throw new Error(
      `Remote size mismatch for ${entry.fileName}: local=${localSize} remote=${remoteSize}; refusing to prune or stamp`,
    );
  }

  // ETag on a single-part PUT is the MD5 of the body, quoted. A multipart
  // ETag contains a `-<partCount>` suffix and is not a body MD5 — this
  // package never issues a multipart PUT, so any ETag we see should be the
  // plain form; if it isn't (a provider quirk), skip the comparison rather
  // than fail on a check that was never meaningful, having already confirmed
  // size.
  const etagRaw = headerValue(response.headers, 'etag');
  const etag = etagRaw ? etagRaw.replace(/^"|"$/g, '') : null;
  if (etag && !etag.includes('-') && expectedMd5Hex && etag !== expectedMd5Hex) {
    throw new Error(
      `Remote ETag mismatch for ${entry.fileName}: local md5=${expectedMd5Hex} remote etag=${etag}; refusing to prune or stamp`,
    );
  }

  return { target: `s3://${s3.bucket}/${s3ObjectKey(s3, entry.fileName)}`, sizeBytes: remoteSize, etag };
}

// Buffered PUT: the whole file is read into memory and sent as one request
// body. This is a deliberate simplicity choice — appropriate for SQLite/
// pg_dump-sized backups, not for arbitrarily large ones. S3 itself caps a
// single-part PUT at 5 GiB (S3_SINGLE_PART_LIMIT_BYTES); above that this
// throws before reading the file rather than attempting (and truncating or
// corrupting) an upload S3 would reject. Multipart upload would remove the
// cap but is a materially larger, stateful protocol (initiate/part-upload/
// complete, each independently retryable) — out of scope here; see README.
async function uploadBackupToS3(entry, s3, runtime) {
  if (!s3.bucket) {
    throw new Error('s3.bucket is required to upload a backup');
  }
  // Fail before touching the network (and before reading the file) when
  // credentials are absent — same "refuse before doing partial work" shape as
  // the rclone binary-presence check.
  resolveS3Credentials(runtime.env);

  const stats = fs.statSync(entry.fullPath);
  if (stats.size > S3_SINGLE_PART_LIMIT_BYTES) {
    throw new Error(
      `Refusing to upload ${entry.fileName}: ${stats.size} bytes exceeds the ${S3_SINGLE_PART_LIMIT_BYTES}-byte ` +
        'single-part S3 PUT limit (5 GiB). This package does not implement multipart upload; reduce the backup ' +
        'size (e.g. --no-compress off, or archive/trim the database) or upload out of band.',
    );
  }

  const body = fs.readFileSync(entry.fullPath);
  const md5 = md5Hex(body);
  const key = s3ObjectKey(s3, entry.fileName);
  const canonicalPath = `/${s3.bucket}/${encodeS3Key(key)}`;

  const response = await s3Request({
    method: 'PUT',
    s3,
    runtime,
    canonicalPath,
    body,
    extraHeaders: { 'content-type': 'application/octet-stream' },
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `S3 upload failed for ${entry.fileName}: PUT returned ${response.status}: ${bodyText(response)}`,
    );
  }

  return verifyS3Object(entry, s3, runtime, md5);
}

// GET ?list-type=2, paginated via continuation tokens, filtered to this
// package's own filename shape (parseBackupFileName). Mirrors pruneRemoteBackups'
// use of rclone `lsf` — returns bare filenames (prefix stripped), not full keys.
async function listS3BackupFileNames(s3, runtime) {
  const prefix = String(s3.prefix || '').replace(/^\/+|\/+$/g, '');
  const names = [];
  let continuationToken = null;

  do {
    const query = { 'list-type': '2', 'max-keys': '1000' };
    if (prefix) query.prefix = prefix;
    if (continuationToken) query['continuation-token'] = continuationToken;

    const canonicalPath = `/${s3.bucket}`;
    const response = await s3Request({ method: 'GET', s3, runtime, canonicalPath, query });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`S3 list failed for bucket ${s3.bucket}: GET returned ${response.status}: ${bodyText(response)}`);
    }

    const xml = Buffer.from(response.body).toString('utf8');
    for (const match of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) {
      const key = match[1];
      const name = prefix && key.startsWith(`${prefix}/`) ? key.slice(prefix.length + 1) : key;
      if (name) names.push(name);
    }

    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    const tokenMatch = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/);
    continuationToken = truncated && tokenMatch ? tokenMatch[1] : null;
  } while (continuationToken);

  return names;
}

// Keep the newest `keep` remote objects, same shape as pruneRemoteBackups:
// never delete the object just uploaded/verified, never drop below 1, and a
// listing/delete failure is a cleanup miss (warn) rather than a data-safety
// issue — the new backup is already verified on both ends.
async function pruneS3Backups(s3, protectFileName, runtime, namePrefix, parseBackupFileName) {
  const keep = Math.max(1, Number(s3.keep) > 0 ? Number(s3.keep) : DEFAULT_S3_KEEP);

  let names;
  try {
    names = await listS3BackupFileNames(s3, runtime);
  } catch (error) {
    console.warn(`[db-backup] Could not list remote backups for pruning: ${error.message}`);
    return [];
  }

  const candidates = names
    .filter((name) => name && name !== protectFileName && parseBackupFileName(name, namePrefix))
    .sort()
    .reverse();

  const doomed = candidates.slice(keep - 1);
  const deleted = [];
  for (const name of doomed) {
    try {
      const canonicalPath = `/${s3.bucket}/${encodeS3Key(s3ObjectKey(s3, name))}`;
      const response = await s3Request({ method: 'DELETE', s3, runtime, canonicalPath });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`DELETE returned ${response.status}`);
      }
      deleted.push(name);
    } catch (error) {
      console.warn(`[db-backup] Failed to prune remote backup ${name} (leaving it in place): ${error.message}`);
    }
  }
  return deleted;
}

module.exports = {
  S3_SINGLE_PART_LIMIT_BYTES,
  DEFAULT_S3_KEEP,
  DEFAULT_S3_TIMEOUT_MS,
  resolveS3Credentials,
  resolveS3Endpoint,
  resolveS3Region,
  resolveS3TimeoutMs,
  signS3Request,
  s3ObjectKey,
  uploadBackupToS3,
  verifyS3Object,
  pruneS3Backups,
  listS3BackupFileNames,
  redactSecrets,
};
