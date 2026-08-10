---
kind: fixed
summary: pruneS3Backups now works with just the 3 documented arguments
---

`src/index.d.ts` documented `namePrefix` and `parseBackupFileNameFn` as
optional on the exported `pruneS3Backups`, so `pruneS3Backups(s3,
protectFileName, runtime)` was legal TypeScript — but the omitted parser
parameter was called as a function and threw before any pruning happened.
`pruneS3Backups` now defaults `parseBackupFileNameFn` to the package's own
`parseBackupFileName` (required lazily, at call time, to avoid a circular
require with index.js) and `namePrefix` to `null`, so the documented 3-arg
call actually works. The parameter was also renamed from `parseBackupFileName`
to `parseBackupFileNameFn` so it no longer shadows the function it defaults
to. Every existing 5+-arg call site (internal and test) is unaffected.
