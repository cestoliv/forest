# `wt prune`: streaming, watch mode, and richer prompts

Date: 2026-10-09. Scope: `packages/cli` (`wt`). Bump the package version.

## Problem

`wt prune` is slow, and its prompt shows too little to decide.

- Every git and forge call is a sync `execFileSync`.
- `wipeWorktrees` (`src/wt/commands/list.ts`) fetches each repo in series.
  It then runs `buildPrunePredicate` on every worktree in series.
  Each worktree can cost 2 forge calls (`hasMergedPullRequest`, `hasClosedPullRequest`), each with a 15s timeout.
- The first prompt shows only after every worktree is checked.
- The prompt is one line: `Remove worktree <project>/<branch>?`.
  It does not say why the worktree is prunable.

## Goals

1. Show the first prompt as soon as one worktree is proven prunable.
   Continue the checks in the background while the prompt is open.
2. Add `wt prune --watch`: poll for prunable worktrees and prompt for each one.
3. Show a multi-line card for each candidate, with PR and commit data.

## Non-goals

- No change to the four prune signals or their fail-closed rules.
  The set of prunable worktrees must stay identical.
- No `--repo` flag. Prune stays global.
- No new dependency.

## 1. Speed: stream candidates

### Async signals

The prompt cannot render while a sync child process blocks the event loop.
So the checks must use async child processes.

- Add async variants of the git helpers that prune calls
  (`isBranchMerged`, `hasNoUniqueCommits`, `isWorktreeClean`, `hasRemoteTrackingRef`, `fetchRemote`).
  Use `execFile` from `node:child_process` with `util.promisify`.
  Keep the sync versions where other callers need them.
- Make `ForgeRunner.query` and `remoteUrl` async. Keep the 15s timeout.
- `buildPrunePredicate` returns `(wt) => Promise<boolean>`.
  Keep the signal order and the short-circuit: the offline signals run first.
- Keep `PruneDeps` injection, typed with the async signatures.

### One forge query per worktree

Replace the two forge queries with one: every PR/MR for `head → base`, all states.
Derive "merged" and "closed with no open PR" from that one result.
Keep the parse rules of `parseMergedResult` and `parseClosedResult`, now applied to one array.
This halves the network calls. It also gives the PR data for the card (section 3) at no extra cost.

- `gh pr list --head <b> --base <base> --state all --json number,title,url,state,mergedAt,closedAt`
- `glab mr list --all --source-branch <b> --target-branch <base> -F json`
  (read `iid`, `title`, `web_url`, `state`, `merged_at`, `closed_at`).

Fail closed as today: an error means "no PR data", never "prunable".

### Pipeline

1. Fetch every repo in parallel (one `git fetch` per repo, async).
   A worktree waits only for the fetch of its own repo.
2. Check worktrees with a concurrency limit of 6.
   Start with the order of `prepareListItems`.
3. Push each worktree that passes the predicate into an async queue.
4. One consumer reads the queue and prompts (`deleteWorktree`) one candidate at a time.
   Prompts never overlap. The checks continue while a prompt is open.
5. While the queue is empty and checks still run, show a clack spinner:
   `Checking worktrees… (<done>/<total>)`. Stop the spinner before each prompt.
6. When all checks are done and the queue is empty, run `pullMainWorktrees` as today.

Keep the existing messages: `No merged or closed worktrees to wipe.` when nothing passes,
and the `✓ Pruned N worktree(s).` summary.

The TUI `P` key calls `wipeWorktrees`, so it gets the same behavior. No separate code path.

### Ctrl-C stops the whole prune

Today `deleteWorktree` treats a clack cancel like No (`isCancel(confirmed) || !confirmed → false`).
So Ctrl-C skips the current worktree and the next prompt shows. Change this:

- Distinguish cancel from No. `deleteWorktree` returns `'removed' | 'declined' | 'cancelled'`.
  This applies to every prompt in it: the main confirm, the teardown "delete anyway?", and the force-confirm.
- On `'cancelled'`, `wipeWorktrees` stops at once: no more prompts, no auto-pull.
  It discards the pending checks. Their results are not used.
- `wt prune` then prints `Prune cancelled.` (dim), runs `warnIfCwdRemoved(cwd)`, and exits with code 0.
  Exit with `process.exit`, so that in-flight `git`/`gh` child processes do not keep the process alive.
- Ctrl-C while the spinner runs (no prompt open) does the same.
- TUI `P` key: a cancel ends the prune pass and returns to the list. It does not close the TUI.
  The list shows the worktrees removed before the cancel as removed.

### Acceptance

- With 20 worktrees across 3 repos, the first prompt appears after the first prunable worktree is checked,
  not after all 20.
- The candidate set is identical to the current implementation (same unit tests pass, adapted to async).
- An offline forge or a missing `gh`/`glab` never makes a worktree prunable.

## 2. Watch mode: `wt prune --watch`

### Behavior

- `wt prune --watch` runs one prune pass (section 1), then waits, then runs again, until Ctrl-C.
- Interval: the global `auto_refresh_minutes` key (default `5`).
  `--interval <minutes>` overrides it for the run. Reject a value that is not a positive number.
