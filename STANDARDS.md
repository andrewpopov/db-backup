# Shared Package Standards

> **Canonical source:** `agent_tools/knowledge/shared-package-standards.md`.
> This file is a synced copy; change the canonical doc first.

Reference for every `andrewpopov/*` package consumed across bewks, stoki,
smarthome, sano-os, and kira (Kira epic BWK-84 / BWK-92). The pilot is
`prisma-tools`; this repo follows the same standard (its `.github/workflows/ci.yml`
and `scripts/verify-pack.mjs` are copied from the pilot with the require-smoke
adjusted).

## Distribution

- Install via git tag: `npm install github:andrewpopov/<pkg>#vX.Y.Z`.
  No npm org, no registry.
- **One package per repo.** The `github:` protocol installs the repo root.
- **Consumers pin a tag**, never a branch or a bare SHA. Upgrading a consumer =
  bump the tag in its `package.json` and reinstall.
- Standalone repo is the **source of truth**. No vendored copies in app repos;
  delete them when the app switches to the `github:` dependency.
- Keep runtime dependencies near zero (dotenv-class only). No framework deps in
  engine packages.

## Source & build

Two shapes, both valid:

1. **Trivial glue (this repo):** plain JS + a hand-written `index.d.ts`. No
   build step, no `dist/`. `main`/`types`/`bin` point at `src/`. Do not retrofit
   TypeScript onto a package this small.
2. **Non-trivial packages:** TypeScript source compiled with `tsc` to a
   **committed** `dist/`. `main`/`types` point at `dist/`. Committing the build
   output means `github:` installs need no install-time build (no `prepare`
   script, no consumer-side compile). CI guarantees the committed `dist/` is not
   stale (see below).

## Versioning & tags

- Semver. Bump `package.json` `version` and add a `CHANGELOG.md` entry in the
  same commit that you tag.
- **Tags are immutable.** Never move or delete a published tag — a moved tag
  silently poisons consumer lockfiles that resolved it. Fix forward with a new
  patch tag.
- Tag format `vX.Y.Z` (matches the `#vX.Y.Z` install ref).

## Branch protection (required on every repo)

`master` is protected so nothing lands without a PR whose CI is green. Apply to
each new package repo immediately after creating it:

```sh
gh api -X PUT repos/andrewpopov/<pkg>/branches/master/protection \
  -H "Accept: application/vnd.github+json" --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["test"] },
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

- `enforce_admins: true` — the owner goes through PRs too; no direct pushes to
  `master`.
- `required_approving_review_count: 0` — a solo owner can't approve their own PR,
  so requiring ≥1 would deadlock. The gate is "PR + green CI + owner clicks
  merge." If a second reviewer or a review bot is ever added, raise this to 1.

## CI (required before tagging)

`.github/workflows/ci.yml` runs on every PR and on `master`:

1. `npm ci`
2. `npm test` — unit tests.
3. **`npm run verify:pack`** — packs the tarball, installs it into a throwaway
   project, and requires it as a consumer would. Catches missing `files`, broken
   `main`/`types`/`bin`, and deps that only resolve inside the source tree.
4. **TS packages only:** `npm run build` then fail on a dirty `git diff --
   dist/`. This is what keeps the committed `dist/` honest against the TS source.

Never tag a commit whose CI is not green.

## Release checklist

`master` is protected (no direct pushes), so the version bump rides along in the
change PR — not a separate post-merge commit.

1. In the change PR, include the `version` bump + `CHANGELOG.md` entry.
2. Merge when CI is green.
3. `git tag vX.Y.Z <merge commit> && git push origin vX.Y.Z`. The tag-triggered
   `release-guard` CI job asserts the tag equals `package.json` version and has a
   CHANGELOG entry — if they drift, the tag build goes red. Tags are immutable;
   if a tag is wrong, cut the next patch tag rather than moving it.
4. In each consuming app: bump the `#vX.Y.Z` ref, reinstall, run the app's
   affected flow (see the app's adoption ticket), note the version in the app
   CHANGELOG.

## The Pi deploy failure mode

`npm ci` on the Raspberry Pi now reaches GitHub to resolve `github:` deps at
deploy time. `deploy-kit` (BWK-86) must prefer lockfile/offline-cache installs
and degrade gracefully when GitHub is unreachable, so a GitHub outage cannot
break a deploy that changes no dependencies.

## Engineering standards

Reliability properties a package must hold before any consumer is migrated onto
it. Each was learned from a real defect; `db-backup` is the reference
implementation.

1. **Be a superset of every consumer's copy.** Audit what a hand-rolled
   implementation does *better* before deleting it, and fold it in. Pin it with a
   regression test you have verified *fails* against the unpatched package.
2. **Expose the seam consumers need.** Ship engine primitives, not only an
   opinionated job wrapper. A consumer that needs different naming, its own
   manifest, or no pruning side-effect will otherwise reimplement the engine
   beside your import.
3. **Bound every external command with a timeout.** No `execFileSync` /
   `execSync` / `spawnSync` without one. Expose it as config with a sane default.
4. **Destructive operations are atomic.** Write to a temp path, verify it there,
   then rename into place. Verify the thing you will actually end up with.
5. **Verify before you keep, and fail loud.** Never produce a silently-incomplete
   artifact. A success message and a green integrity check are not proof.
6. **SQLite is not one file.** Never copy, move, replace, or delete a `.db`
   without deciding what happens to `-wal`, `-shm`, and `-journal`. Snapshot with
   the online backup API, never `cp`. Escape quotes in dot-command paths. Retry
   on `database is locked`.
7. **Removing a config key is a breaking change.** Strict validation fails closed,
   so a deleted key hard-throws in every consumer that still sets it. Requires a
   major bump and a sweep of every consumer's config in the same change.
8. **Types are a contract, and the contract is tested.** Exercise `index.d.ts`
   from a consumer-shaped file in CI. Model exclusive shapes as discriminated
   unions. Never let an overload promise a narrow return the runtime cannot
   guarantee. Pin unsoundness with a load-bearing `@ts-expect-error`.
9. **Uniform script names:** `test`, `verify:pack`, `verify:types` (+ `build` for
   TS packages).
