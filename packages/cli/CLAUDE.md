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
  - `--mode` — Claude Code permission mode: `default` (default), `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`. When omitted, falls back to the `agent_mode` config key (which itself defaults to `default`).
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
  The `C` (create) and `A` (agent) shortcuts are back-navigable wizards via
  `runWizard` (a generic array-of-steps + index runner in `tui.ts`: each step
  resolves `true` to advance or `false` to step back one; cancelling the first
  step aborts to the list). The shared `buildWorktreeSteps(store, state)` helper
  supplies the leading steps — it **always** pushes `runRepoPicker` then
  `runBranchInput`, writing into a mutable `state` object (`state.pickedRepo`
  starts undefined and is only set by the picker). `onCreate` runs just those
  steps; then calls `createWorktree(branch, { repoRoot: pickedRepo })`. `onAgent`
  appends two more steps — `clack.text` (plan) and `clack.select` (permission
  mode from the exported `VALID_MODES`, preselecting the picked repo's effective
  `agent_mode`) — for **worktree → plan → mode**, then calls
  `createAgentWorktree(branch, plan, { repoRoot: pickedRepo, mode })`. Both pass
  the resolved repo as `repoRoot` (not `cwd`) and the branch explicitly so
  `prepareWorktree` skips its own picker and only handles create + the
  existing-worktree prompt. Steps preserve entered values (pickers take an
  optional initial value; clack uses `initialValue`). After create/agent the
  list refreshes in place and stays open (the `refreshItems` handler re-runs
  `prepareListItems`); only `Enter` (open) and `Q`/`Esc` exit.
  `list.ts` also owns the shared delete/prune logic as reusable exports:
  `deleteWorktree` (single-worktree confirm → `teardown_commands`,
  template-expanded via `template.ts` from the worktree item →
  `removeWorktree` → force-confirm on submodule/dirty errors; backs both the
  TUI `D` key and prune), the pure `selectWipeCandidates` (excludes current,
  main, and detached worktrees, then applies a prune predicate),
  `buildPrunePredicate` (per-repo `base_branch` via `getEffectiveConfig`; a
  worktree is prunable when its branch `isBranchMerged` **OR** `isBranchClosed`
  — merged into base, or PR/MR closed without merging), and `wipeWorktrees`
  (best-effort fetch → select → delete
  each with per-branch confirmation; the `P` key's `onWipe` handler). The fetch
  step skips repos with no matching remote (`remoteExists` guard) and warns
  cleanly (`⚠ <repo> has no "<remote>" remote — falling back to local git`)
  instead of surfacing a raw `git fetch` failure — the local-only-repo case.
- `wt create [branch]` → `src/wt/commands/create.ts`. The full create flow lives
  here as reusable exports: `prepareWorktree` (repo/branch resolution +
  worktree creation + `setup_commands`, template-expanded via `template.ts`
  before running; returns the resolved `branch` so agent/teardown flows can
  build template vars) and `openConfiguredIde` (open the
  worktree in the configured IDE + report). `prepareWorktree` takes an optional
  `repoRoot` option: when set it skips the picker; when unset the repo picker
  **always** runs (`cwd` is used only to auto-register the current repo for
  discovery, never to scope/default to it). `repoRoot` comes from either the TUI
  wizard (an already-validated picked repo) or the `--repo <path>` CLI flag
  (untrusted): it is resolved against `cwd` and validated with `getRepoRoot`, and
  a path that isn't a git repo prints `✗ <path> is not a git repository` and
  returns null; the resolved root is then `registerRepo`d for future discovery.
  The branch is prompted via the injectable `branchInput` for all paths.
  `prepareWorktree` returns a
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
  `src/wt/lib/zed.ts`; it template-expands `agent_command` through `template.ts` —
  passing the prepared `branch`/`repoRoot` plus the plan as `{{prompt}}` — and
  passes `buildAgentTask` an `appendPrompt` flag = `!hasPromptPlaceholder(raw
  agent_command)` so a command containing `{{prompt}}` gets the prompt inline
  (not doubly appended); `buildAgentTask` stays pure and only honours the flag);
  falls back to a plain `openConfiguredIde` when
  Zed/`agent_command` is unavailable. On an existing worktree it prompts with
  `promptExistingWorktree` (the agent option included) and reuses
  `startAgentInWorktree` for the "open and start agent" choice.
