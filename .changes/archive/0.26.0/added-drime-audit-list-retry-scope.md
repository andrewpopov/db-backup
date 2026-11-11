---
kind: added
summary: drime-audit retries every listing and takes --path <set> to audit only chosen sets
---

Every audit read (the top-level, raw and crypt listings, the re-list stat and the name decode) now shares the header read's retry: up to 3 attempts with a 1 s then 3 s backoff, never for not-found, an over-limit listing, a name that does not decrypt or a malformed credential. After the last attempt the audit exits 2 with the same fixed-string error plus the attempt count.

`drime-audit --path <set>` (repeatable) audits only those decrypted top-level sets inside the crypt root. Each set is mapped to its encrypted directory through the crypt remote, and the raw listing, crypt listing, header reads and closing passes are limited to those directories, so a quiet set gets a verdict independent of a busy mirror beside it. The top-level namespace check still runs in full, an unknown set exits 2, a set name must be one safe path component, the summary line names the scope and `--json` carries `scope`.
