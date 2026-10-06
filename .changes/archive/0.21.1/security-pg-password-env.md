---
kind: security
summary: pg_dump and pg_restore no longer receive the Postgres password on the command line
---

`createPostgresBackup` and `restorePostgresBackup` passed the full `DATABASE_URL`,
password included, as an argv element, so any local user could read it with `ps`.
The password is now moved into `PGPASSWORD` in the child's environment (merged over
the runtime env) and removed from the URL; the username stays. Prisma-only query
params libpq rejects as "invalid URI query parameter" (`connection_limit`,
`pool_timeout`, `socket_timeout`, `sslaccept`, `pgbouncer`, `statement_cache_size`,
`schema`) are dropped; libpq params such as `sslmode` are kept.
