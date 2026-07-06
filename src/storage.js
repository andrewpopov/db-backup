'use strict';

// Backup-storage helpers generalized from stoki/pantry's admin backup subsystem
// (BWK-85): resolve a set of candidate backup directories, safely contain a
// user-supplied restore path, and track backups in a per-directory manifest.
//
// Everything here is policy-free: the caller supplies the candidate directory
// list and env var name, so bewks/sano/pantry each keep their own directory
// policy while sharing the mechanism.

const fs = require('fs');
const path = require('path');

const MANIFEST_FILENAME = 'backup-manifest.json';

// Expand a leading `~/` against HOME, otherwise resolve to an absolute path.
function expandHome(dir, home = process.env.HOME) {
  if (typeof dir !== 'string') {
    throw new TypeError('expandHome expects a string path');
  }
  if (dir.startsWith('~/') && home) {
    return path.resolve(home, dir.slice(2));
  }
  return path.resolve(dir);
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function uniquePaths(values) {
  return Array.from(
    new Set(values.filter((value) => typeof value === 'string' && value.trim().length > 0)),
  );
}

// Merge directories from a CSV env var (default `BACKUP_DIRS`) with a caller-
// supplied candidate list, expand `~/`, and de-duplicate. Order is env-first.
function resolveBackupDirectories({
  env = process.env,
  envVar = 'BACKUP_DIRS',
  candidates = [],
  home = process.env.HOME,
} = {}) {
  const envDirectories = splitCsv(env[envVar]).map((dir) => expandHome(dir, home));
  const candidateList = (typeof candidates === 'function' ? candidates() : candidates) || [];
  const candidateDirectories = candidateList
    .filter((dir) => typeof dir === 'string' && dir.trim().length > 0)
    .map((dir) => expandHome(dir, home));
  return uniquePaths([...envDirectories, ...candidateDirectories]);
}

// Default write target when no configured directory exists yet.
function getBackupFallbackDirectory({ cwd = process.cwd() } = {}) {
  return path.resolve(cwd, 'backups');
}

function isContainedWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// Resolve a user-supplied backup path and confirm it sits inside one of the
// allowed directories. Returns the resolved absolute path, or null if it
// escapes every allowed directory (traversal / arbitrary-file access). A
// restore overwrites the live database, so callers MUST gate on this.
function resolveContainedBackupPath(candidate, { directories = [], home = process.env.HOME } = {}) {
  const resolved = expandHome(candidate, home);
  for (const directory of uniquePaths(directories)) {
    if (isContainedWithin(directory, resolved)) {
      return resolved;
    }
  }
  return null;
}

function readBackupManifest(directory) {
  const manifestPath = path.join(directory, MANIFEST_FILENAME);
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) {
      return parsed;
    }
  } catch {
    // Missing or invalid manifest — treat as empty.
  }
  return { version: 1, entries: [] };
}

function appendBackupManifestEntry(directory, entry) {
  const manifest = readBackupManifest(directory);
  manifest.entries.push(entry);
  fs.writeFileSync(
    path.join(directory, MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return manifest;
}

module.exports = {
  MANIFEST_FILENAME,
  expandHome,
  isContainedWithin,
  resolveBackupDirectories,
  getBackupFallbackDirectory,
  resolveContainedBackupPath,
  readBackupManifest,
  appendBackupManifestEntry,
};
