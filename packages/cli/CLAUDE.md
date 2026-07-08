# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Run CLI without building (tsx)
npm run build        # Compile to dist/ and chmod +x dist/wt.js dist/spawner.js
npm test             # Run all tests (vitest, single-fork, serial)
npm run typecheck    # Type-check only (tsc --noEmit)
npm run lint         # Biome lint check
npm run format       # Biome auto-format
```

Run a single test file:

```bash
npx vitest run src/wt/lib/git.test.ts
```

After building, the CLI is available as `wt` (via the `bin` field in package.json).

### CLI Usage

- `wt` — Interactive TUI for browsing and opening worktrees
- `wt create [branch]` — Create a new worktree
- `wt agent <branch> <plan_prompt> [--mode <mode>]` — Create a worktree and auto-start Claude Code agent in Zed (macOS)
  - `--mode` — Claude Code permission mode: `default`, `acceptEdits`, `plan` (default), `auto`, `dontAsk`, `bypassPermissions`
- `wt prune` — Remove all worktrees whose branch is merged into `base_branch` (per-branch confirmation; also the TUI `P` key)
- `wt config [--path]` — Open config file or print its path
- `wt skill` — Print the bundled SKILL.md

## Distribution

The package is published to npm as **`@cestoliv/forest`** (scoped, public —
`publishConfig.access: public`). The CLI command stays `wt` (from the `bin`
field key, independent of the package name); the same package also ships the
`agent-spawner` bin (see `## agent-spawner` below).

- `dist/` is **gitignored** (not committed). The `files` field ships `dist/`
  and `SKILL.md`. `prepublishOnly` runs `npm run build` so the published
  tarball always contains a fresh build.
- **Do not install from the git URL** (`npm install -g github:...`). It is
  broken on npm 11.x: npm symlinks the package to an ephemeral clone cache it
  then deletes (open upstream bug npm/cli#8440, #2084, #1865). Registry
  installs use a completely different path and are unaffected.
- **Do not add a `prepare`/`prepack`/`postinstall` script.** Use
  `prepublishOnly` (publish-only, never runs on install) for build-on-publish.

CI and publishing are now handled by the root-level, path-aware workflows —
see the root `CLAUDE.md`'s "Release model" for the full description
(`.github/workflows/ci.yml` gates PRs/`main` for the areas that changed;
`.github/workflows/publish-cli.yml` publishes `packages/cli` to npm on push to
`main`, plus the `publish-dev` PR-label prerelease flow).

CLI version: `src/wt/cli.ts` uses `__VERSION__`, injected at build time by
`tsup` (`define`) from `package.json` `version` (declared in
`src/globals.d.ts`). Never hardcode the version; `wt --version` always
reflects the published version (prereleases included, since `prepublishOnly`
builds after `npm version`). Similarly, `__WT_SKILL__` is injected from
`SKILL.md` at build time and used by the `wt skill` command.

Publishing uses **npm Trusted Publishers (OIDC)** — no `NPM_TOKEN` secret.
The workflow grants `id-token: write` and uses Node 24 (npm ≥ 11.5.1 required;
provenance is automatic for this public repo/package). A trusted publisher must
be configured on the package's npmjs.com settings (org `cestoliv`, repo
`forest`, workflow file `publish-cli.yml`). Because that page only exists once
the package does, the **first publish is a one-time manual bootstrap**
(`npm publish --access public` after `npm login`); all later publishes are
tokenless via the workflow.

## Linting & Formatting Rules

Biome is the sole linter/formatter. Key style: single quotes, 2-space indent, trailing commas (all). Both `npm run lint` and `npm run build` must pass cleanly before any work is considered done. After code changes, always run `npm run lint` and `npm test`, then `npm run build` so the user can immediately test with the `wt` CLI.

## Architecture

### Entry point & commands

`src/wt/cli.ts` registers Commander commands and uses **dynamic imports** for each:

