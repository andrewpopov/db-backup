---
kind: fixed
summary: drime-audit retries a failed object header read instead of failing the audit on one transient error
---

A header read that fails with an exit other than not-found is retried up to 3 attempts with a 1 s then 3 s backoff before the audit exits 2 (the error now names the attempt count). A read that returns bytes is never retried, so a wrong header is still a finding on the first read.
