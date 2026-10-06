# Changesets

This folder holds pending release notes. Each PR that changes the published package adds one file via `pnpm changeset` (pick the bump type and write the user-facing note). At release time `pnpm changeset:version` folds them into `CHANGELOG.md` and bumps `package.json`; `pnpm changeset:publish` builds and publishes.

Docs: https://github.com/changesets/changesets
