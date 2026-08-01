# db-backup project guidelines

Reusable database backup manager with age-tier retention (SQLite raw/gzip + Postgres pg_dump)

This is a package in the shared fleet documented by `packages-meta`. Fleet-wide
architecture, maturity criteria, and composition rules live there; personal
workflow standards load from `agent_brain` via the directory tree.

## Source of truth

- This package's source and packed exports are authoritative for its behavior.
- `packages-meta` owns cross-package boundaries and the catalog entry.
- `STANDARDS.md`, `CONTRIBUTING.md`, and `RELEASING.md` in this repo govern
  code, contribution, and release mechanics.

## Rules

- Packages own reusable mechanism; consuming applications own product policy,
  storage, routing, authorization enforcement, and operational authority.
- Prefer typed contracts and host adapters over package-to-package runtime
  dependencies.
- Keep the public API surface deliberate: every export is a compatibility
  commitment. Follow the release flow in `RELEASING.md` (patch-note fragments,
  version gates) for any user-visible change.
- Run the repo's verification gate (see `package.json` scripts / CI) before
  calling work done.
