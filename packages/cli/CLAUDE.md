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
- `wt prune` — Remove all worktrees whose branch is merged into `base_branch` (per-branch confirmation; also the TUI `P` key). Afterwards fast-forwards each affected repo's main worktree (`git pull --ff-only`); `--no-pull` opts out (CLI-only — the TUI `P` key always pulls)
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
  `deleteWorktree` (single-worktree confirm → best-effort `stopOrcaWorktree`
  (`lib/orca.ts`) → `teardown_commands`, template-expanded via `template.ts`
  from the worktree item → `removeWorktree` → force-confirm on submodule/dirty
  errors; backs both the TUI `D` key and prune). The Orca stop runs **before**
  teardown and git removal (a live agent PTY inside the worktree makes removal
  fail "busy"), is attempted for every deletion (there is no per-worktree `ide`
  to gate on), and is wrapped in a try/catch so Orca can never block a delete.
  `deleteWorktree` funnels its three success paths (normal removal + the two
  force fallbacks) through one `reportRemoved` helper (green `✓ Removed` line).
  It does **not** print the "your shell is now in a gone directory" hint —
  mid-delete that would be repainted over by the TUI's next render. Instead each
  entry point calls the exported `warnIfCwdRemoved(cwd, suggestion?)` once, at
  the end, when control returns to the shell: `runList` after
  `runInteractiveList` resolves (terminal already restored — covers `D`/`P` and
  an externally deleted cwd), and `prune.ts` after `wipeWorktrees` (**not** inside
  `wipeWorktrees`, which the TUI `P` also calls). It's existence-based (prints
  only if `cwd` is gone on disk), so it's path-independent, and suggests the
  nearest surviving ancestor when no explicit target is given.
  The pure `selectWipeCandidates` (excludes the **main and detached** worktrees —
  both path-independent — then applies a prune predicate; the current worktree
  is deliberately **not** excluded, so prune behaves the same regardless of
  launch directory — `removeWorktree` still hard-refuses the main worktree and
  the per-branch confirm is the guard),
  `buildPrunePredicate` (per-repo `base_branch` via `getEffectiveConfig`; a
  worktree is prunable when its branch `isBranchMerged` **OR** (`hasNoUniqueCommits`
  **AND** `isWorktreeClean` **AND** `hasRemoteTrackingRef`) **OR**
  `isBranchMergedOnForge` **OR** `isBranchClosed` — see the `git.ts` row below
  for what each signal proves; the two offline signals come first so the two
  network calls short-circuit away. Its deps are injectable as
  `buildPrunePredicate(store, deps?: Partial<PruneDeps>)` for testing), and
  `wipeWorktrees`
  (best-effort fetch → select → delete
  each with per-branch confirmation → post-prune auto-pull; the `P` key's
  `onWipe` handler). The fetch
  step skips repos with no matching remote (`remoteExists` guard) and warns
  cleanly (`⚠ <repo> has no "<remote>" remote — falling back to local git`)
  instead of surfacing a raw `git fetch` failure — the local-only-repo case.
  After a successful wipe (`removed.length > 0`), unless `options.pull` is false
  (default true), it calls the exported `pullMainWorktrees(items,
  removedRepoRoots, store, deps?)`: for each deduped affected repo root it
  resolves the main worktree (`items.find(w => w.repoRoot === repo && w.isMain)`)
  and `git pull --ff-only`s it (`pullFfOnly`) so the primary checkout picks up
  the merged changes. All guards are skip-with-reason (never throw out of the
  loop): main missing → silent skip; main not on the `base_branch` (via
  `splitBaseRef`) → dim note; dirty main (`isWorktreeClean`) → yellow warn; no
  matching remote (`remoteExists`) → dim note; else pull in try/catch (green ✓ on
  success, yellow warn surfacing git's message on failure). `pull` /
  `isWorktreeClean` / `remoteExists` are injectable (`PullDeps`) for tests. The
  `P` key always pulls (`onWipe` passes no `pull`, so it defaults true — no TUI
  opt-out); `--no-pull` is CLI-only.
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
  `prepareWorktree` + (on `exists`) prompt + `openConfiguredIde`. `--ide <ide>`
  (also `CreateOptions.ide`) overrides the configured `ide` for one run
  (precedence `--ide` → `config.ide` → default `zed`); `createWorktree`
  applies it by shallow-overriding `config.ide` so the rest of the flow reads
  it uniformly. `openConfiguredIde` special-cases `ide === 'orca'`: instead of
  `spawn`ing an editor it opens the worktree via the Orca CLI (`lib/orca.ts`
  `openWorktreeInOrca` — `orca repo add` + `orca terminal create`), so it takes
  the `repoRoot` (needed by `repo add`) as a 4th argument.
- `wt agent <branch> <plan_prompt>` → `src/wt/commands/agent.ts` — the AI-first
  path. Reuses `prepareWorktree` + `openConfiguredIde` (no duplicated create
  logic) and extends them by auto-starting the configured AI agent via the
  extracted `startAgentInWorktree` helper, which **dispatches on the resolved
  `ide`** (`--ide`/`options.ide` → `config.ide` → default `zed`; applied by
  shallow-overriding `config.ide`). `ide === 'zed'` runs the macOS-only Zed
  automation (`src/wt/lib/zed.ts`); `ide === 'orca'` runs `startAgentInOrcaWorktree`,
  which builds the same command line via `lib/orca.ts` `buildAgentCommandLine`
  and hands it to `startAgentInOrca` (Orca CLI: `repo add` + `terminal create
  --command`); any other `ide` falls back to a plain `openConfiguredIde` (no
  agent). Both the Zed and Orca paths template-expand `agent_command` through
  `template.ts` — passing the prepared `branch`/`repoRoot` plus the plan as
  `{{prompt}}` — and pass an `appendPrompt` flag = `!hasPromptPlaceholder(raw
  agent_command)` so a command containing `{{prompt}}` gets the prompt inline
  (not doubly appended); the pure builders (`buildAgentTask` /
  `buildAgentCommandLine`) only honour the flag. Zed also falls back to a plain
  `openConfiguredIde` when Zed/`agent_command` is unavailable. On an existing
  worktree it prompts with `promptExistingWorktree` (the agent option included)
  and reuses `startAgentInWorktree` for the "open and start agent" choice.
- `wt prune` → `src/wt/commands/prune.ts` — reuses `prepareListItems` (always
  across all registered repos) then `wipeWorktrees(items, store, { fetch: true,
  pull })` from `list.ts`;
  no duplicated delete logic. `prune.ts` only threads the flag; the pull is
  orchestrated inside `wipeWorktrees`. The `--no-pull` CLI flag (Commander
  `--no-pull` → `options.pull` false, default true) opts out of the post-prune
  auto-pull. Removes every worktree whose branch, against its
  repo's `base_branch`, satisfies any of `buildPrunePredicate`'s four signals:
  git proves the merge by patch id (squash/rebase); **or** the branch has no
  unique commits *and* the worktree is clean *and* the branch was pushed
  (fast-forward / merge-commit merge — the clean+pushed conjuncts are what keep
  a fresh worktree holding only uncommitted work from being offered); **or** the
  forge reports a merged PR/MR targeting base (a squash the forge rebased onto a
  newer base, which git cannot see); **or** its PR/MR targeting base was closed
  without merging (dead branch). One per-branch confirmation each; only the
  worktree is removed, never the branch. The **current** worktree (the one you
  ran `wt` from) is a candidate like any other — prune is path-independent; if
  it's the one removed, a warning printed on return to the shell (via
  `warnIfCwdRemoved`) notes the current directory no longer exists. Only `main`
  is protected (`removeWorktree` hard-refuses it).
