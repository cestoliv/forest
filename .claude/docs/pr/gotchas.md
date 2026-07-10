# forest — gotchas

Durable lessons. Append a dated bullet when something bites. One fact per bullet.

## GitHub Actions

- **2026-07-10 — zero workflow runs on a PR? The branch conflicts with `main`.** GitHub builds the
  `pull_request` event against the PR's *merge ref*; when that ref can't be created, **no run is ever
  queued** — no `ci`, no `publish`, nothing in the Actions tab. Opening, labeling, and close/reopen all
  do nothing. `gh pr view <N> --json mergeable` → `CONFLICTING` answers it in one call. Rebase onto
  `main`, force-push, and the runs queue immediately. Check mergeability **before** opening the PR:
  `main` moves while a branch is in flight (an Orca-support commit landed on `main` mid-run during
  PR #3). Cost when missed: ~12 tool calls ruling out Actions permissions, workflow state, repo
  visibility/billing, trigger config, and draft status — all of which looked healthy.
- **2026-07-10 — `gh api "repos/<o>/<r>/actions/runs?head_sha=<sha>"` needs the full 40-char sha.**
  An abbreviated sha silently returns `total_count: 0`, indistinguishable from "no runs yet" and burns
  a wait loop. Use `$(git rev-parse HEAD)`, or just `gh pr checks <N>`.

## Running checks

- **2026-07-09 — `npm run lint` prints a fake ESLint failure.** The RTK proxy emits
  `ESLint output (JSON parse failed: EOF while parsing a value at line 1 column 0)`. It is **not** a
  lint failure. Confirm with `./node_modules/.bin/biome check .` run directly, which reports
  `Checked 71 files … No fixes applied`. Two separate agents lost time on this in one run.
- **2026-07-09 — `node_modules` is often absent** in `packages/cli/`. Run `npm ci` (what CI runs)
  before any check; it leaves `package-lock.json` untouched.

## Committing PR knowledge

- **2026-07-09 — `.claude/` is gitignored, but `.claude/docs/` is not.** `.gitignore` uses
  `.claude/*` + `!.claude/docs/` so this knowledge cache is tracked while `settings.local.json` stays
  ignored. It must be written that way: git does **not** descend into an excluded *directory*, so the
  obvious `.claude/` + `!.claude/docs/` silently fails and `git add` still refuses the path.

## Writing tests

- **2026-07-09 — building a "merged" branch for `wt prune` tests.** `git worktree add -b feature` +
  a commit + `git cherry-pick feature` on `main` does **not** produce a merged branch: the cherry-pick
  fast-forwards `main` onto `feature`'s exact sha, the tips end up equal, `git cherry` reports 0
  commits, and `isBranchMerged` deliberately never treats a worktree sitting exactly on base as merged.
  Advance `main` with an **unrelated** commit first.

## Probing the real Orca CLI (agents do this to verify behavior)

- **2026-07-09 — `orca repo add` has no inverse.** There is no `orca repo rm`. Every throwaway repo an
  agent registers while probing stays in the user's Orca registry forever. Probe inside the scratchpad
  and expect permanent (harmless) residue; `orca project setup-delete` is the closest cleanup.
- **2026-07-09 — `orca worktree rm --worktree path:<abs>` is destructive beyond Orca.** It also deletes
  the **git worktree and the directory on disk**. Never reach for it as a "deregister from Orca" call.
  Use `orca terminal stop --worktree path:<abs>`, which touches no git state.
- **2026-07-09 — Orca resolves `path:<abs>` for worktrees it did not create.** Externally-created
  (`git worktree add`) worktrees are addressable, but never appear in `orca worktree list`
  (`externalWorktreeVisibility: "hide"`). Absence from that list does not mean absence from Orca.

## Where the Orca *code* facts live

- Behavioral quirks that constrain the implementation — the broken `orca terminal create --focus`, the
  `/usr/local/bin/orca` bash-wrapper that defeats Node's `spawn({ timeout })`, and the
  verified-synchronous `orca terminal stop` — are documented in **`packages/cli/CLAUDE.md`**
  (`lib/orca.ts` section). Read them before touching `src/wt/lib/orca.ts`. Do not duplicate them here.
