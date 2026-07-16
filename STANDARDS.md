# Shared package standards

*Canonical standard for every `andrewpopov/*` package under `~/proj/packages/`. Each package repo carries a `STANDARDS.md` that must match this file — this is the source of truth; the per-repo copies are synchronized from it. Every engineering rule below cites the real defect that motivated it.*

The governing rule: **a shared package must be a superset of the best implementation across all of its consumers.** Consolidation is only a win if the shared version is more feature-rich and more reliable than the hand-rolled copy it replaces. See [`shared-packages-extraction.md`](shared-packages-extraction.md) for where the boundaries go and why.

### Who these packages are for — and who they are NOT for

Every `andrewpopov/*` package under `~/proj/packages/` is **Node/TypeScript**, consumed via a `github:` dependency. A repo that cannot `npm install` is **not a consumer and is not an adoption target**.

**`fidash` is EXCLUDED. It is Python / FastAPI and will never adopt these kits.** Do not put it on an adoption list, do not open "adopt <kit> in fidash" tickets, and do not treat it as a gap that a kit bump could close. fidash's security work — SSRF validation, rate limiting, client-IP resolution, admin guards — is implemented **natively in Python and stays there**. `zirkbot` (no HTTP server) and `budget` are likewise not HTTP-kit consumers; check `shared-packages-extraction.md` for the current stack table before assuming any repo is a target.

**But excluded ≠ ignored.** fidash is still a legitimate *source* of design to port INTO a kit — its rate limiting and boot-time security preflight were the fleet's best when audited, and a Python implementation can still be the best implementation the superset rule points at. The direction is one-way: **read fidash, copy the idea into the kit, in the kit's own language.** Never the reverse.

Two corollaries, both learned the hard way (2026-07-13):
- **A cross-language comparison is not an adoption blocker.** An audit repeatedly flagged "the kit is worse than fidash" as if it blocked adoption. It never could — fidash cannot import a Node package. The finding was still *useful* (it named a real kit gap), but the recommended action was wrong.
- **Excluded repos still get fixed, in their own language.** fidash held the fleet's only live leftmost-XFF bug. The fix was a Python change to `security/network.py`, made *at the same time as* porting the correct precedence into `express-security-kit` — one idea, two implementations, because there is no other option.

---

## Part 1 — Packaging (unchanged, previously in each repo's STANDARDS.md)

### Distribution

- Install via git tag: `npm install github:andrewpopov/<pkg>#vX.Y.Z`. No npm org, no registry.
- **One package per repo.** The `github:` protocol installs the repo root.
- **Consumers pin a tag**, never a branch or a bare SHA.
- **Upgrading a consumer is NOT "bump the tag and reinstall."** `npm install` does not re-resolve a `github:` dependency when only the `#tag` changes — npm treats the commit recorded in the lockfile as already satisfying the spec, exits 0, and leaves the old version installed. Run **`npm update <pkg>`** (or `npm install <name>@<spec>`), then **verify the installed version** rather than trusting the exit code:

  ```bash
  npm update @andrewpopov/db-backup
  node -p "require('@andrewpopov/db-backup/package.json').version"   # must match the tag
  ```
- The standalone repo is the **source of truth**. No vendored copies in app repos; delete them when the app switches to the `github:` dependency.
- Keep runtime dependencies near zero (dotenv-class only). No framework deps in engine packages — frameworks are `peerDependencies`.

### Source & build

Two shapes, both valid:

1. **Trivial glue:** plain JS + a hand-written `index.d.ts`. No build step, no `dist/`. `main`/`types`/`bin` point at `src/`.
2. **Non-trivial packages:** TypeScript compiled with `tsc` to a **committed** `dist/`. `main`/`types` point at `dist/`. Committing build output means `github:` installs need no install-time build. CI guarantees the committed `dist/` is not stale.

### Versioning & tags

