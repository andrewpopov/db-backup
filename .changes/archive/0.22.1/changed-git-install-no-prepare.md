---
kind: changed
summary: Installing from git no longer runs a full dependency install: the `prepare` script is gone (run `npm run hooks` once after cloning)
---

Git installs of this package no longer trigger a nested `npm install`; local development needs `npm run hooks` once after cloning to enable the pre-push gate.
