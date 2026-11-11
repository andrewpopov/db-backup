---
kind: fixed
summary: `install-schedule --replace-line` ignores matches inside the app's own block and inside blocks being replaced
---

In 0.23.0 a `--replace-line` substring that also appears in the new block's own command (the usual case: the migrated command is the same command) refused on the second deploy with "matches a line inside block db-backup:<name>", so the flag could not stay in a deploy hook. Those matches are now skipped; a match inside any other marked block still refuses.