- `wt prune` → `src/wt/commands/prune.ts` — reuses `prepareListItems` (always
  across all registered repos) then `wipeWorktrees(items, store, { fetch: true })`
  from `list.ts`;
  no duplicated delete logic. Removes every worktree whose branch is merged into
  its repo's `base_branch` **or** whose PR/MR was closed without merging (dead
  branch), one per-branch confirmation each.
- `wt config [--path]` → `src/wt/commands/config.ts` — opens the config file in `$EDITOR`, or prints the path with `--path`
- `wt skill` → `src/wt/commands/skill.ts` — prints the bundled SKILL.md to stdout

### Library layer (`src/wt/lib/`)

| File          | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git.ts`      | All `git worktree` shell calls via `execFileSync`. Exports `parseWorktreeList` separately (pure, no fs) to allow unit-testing without real repos. `isBranchMerged(repoRoot, branch, baseBranch, forgeCheck?)` detects merged branches in three tiers: (1) **squash/rebase** by patch id (`git cherry`): ≥1 commit, all patch-present in base; (2) **ambiguous fast-forward / merge-commit** — tip is an ancestor of base AND strictly behind it (tip ≠ base tip, via `git merge-base --is-ancestor`). Git can't tell this apart from a worktree holding only uncommitted work whose base has since advanced (both are 0 ahead), so the **forge** (a merged PR/MR) is the tiebreaker via the injectable `forgeCheck` (defaults to `hasMergedPullRequest` in `forge.ts`) — but only for **pushed** branches (a `refs/remotes/<remote>/<branch>` exists; never-pushed branches can't have a PR/MR, so the network call is skipped — the common stale-worktree case). A worktree sitting exactly on base (tip = base tip) is never queried; tier-1 runs first and tips are rev-parsed lazily only for tier 2. (3) otherwise not merged. Fails closed (`false`) on any error (a bad base ref throws on `rev-parse` → caught); `forgeCheck` itself fails closed, so an unavailable/offline forge yields not-merged. `isBranchClosed(repoRoot, branch, baseBranch, forgeCheck=hasClosedPullRequest)` is a **forge-only** parallel path (used by prune alongside `isBranchMerged`): a **closed-unmerged** PR/MR means the branch is dead (fix applied another way). Unlike `isBranchMerged` it does **no** cherry/ancestry/tip checks — a closed PR says nothing about git topology, so it can prune a branch that is *ahead* of base; the only git-side guard is the same pushed-branch check (`hasRemoteTrackingRef`; never-pushed ⇒ skip the network call). `forgeCheck` is injectable and fails closed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `forge.ts`    | Forge (GitHub/GitLab) merge **and closed-PR** detection — the tiebreaker for `isBranchMerged`'s ambiguous case, and the sole signal for `isBranchClosed`. Pure, unit-tested helpers (`parseRemoteHost`, `selectForgeTool` → `github.*` prefix / `*.github.com` ⇒ `gh`, else ⇒ `glab`; `buildMergedQuery`, `parseMergedResult`; `buildClosedQuery`, `parseClosedResult`) + side-effecting `hasMergedPullRequest` / `hasClosedPullRequest(repoRoot, branch, remote?, runner?)`, which resolve the remote URL → host → CLI and run `gh pr list --head <b> --state merged\|closed` / `glab mr list --merged\|--closed -s <b>` (auto-detects the host, so self-hosted GitLab works) with a 15s timeout. **`gh --state closed` also returns MERGED PRs** (gh models merged as a kind of closed), so `parseClosedResult` keeps only entries whose `state` is `CLOSED` (case-insensitively; drops gh `MERGED` + glab `merged`); `glab --closed` already excludes merged. Everything fails closed (`false`) on missing CLI / offline / unauth / no result. `ForgeRunner` is injectable so the decision logic is testable without network.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `config.ts`   | Typed config schema (`WtConfig`), read/write via the `conf` package (persisted to `~/Library/Preferences/wt-nodejs/config.json` on macOS). `getEffectiveConfig(repoPath)` merges global defaults → global config → per-repo overrides.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `registry.ts` | Maintains the `repos[]` list in config — repos auto-register themselves on first `wt` invocation inside them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `tui.ts`      | Terminal UI: pure functions (`filterItems`, `groupByRepo`, `renderList`) + interactive `runInteractiveList` using raw stdin. The worktree list is viewport-aware so it never overflows short terminals: `buildListLayout` splits output into a pinned `header`/`footer` and a scrollable `body` (with per-item line `itemSpans`), `clampScroll` keeps the selected item visible with edge-anchored scrolling, and `composeView` slices the body to `process.stdout.rows` and adds `↑/↓ more` indicators. `runInteractiveList` persists the scroll offset across renders and re-renders on terminal `resize`. Also exports `runWizard`, a generic back-navigable step runner (used by the create/agent flows in `list.ts`). `TuiHandlers` is `{ onOpen, onDelete, onCreate, onAgent, onWipe, refreshItems }`. The `C`/`A` (create/agent), `D` (delete), and `P` (prune) branches share one in-place lifecycle: detach listener → `cleanupRawMode` → run the handler (cooked mode for clack/pickers) → for create/agent re-query via `refreshItems` (delete/prune filter out the removed items instead) → `setupRawMode` → re-attach → re-render. So the list stays open after these actions; only `Enter`/`Q`/`Esc` resolve. The `P` (prune) branch calls `onWipe` on the full item set, ignoring any active search filter. Letters `a`/`c`/`d`/`p` are command keys (can't be typed in search). Auto-refresh: when `runInteractiveList` is given `{ autoRefreshMinutes }` (> 0), a `setInterval` re-runs `handlers.refreshItems` on a timer, preserving the active filter and the selected worktree by path (`reconcileSelectedIndex`) and rendering a "last refreshed" header (`formatRefreshStatus`, prepended in `buildListLayout`). The tick is skipped while a delete/create/agent/prune prompt is active (`interacting` guard) and never overlaps itself (`refreshing` guard); the timer is cleared on every exit path. |
| `ide.ts`      | Launches the configured IDE via `spawn` with `detached: true`. `unref()` is called only after the `spawn` event fires (not immediately) to ensure error events can still surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `setup.ts`    | Exports the generic sequential shell runner `runCommands(commands, cwd)` (via `spawn` with `shell: true`, `stdio: 'inherit'`, stops on first non-zero exit). Used for `setup_commands` on create (`create.ts`) and `teardown_commands` just before delete (`list.ts` `deleteWorktree`). Callers template-expand each command via `template.ts` before passing them in; `runCommands` itself receives already-expanded strings and is unaware of templating.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `template.ts` | `{{…}}` command templating. Pure, unit-tested. `expandTemplate(template, vars)` replaces `{{name}}` (whitespace inside braces allowed, case-sensitive) with `vars[name]`, leaving unknown/absent placeholders **verbatim** (pass-through, no escaping). `buildTemplateVars({ branch, repoRoot, worktreePath, prompt? })` → `{ branch, project: basename(repoRoot), path: worktreePath, repo_root: repoRoot }`, adding `prompt` only when provided. `hasPromptPlaceholder(str)` reports whether a string contains a `{{prompt}}` placeholder (used by the agent flow to decide prompt placement). Used to expand `setup_commands`/`teardown_commands`/`agent_command` before they run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `zed.ts`      | Zed automation for `wt agent`. Stays pure/unaware of templating — `agent.ts` template-expands `agent_command` (via `template.ts`) and passes the already-expanded base command into `buildAgentTask`, along with an `appendPrompt` flag: when false (the raw command already carried `{{prompt}}`), `buildAgentTask` does not append/quote the prompt again. Pure builders (`buildAgentTask`, `parseChord`, `buildOsascript`, `buildGuiHelperScript`, `parseGuiResult`, `isHeadlessSession`, keymap/task upserts) + side-effecting wrappers (`writeAgentTask`, `ensureKeymap`, `cleanupAgentTask`, darwin-gated `triggerChord`; the osascript runner is `defaultRunner`, which picks `runViaGuiHelper` over SSH or `runOsascriptDirect` otherwise). Exports `AGENT_TASK_LABEL`. Over SSH (`isHeadlessSession`), the keystroke can't reach the GUI from SSH's namespace, so it is handed to Launch Services (`open -a Terminal` runs a helper inside the logged-in user's Aqua session and writes its result to a polled temp file) instead of spawning osascript directly (which times out, `-1712`); the runner has a 30s timeout backstop.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### Config & config layers

Config lives in a single global JSON file managed by `conf`. `WtConfig` has top-level defaults plus `repo_overrides: Record<string, Partial<RepoConfig>>` for per-repo overrides. `getEffectiveConfig(repoPath)` merges them at call time. Per-repo-overridable keys live on `RepoConfig`; global-only keys live on `WtConfig` and are excluded from the `getEffectiveConfig` merge: `repos`, `repo_overrides`, and `auto_refresh_minutes` (default `5`, used by the interactive list's auto-refresh — read via `getGlobalConfig(store).auto_refresh_minutes`, deliberately **not** per-repo overridable).

**Command templating.** `setup_commands`, `teardown_commands`, and `agent_command` are `{{…}}`-expanded (via `template.ts`) just before they run. Variables: `{{branch}}`, `{{project}}` (repo dir basename), `{{path}}` (worktree path), `{{repo_root}}` — available in all three contexts — plus `{{prompt}}` (the plan prompt), available in `agent_command` **only**. Whitespace inside braces is allowed and names are case-sensitive; an unknown/absent variable is left **verbatim** (never blanked), and values are inserted raw (no shell-escaping). In `agent_command`, `{{prompt}}` controls prompt placement: if the raw command contains `{{prompt}}` (detected via `hasPromptPlaceholder`), the plan prompt is substituted there and `buildAgentTask` does **not** auto-append it (avoiding a double emit); if absent, `buildAgentTask` appends the prompt single-quoted as before (its `appendPrompt` flag).

### Always global

The tool is **always global**: `list.ts`/`prune.ts` always show worktrees across
**all registered repos**, regardless of the CWD. There is no repo-scoped mode.
Being inside a git repo only triggers **auto-registration** of that repo for
discovery (via `registerRepo(getRepoRoot(cwd))`, best-effort in a try/catch) —
it never scopes or defaults the list, create, or prune to the current repo.
`prepareListItems` still passes `cwd` to `listWorktrees` so the current worktree
renders as `(current)`.

`C` (create) and `A` (agent) — and `wt create`/`wt agent` — **always** prompt
for the target repo via `prepareWorktree`'s repo picker. The picker is skipped
only when a `repoRoot` is passed explicitly: the TUI wizard (which already ran
its own picker) or the `--repo <path>` CLI flag (validated as a real git repo
first). A consequence approved as part of this design: a non-TTY
`wt create`/`wt agent` run from inside a repo (without `--repo`) exits with the
"no TTY available" error because the picker needs a TTY — there is no
single-repo shortcut. `wt prune` deliberately has **no** `--repo` flag: it stays
global (all registered repos) so no scoping is reintroduced.

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
