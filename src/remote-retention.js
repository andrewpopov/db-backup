'use strict';

// Flat-count remote retention shared by the rclone and S3 prune paths.
// `entries` are `{ fileName, createdAt }` for this job's own parseable backups.
// The protected (just-uploaded, verified) object always stays and counts as 1
// of `keep`; the newest `keep - 1` others stay; the rest are returned to delete.
function planFlatRemoteRetention(entries, protectFileName, keep) {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`keep must be an integer >= 1 (got ${JSON.stringify(keep)})`);
  }
  const keepTotal = keep;
  return entries
    .filter((entry) => entry.fileName !== protectFileName)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.fileName.localeCompare(a.fileName))
    .slice(keepTotal - 1)
    .map((entry) => entry.fileName);
}

module.exports = { planFlatRemoteRetention };
