---
kind: changed
summary: Manage releases with release-kit (fragment-based CHANGELOG + version bump)
---

Releases are now driven by release-kit: describe each change as a fragment
under `.changes/unreleased/` and run `npm run release:cut` to compile them
into a new CHANGELOG section, bump the version, and archive the fragments.
