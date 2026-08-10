---
kind: breaking
summary: PostgreSQL backups now require pg_restore to validate the dump before keeping it
---

`createPostgresBackup` used to silently accept and rotate an unverified
`pg_dump` archive whenever `pg_restore` was not installed — the only
consequence was a comment, never an error or a marked result. `pg_restore
--list` validation (mirroring the SQLite `PRAGMA integrity_check`) is now
**required**: if `pg_restore` is unavailable, the run throws naming the
missing binary and what to install, and the dump is deleted rather than kept.
Pass `allowUnverifiedPostgresBackup` (CLI: `--allow-unverified-postgres-backup`)
to explicitly accept an unverified dump — the opt-out is then surfaced on the
result as `BackupEntry.verified: false`, not only in config. Impact: none for
hosts with `pg_restore` installed (the common case); a pg_dump-only host must
either install `pg_restore` or opt in explicitly.
