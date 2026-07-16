import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { dbBackup, fixedNow, makeTempDir, makeRuntime, cleanupTempDirs } from './helpers';

const {
  listBackupsWithPlan,
  resolveDestinations,
  normalizeDestination,
  runBackupJob,
  runBackupJobAsync,
  runCli,
  parseBackupFileName,
  normalizeRuntime,
  signS3Request,
  uploadBackupToS3,
  pruneS3Backups,
} = dbBackup;

afterEach(() => {
  cleanupTempDirs();
});

describe('@andrewpopov/db-backup — destinations + off-host replication (rclone, S3/R2)', () => {
  it('uploads off-host and verifies the remote object before pruning or stamping (BWK-131)', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    const stampFile = path.join(outputDir, '.last-success');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'app.db'), 'database bytes');

    const calls: string[][] = [];
    const runtime = makeRuntime({
      commandExists: (c: string) => c === 'rclone',
      execFileSync: ((cmd: string, args: string[]) => {
        calls.push([cmd, ...args]);
        if (args[0] === 'lsjson') {
          // Report the real local size so verification passes.
          const local = fs.statSync(path.join(outputDir, fs.readdirSync(outputDir).find((f) => f.startsWith('sqlite-backup-') && f.endsWith('.db'))!)).size;
          return Buffer.from(JSON.stringify({ Size: local }));
        }
        if (args[0] === 'lsf') return Buffer.from('');
        return Buffer.from('');
      }) as never,
    });

    const result = runBackupJob({
      allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir,
      compressSqlite: false, stampFile, runtime,
      remote: { target: 'offsite:backups/app' },
    });

    const verbs = calls.map((c) => c[1]);
    expect(verbs).toContain('copyto');
    expect(verbs).toContain('lsjson');
    // Upload+verify must precede any pruning.
    expect(verbs.indexOf('lsjson')).toBeLessThan(verbs.indexOf('lsf') === -1 ? Infinity : verbs.indexOf('lsf'));
    expect(result.uploaded).toMatchObject({ target: `offsite:backups/app/${result.created.fileName}` });
    expect(fs.existsSync(stampFile)).toBe(true);
  });

  it('a remote size mismatch prunes nothing and stamps nothing (fail-closed)', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    const stampFile = path.join(outputDir, '.last-success');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'app.db'), 'database bytes');
    fs.writeFileSync(path.join(outputDir, 'sqlite-backup-20260701-120000Z.db'), 'old');
    fs.writeFileSync(stampFile, '2026-07-01T00:00:00.000Z\n');

    const runtime = makeRuntime({
      commandExists: (c: string) => c === 'rclone',
      execFileSync: ((_c: string, args: string[]) =>
        args[0] === 'lsjson' ? Buffer.from(JSON.stringify({ Size: 1 })) : Buffer.from('')) as never,
    });

    expect(() =>
      runBackupJob({
        allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir,
        compressSqlite: false, stampFile, runtime,
        policy: { mode: 'keep-last', keepLast: 1 },
        remote: { target: 'offsite:backups/app' },
      }),
    ).toThrow(/Remote size mismatch/);

    expect(fs.existsSync(path.join(outputDir, 'sqlite-backup-20260701-120000Z.db')), 'old backup must survive').toBe(true);
    expect(fs.readFileSync(stampFile, 'utf8').trim()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('an unparseable rclone response is a verification failure, not a pass', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'app.db'), 'db');

    const runtime = makeRuntime({
      commandExists: (c: string) => c === 'rclone',
      execFileSync: ((_c: string, args: string[]) =>
        args[0] === 'lsjson' ? Buffer.from('not json at all') : Buffer.from('')) as never,
    });

    expect(() =>
      runBackupJob({
        allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir,
        compressSqlite: false, runtime, remote: { target: 'offsite:x' },
      }),
    ).toThrow(/Could not determine remote object size/);
  });

  it('refuses to report success when rclone is unavailable', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'app.db'), 'db');

    expect(() =>
      runBackupJob({
        allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir,
        compressSqlite: false, runtime: makeRuntime({ commandExists: () => false }),
        remote: { target: 'offsite:x' },
      }),
    ).toThrow(/rclone.*unavailable/i);
  });

  it('--skip-remote runs local-only without touching rclone', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'app.db'), 'db');
    const calls: string[] = [];

    const result = runBackupJob({
      allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir, compressSqlite: false,
      remote: { target: 'offsite:x' }, skipRemote: true,
      runtime: makeRuntime({ execFileSync: ((c: string) => { calls.push(c); return Buffer.from(''); }) as never }),
    });

    expect(calls).not.toContain('rclone');
    expect(result.uploaded).toBeNull();
  });

  it('refuses a silent local-only backup: no --remote and no --skip-remote aborts, and leaves no backup file', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.writeFileSync(path.join(cwd, 'app.db'), 'db');

    expect(() =>
      runBackupJob({
        allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir, compressSqlite: false,
        runtime: makeRuntime(),
      }),
    ).toThrow(/Refusing to create a local-only backup.*--remote.*--skip-remote/s);

    // No backup file, no output dir, nothing implying success.
    expect(fs.existsSync(outputDir)).toBe(false);
  });

  it('CLI backup with neither --remote nor --skip-remote aborts', async () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.writeFileSync(path.join(cwd, 'app.db'), 'db');
    const originalUrl = process.env.DATABASE_URL;
    const originalNodeEnv = process.env.NODE_ENV;
    const originalCwd = process.cwd();
    try {
      process.chdir(cwd);
      process.env.DATABASE_URL = 'file:./app.db';
      process.env.NODE_ENV = 'development';
      await expect(
        runCli(['backup', '--output-dir', outputDir, '--allow-unsafe-copy']),
      ).rejects.toThrow(/Refusing to create a local-only backup/);
      expect(fs.existsSync(outputDir)).toBe(false);
    } finally {
      process.chdir(originalCwd);
      if (originalUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalUrl;
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('a remote configured (no --skip-remote) succeeds and uploads as before', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'app.db'), 'db');

    const runtime = makeRuntime({
      commandExists: (c: string) => c === 'rclone',
      execFileSync: ((_c: string, args: string[]) => {
        if (args[0] === 'lsjson') {
          const f = fs.readdirSync(outputDir).find((n) => n.startsWith('sqlite-backup-') && n.endsWith('.db'))!;
          return Buffer.from(JSON.stringify({ Size: fs.statSync(path.join(outputDir, f)).size }));
        }
        return Buffer.from('');
      }) as never,
    });

    const result = runBackupJob({
      allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir, compressSqlite: false,
      remote: { target: 'offsite:x' }, runtime,
    });

    expect(result.uploaded).not.toBeNull();
    expect(result.localOnly).toBe(false);
  });

  it('skipRemote: true with no remote succeeds (explicit opt-out) and surfaces a localOnly warning', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.writeFileSync(path.join(cwd, 'app.db'), 'db');
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => { warnings.push(String(message)); };

    let result;
    try {
      result = runBackupJob({
        allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir, compressSqlite: false,
        skipRemote: true, runtime: makeRuntime(),
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(result.created.fileName).toBe('sqlite-backup-20260705-150000Z.db');
    expect(result.localOnly).toBe(true);
    expect(warnings.some((w) => /local-only backup/i.test(w))).toBe(true);
  });

  it('CLI --skip-remote with no --remote succeeds', async () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    // A real (if minimal) SQLite file — this exercises the actual sqlite3
    // binary via runCli (no injected runtime), which rejects non-database bytes.
    execFileSync('sqlite3', [path.join(cwd, 'app.db'), 'CREATE TABLE t (a INTEGER);']);
    const originalUrl = process.env.DATABASE_URL;
    const originalNodeEnv = process.env.NODE_ENV;
    const originalCwd = process.cwd();
    try {
      process.chdir(cwd);
      process.env.DATABASE_URL = 'file:./app.db';
      process.env.NODE_ENV = 'development';
      await runCli(['backup', '--output-dir', outputDir, '--allow-unsafe-copy', '--skip-remote']);
      expect(fs.readdirSync(outputDir).some((f) => f.startsWith('sqlite-backup-'))).toBe(true);
    } finally {
      process.chdir(originalCwd);
      if (originalUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalUrl;
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('remote prune never deletes the object it just uploaded', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'app.db'), 'db');
    const deleted: string[] = [];

    const runtime = makeRuntime({
      commandExists: (c: string) => c === 'rclone',
      execFileSync: ((_c: string, args: string[]) => {
        if (args[0] === 'lsjson') {
          const f = fs.readdirSync(outputDir).find((n) => n.startsWith('sqlite-backup-') && n.endsWith('.db'))!;
          return Buffer.from(JSON.stringify({ Size: fs.statSync(path.join(outputDir, f)).size }));
        }
        if (args[0] === 'lsf') {
          // The just-uploaded object sorts OLDEST here (clock rolled backward).
          return Buffer.from(
            ['sqlite-backup-20260709-120000Z.db', 'sqlite-backup-20260708-120000Z.db', 'sqlite-backup-20260705-150000Z.db'].join('\n'),
          );
        }
        if (args[0] === 'deletefile') deleted.push(String(args[1]));
        return Buffer.from('');
      }) as never,
    });

    const result = runBackupJob({
      allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir, compressSqlite: false,
      runtime, remote: { target: 'offsite:x', keep: 1 },
    });

    expect(deleted.some((d) => d.endsWith(result.created.fileName)), 'must never delete the object it just verified').toBe(false);
    expect(deleted.length).toBeGreaterThan(0);
  });


  it('a custom namePrefix names, lists, prunes and restores its own backups (BWK-133)', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'app.db'), 'db');

    const result = runBackupJob({ skipRemote: true,
      allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir,
      compressSqlite: false, namePrefix: 'smarthome', runtime: makeRuntime(),
    });

    expect(result.created.fileName).toBe('smarthome-20260705-150000Z.db');
    // Engine still resolves — it comes from the `.db` extension, not the prefix.
    expect(result.created.engine).toBe('sqlite');

    const listed = listBackupsWithPlan({ cwd, outputDir, namePrefix: 'smarthome', runtime: makeRuntime() });
    expect(listed.backups.map((b) => b.fileName)).toEqual(['smarthome-20260705-150000Z.db']);
  });

  it('prefix scoping: a job never sees or prunes another app\u2019s backups (BWK-133)', () => {
    // A shared backup directory (or remote bucket) must not let app A prune app B.
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'app.db'), 'db');
    fs.writeFileSync(path.join(outputDir, 'otherapp-20260101-000000Z.db'), 'foreign');
    fs.writeFileSync(path.join(outputDir, 'sqlite-backup-20260101-000000Z.db'), 'canonical');
    fs.writeFileSync(path.join(outputDir, 'notes.db'), 'not a backup');

    // keep-last:1 would prune everything it can see.
    runBackupJob({ skipRemote: true,
      allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir,
      compressSqlite: false, namePrefix: 'smarthome',
      policy: { mode: 'keep-last', keepLast: 1 }, runtime: makeRuntime(),
    });

    for (const survivor of ['otherapp-20260101-000000Z.db', 'sqlite-backup-20260101-000000Z.db', 'notes.db']) {
      expect(fs.existsSync(path.join(outputDir, survivor)), `${survivor} must survive`).toBe(true);
    }
  });

  it('without namePrefix, only the canonical prefixes are recognised (no widening)', () => {
    expect(parseBackupFileName('sqlite-backup-20260705-150000Z.db')).toMatchObject({ engine: 'sqlite' });
    expect(parseBackupFileName('postgres-backup-20260705-150000Z.dump')).toMatchObject({ engine: 'postgres' });
    // A foreign prefix must NOT parse by default.
    expect(parseBackupFileName('smarthome-20260705-150000Z.db')).toBeNull();
    expect(parseBackupFileName('otherapp-20260705-150000Z.db')).toBeNull();
    // ...but does with the prefix supplied.
    expect(parseBackupFileName('smarthome-20260705-150000Z.db', 'smarthome')).toMatchObject({
      engine: 'sqlite', prefix: 'smarthome',
    });
    // Engine comes from the extension.
    expect(parseBackupFileName('smarthome-20260705-150000Z.dump', 'smarthome')).toMatchObject({ engine: 'postgres' });
    // And the canonical prefix must not parse when a different one is expected.
    expect(parseBackupFileName('sqlite-backup-20260705-150000Z.db', 'smarthome')).toBeNull();
  });

  it('remote prune is scoped to the configured prefix', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'app.db'), 'db');
    const deleted: string[] = [];

    const runtime = makeRuntime({
      commandExists: (c: string) => c === 'rclone',
      execFileSync: ((_c: string, args: string[]) => {
        if (args[0] === 'lsjson') {
          const f = fs.readdirSync(outputDir).find((n) => n.startsWith('smarthome-') && n.endsWith('.db'))!;
          return Buffer.from(JSON.stringify({ Size: fs.statSync(path.join(outputDir, f)).size }));
        }
        if (args[0] === 'lsf') {
          // A shared bucket holding two apps' backups.
          return Buffer.from(
            ['smarthome-20260101-000000Z.db', 'smarthome-20260102-000000Z.db', 'otherapp-20260101-000000Z.db'].join('\n'),
          );
        }
        if (args[0] === 'deletefile') deleted.push(String(args[1]));
        return Buffer.from('');
      }) as never,
    });

    runBackupJob({
      allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir, compressSqlite: false,
      namePrefix: 'smarthome', runtime, remote: { target: 'offsite:shared', keep: 1 },
    });

    expect(deleted.some((d) => d.includes('otherapp')), 'must never prune another app').toBe(false);
    expect(deleted.some((d) => d.includes('smarthome-2026010'))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Native S3-compatible remote (AWS S3 + Cloudflare R2). No test here ever
  // touches the network: `runtime.fetchImpl` is always a synchronous mock —
  // see makeFakeS3. The S3 call chain (s3Request and everything built on it)
  // is async, so these tests await it; `await` on a synchronous mock's return
  // value resolves immediately, so the mock itself needn't change shape.
  // ---------------------------------------------------------------------------
  function makeFakeS3(options: { objects?: Map<string, Buffer>; onRequest?: (url: string, opts: any) => void } = {}) {
    const objects = options.objects || new Map<string, Buffer>();
    const fetchImpl = (url: string, opts: { method: string; headers: Record<string, string>; body?: Buffer }) => {
      options.onRequest?.(url, opts);
      const parsed = new URL(url);
      const key = decodeURIComponent(parsed.pathname.replace(/^\/[^/]+\//, ''));

      if (opts.method === 'PUT') {
        const body = Buffer.from(opts.body || Buffer.alloc(0));
        objects.set(key, body);
        const md5 = crypto.createHash('md5').update(body).digest('hex');
        return { status: 200, headers: { etag: `"${md5}"` }, body: Buffer.alloc(0) };
      }
      if (opts.method === 'HEAD') {
        const obj = objects.get(key);
        if (!obj) return { status: 404, headers: {}, body: Buffer.alloc(0) };
        const md5 = crypto.createHash('md5').update(obj).digest('hex');
        return { status: 200, headers: { 'content-length': String(obj.length), etag: `"${md5}"` }, body: Buffer.alloc(0) };
      }
      if (opts.method === 'DELETE') {
        objects.delete(key);
        return { status: 204, headers: {}, body: Buffer.alloc(0) };
      }
      if (opts.method === 'GET') {
        const prefix = parsed.searchParams.get('prefix') || '';
        const contents = [...objects.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => `<Contents><Key>${k}</Key></Contents>`)
          .join('');
        return {
          status: 200,
          headers: { 'content-type': 'application/xml' },
          body: Buffer.from(`<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`),
        };
      }
      return { status: 400, headers: {}, body: Buffer.from('unhandled method') };
    };
    return { objects, fetchImpl };
  }

  const S3_CREDS_ENV = { AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };

  it('SigV4 signing matches an independently-verified known vector', () => {
    // Fixed key/date/region/payload from AWS's published SigV4 "get-vanilla"
    // test suite (https://docs.aws.amazon.com/general/latest/gr/sigv4_signing.html):
    // GET / against host example.amazonaws.com, region us-east-1, date
    // 2015-08-30T12:36:00Z, empty payload, access key AKIDEXAMPLE / secret
    // wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY. `service` is left as the
    // AWS test suite's generic "service" (a parameter that exists on
    // signS3Request only so this vector can be exercised — every production
    // caller in this package signs with "s3"). Because this package always
    // signs `x-amz-content-sha256` (required for S3, absent from the generic
    // AWS vector), the expected signature below is not the published one
    // verbatim — it is the same inputs run through the published algorithm
    // with that one additional signed header, independently re-derived via
    // `openssl dgst -sha256 -mac HMAC` outside this test (both the canonical
    // request's SHA-256 and the final HMAC chain) before being pinned here.
    const emptyPayloadHash = crypto.createHash('sha256').update('').digest('hex');
    const result = signS3Request({
      method: 'GET',
      host: 'example.amazonaws.com',
      canonicalPath: '/',
      query: {},
      payloadHash: emptyPayloadHash,
      region: 'us-east-1',
      service: 'service',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      date: new Date('2015-08-30T12:36:00Z'),
    });

    expect(result.canonicalRequest).toBe(
      [
        'GET',
        '/',
        '',
        'host:example.amazonaws.com',
        `x-amz-content-sha256:${emptyPayloadHash}`,
        'x-amz-date:20150830T123600Z',
        '',
        'host;x-amz-content-sha256;x-amz-date',
        emptyPayloadHash,
      ].join('\n'),
    );
    expect(result.stringToSign).toBe(
      [
        'AWS4-HMAC-SHA256',
        '20150830T123600Z',
        '20150830/us-east-1/service/aws4_request',
        'bd2af82b09d2569ab8594ef6bcc1638c8675cb753915d0f401b2f40ecde6f823',
      ].join('\n'),
    );
    expect(result.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-content-sha256;x-amz-date, ' +
        'Signature=b0e9826b8e27230263689c913533611258ba50a1cf46f2c0ae5eea5c777359c2',
    );
  });

  it('uploads to S3 and verifies (size + ETag) before returning', async () => {
    const cwd = makeTempDir();
    const filePath = path.join(cwd, 'sqlite-backup-20260705-150000Z.db.gz');
    fs.writeFileSync(filePath, 'sqlite backup payload bytes');
    const { fetchImpl } = makeFakeS3();

    const result = await uploadBackupToS3(
      { fileName: path.basename(filePath), fullPath: filePath } as never,
      { bucket: 'mybucket', prefix: 'app', endpoint: 'https://abc123.r2.cloudflarestorage.com' } as never,
      normalizeRuntime({ fetchImpl, env: S3_CREDS_ENV } as never),
    );

    expect(result.target).toBe(`s3://mybucket/app/${path.basename(filePath)}`);
    expect(result.sizeBytes).toBe(fs.statSync(filePath).size);
    expect(result.etag).toBe(crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex'));
  });

  it('a HEAD size mismatch after upload THROWS — never reports success (fail-closed)', async () => {
    const cwd = makeTempDir();
    const filePath = path.join(cwd, 'sqlite-backup-20260705-150000Z.db.gz');
    fs.writeFileSync(filePath, 'sqlite backup payload bytes');

    // A HEAD that lies about the object's size — simulates a corrupted or
    // partial upload the provider nonetheless reports as present.
    const fetchImpl = (_url: string, opts: { method: string }) => {
      if (opts.method === 'PUT') return { status: 200, headers: {}, body: Buffer.alloc(0) };
      if (opts.method === 'HEAD') return { status: 200, headers: { 'content-length': '3' }, body: Buffer.alloc(0) };
      return { status: 400, headers: {}, body: Buffer.alloc(0) };
    };

    await expect(
      uploadBackupToS3(
        { fileName: path.basename(filePath), fullPath: filePath } as never,
        { bucket: 'mybucket' } as never,
        normalizeRuntime({ fetchImpl, env: S3_CREDS_ENV } as never),
      ),
    ).rejects.toThrow(/Remote size mismatch/);
  });

  it('a non-2xx PUT throws, and the error contains no credentials', async () => {
    const cwd = makeTempDir();
    const filePath = path.join(cwd, 'sqlite-backup-20260705-150000Z.db.gz');
    fs.writeFileSync(filePath, 'payload');
    const fetchImpl = () => ({ status: 403, headers: {}, body: Buffer.from('AccessDenied') });

    let caught: Error | null = null;
    try {
      await uploadBackupToS3(
        { fileName: path.basename(filePath), fullPath: filePath } as never,
        { bucket: 'mybucket' } as never,
        normalizeRuntime({ fetchImpl, env: S3_CREDS_ENV } as never),
      );
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/PUT returned 403/);
    expect(caught!.message).not.toContain(S3_CREDS_ENV.AWS_SECRET_ACCESS_KEY);
    expect(caught!.message).not.toContain(S3_CREDS_ENV.AWS_ACCESS_KEY_ID);
  });

  it('resolves the R2 endpoint override and the AWS default endpoint to the correct hosts', async () => {
    const cwd = makeTempDir();
    const filePath = path.join(cwd, 'sqlite-backup-20260705-150000Z.db.gz');
    fs.writeFileSync(filePath, 'payload');

    const seenHosts: string[] = [];
    const { fetchImpl } = makeFakeS3({ onRequest: (url) => seenHosts.push(new URL(url).host) });

    await uploadBackupToS3(
      { fileName: path.basename(filePath), fullPath: filePath } as never,
      { bucket: 'b', endpoint: 'https://abc123.r2.cloudflarestorage.com' } as never,
      normalizeRuntime({ fetchImpl, env: S3_CREDS_ENV } as never),
    );
    expect(seenHosts.every((h) => h === 'abc123.r2.cloudflarestorage.com')).toBe(true);

    seenHosts.length = 0;
    await uploadBackupToS3(
      { fileName: path.basename(filePath), fullPath: filePath } as never,
      { bucket: 'b' } as never,
      normalizeRuntime({ fetchImpl, env: S3_CREDS_ENV } as never),
    );
    expect(seenHosts.every((h) => h === 's3.us-east-1.amazonaws.com')).toBe(true);
  });

  // The first real backup on the Pi failed with:
  //   301 PermanentRedirect - The bucket you are attempting to access must be
  //   addressed using the specified endpoint
  // because the region defaulted to us-east-1 and AWS_REGION -- the env var every
  // AWS SDK and the CLI honor, and the one set in /etc/db-backup/s3.env -- was
  // IGNORED. A bucket lives in ONE region; the request must go to that region's
  // endpoint. It failed closed (exit 1, no false success), but it failed.
  it('honors AWS_REGION from the environment so a non-us-east-1 bucket is reachable', async () => {
    const cwd = makeTempDir();
    const filePath = path.join(cwd, 'sqlite-backup-20260705-150000Z.db.gz');
    fs.writeFileSync(filePath, 'payload');

    const seenHosts: string[] = [];
    const { fetchImpl } = makeFakeS3({ onRequest: (url) => seenHosts.push(new URL(url).host) });

    await uploadBackupToS3(
      { fileName: path.basename(filePath), fullPath: filePath } as never,
      { bucket: 'b' } as never,
      normalizeRuntime({
        fetchImpl,
        env: { ...S3_CREDS_ENV, AWS_REGION: 'us-west-2' },
      } as never),
    );

    expect(seenHosts.every((h) => h === 's3.us-west-2.amazonaws.com')).toBe(true);
    expect(seenHosts.some((h) => h.includes('us-east-1'))).toBe(false);
  });

  it('honors AWS_DEFAULT_REGION as a fallback', async () => {
    const cwd = makeTempDir();
    const filePath = path.join(cwd, 'sqlite-backup-20260705-150000Z.db.gz');
    fs.writeFileSync(filePath, 'payload');

    const seenHosts: string[] = [];
    const { fetchImpl } = makeFakeS3({ onRequest: (url) => seenHosts.push(new URL(url).host) });

    await uploadBackupToS3(
      { fileName: path.basename(filePath), fullPath: filePath } as never,
      { bucket: 'b' } as never,
      normalizeRuntime({
        fetchImpl,
        env: { ...S3_CREDS_ENV, AWS_DEFAULT_REGION: 'eu-central-1' },
      } as never),
    );

    expect(seenHosts.every((h) => h === 's3.eu-central-1.amazonaws.com')).toBe(true);
  });

  it('an explicit --s3-region still wins over the environment', async () => {
    const cwd = makeTempDir();
    const filePath = path.join(cwd, 'sqlite-backup-20260705-150000Z.db.gz');
    fs.writeFileSync(filePath, 'payload');

    const seenHosts: string[] = [];
    const { fetchImpl } = makeFakeS3({ onRequest: (url) => seenHosts.push(new URL(url).host) });

    await uploadBackupToS3(
      { fileName: path.basename(filePath), fullPath: filePath } as never,
      { bucket: 'b', region: 'ap-south-1' } as never,
      normalizeRuntime({
        fetchImpl,
        env: { ...S3_CREDS_ENV, AWS_REGION: 'us-west-2' },
      } as never),
    );

    expect(seenHosts.every((h) => h === 's3.ap-south-1.amazonaws.com')).toBe(true);
  });

  it('refuses with a clear error naming the env vars when S3 credentials are absent', async () => {
    const cwd = makeTempDir();
    const filePath = path.join(cwd, 'sqlite-backup-20260705-150000Z.db.gz');
    fs.writeFileSync(filePath, 'payload');

    await expect(
      uploadBackupToS3(
        { fileName: path.basename(filePath), fullPath: filePath } as never,
        { bucket: 'mybucket' } as never,
        normalizeRuntime({ fetchImpl: makeFakeS3().fetchImpl, env: {} } as never),
      ),
    ).rejects.toThrow(/AWS_ACCESS_KEY_ID.*AWS_SECRET_ACCESS_KEY/s);
  });

  it('the SYNC runBackupJob THROWS when an S3 remote is configured, naming runBackupJobAsync and the CLI, and never attempts an upload', () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.writeFileSync(path.join(cwd, 'app.db'), 'db');
    let fetchCalled = false;
    const fetchImpl = (...args: unknown[]) => {
      fetchCalled = true;
      return makeFakeS3().fetchImpl(...(args as [string, never]));
    };

    expect(() =>
      runBackupJob({
        allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir, compressSqlite: false,
        s3: { bucket: 'mybucket' } as never,
        runtime: makeRuntime({ fetchImpl, env: S3_CREDS_ENV } as never),
      }),
    ).toThrow(/runBackupJobAsync/);

    expect(() =>
      runBackupJob({
        allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir, compressSqlite: false,
        s3: { bucket: 'mybucket' } as never,
        runtime: makeRuntime({ fetchImpl, env: S3_CREDS_ENV } as never),
      }),
    ).toThrow(/db-backup.*CLI|CLI.*db-backup/i);

    // No upload attempt and no output directory created — refused before any
    // side effect, not a partial/blocked attempt.
    expect(fetchCalled).toBe(false);
    expect(fs.existsSync(outputDir)).toBe(false);
  });

  it('runBackupJobAsync uploads to S3, verifies, and a size mismatch still throws (fail-closed survives the refactor)', async () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.writeFileSync(path.join(cwd, 'app.db'), 'db');
    const { fetchImpl } = makeFakeS3();

    const result = await runBackupJobAsync({
      allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir, compressSqlite: false,
      s3: { bucket: 'mybucket' } as never,
      runtime: makeRuntime({ fetchImpl, env: S3_CREDS_ENV } as never),
    });

    expect(result.localOnly).toBe(false);
    expect(result.uploaded).not.toBeNull();
    expect((result.uploaded as any).target).toContain('mybucket');

    // Fail-closed: a HEAD that lies about size must still fail the whole job.
    const cwd2 = makeTempDir();
    const outputDir2 = path.join(cwd2, 'backups');
    fs.writeFileSync(path.join(cwd2, 'app.db'), 'db');
    const lyingFetch = (_url: string, opts: { method: string }) => {
      if (opts.method === 'PUT') return { status: 200, headers: {}, body: Buffer.alloc(0) };
      if (opts.method === 'HEAD') return { status: 200, headers: { 'content-length': '3' }, body: Buffer.alloc(0) };
      return { status: 400, headers: {}, body: Buffer.alloc(0) };
    };
    await expect(
      runBackupJobAsync({
        allowUnsafeCopy: true, cwd: cwd2, databaseUrl: 'file:./app.db', outputDir: outputDir2, compressSqlite: false,
        s3: { bucket: 'mybucket' } as never,
        runtime: makeRuntime({ fetchImpl: lyingFetch, env: S3_CREDS_ENV } as never),
      }),
    ).rejects.toThrow(/Remote size mismatch/);
  });

  it('--remote and --s3-bucket are mutually exclusive', async () => {
    await expect(
      runCli(['backup', '--remote', 'offsite:x', '--s3-bucket', 'mybucket']),
    ).rejects.toThrow(/mutually exclusive/);

    expect(() =>
      runBackupJob({ remote: { target: 'offsite:x' }, s3: { bucket: 'mybucket' } as never }),
    ).toThrow(/mutually exclusive/);
  });

  it('S3 retention keeps the newest N objects and never deletes the object just uploaded', async () => {
    const { objects, fetchImpl } = makeFakeS3();
    const runtime = makeRuntime({ fetchImpl, env: S3_CREDS_ENV } as never);
    const s3 = { bucket: 'mybucket', keep: 1 } as never;

    const dir = makeTempDir();
    for (const name of [
      'sqlite-backup-20260101-000000Z.db',
      'sqlite-backup-20260102-000000Z.db',
      'sqlite-backup-20260103-000000Z.db',
    ]) {
      const filePath = path.join(dir, name);
      fs.writeFileSync(filePath, name);
      await uploadBackupToS3({ fileName: name, fullPath: filePath } as never, s3, runtime as never);
    }

    const deleted = await pruneS3Backups(s3, 'sqlite-backup-20260103-000000Z.db', runtime as never, null, parseBackupFileName);

    expect(deleted.sort()).toEqual(['sqlite-backup-20260101-000000Z.db', 'sqlite-backup-20260102-000000Z.db']);
    expect(objects.has('sqlite-backup-20260103-000000Z.db')).toBe(true);
  });

  it('no event-loop block: an in-flight S3 upload lets a concurrent timer/microtask run', async () => {
    const cwd = makeTempDir();
    const outputDir = path.join(cwd, 'backups');
    fs.writeFileSync(path.join(cwd, 'app.db'), 'db');

    let uploadInFlight = false;
    let timerFiredWhileUploadWasInFlight = false;

    // A "slow" fetchImpl: an async function that doesn't resolve until a
    // macrotask (setTimeout) elsewhere has had a chance to run. If this
    // package blocked the event loop for the upload (the old Atomics.wait
    // design), the concurrent timer below could not fire until AFTER this
    // resolves — observing it fire while the upload is still in flight is
    // exactly what would be impossible under the old design.
    const { fetchImpl: fakeFetch } = makeFakeS3();
    const delayedFetch = async (url: string, opts: never, timeoutMs: number) => {
      uploadInFlight = true;
      await new Promise((resolve) => setTimeout(resolve, 20));
      uploadInFlight = false;
      return fakeFetch(url, opts as never);
    };

    const jobPromise = runBackupJobAsync({
      allowUnsafeCopy: true, cwd, databaseUrl: 'file:./app.db', outputDir, compressSqlite: false,
      s3: { bucket: 'mybucket' } as never,
      runtime: makeRuntime({ fetchImpl: delayedFetch, env: S3_CREDS_ENV } as never),
    });

    // Scheduled AFTER the job starts. If the event loop were blocked for the
    // ~20ms the upload is in flight, this timer could not fire until the
    // block released — so observing it fire while uploadInFlight is still
    // true proves the loop kept running concurrently with the "network" call.
    const timerPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerFiredWhileUploadWasInFlight = uploadInFlight;
        resolve();
      }, 5);
    });

    await Promise.all([jobPromise, timerPromise]);

    expect(timerFiredWhileUploadWasInFlight).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Destinations: WHERE backups go, orthogonal to retention (HOW MANY/WHICH).
  // ---------------------------------------------------------------------------
  describe('destinations model', () => {
    it('zero destinations aborts — a caller must choose at least one', () => {
      expect(() => resolveDestinations({ cwd: '/tmp', destinations: [] })).toThrow(/zero destinations/i);
    });

    it('normalizeDestination validates each destination shape', () => {
      expect(() => normalizeDestination({ type: 'bogus' }, '/tmp')).toThrow(/type/);
      expect(() => normalizeDestination({ type: 'local' }, '/tmp')).toThrow(/path/);
      expect(() => normalizeDestination({ type: 's3' }, '/tmp')).toThrow(/bucket/);
      expect(() => normalizeDestination({ type: 'rclone' }, '/tmp')).toThrow(/target/);
      expect(normalizeDestination({ type: 'local', path: 'backups' }, '/tmp')).toEqual({
        type: 'local',
        path: '/tmp/backups',
      });
    });

    it('destinations mixed with legacy remote/s3/skipRemote options is an ERROR', () => {
      expect(() =>
        resolveDestinations({ cwd: '/tmp', destinations: [{ type: 'local', path: 'x' }], skipRemote: true }),
      ).toThrow(/cannot be combined/);
      expect(() =>
        resolveDestinations({
          cwd: '/tmp',
          destinations: [{ type: 'local', path: 'x' }],
          remote: { target: 'r:x' },
        }),
      ).toThrow(/cannot be combined/);
    });

    it('legacy remote/s3/skipRemote map onto the same destinations shape (local always included, back-compat)', () => {
      const legacy = resolveDestinations({ cwd: '/tmp', outputDir: 'backups', remote: { target: 'r2:x' } });
      expect(legacy.destinations).toEqual([
        { type: 'local', path: '/tmp/backups' },
        { type: 'rclone', target: 'r2:x', verify: true },
      ]);
      expect(legacy.localOnly).toBe(false);

      const localOnly = resolveDestinations({ cwd: '/tmp', outputDir: 'backups', skipRemote: true });
      expect(localOnly.destinations).toEqual([{ type: 'local', path: '/tmp/backups' }]);
      expect(localOnly.localOnly).toBe(true);
    });

    it('a legacy call with no remote/s3/skipRemote only aborts when the caller requires offsite (runBackupJob), not for restore/list/prune', () => {
      // requireOffsite defaults false — resolveDestinations itself must not
      // block restore/list/prune, which never call it with requireOffsite.
      expect(() => resolveDestinations({ cwd: '/tmp', outputDir: 'backups' })).not.toThrow();
      expect(() =>
        resolveDestinations({ cwd: '/tmp', outputDir: 'backups', requireOffsite: true }),
      ).toThrow(/Refusing to create a local-only backup/);
    });

    it('s3-only (no local destination) works end-to-end and never leaves a local copy behind', async () => {
      const cwd = makeTempDir();
      fs.writeFileSync(path.join(cwd, 'app.db'), 'db');
      const { objects, fetchImpl } = makeFakeS3();
      const stagingDir = path.join(cwd, 'staging');

      const result = await runBackupJobAsync({
        allowUnsafeCopy: true,
        cwd,
        databaseUrl: 'file:./app.db',
        compressSqlite: false,
        outputDir: stagingDir, // legacy field ignored when destinations is set; used as internal scratch fallback only
        destinations: [{ type: 's3', bucket: 'mybucket' }],
        runtime: makeRuntime({ fetchImpl, env: S3_CREDS_ENV } as never),
      });

      expect(result.uploaded).not.toBeNull();
      expect(objects.size).toBe(1);
      // No local destination was configured: the staged file must be removed,
      // not left behind as a silent, untracked local copy.
      expect(fs.existsSync(result.created.fullPath)).toBe(false);
    });

    it('local+s3 both prune to the SAME GFS plan — identical kept/pruned sets at both destinations', async () => {
      const cwd = makeTempDir();
      fs.writeFileSync(path.join(cwd, 'app.db'), 'db');
      const outputDir = path.join(cwd, 'backups');
      fs.mkdirSync(outputDir, { recursive: true });

      // Pre-seed IDENTICAL backup sets locally and "remotely" (same filenames):
      // one newer-than-a-week, one at ~40 days (should rotate out under a
      // daily:1 policy), one at ~1 day (kept — within the daily slot... use a
      // clean scenario: daily:1 keeps only the single newest).
      const names = [
        'sqlite-backup-20260701-000000Z.db', // ~4 days old
        'sqlite-backup-20260625-000000Z.db', // ~10 days old
        'sqlite-backup-20260601-000000Z.db', // ~34 days old
      ];
      for (const name of names) {
        fs.writeFileSync(path.join(outputDir, name), 'old backup bytes');
      }
      const objects = new Map<string, Buffer>(names.map((n) => [n, Buffer.from('old backup bytes')]));
      const { fetchImpl } = makeFakeS3({ objects });

      const result = await runBackupJobAsync({
        allowUnsafeCopy: true,
        cwd,
        databaseUrl: 'file:./app.db',
        compressSqlite: false,
        now: fixedNow,
        destinations: [
          { type: 'local', path: outputDir },
          { type: 's3', bucket: 'mybucket' },
        ],
        policy: { mode: 'gfs', daily: 1 }, // keep only the single newest
        runtime: makeRuntime({ now: () => fixedNow, fetchImpl, env: S3_CREDS_ENV } as never),
      });

      // Locally: the 3 pre-seeded old backups all rotate out (daily:1 keeps
      // only the just-created backup).
      expect(result.removed.map((e) => e.fileName).sort()).toEqual(names.slice().sort());
      // Remotely: the SAME 3 filenames rotate out — one unified plan, not two.
      const s3Result = result.destinationResults.find((d) => d.destination.type === 's3');
      expect(s3Result?.removed.slice().sort()).toEqual(names.slice().sort());
    });

    it('mixing legacy location flags with the new destinations model is rejected by resolveBackupOptions too', () => {
      expect(() =>
        runBackupJob({
          destinations: [{ type: 'local', path: '/tmp/x' }],
          remote: { target: 'r2:x' },
          databaseUrl: 'file:./app.db',
          requireDatabaseUrl: false,
        }),
      ).toThrow(/cannot be combined/);
    });
  });

  describe('CLI: --dest, --retain-*, --retention-policy, --dry-run', () => {
    it('CLI --retain-daily + --keep-last together is an ERROR', async () => {
      await expect(
        runCli(['backup', '--retain-daily', '5', '--keep-last', '3', '--skip-remote']),
      ).rejects.toThrow(/cannot be combined/);
    });

    it('CLI --dest combined with --remote is an ERROR', async () => {
      await expect(
        runCli(['backup', '--dest', 'local:/tmp/x', '--remote', 'r2:backups']),
      ).rejects.toThrow(/cannot be combined/);
    });

    it('--dry-run (prune) prints the plan with a reason per survivor and deletes NOTHING', async () => {
      const cwd = makeTempDir();
      const outputDir = path.join(cwd, 'backups');
      fs.mkdirSync(outputDir, { recursive: true });
      const files = [
        'sqlite-backup-20260705-150000Z.db',
        'sqlite-backup-20260704-150000Z.db',
        'sqlite-backup-20260703-150000Z.db',
      ];
      for (const name of files) fs.writeFileSync(path.join(outputDir, name), 'sqlite');

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (message?: unknown) => {
        logs.push(String(message));
      };
      try {
        await runCli(['prune', '--dry-run', '--output-dir', outputDir, '--keep-last', '1']);
      } finally {
        console.log = originalLog;
      }

      expect(logs.some((l) => /DRY RUN/.test(l))).toBe(true);
      expect(logs.some((l) => /KEEP.*20260705/.test(l))).toBe(true);
      expect(logs.some((l) => /DELETE.*20260704/.test(l))).toBe(true);
      // Nothing was actually deleted.
      expect(fs.readdirSync(outputDir).sort()).toEqual(files.slice().sort());
    });

    it('--dry-run reports the reason for each survivor (keep_last here) rather than a bare KEEP', () => {
      const cwd = makeTempDir();
      const outputDir = path.join(cwd, 'backups');
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, 'sqlite-backup-20260705-150000Z.db'), 'x');

      const result = listBackupsWithPlan({
        cwd,
        outputDir,
        requireDatabaseUrl: false,
        policy: { mode: 'keep-last', keepLast: 1 },
      });

      expect(result.backups[0].retentionReason).toBe('keep_last');
    });
  });
});
