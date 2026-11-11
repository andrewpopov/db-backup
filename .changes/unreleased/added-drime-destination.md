---
kind: added
summary: An encrypted `drime` destination and `db-backup drime-audit`, and generic rclone destinations now refuse Drime and wrapper remotes
---

A `drime` destination (`--dest drime:<path>`) stores every backup in Drime through an rclone crypt layer that db-backup builds itself from a credentials env file, with a hermetic rclone environment, a 5 GB `maxBytes` cap that fails the run when exceeded, and `keep` defaulting to 10. `db-backup drime-audit` checks the store holds only the crypt root, that names decrypt, and that every object carries the rclone crypt header. A generic `rclone` destination now refuses (before any copy) a Drime remote, a wrapper remote (alias, union, combine, chunker, hasher, compress, crypt, cache), an inline connection-string target, or one whose type cannot be resolved, so nothing can reach Drime unencrypted.