- Semver. Bump `package.json` `version` and add a `CHANGELOG.md` entry **in the same commit that you tag**.
- **Tags are immutable.** Never move or delete a published tag — a moved tag silently poisons consumer lockfiles that resolved it. Fix forward with a new patch tag.
- Tag format `vX.Y.Z` (matches the `#vX.Y.Z` install ref).

### Branch protection, local verification, release checklist

The default branch is protected: PR + owner merge, `enforce_admins: true`, and
`required_approving_review_count: 0` (a solo owner cannot approve their own
PR). External status checks are intentionally not required: this fleet uses
local verification as the release authority.

Before opening or merging a PR, run the package's authoritative local gate:
type check (where applicable), tests, build, `verify:pack` (packs the tarball
and installs it into a throwaway consumer), and an audit when that package
defines one. Record the exact commands and results in the PR. If optional CI is
enabled later, it is corroborating evidence, not a substitute for local proof.

Release: version bump rides in the change PR → run the local release gate →
merge → `git tag vX.Y.Z <merge commit> && git push origin vX.Y.Z` → in each
consuming app, bump the `#vX.Y.Z` ref, run `npm update <pkg>`, **verify the
installed version**, then run the app's affected flow.

### A manifest that disagrees with its lockfile is a bug

The code that runs is the lockfile's. A `package.json` naming a newer tag is documentation nobody checks, and it hides real defects.

> **Why:** `bewks` pinned `db-backup#v0.5.0` with **0.4.1** installed. `cairn`, `smarthome`, and `savoro` all pin `deploy-kit#v0.5.0` while their lockfiles resolve **0.3.1** — none has ever installed what it claims. Someone bumped the manifest, ran `npm install`, saw no error, and shipped. It is also why PTRY-226 stayed latent: savoro's config uses a key that was removed in the version it *claims* to pin but never installed, so the breakage waits for the next dependency refresh.

Audit it: compare each consumer's manifest spec against `package-lock.json`, and against `node_modules/<pkg>/package.json` — all three can disagree.

#### Why it keeps happening: editing the tag and running `npm install` does nothing

This is the root cause of the drift above, and it is not obvious.

**A `#vX.Y.Z` tag bump on a `github:` dep does NOT re-resolve.** npm honours the **lockfile's pinned commit**, exits **0**, prints `up to date`, and silently keeps the old version. `rm -rf node_modules/<pkg> && npm install` does not fix it either — the lockfile still pins the old commit.

The **only** thing that re-resolves:

```bash
npm install "github:andrewpopov/<pkg>#vX.Y.Z" --workspace packages/api   # explicit spec
```

Then **verify the installed version, never the manifest**:

```bash
node -e "console.log(require('./node_modules/@andrewpopov/<pkg>/package.json').version)"
grep -oE "<pkg>.git#[a-f0-9]{7}" package-lock.json | head -1
```

> **Why:** during the 2026-07-10 fleet migration this trap fired in **five separate repos**. In two of them the manifest read `v1.2.1` while the installed package was still **v1.0.0** — so "I bumped it and the tests passed" was a *true statement about the wrong code*. One migration nearly shipped a "v0.1.1 SSRF fix" that was still running the vulnerable v0.1.0.
>
> Note for annotated tags: `git rev-parse v0.8.2` returns the **tag object**, not the commit. Use `git rev-parse v0.8.2^{commit}` when comparing against a lockfile SHA.

---

## Part 2 — Engineering standards (new)

These are the reliability properties a package must hold before any consumer is migrated onto it. Each was learned from a real defect.

### 1. Be a superset of every consumer's copy

Before deleting a hand-rolled implementation, audit what it does **better** and fold that into the package. A hand-rolled copy usually encodes a hard-won fix the package lacks.

> **Why:** savoro's hand-rolled SQLite restore ran `PRAGMA wal_checkpoint(TRUNCATE)`. `db-backup` never touched `-wal`/`-shm` at all and silently resurrected pre-restore rows (BWK-118). savoro's "duplicate code" was *safer than the package it was supposed to adopt.* Migrating first would have introduced data corruption.

