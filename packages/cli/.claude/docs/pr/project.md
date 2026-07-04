# Project: wt (@cestoliv/wt) — git worktree manager CLI

## Host & CLI
- GitHub. Remote: `git@github.com:cestoliv/worktrees.git`. Use `gh`.
- PRs open as **ready** (not draft). Reference the task/issue in the PR **description**, not the commit.

## CI (required checks on every PR)
- GitHub Actions, `.github/workflows/ci.yml`, job **`check`**: runs `npm run lint`, `npm run typecheck` (`tsc --noEmit`), `npm test`. No publishing.
- Two required checks total: **`check`** + **GitGuardian** (secret scan). Both must be green to merge.
- Finishes in a few minutes; poll with `gh pr checks <N>`.

## Local commands (for implementer / reviewer)
- Test: `npm test` (vitest, `pool: forks`, `singleFork: true`, serial — do not change). Single file: `npx vitest run src/lib/x.test.ts`.
- Typecheck: `npm run typecheck`.
- Lint/format: Biome — `npm run lint` / `npm run format`. Style: single quotes, 2-space indent, trailing commas (all).
  - GOTCHA: run **`npx @biomejs/biome check src`** directly — `npm run lint` is garbled through the user's local RTK proxy. See gotchas.md.
- Build: `npm run build` (tsup → `dist/`, chmod +x). Injects `__WT_VERSION__` and `__WT_SKILL__` at build time.

## Conventions
- **Conventional commits with scope**: `feat(config): …`, `fix(prune): …`; breaking = `feat(list)!: …`. One-line subject.
- **One commit per branch** (amend as work progresses). **No Co-Authored-By, no AI attribution anywhere.**
- **ESM-only**: internal imports MUST use `.js` extension even for `.ts` sources (`moduleResolution: NodeNext`).
- Docs triad kept in sync on any command/flag/config change: **CLAUDE.md + SKILL.md + README.md** (SKILL.md is embedded into the binary via `__WT_SKILL__`, printed by `wt skill`).

## Merge method
- **Rebase** — `gh pr merge <N> --rebase`. No merge commits; branch commit replayed onto `main`.
