---
kind: added
summary: db-backup fetch downloads the newest or a named backup from the Drime store so restore drills restore the primary copy
---

`db-backup fetch --from drime:<set> (--latest | --file <name>) --output <dir>` downloads one backup through the same hermetic crypt context as the destination, read-only, and prints its absolute path alone on stdout (`--json` prints `{file, size, set}`). `--latest` picks the newest by the filename timestamp retention uses; an ambiguous listing refuses, the size is checked against the listing (a partial file is deleted), nothing is written outside `--output`, and listing and download retry like the audit reads. Library: `fetchFromDrime`.
