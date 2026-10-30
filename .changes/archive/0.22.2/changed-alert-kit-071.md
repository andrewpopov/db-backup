---
kind: changed
summary: Depends on alert-kit v0.7.1, so installing db-backup no longer starts a nested npm install
---

alert-kit v0.6.1 still declared a build script, which made npm run a nested install in every consumer of db-backup. v0.7.1 does not.