- `wt config [--path]` → `src/wt/commands/config.ts` — opens the config file in `$EDITOR`, or prints the path with `--path`
- `wt skill` → `src/wt/commands/skill.ts` — prints the bundled SKILL.md to stdout

### Library layer (`src/wt/lib/`)

| File          | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git.ts`      | All `git worktree` shell calls via `execFileSync`. Exports `parseWorktreeList` separately (pure, no fs) to allow unit-testing without real repos. Prune's four signals live here, each answering one narrow question and each failing closed (`false`) on any error, so callers never wipe on uncertainty. **`isBranchMerged(repoRoot, branch, baseBranch)`** — pure git topology, patch id only (`git cherry <base> <branch>`: ≥1 commit, all `-` = patch-present in base). Proves a **squash/rebase** merge offline; no false positives (a branch with no commits of its own emits nothing). It deliberately knows nothing else — no ancestry, no tips, no forge. **`hasNoUniqueCommits(repoRoot, branch, baseBranch)`** — `git cherry` emits zero lines AND the tip is an ancestor of base (`git merge-base --is-ancestor`, belt-and-braces). True for a **fast-forward / merge-commit** merge, for a branch sitting on base's tip, *and* for a fresh worktree whose only work is uncommitted — git cannot tell them apart at the branch level, so this is **not** a merged signal on its own; `buildPrunePredicate` ANDs it with `isWorktreeClean` + `hasRemoteTrackingRef` (both exported here). **`isWorktreeClean(worktreePath)`** — `git status --porcelain` empty; untracked files count as dirty. Fails closed, unlike `listWorktreeDirtyFiles` (which returns `[]` on error, reading a broken path as clean) — never reuse the latter for a delete decision. **`isBranchMergedOnForge(repoRoot, branch, baseBranch, forgeCheck=hasMergedPullRequest)`** — the forge (a merged PR/MR) is the only witness when a squash was **rebased onto a newer base**: the squash commit's patch id matches nothing and the branch stays *ahead* of base, so both git signals above are false. **`isBranchClosed(repoRoot, branch, baseBranch, forgeCheck=hasClosedPullRequest)`** — a **closed-unmerged** PR/MR means the branch is dead (the fix landed another way). The last two are structurally identical: **no** git topology checks at all (a closed or rebased-squash PR says nothing about topology, so either can prune a branch that is *ahead* of base), and the only git-side guard is `hasRemoteTrackingRef` — a never-pushed branch can't have a PR/MR, so the network call is skipped (the common stale-worktree case). Because neither checks ancestry, both thread `baseBranch`'s **local** name into `forgeCheck(repoRoot, branch, baseLocal, remote)` so the query filters PRs/MRs by *target* branch — otherwise a branch merged into `develop` would read as merged into `main`. Both `forgeCheck`s are injectable and themselves fail closed, so an unavailable/offline forge yields `false`. **`splitBaseRef(baseBranch)`** splits a `base_branch` into `{ remote, branch }`, stripping only the leading `<remote>/` (so `origin/feature/nested` → `feature/nested`) and defaulting a slashless value to `origin`; use it rather than re-deriving the remote ad hoc. `hasRemoteTrackingRef`'s doc notes a real caveat: `fetchRemote` runs a plain `git fetch`, which honours the user's `fetch.prune` config, so with pruning fetches + forge auto-delete-on-merge every ref-gated signal fails closed and prune under-reports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `forge.ts`    | Forge (GitHub/GitLab) merge **and closed-PR** detection — the sole signal for `isBranchMergedOnForge` and `isBranchClosed`. Pure, unit-tested helpers (`parseRemoteHost`, `selectForgeTool` → `github.*` prefix / `*.github.com` ⇒ `gh`, else ⇒ `glab`; `buildMergedQuery(tool, branch, baseBranch)`, `parseMergedResult`; `buildClosedQuery(tool, branch, baseBranch)`, `parseClosedResult`) + side-effecting `hasMergedPullRequest` / `hasClosedPullRequest(repoRoot, branch, baseBranch, remote?, runner?)`, which resolve the remote URL → host → CLI and run `gh pr list --head <b> --base <base> --state merged\|closed` / `glab mr list --merged\|--closed --source-branch <b> --target-branch <base>` (auto-detects the host, so self-hosted GitLab works) with a 15s timeout. `baseBranch` is the **local** branch name (`main`, not `origin/main`) and filters by PR/MR *target*: the callers do no ancestry check, so without it a branch merged into another base would be reported as merged into this one. **`gh --state closed` also returns MERGED PRs** (gh models merged as a kind of closed), so `parseClosedResult` keeps only entries whose `state` is `CLOSED` (case-insensitively; drops gh `MERGED` + glab `merged`); `glab --closed` already excludes merged. Everything fails closed (`false`) on missing CLI / offline / unauth / no result. `ForgeRunner` is injectable so the decision logic is testable without network.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `config.ts`   | Typed config schema (`WtConfig`), read/write via the `conf` package (persisted to `~/Library/Preferences/wt-nodejs/config.json` on macOS). `getEffectiveConfig(repoPath)` merges global defaults → global config → per-repo overrides.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `registry.ts` | Maintains the `repos[]` list in config — repos auto-register themselves on first `wt` invocation inside them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `tui.ts`      | Terminal UI: pure functions (`filterItems`, `groupByRepo`, `renderList`) + interactive `runInteractiveList` using raw stdin. The worktree list is viewport-aware so it never overflows short terminals: `buildListLayout` splits output into a pinned `header`/`footer` and a scrollable `body` (with per-item line `itemSpans`), `clampScroll` keeps the selected item visible with edge-anchored scrolling, and `composeView` slices the body to `process.stdout.rows` and adds `↑/↓ more` indicators. `runInteractiveList` persists the scroll offset across renders and re-renders on terminal `resize`. Also exports `runWizard`, a generic back-navigable step runner (used by the create/agent flows in `list.ts`). `TuiHandlers` is `{ onOpen, onDelete, onCreate, onAgent, onWipe, refreshItems }`. The `C`/`A` (create/agent), `D` (delete), and `P` (prune) branches share one in-place lifecycle: detach listener → `cleanupRawMode` → run the handler (cooked mode for clack/pickers) → for create/agent re-query via `refreshItems` (delete/prune filter out the removed items instead) → `setupRawMode` → re-attach → re-render. So the list stays open after these actions; only `Enter`/`Q`/`Esc` resolve. The `P` (prune) branch calls `onWipe` on the full item set, ignoring any active search filter. After it returns — whether or not anything was pruned — it prints `Press any key to continue…` and `await waitForKeypress()` before the re-render, so the `✓ Removed` summary and the post-wipe auto-pull output (from `wipeWorktrees` → `pullMainWorktrees`) stay on screen instead of being erased by `render()` (both the pruned and nothing-pruned branches do this symmetrically). Letters `a`/`c`/`d`/`p` are command keys (can't be typed in search). Auto-refresh: when `runInteractiveList` is given `{ autoRefreshMinutes }` (> 0), a `setInterval` re-runs `handlers.refreshItems` on a timer, preserving the active filter and the selected worktree by path (`reconcileSelectedIndex`) and rendering a "last refreshed" header (`formatRefreshStatus`, prepended in `buildListLayout`). The tick is skipped while a delete/create/agent/prune prompt is active (`interacting` guard) and never overlaps itself (`refreshing` guard); the timer is cleared on every exit path. |
| `ide.ts`      | Launches the configured IDE via `spawn` with `detached: true`. `unref()` is called only after the `spawn` event fires (not immediately) to ensure error events can still surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `setup.ts`    | Exports the generic sequential shell runner `runCommands(commands, cwd)` (via `spawn` with `shell: true`, `stdio: 'inherit'`, stops on first non-zero exit). Used for `setup_commands` on create (`create.ts`) and `teardown_commands` just before delete (`list.ts` `deleteWorktree`). Callers template-expand each command via `template.ts` before passing them in; `runCommands` itself receives already-expanded strings and is unaware of templating.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `template.ts` | `{{…}}` command templating. Pure, unit-tested. `expandTemplate(template, vars)` replaces `{{name}}` (whitespace inside braces allowed, case-sensitive) with `vars[name]`, leaving unknown/absent placeholders **verbatim** (pass-through, no escaping). `buildTemplateVars({ branch, repoRoot, worktreePath, prompt? })` → `{ branch, project: basename(repoRoot), path: worktreePath, repo_root: repoRoot }`, adding `prompt` only when provided. `hasPromptPlaceholder(str)` reports whether a string contains a `{{prompt}}` placeholder (used by the agent flow to decide prompt placement). Used to expand `setup_commands`/`teardown_commands`/`agent_command` before they run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `orca.ts`     | Orca automation for `wt agent`/`wt create` when `ide` is `orca`. Home of the shared **pure** `buildAgentCommandLine(agentCommand, prompt, mode?, appendPrompt?)` (mode inject/dedupe + prompt single-quote escaping + `appendPrompt` handling) — the single source of truth reused by `zed.ts`'s `buildAgentTask`. Also pure `buildOrcaCommands({ repoRoot, worktreePath, commandLine?, title? })` → `{ status, open, repoAdd, terminalCreate }` argv arrays, `buildSwitchCommand(handle)`, `parseTerminalHandle(createJson)`, `isRuntimeReachable(statusJson)`, and `isOrcaSuccess(result)` (success = exit 0 **and** JSON `ok: true`; unparseable/missing `ok` falls back to the exit code). Side-effecting `startAgentInOrca` (agent) / `openWorktreeInOrca` (no-command open) run ensure-runtime → `repo add` → `terminal create` via an injectable `OrcaRunner` (defaults to `spawn('orca', …)`) with an injectable `Sleeper` for the launch poll; both return a `started`/`opened` boolean (true only when `terminal create` passes `isOrcaSuccess`). If `orca status` shows the runtime down it **auto-launches** it (`orca open`) and polls `orca status` a bounded number of times (`RUNTIME_POLL_ATTEMPTS` × `RUNTIME_POLL_DELAY_MS`, ~3s) before proceeding; only if it never comes up does it report the actionable "open Orca / `orca open`" error + return false. ENOENT (orca not installed, on `status` or `open`) and any non-zero/`ok:false` exit also report + return false. **Focus:** for interactive CLI/TUI runs (`focus: true`; the daemon `runAgent` leaves it false) the created tab is revealed with a **best-effort** `terminal switch --terminal <handle>` afterwards — NOT `terminal create --focus`, which reliably times out ("waiting for terminal handle") on the installed Orca. A failed/handle-less switch never fails the launch (the terminal already exists). **Teardown:** `stopOrcaWorktree({ worktreePath, runner? })` (+ pure `buildStopCommand(worktreePath)` → `terminal stop --worktree path:<abs> --json`) stops the agent and closes the terminal for a worktree, addressed by **path** (the `terminal close` handle is ephemeral and never persisted). It is called by `deleteWorktree` for *every* removal and is deliberately silent: it only **probes** `orca status` (never `orca open` — a teardown must not boot Orca) and swallows an unreachable runtime, ENOENT, non-zero exits, and `ok:false`/`selector_not_found` (the normal answer for a worktree Orca never saw). Each teardown call is bounded by `STOP_TIMEOUT_MS` (5s) so a wedged runtime can't block `deleteWorktree` (once per worktree during `wt prune`); the killed child's null exit code already reads as "give up quietly". The timeout is **not** applied on the launch path (`orca open` legitimately takes a while). `defaultRunner` implements the bound itself and **must not** be simplified to `spawn`'s own `timeout` option: `orca` is a bash wrapper that execs the real binary as a child, so SIGTERM-ing the wrapper leaves that grandchild alive holding the stdout pipe open and `close` (what the runner resolves on) fires only when it eventually exits — measured at 60s instead of 5s. Instead the runner spawns `detached` (child leads its own process group), `kill(-pid, 'SIGKILL')`s the whole tree on expiry, and resolves from the timer rather than awaiting `close`, so even a failed kill cannot hang past the bound. `orca terminal stop` is **synchronous** (verified against the installed CLI: on return the PTY's child is reaped and `terminal list` reports 0 terminals), so `deleteWorktree` needs no post-stop wait before `removeWorktree`. Never use `orca worktree rm` here — it would delete the git worktree and directory behind `wt`'s back, bypassing `teardown_commands`, `removeWorktree`, and the dirty/submodule force-confirm. |
| `zed.ts`      | Zed automation for `wt agent`. Stays pure/unaware of templating — `agent.ts` template-expands `agent_command` (via `template.ts`) and passes the already-expanded base command into `buildAgentTask`, along with an `appendPrompt` flag: when false (the raw command already carried `{{prompt}}`), `buildAgentTask` does not append/quote the prompt again. `buildAgentTask` delegates the command-string construction to `lib/orca.ts`'s `buildAgentCommandLine` so the Zed and Orca command lines are byte-for-byte identical. Pure builders (`buildAgentTask`, `parseChord`, `buildOsascript`, `buildGuiHelperScript`, `parseGuiResult`, `isHeadlessSession`, keymap/task upserts) + side-effecting wrappers (`writeAgentTask`, `ensureKeymap`, `cleanupAgentTask`, darwin-gated `triggerChord`; the osascript runner is `defaultRunner`, which picks `runViaGuiHelper` over SSH or `runOsascriptDirect` otherwise). Exports `AGENT_TASK_LABEL`. Over SSH (`isHeadlessSession`), the keystroke can't reach the GUI from SSH's namespace, so it is handed to Launch Services (`open -a Terminal` runs a helper inside the logged-in user's Aqua session and writes its result to a polled temp file) instead of spawning osascript directly (which times out, `-1712`); the runner has a 30s timeout backstop.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### Config & config layers

Config lives in a single global JSON file managed by `conf`. `WtConfig` has top-level defaults plus `repo_overrides: Record<string, Partial<RepoConfig>>` for per-repo overrides. `getEffectiveConfig(repoPath)` merges them at call time. Per-repo-overridable keys live on `RepoConfig`; global-only keys live on `WtConfig` and are excluded from the `getEffectiveConfig` merge: `repos`, `repo_overrides`, and `auto_refresh_minutes` (default `5`, used by the interactive list's auto-refresh — read via `getGlobalConfig(store).auto_refresh_minutes`, deliberately **not** per-repo overridable).

**IDE axis.** `ide` (default `zed`) selects the launch target for both `wt create` and `wt agent`: `zed` (the `.zed/tasks.json` + keymap-chord automation in `zed.ts`) or `orca` (the Orca CLI in `orca.ts`). `--ide <ide>` on `create`/`agent` overrides it for one run (precedence `--ide` → `config.ide` → default `zed`), threaded as `CreateOptions.ide` (and `RunAgentOptions.ide` for the in-process `runAgent` seam); the command functions apply it by shallow-overriding `config.ide`. Keep the default `zed` behaviour byte-for-byte unchanged when no `--ide`/`ide` is set.

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
`rules` (project + optional label ids → repo path, plus an optional per-route
`ide`; first match wins, see `src/spawner/lib/router.ts`).
`packages/cli/config.example.json` has a starting point. `resolveRoute` returns
the whole matched `RouteRule` (not just `path`) so `dispatchTask` can read its
`ide` and thread it through `spawnAgent`/`runWtAgent` → `runAgent({ …, ide })`;
a `RouteRule` with no `ide` (or a blank one, which `loadConfig` normalises to
`undefined`) falls back to `wt`'s configured `ide` default via
`createAgentWorktree`'s `options.ide ?? config.ide`. Every `pollIntervalSeconds` (default 600) it fetches `Agent
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
