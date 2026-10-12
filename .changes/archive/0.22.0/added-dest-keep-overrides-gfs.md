---
kind: added
summary: A remote destination's `keep` now overrides the shared GFS plan, and `keep: N` leaves exactly N objects
---

A rclone or S3 destination with an explicit `keep` (or `--remote-keep`) retains only its own newest N objects while local keeps the full GFS history, e.g. offsite `keep: 1`. `keep` must be an integer >= 1. The just-uploaded verified object counts as one of the N, so rclone `keep: N` now leaves N objects in total instead of N+1. A remote with `verify: false` is no longer pruned, and an invalid flat count passed to the prune functions deletes nothing.
