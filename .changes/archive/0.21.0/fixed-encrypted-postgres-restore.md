---
kind: fixed
summary: restore now decrypts an encrypted PostgreSQL backup before running pg_restore
---

An encrypted PostgreSQL backup could not be restored: `createBackup` applied
GPG encryption to Postgres dumps, but `restorePostgresBackup` handed the
`.dump.gpg` ciphertext straight to `pg_restore`, which cannot parse it.
`decryptBackupToPath` (already used by the SQLite restore path) had exactly
one call site — the Postgres path never called it at all, and the dispatcher
never threaded `encryption` through to it either. Restore now decrypts an
encrypted Postgres backup to a private scratch file before invoking
`pg_restore`, mirroring the SQLite path; an unencrypted backup is unaffected.