Pin each folded-in protection with a regression test, and **verify the test fails against the unpatched package**. A test that passes before and after guards nothing.

### 2. Expose the seam consumers actually need

Ship a **primitive/engine layer** and, optionally, an opinionated **job wrapper** on top. If only the wrapper is exported, a consumer that needs different naming, its own manifest, or no pruning side-effect will reimplement the engine right next to your import.

> **Why:** `db-backup` exported `runBackupJob` (which owns env resolution, filenames, its own manifest, and prunes as a side effect) plus storage helpers — but `createSqliteBackup`, `verifySqliteBackupIntegrity`, and `restoreSqliteBackup` were defined and *not exported*. savoro imported the storage helpers and reimplemented the engine with five `execFileSync` calls.

A missing policy knob produces a reimplementation, not a PR against the package. Same for a missing seam.

### 3. Bound every external command with a timeout

No `execFileSync` / `execSync` / `spawnSync` without an explicit `timeout`. Expose it as config with a sane default; never leave it unbounded.

**A timeout that defaults to off is not a bound.** Ship it enabled, with a default generous enough that nobody needs to disable it.

> **Why:** `db-backup` and `prisma-tools` bounded *none* of their commands (db-backup's only `timeout` was sqlite's `.timeout 5000` *lock* pragma, not a process bound), so a hung `pg_dump` or `next build` blocked a nightly cron or a deploy forever. Both are fixed (v0.7.0, v0.4.0).
>
> `deploy-kit` is the cautionary case: `src/exec.js:51` applies a timeout only `if (config.stepTimeoutSeconds)`, and `src/config.js:53` defaults it to `null`. **None of its five consumers set it**, so every deploy step (`npm ci`, build, migrate, `pm2 restart`) runs unbounded on the Pi — directly under the code comment *"Kill a hung remote command instead of blocking the pipeline forever."* The capability shipped; the bound never did.
>
> `release-kit` is the reference: both of its `execFileSync` calls carry a timeout (10s, 5s).

Genuinely long-running foreground processes are the exception — `deploy-kit`'s `tunnel.js` *is* the tunnel, and bounding it would kill the thing it launched. Say so in a comment.

### 4. Destructive operations are atomic

Write to a temp path, verify it there, then `rename` into place. Never overwrite a live file in place, and never validate *after* the swap.

> **Why:** `db-backup`'s restore does temp → verify → rename, so a corrupt backup can never destroy a good database. savoro's restore `copyFile`s straight over the live DB — an interrupted copy destroys it. Conversely db-backup's `assertSqliteIntegrity` ran on the temp file and therefore *missed* the sidecar corruption in BWK-118: verify the thing you will actually end up with.

### 5. Verify before you keep, and fail loud

Never produce a silently-incomplete artifact. A loud failure beats a quiet bad result. If a capability is unavailable, refuse — do not degrade to a weaker mechanism and report success.