- Each pass calls `prepareListItems` again, so new worktrees and new repos show up.
- A declined worktree (answer No) is asked again on the next pass. Keep no skip list.
- Auto-pull runs once per pass, after the last prompt of that pass, as in a normal run.
  `--no-pull` turns it off for every pass.
- Passes never overlap. A pass ends only when every check is done, every prompt is answered, and the pull is done.
  The wait for the next pass starts at that point. An open prompt holds the next pass for as long as it stays open.
  Use a sequential loop (`await pass(); await sleep(interval)`), not `setInterval`.

### Output between passes

After each pass, print one dim line, for example:
`Watching — next check at 14:35 (every 5 min). Ctrl-C to stop.`
If a pass finds nothing, print no "No merged or closed worktrees" line. The status line is sufficient.

### Exit

Ctrl-C at any moment exits the whole command, never only the current worktree:

- While waiting between passes: exit 0.
- During a pass (prompt or spinner): the same rules as "Ctrl-C stops the whole prune". The watch ends, no pull runs.
- Call `warnIfCwdRemoved(cwd)` once, on exit.

### Acceptance

- Merge a PR while `wt prune --watch` runs. The next pass prompts for its worktree.
- Decline a worktree. The next pass prompts for it again.
- Press Ctrl-C at a prompt in `wt prune` or `wt prune --watch`. The command exits. No other prompt shows.
- `--interval 1` polls every minute.

## 3. The candidate card

Replace the one-line confirm message with a multi-line card above the confirm.
Use `clack.note` (or `clack.log.message`) for the card, then `clack.confirm` with `Remove this worktree?`.
Keep the force-confirm and teardown prompts of `deleteWorktree` unchanged.

### Content

```
<project>/<branch>                                     (bold)
  Reason   PR merged into main                        (one of the 4 signals)
  PR       #123 feat(auth): add SSO login              (title)
           https://github.com/org/repo/pull/123       (link)
  Status   merged 3 days ago                           (merged / closed / open)
  Commits  4 ahead of main · last commit 5 days ago
  Path     ~/dev/repo-feat-sso
  State    clean                                       (or "3 uncommitted files", yellow)
```

Rules:

- **Reason** names the signal that matched:
  `merged (patch in main)`, `fast-forward merged`, `PR merged into <base>`, `PR closed without merge`.
  The predicate must return this reason, not only a boolean.
  Change it to resolve `PruneReason | null`.
- **PR, Status**: from the single forge query of section 1.
  If several PRs match, show the most recent one.
  If the forge gave no data, print `PR  none found` (dim). Do not hide the line.
  For a git-only match (signals 1 and 2), run the forge query only to fill the card.
  Run it in the background check, never at prompt time.
- **Commits**: `git rev-list --count <base>..<branch>` and the last commit date (`git log -1 --format=%cr`).
- **Path**: the worktree path, with `$HOME` shown as `~`.
- **State**: from the same `git status --porcelain` call. Dirty is yellow.
- Gather all card data during the background check, so the card renders with no delay.

### Acceptance

- Each prompt shows the card with reason, PR title, PR link, PR status, commit count, path, and state.
- A repo with no forge CLI shows the card with `PR  none found` and no error.

## Code layout

- `lib/forge.ts`: the single all-states query, its parser (PR list → `{ merged, closed, latest }`), async runner.
- `lib/git.ts`: async helpers, plus commit count and last-commit date.
- `commands/list.ts`: async `buildPrunePredicate` that returns a reason and card data,
  the streaming `wipeWorktrees`, the card in `deleteWorktree` (optional `details` argument so the TUI `D` key keeps the short prompt).
- `commands/prune.ts`: the watch loop.
- `cli.ts`: `--watch` and `--interval <minutes>` on `prune`.

Do not add a generic queue or worker-pool module. A small inline pool in `wipeWorktrees` is sufficient.

## Tests

- `forge.test.ts`: the new parser on gh and glab fixtures (merged, closed, open veto, mixed, empty, bad JSON).
- `list.test.ts`: the async predicate returns the correct reason for each signal, with injected deps.
- `list.test.ts`: streaming. With injected deps where worktree A resolves fast and B slow,
  the prompt for A happens before B resolves.
- `list.test.ts`: a cancelled confirm stops `wipeWorktrees`. No later candidate is prompted, and no pull runs.
  A declined confirm moves on to the next candidate.
- `prune` watch loop: inject the sleeper and the pass function. Check the interval, the re-ask of a declined worktree, and the stop on cancel.
- Keep the real-git rule: `git.test.ts` uses temporary repos, no mocks of `execFile`.

## Docs

Update in the same PR: `packages/cli/CLAUDE.md` (prune section, `forge.ts` and `git.ts` rows),
`packages/cli/SKILL.md` (`wt prune`, `--watch`, `--interval`), `packages/cli/README.md`.
Bump `packages/cli/package.json` (minor).

## Verification

1. `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` in `packages/cli`.
2. Run `wt prune` on a real setup with several repos. Time to the first prompt must drop clearly. Note before and after times in the PR.
3. Run `wt prune --watch --interval 1`. Merge a test PR. Confirm the next pass prompts for it.
4. Press `P` in the TUI. Confirm the streaming and the card.
