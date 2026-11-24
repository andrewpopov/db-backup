---
kind: fixed
summary: A transient Drime upload failure is retried instead of failing the whole backup run
---

A Drime `copyto` that fails is now retried up to 3 attempts with a 30 s then 2 min backoff, and only while the time spent plus the next wait stays within half of `commandTimeoutSeconds`. Auth or config errors, crypt errors, quota errors, a missing path, an over-limit buffer and rclone's usage, fatal and max-transfer exits are never retried. An upload that succeeds on a retry is a normal success: it is verified, pruned and stamped as usual.

When the last attempt fails the log reads `upload to drime:<set> failed after 3 attempts (network)`, where the class is one of `auth`, `network`, `quota`, `timeout`, `crypt` or `unknown`. The class is decided inside the module from the exit status and stderr; stderr is still never logged or attached to the error, which now reads `rclone copyto failed (exit 1) after 3 attempt(s) (network)`.