> **Why:** `createSqliteBackup` falls back to `fs.copyFileSync` when `sqlite3` is absent, which in WAL mode omits committed transactions living in `-wal` (BWK-119). That is the exact defect the package exists to eliminate (smarthome's raw `cp`, SMH-113). The package's own comment already states the principle: *"A bad backup is worse than a loud failure."*

Corollary: a success message and a green `integrity_check` are not proof. BWK-118 printed `Restore completed.` and `PRAGMA integrity_check` returned `ok` while serving resurrected rows.

### 6. SQLite: be sidecar-aware

A SQLite database is not one file. Never copy, move, replace, or delete a `.db` without deciding what happens to `-wal`, `-shm`, and `-journal`.

- **Snapshot** with the online backup API (`sqlite3 .backup`), never `cp` — it checkpoints WAL frames into a single self-contained file.
- **Replace** a database only after discarding the destination's sidecars; they describe the database being replaced.
- Escape single quotes in any path interpolated into a sqlite3 dot-command (`path.replace(/'/g, "''")`).
- Retry on `database is locked` with backoff, and set `.timeout`.

> **Why:** BWK-118 (restore replayed a stale WAL), BWK-119 (`cp` fallback drops the WAL), SMH-113 (smarthome's `db:backup` is a raw `cp` of a live DB). rouge's script gets this right and documents it.

### 7. Removing a config key is a breaking change

Strict config validation must fail closed — but a key you delete will hard-throw in every consumer that still sets it. Removing or renaming a key requires a major bump **and** a sweep of every consumer's config in the same change.

> **Why:** `deploy-kit` v0.4.0 removed `ensureTunnelOnDeploy` in favor of `ensureApps` and hard-rejects the old key. savoro's `.deploy-kit.config.json` still sets it. savoro's deploy works today only because its lockfile is stale at 0.3.1; the next `npm install` breaks every deploy and remote command (PTRY-226). The two keys are mutually exclusive across versions, so neither half of the fix is safe alone.

### 8. Types are a contract, and the contract is tested

- Hand-written `index.d.ts` must be exercised by a consumer-shaped file that CI type-checks (`scripts/types-consumer.ts` + `npm run verify:types`).
- Model exclusive shapes as a **discriminated union**, not one interface with optional fields.
- Do not let an overload promise a narrow return the runtime cannot guarantee. Where an input's presence is not statically knowable, return the union and make the caller narrow.
- Pin unsoundness with `@ts-expect-error` — and verify the directive is load-bearing (TypeScript reports an unused `@ts-expect-error`, so a passing check proves the error is real).

> **Why:** widening `RetentionPolicy` to a union silently broke `DEFAULT_RETENTION_POLICY.maxBackups` for TS consumers; `verify:types` did not catch it because the contract file never read the field.

### 9. Uniform gates, named for what they check

Every package exposes `test` and `verify:pack`, plus a **type gate appropriate to its shape** — the two shapes check genuinely different things, so they are correctly named differently:

| Package shape | Type gate | What it protects against |
|---|---|---|
| Plain JS + hand-written `index.d.ts` (`db-backup`, `prisma-tools`) | `verify:types` | The hand-written `.d.ts` drifting from the JS. Type-checks a **consumer-shaped file** against the declarations. |
| TypeScript → committed `dist/` (`express-security-kit`, `release-kit`) | `typecheck` + `build` + a dist-freshness gate | The source not compiling, and the committed `dist/` going stale. The `.d.ts` is emitted by `tsc`, so it *cannot* drift. |

Do not rename `typecheck` to `verify:types` on a TS package: it would be cosmetic and would hide that the gates verify different properties. What must be uniform is the *coverage*, not the string.

---

## Conformance audits

The rules above are durable; package versions, current gates, and remaining
gaps are not. Record fleet conformance in `packages-meta` and delivery work in
Cairn, then update this standard only when the underlying rule changes. Do not
keep a dated package-status table here.

---

## Part 3 — Adopting a package (the consumer side)

Part 2 is what a package owes its consumers. This is what a consumer owes itself **before deleting a local copy**. Every item below cost real debugging during the 2026-07-10 fleet migration, and each one had a failure mode that produces a **green test suite and a broken production app**.

### The governing rule: a package is not a superset just because it says it is

Part 2 standard 1 says a package *must* be a superset. **Do not trust that it is.** Diff the behaviour yourself, before you delete anything.

> **Why:** `url-guard` v0.1.0 was *designed* as a superset of four hand-rolled SSRF guards, *documented* as one, and had already been adopted by two repos on that basis. It still missed **TEST-NET-1** (`192.0.2.0/24`) and **`fec0::/10`**. Two independent adoption attempts, in different repos, found the same two gaps by diffing behaviour. Adopting blind would have *narrowed* savoro's SSRF protection — in a PR that deletes 208 lines and shows all-green tests. Fixed upstream as v0.1.1 rather than worked around locally.

So: **diff behaviour, not code.** Enumerate what the local copy blocks/handles/guards, and assert the package does each one. Where it doesn't, **stop and fix the package** — do not adopt over a regression, and do not paper it over with a local supplemental check (that just re-creates the drift you're deleting).

### Keep the parts the package doesn't own

A local file usually mixes the package's concern with adjacent ones. Deleting the file deletes both.

> savoro's `url-safety.ts` also held `MAX_REDIRECTS`, `MAX_HTML_BYTES`, and a content-type check — fetch-time concerns url-guard has no opinion about. cairn's API client also held an **SSE reader**, `upload()`, and `getBlob()`. Those survive the migration; only the duplicated concern moves.

### Credential-shaped changes: verify the OLD artifact against the NEW code

The single most dangerous class. If a package changes how a **stored** value is derived, a test suite that creates *and* verifies with the new code passes perfectly while every existing user is locked out.

**`auth-kit`'s `preHash` is the canonical example**, and it cuts both ways:

| Repo | Existing stored hashes | Correct setting | Get it backwards → |
|---|---|---|---|
| **sano-os** | SHA-256 pre-hash → bcrypt | `preHash: true` | every user locked out |
| **savoro** | plain bcrypt | `preHash: false` | every user locked out |

The **only** test that catches this:

> Produce a hash **the old way** (raw `bcrypt`/`sha256+bcrypt`, no package involved), then verify it **through the new verifier**. It must pass. Then flip the setting and watch it **fail** — that failure is the proof the test is real.

Both repos proved it in both directions before merging. Generalise this to any package that touches stored hashes, tokens, signatures, or encrypted-at-rest values.

### Adopting a package can silently break test *mechanisms*

The tests may stop testing what you think they test.

> **mailer-kit ships CommonJS.** Its internal `require('nodemailer')` is invisible to `vi.mock('nodemailer')` from an ESM test graph. The moment an app stopped depending on `nodemailer` *directly*, the existing mock **silently stopped intercepting** — and the specs began opening a **live SMTP connection to the real relay**. This hit **savoro and sano-os independently**. Fix: use the package's documented `transportFactory` seam (Part 2 standard 2 exists for exactly this). Any package that wraps a mockable module will do this to its adopters.

### Coverage gates drop structurally on adoption — do not lower the threshold

Adoption moves locally-counted lines into a dependency the coverage run doesn't measure. Coverage falls **by construction**, not because anything got worse.

> smarthome deleted its ~110-loc SSRF guard and dropped from 70.02% to 69.94% — under its 70% gate. The threshold was **not** lowered. The margin was recovered with real tests of genuinely untested paths (the create/update *write* path, proving a rejected URL writes no DB row). Expect this on every adoption in a repo with a tight margin.

### Never run the authoritative suite next to a sub-agent's

A concurrent run in the same worktree races over the same SQLite test DBs and module caches, and produces **phantom failures** you will waste time diagnosing.

> A savoro run showed 3 mailer failures that vanished entirely once an orphaned `vitest` was killed and the suite ran alone: 170 files / 2,041 tests green. Kill orphan lanes first; wait for the sub-agent's *terminal* completion; then run.

### Before calling a failure "pre-existing", install the deps

A fresh worktree's gitignored build output is empty, and a stale primary checkout can fail for reasons unrelated to your change.

> savoro's `check:generated-src` gate looked like it failed *differently* on master than in the worktree — because master's `node_modules` predated a merged PR and blew up on a missing package instead. After `npm install`, master failed with the **same** error on a clean tree, confirming the gate was genuinely pre-existing (PTRY-236). Run `prisma generate` / the package build in a fresh worktree before believing any failure.
