# forest — PR facts

Knowledge cache for the `perso:pr` skill. One fact per bullet. Last verified 2026-07-10 (PR #3).

## Host

- GitHub, repo `cestoliv/forest`, CLI `gh`. Remote is SSH (`git@github.com:cestoliv/forest.git`).
- `main` is protected **by convention only** — never commit, merge, or fast-forward directly. There is
  no GitHub branch protection and no rulesets (verified 2026-07-10: `gh api
  repos/cestoliv/forest/branches/main/protection` → 404, `.../rulesets` → `[]`). Consequence:
  `gh pr merge` will merge a **red** PR. Confirm CI is green yourself before the merge gate.
- `delete_branch_on_merge: false` — the merged branch survives. Delete it only if the user asks.

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

- A fresh worktree has no `node_modules`. Run `npm ci` (what CI runs) before any check.
- `npm run typecheck` → `tsc --noEmit`
- `npm run lint` → biome. **See gotchas.md** — the RTK proxy prints a bogus ESLint line here.
- `npm run format` → `biome format --write .` (idempotent; re-run should report no fixes)
- `npm test` → vitest, ~25 s. Runs `pool: forks` / `singleFork: true` (serial) — do not change that.
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
- **CI compute is ~40 s** on a `packages/cli`-only PR (run `29096574262`, 13:34:45Z → 13:35:25Z,
  2026-07-10). Queue time dominates and varies wildly — PR #2 took ~4 min end to end, PR #3 under a
  minute. First wakeup at ~1 min, then back off.
- `gh pr checks <N> --json name,state,bucket` is the compact way to read it.

## Dev deploy (do this on every PR — the user asks for it)

- `gh pr edit <N> --add-label publish-dev` triggers the `dev` job in
  `.github/workflows/publish-cli.yml` (~20 s).
- It publishes a pinned prerelease `X.Y.Z-pr<N>.g<sha>` (e.g. `0.1.0-pr2.gc03d639`) under a `pr-<N>`
  dist-tag via npm OIDC trusted publishing, and **comments the install command on the PR**.
- Retrieve it with `gh pr view <N> --json comments --jq '.comments[].body'`, then relay
  `npm install -g @cestoliv/forest@X.Y.Z-pr<N>.g<sha>` to the user. Verified working end-to-end on
  PR #2 — the user installed the prerelease and confirmed the feature works.
- **A force-push does NOT republish**, and **the workflow removes the `publish-dev` label itself**
  (`if: always()`, so it clears even on failure). The `dev` job fires on the PR `labeled` event, never
  on `synchronize`. To republish after an amend + force-push, just `gh pr edit <N> --add-label
  publish-dev` again — the label is already gone, no `--remove-label` needed. The job checks out
  `pull_request.head.ref`, so confirm the sha in the new PR comment matches `git rev-parse --short
  HEAD` before telling the user to install.
- Pushing to `main` publishes `latest` (skipped if that `package.json` version already exists — bump
  `version` to release). `apps/ide-toggler` releases separately via `ide-toggler-v*` tags.

## Actions that need explicit user authorization

The permission classifier blocks these; ask for both **up front**, not mid-flow:

- `gh pr edit <N> --add-label publish-dev` — publishes to the public npm registry.
- `git push --force-with-lease` — rewrites remote branch history (needed after every amend).
