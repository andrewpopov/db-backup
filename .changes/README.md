# Changelog fragments

This package manages its `CHANGELOG.md` with
[`release-kit`](https://github.com/andrewpopov/release-kit) using a
fragment-based flow instead of hand-editing the changelog directly.

## Convention

Each user-facing change gets its own markdown fragment under
`.changes/unreleased/<kind>-<slug>.md`, with front-matter and a short body:

```markdown
---
kind: changed
summary: One-line, user-facing summary of the change
---

A short paragraph describing the change in more detail. This becomes the
bullet body under the compiled CHANGELOG entry.
```

`kind` must be one of the kinds declared in `release-kit.config.js`:
`breaking`, `added`, `changed`, `fixed`, `security`. The kind controls bullet
ordering within a release (this package's CHANGELOG is flat, not grouped by
heading).

## Workflow

- **Add a fragment for your change:** `npm run release:note -- --kind fixed --slug short-slug --summary "User-facing summary"`
  scaffolds a fragment under `.changes/unreleased/` for you to fill in (or
  write one by hand following the format above).
- **Cut a release:** `npm run release:cut` compiles every fragment in
  `.changes/unreleased/` into a new `## <version>` section at the top of
  `CHANGELOG.md`, bumps the version in `package.json`, and archives the
  consumed fragments under `.changes/archive/` (kept, not deleted, for
  provenance).
- **Check hygiene:** `npm run release:hygiene -- --base origin/master` verifies
  that a change touching `src/` (or other relevant paths) shipped with a
  fragment, so nothing merges without a changelog entry.

See `RELEASING.md` at the repo root for the full release process.
