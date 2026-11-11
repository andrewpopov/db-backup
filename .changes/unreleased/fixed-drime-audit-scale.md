---
kind: fixed
summary: drime-audit checks object headers in a bounded pool and survives a store that changes underneath it
---

The header check reads up to 8 objects at once (`--concurrency <n>`, 1 to 64) instead of one rclone process per object in turn, so a 10k-object store audits in minutes. An object that vanishes or is replaced between the listing and its read is re-listed: a gone object is reported as changed-during-audit (counted in the summary line, not a finding), a replacement is read once more, and more than `--max-changed <n>` (default 50) changes exits 2. Header-read errors now name the raw path. A closing re-listing, repeated until stable, also checks objects that appeared or were replaced after the first listing; a store that never settles exits 2.
