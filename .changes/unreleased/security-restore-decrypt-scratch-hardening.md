---
kind: security
summary: restore's decrypt-to-temp scratch directory is now created via mkdtemp, closing a symlink-plant window
---

Both restore paths used to decrypt an encrypted backup to a filename built
from `runtime.randomId()` — not cryptographically random, and merely computed
rather than exclusively created. A file or symlink pre-planted at that
predictable path before a restore ran would be reused: `gpg --yes` writes
through a symlink, so the decrypted plaintext could land wherever the symlink
pointed, outside the backup directory entirely. Both paths now decrypt into a
directory created with `fs.mkdtempSync` — exclusively created, unpredictably
named, and `0700` by construction — via one shared helper instead of two
divergent implementations. Cleanup of that directory can itself fail (a
permissions or filesystem error); that is now handled without masking the
real outcome: a cleanup failure after a successful restore is logged, not
thrown, and a cleanup failure after a failed restore never replaces the
original error. The SQLite path's scratch directory is created next to the
live database (guaranteed writable), not next to the backup artifact (which
may sit on a read-only mount); the Postgres path, which has no local live-DB
file to anchor to, keeps using the backup artifact's own directory.
