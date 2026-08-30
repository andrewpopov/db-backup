---
kind: fixed
summary: additional local destinations are now actually replicated to, not silently dropped
---

A config listing two or more `local` destinations silently backed up to only
the first: `resolveBackupOptions` picked the FIRST `local` entry as the
staging/output directory, and both job paths (`runBackupJob` and
`runBackupJobAsync`) filtered `destinations` down to `dest.type !== 'local'`
before distributing, so every `local` destination after the first was never
written to, never retained, and never manifested — the run still reported
success. Every `local` destination is now a real replication target: the
first stays the staging directory the artifact is created in, and each one
after that is copied to and verified by sha256 before anything is pruned or
stamped, exactly like a remote upload — a copy that can't be written, or
that doesn't checksum-match, fails the whole run and leaves every
destination's previous backups and the stamp untouched. Retention and the
manifest are then applied independently at every local destination. The
back-compat top-level `removed`/`kept` still describe the primary (staging)
destination only; every additional local destination's upload and prune
result now appears in `destinationResults`, alongside remote destinations.
