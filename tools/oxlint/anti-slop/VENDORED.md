# Vendored: anti-slop

- Upstream: https://github.com/dmmulroy/anti-slop
- Commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`
- Copied from: `skills/install-anti-slop/assets/anti-slop/` via `skills/install-anti-slop/scripts/install.mjs`
  (identical to upstream `src/` minus `*.test.ts`).
- Registered in `oxlint.config.ts` as `anti-slop` (generic rules only; the `effect/` plugin is not registered).
- Runs on `oxlint`/`@oxlint/plugins` 1.86.0 (upstream pins 1.78.0); no source changes were needed.

## Local deviations

- Reformatted with the repo's oxfmt config (upstream uses tabs and double quotes); no logic changes.
  Compare against upstream with `git diff --no-index -w` or reformat the incoming copy first.