- `wt` (default, no subcommand) → `src/wt/commands/list.ts` — interactive TUI.
  The `C` (create) and `A` (agent) shortcuts work in **both** repo and global
  mode and are built as back-navigable wizards via `runWizard` (a generic
  array-of-steps + index runner in `tui.ts`: each step resolves `true` to
  advance or `false` to step back one; cancelling the first step aborts to the
  list). The shared `buildWorktreeSteps(repoRoot, store, state)` helper supplies
  the leading steps — `runRepoPicker` (global mode only) then `runBranchInput` —
  writing into a mutable `state` object. `onCreate` runs just those steps; then
  calls `createWorktree(branch, { cwd: pickedRepo })`. `onAgent` appends two more
  steps — `clack.text` (plan) and `clack.select` (permission mode from the
  exported `VALID_MODES`) — for **worktree → plan → mode**, then calls
  `createAgentWorktree(branch, plan, { cwd: pickedRepo, mode })`. Both pass the
  resolved repo as `cwd` and the branch explicitly so `prepareWorktree` skips its
  own pickers and only handles create + the existing-worktree prompt. Steps
  preserve entered values (pickers take an optional initial value; clack uses
  `initialValue`). After create/agent the list refreshes in place and stays open
  (the `refreshItems` handler re-runs `prepareListItems`); only `Enter` (open)
  and `Q`/`Esc` exit.
  `list.ts` also owns the shared delete/prune logic as reusable exports:
  `deleteWorktree` (single-worktree confirm → `teardown_commands` →
  `removeWorktree` → force-confirm on submodule/dirty errors; backs both the
  TUI `D` key and prune), the pure `selectWipeCandidates` (excludes current,
  main, and detached worktrees, then applies a merged predicate),
  `buildMergedPredicate` (per-repo `base_branch` via `getEffectiveConfig` +
  `isBranchMerged`), and `wipeWorktrees` (best-effort fetch → select → delete
  each with per-branch confirmation; the `P` key's `onWipe` handler).
- `wt create [branch]` → `src/wt/commands/create.ts`. The full create flow lives
  here as reusable exports: `prepareWorktree` (repo/branch resolution +
  worktree creation + `setup_commands`) and `openConfiguredIde` (open the
  worktree in the configured IDE + report). `prepareWorktree` returns a
  `status: 'created' | 'exists'` — when the path already exists as a registered
  worktree it returns early (no fetch/create) and the command prompts via the
  shared `promptExistingWorktree` (open IDE / start agent / quit; injectable for
  tests as `CreateOptions.existingWorktreePrompt`); a path that exists but is
  not a worktree is a hard error. `createWorktree` is
  `prepareWorktree` + (on `exists`) prompt + `openConfiguredIde`.
- `wt agent <branch> <plan_prompt>` → `src/wt/commands/agent.ts` — the AI-first
  path. Reuses `prepareWorktree` + `openConfiguredIde` (no duplicated create
  logic) and extends them by auto-starting the configured AI agent in Zed via
  the extracted `startAgentInWorktree` helper (macOS-only automation via
  `src/wt/lib/zed.ts`); falls back to a plain `openConfiguredIde` when
  Zed/`agent_command` is unavailable. On an existing worktree it prompts with
  `promptExistingWorktree` (the agent option included) and reuses
  `startAgentInWorktree` for the "open and start agent" choice.
- `wt prune` → `src/wt/commands/prune.ts` — reuses `prepareListItems` (repo or
  global) then `wipeWorktrees(items, store, { fetch: true })` from `list.ts`;
  no duplicated delete logic. Removes every worktree whose branch is merged into
  its repo's `base_branch`, one per-branch confirmation each.
- `wt config [--path]` → `src/wt/commands/config.ts` — opens the config file in `$EDITOR`, or prints the path with `--path`
- `wt skill` → `src/wt/commands/skill.ts` — prints the bundled SKILL.md to stdout

### Library layer (`src/wt/lib/`)

| File          | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git.ts`      | All `git worktree` shell calls via `execFileSync`. Exports `parseWorktreeList` separately (pure, no fs) to allow unit-testing without real repos. `isBranchMerged(repoRoot, branch, baseBranch)` detects merged branches by patch id (`git cherry`): the branch must have ≥1 commit, all patch-present in base (catches squash/rebase merges; a no-commit branch reads as not merged, and plain merge-commits are intentionally not detected). Fails closed (`false`) on any error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `config.ts`   | Typed config schema (`WtConfig`), read/write via the `conf` package (persisted to `~/Library/Preferences/wt-nodejs/config.json` on macOS). `getEffectiveConfig(repoPath)` merges global defaults → global config → per-repo overrides.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `registry.ts` | Maintains the `repos[]` list in config — repos auto-register themselves on first `wt` invocation inside them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `tui.ts`      | Terminal UI: pure functions (`filterItems`, `groupByRepo`, `renderList`) + interactive `runInteractiveList` using raw stdin. The worktree list is viewport-aware so it never overflows short terminals: `buildListLayout` splits output into a pinned `header`/`footer` and a scrollable `body` (with per-item line `itemSpans`), `clampScroll` keeps the selected item visible with edge-anchored scrolling, and `composeView` slices the body to `process.stdout.rows` and adds `↑/↓ more` indicators. `runInteractiveList` persists the scroll offset across renders and re-renders on terminal `resize`. Also exports `runWizard`, a generic back-navigable step runner (used by the create/agent flows in `list.ts`). `TuiHandlers` is `{ onOpen, onDelete, onCreate, onAgent, onWipe, refreshItems }`. The `C`/`A` (create/agent), `D` (delete), and `P` (prune) branches share one in-place lifecycle: detach listener → `cleanupRawMode` → run the handler (cooked mode for clack/pickers) → for create/agent re-query via `refreshItems` (delete/prune filter out the removed items instead) → `setupRawMode` → re-attach → re-render. So the list stays open after these actions; only `Enter`/`Q`/`Esc` resolve. The `P` (prune) branch calls `onWipe` on the full item set, ignoring any active search filter. Letters `a`/`c`/`d`/`p` are command keys (can't be typed in search). Auto-refresh: when `runInteractiveList` is given `{ autoRefreshMinutes }` (> 0), a `setInterval` re-runs `handlers.refreshItems` on a timer, preserving the active filter and the selected worktree by path (`reconcileSelectedIndex`) and rendering a "last refreshed" header (`formatRefreshStatus`, prepended in `buildListLayout`). The tick is skipped while a delete/create/agent/prune prompt is active (`interacting` guard) and never overlaps itself (`refreshing` guard); the timer is cleared on every exit path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ide.ts`      | Launches the configured IDE via `spawn` with `detached: true`. `unref()` is called only after the `spawn` event fires (not immediately) to ensure error events can still surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `setup.ts`    | Exports the generic sequential shell runner `runCommands(commands, cwd)` (via `spawn` with `shell: true`, `stdio: 'inherit'`, stops on first non-zero exit). Used for `setup_commands` on create (`create.ts`) and `teardown_commands` just before delete (`list.ts` `deleteWorktree`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `zed.ts`      | Zed automation for `wt agent`: pure builders (`buildAgentTask`, `parseChord`, `buildOsascript`, `buildGuiHelperScript`, `parseGuiResult`, `isHeadlessSession`, keymap/task upserts) + side-effecting wrappers (`writeAgentTask`, `ensureKeymap`, `cleanupAgentTask`, darwin-gated `triggerChord`; the osascript runner is `defaultRunner`, which picks `runViaGuiHelper` over SSH or `runOsascriptDirect` otherwise). Exports `AGENT_TASK_LABEL`. Over SSH (`isHeadlessSession`), the keystroke can't reach the GUI from SSH's namespace, so it is handed to Launch Services (`open -a Terminal` runs a helper inside the logged-in user's Aqua session and writes its result to a polled temp file) instead of spawning osascript directly (which times out, `-1712`); the runner has a 30s timeout backstop. |

### Config & config layers

Config lives in a single global JSON file managed by `conf`. `WtConfig` has top-level defaults plus `repo_overrides: Record<string, Partial<RepoConfig>>` for per-repo overrides. `getEffectiveConfig(repoPath)` merges them at call time. Per-repo-overridable keys live on `RepoConfig` (e.g. `auto_refresh_minutes`, default `5`, used by the interactive list's auto-refresh); global-only keys (`repos`, `repo_overrides`) live on `WtConfig`.

### Two operating modes

`list.ts` detects whether the CWD is inside a git repo:

- **Repo mode**: shows worktrees for the current repo only.
- **Global mode**: shows worktrees across all registered repos (fallback when not in a repo).

`C` (create) and `A` (agent) are enabled in **both** modes — in global mode the
create/agent flow resolves the target repo via `prepareWorktree`'s repo-picker
fallback (`createWorktree`/`createAgentWorktree` are called with `cwd: repoRoot ?? cwd`).

### Worktree path convention

`resolveWorktreePath(repoRoot, worktreePath, branch)` places worktrees as siblings to the repo directory: `<parent>/<repo-name>-<branch-name>`. Slashes in branch names are replaced with dashes to prevent path traversal.

## Testing Conventions

- Tests live alongside source files as `*.test.ts`.
- Git-layer tests (`git.test.ts`) create real temporary git repos in `os.tmpdir()` — do not mock `execFileSync` or the filesystem for git tests.
- Functions that depend on external state (store, cwd) accept optional injected parameters for testability — always write tests using these injected parameters, not by touching the real global store.
- Vitest runs with `pool: "forks"` and `singleFork: true` (serial). Do not change this.

## Keeping Docs Up to Date

After any change that affects commands, architecture, config schema, testing conventions, or module structure: update the relevant section of this file. If a README.md exists (or should exist), keep it in sync with user-facing changes — new commands, flags, config keys, or install steps. Do this proactively as part of the same task, not as a follow-up.

`SKILL.md` is the agent-facing documentation for the `wt` CLI. It is embedded into the built binary at build time via `__WT_SKILL__` and output by `wt skill`. When adding, removing, or changing commands, flags, config keys, or workflows, update `SKILL.md` in the same task — it must stay in sync with the actual CLI behavior. Treat it with the same priority as README.md.

## Module System

The project is ESM-only (`"type": "module"`, `moduleResolution: NodeNext`). All internal imports must use `.js` extensions even when importing `.ts` source files.

## agent-spawner

The rest of this file is `wt`'s original guidance, kept intact above. This
section is agent-spawner's — merged in from its own repo's CLAUDE.md when the
two tools were combined into this package (see the root `CLAUDE.md` for the
"one package, two bins" model). agent-spawner's source lives in `src/spawner/`
(`commands/` for the CLI subcommands, `lib/` for the daemon logic), separate
from `wt`'s `src/wt/`, but both build from this same `package.json` (see
`## Commands` and `## Distribution` above — same lint/test/build tooling
applies to both).

agent-spawner is a macOS daemon that polls Todoist for tasks labelled `Agent
Ready` and dispatches each one to a `wt agent` worktree + Zed session, routed
to the correct local repo by Todoist project + label. After dispatching it
swaps the label to `Agent Working` so the task is processed once; on failure
or when no routing rule matches, it swaps to `Agent Error` with an
explanatory comment and leaves `Agent Ready` so it can be retried.
agent-spawner does not yet have its own section in `packages/cli/README.md`
(that file currently only documents `wt`); its CLI subcommands, reproduced
here from its original README:

- `agent-spawner run` — foreground (use this first to grant Accessibility)
- `agent-spawner install` / `agent-spawner uninstall` — launchd auto-start on login
- `agent-spawner logs` — tail the log
- `agent-spawner config [--path]` — open config in `$EDITOR`, or print its path

Config: a Todoist API token (`TODOIST_API_TOKEN` env var or `token` in
config), the three label ids (`ready`/`working`/`error`), and ordered routing
`rules` (project + optional label ids → repo path; first match wins, see
`src/spawner/lib/router.ts`). `packages/cli/config.example.json` has a
starting point. Every `pollIntervalSeconds` (default 600) it fetches `Agent
Ready` tasks, picks the oldest not already Working/Error, resolves a repo via
the rules, and dispatches. The prompt sent to `wt agent` is built from
`promptTemplate` with `{{url}}`, `{{title}}`, `{{id}}`, `{{description}}`, and
`{{projectId}}` placeholders.

### Dispatch is now in-process, not a subprocess on `$PATH`

Before the merge into this monorepo, agent-spawner was a standalone package
and `spawnWtAgent` (`src/spawner/lib/dispatch.ts`) shelled out to a `wt`
binary that had to be separately installed and resolved on `$PATH`, running
`wt agent --repo <path> <branch> <prompt>` with no `cwd` (the daemon has no
TTY, so `--repo` was required to skip `wt`'s interactive repo picker). That
setup had real version-skew risk: `agent-spawner` and `wt` were installed and
updated independently, and a `wt` release that lagged behind (or shipped
without the `--repo` flag agent-spawner depended on) would silently break
dispatch with `error: unknown option '--repo'`.

Now that both binaries build from this one package, `dispatch.ts` calls
`runAgent` from `../../wt/agent-api.js` (`packages/cli/src/wt/agent-api.ts`)
**directly, in-process** — no subprocess, no `$PATH` lookup, no version skew
between the daemon and `wt`'s agent flow (they're always the exact same
build). `runAgent({ repoPath, branch, prompt, mode? })` resolves the target
repo from `repoPath` (still no interactive picker — the daemon still has no
TTY), runs the worktree + agent automation, and returns `{ ok, output }`; it
never calls `process.exit`, so a throw inside `wt agent`'s flow becomes a
clean `{ ok: false }` the daemon can act on (label the task `Agent Error` with
`output` as the comment) instead of crashing the process. The routing rule's
`path` must still be an absolute (or `~`-expandable) path to the repo root —
that part of the routing contract didn't change.

agent-spawner's original repo also had a `docs/WT_INTEGRATION.md` describing
the old subprocess mechanism above (the `--repo` requirement, the PATH/version
gotchas). That doc was **not** carried into this monorepo — the mechanism it
described no longer applies now that dispatch is in-process via `runAgent`.
If similar non-obvious findings accumulate for agent-spawner going forward,
they belong in a topic doc under this repo's root `docs/` (see root
`CLAUDE.md`'s "Where docs live"), not resurrected from the old file as-is.

### Testing

Tests live alongside source as `*.test.ts` under `src/spawner/` — e.g.
`lib/dispatch.test.ts`, `lib/router.test.ts`, `lib/template.test.ts`,
`lib/todoist.test.ts`, `lib/launchd.test.ts`, `lib/loop.test.ts`,
`lib/branch.test.ts`, `lib/config.test.ts`, `lib/smoke.test.ts`. Same vitest
config as `wt` (single-fork, serial — see `## Testing Conventions` above);
there is no separate test command for agent-spawner, `npm test` runs both.
