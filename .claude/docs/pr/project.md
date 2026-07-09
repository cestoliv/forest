# forest — PR facts

Knowledge cache for the `perso:pr` skill. One fact per bullet. Last verified 2026-07-09 (PR #2).

## Host

- GitHub, repo `cestoliv/forest`, CLI `gh`. Remote is SSH (`git@github.com:cestoliv/forest.git`).
- `main` is protected: never commit, merge, or fast-forward directly. Changes land via PR only.

## Branch & commit conventions

- One feature branch off `main`, **exactly one commit**, amended as work progresses.
- Conventional commits, **one-line subject, no body** — verified against `git log --oneline --no-merges`
  (e.g. `fix: harden daemon dispatch — no false "Working", shell-safe templates`).
- No `Co-Authored-By`, no AI attribution.
- No pre-commit hook, no `.husky/` — nothing reformats behind you, no re-staging dance.

## PR conventions

- `gh pr create --base main --head <branch> --title … --body …`. Opens **ready**, not draft.
- No PR template exists (`.github/` contains only `workflows/`).
- **Merge method: rebase** — `gh pr merge <N> --rebase`. Confirmed by the user 2026-07-09.

## Local checks — run from `packages/cli/`

- `npm install` first if `node_modules` is absent (it often is; `package-lock.json` stays unchanged).
- `npm run typecheck` → `tsc --noEmit`
- `npm run lint` → biome. **See gotchas.md** — the RTK proxy prints a bogus ESLint line here.
- `npm run format` → `biome format --write .` (idempotent; re-run should report no fixes)
- `npm test` → vitest. Baseline at PR #2: **430 tests / 29 files, ~25 s**.
- `npm run build` → tsup.
- Biome directly: `./node_modules/.bin/biome check .` → `Checked 71 files`.

## CI

- Single path-aware workflow `.github/workflows/ci.yml`. A `changes` job filters
  `packages/cli/**` vs `apps/ide-toggler/**`; only affected areas run.
- **`ci-ok` is the single required check.** It passes if every job that ran passed; jobs for unchanged
  areas are skipped and count as success.
- Full check list on a `packages/cli`-only PR: `changes` (pass), `cli` (pass), `ide-toggler-macos`
  (skipped), `ide-toggler-linux` (skipped), `ci-ok` (pass), plus `dev`/`release` from the publish
  workflow and an external `GitGuardian Security Checks` (~1 s).
- **Wall clock ≈ 4 min** from `gh pr create` to all-green (measured on PR #2: 17:47:48Z → 17:52:03Z).
  Schedule the first wakeup ~4 min out; don't poll sooner.
- `gh pr checks <N> --json name,state,bucket` is the compact way to read it.

## Dev deploy (do this on every PR — the user asks for it)

- `gh pr edit <N> --add-label publish-dev` triggers the `dev` job in
  `.github/workflows/publish-cli.yml` (~20 s).
- It publishes a pinned prerelease `X.Y.Z-pr<N>.g<sha>` (e.g. `0.1.0-pr2.gc03d639`) under a `pr-<N>`
  dist-tag via npm OIDC trusted publishing, and **comments the install command on the PR**.
- Retrieve it with `gh pr view <N> --json comments --jq '.comments[].body'`, then relay
  `npm install -g @cestoliv/forest@X.Y.Z-pr<N>.g<sha>` to the user. Verified working end-to-end on
  PR #2 — the user installed the prerelease and confirmed the feature works.
- **A force-push does NOT republish.** The `dev` job fires on the PR `labeled` event, not on
  `synchronize` — after an amend + force-push, CI re-runs but `publish` does not. Re-trigger with
  `gh pr edit <N> --remove-label publish-dev && gh pr edit <N> --add-label publish-dev`, then confirm
  the new comment's sha matches `git rev-parse --short HEAD` before telling the user to install.
  (Verified on PR #2: force-push to `7e3d8c6` left the prerelease pinned at `c03d639` until re-labeled.)
- Pushing to `main` publishes `latest` (skipped if that `package.json` version already exists — bump
  `version` to release). `apps/ide-toggler` releases separately via `ide-toggler-v*` tags.
