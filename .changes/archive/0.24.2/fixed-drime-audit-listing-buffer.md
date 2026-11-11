---
kind: fixed
summary: drime-audit no longer fails on stores whose listing exceeds 1 MiB
---

The audit's recursive JSON listings run with a 256 MiB output bound instead of Node's 1 MiB default. A listing past the bound exits 2 with an explicit cannot-audit message rather than parsing truncated output.
