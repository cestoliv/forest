# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Run CLI without building (tsx)
npm run build        # Compile to dist/ and chmod +x dist/cli.js
npm test             # Run all tests (vitest, single-fork, serial)
npm run typecheck    # Type-check only (tsc --noEmit)
npm run lint         # Biome lint check
npm run format       # Biome auto-format
```

Run a single test file:

```bash
npx vitest run src/lib/git.test.ts
```

After building, the CLI is available as `wt` (via the `bin` field in package.json).

### CLI Usage

- `wt` — Interactive TUI for browsing and opening worktrees
- `wt create [branch]` — Create a new worktree
- `wt agent <branch> <plan_prompt> [--mode <mode>]` — Create a worktree and auto-start Claude Code agent in Zed (macOS)
  - `--mode` — Claude Code permission mode: `default`, `acceptEdits`, `plan` (default), `auto`, `dontAsk`, `bypassPermissions`
- `wt config [--path]` — Open config file or print its path
- `wt skill` — Print the bundled SKILL.md

## Distribution

The package is published to npm as **`@cestoliv/wt`** (scoped, public —
`publishConfig.access: public`). The CLI command stays `wt` (from the `bin`
field key, independent of the package name).

- `dist/` is **gitignored** (not committed). The `files` field ships `dist/`
  and `SKILL.md`. `prepublishOnly` runs `npm run build` so the published
  tarball always contains a fresh build.
- **Do not install from the git URL** (`npm install -g github:...`). It is
  broken on npm 11.x: npm symlinks the package to an ephemeral clone cache it
  then deletes (open upstream bug npm/cli#8440, #2084, #1865). Registry
  installs use a completely different path and are unaffected.
- **Do not add a `prepare`/`prepack`/`postinstall` script.** Use
  `prepublishOnly` (publish-only, never runs on install) for build-on-publish.

Two workflows:

- `.github/workflows/ci.yml` — quality gate on PRs and `main`: `npm run lint`,
  `npm run typecheck` (`tsc --noEmit`), `npm test`. No publishing.
- `.github/workflows/publish.yml` — publishing only (no lint/test; CI covers
  that). Push to `main` → publish `version` under `latest` (skipped if already
  on npm — bump `version` to release). Adding the `publish-dev` label to a PR →
  publish a unique prerelease `X.Y.Z-pr<N>.g<sha>` under a throwaway `pr-<N>`
  dist-tag (deliberately **not** `latest` or a pretend-stable `dev` channel);
  the exact version is posted as a PR comment, then the label is removed
  (re-add it to publish again). The `publish-dev` label must exist in the repo.

CLI version: `src/cli.ts` uses `__WT_VERSION__`, injected at build time by
`tsup` (`define`) from `package.json` `version` (declared in
`src/globals.d.ts`). Never hardcode the version; `wt --version` always
reflects the published version (prereleases included, since `prepublishOnly`
builds after `npm version`). Similarly, `__WT_SKILL__` is injected from
`SKILL.md` at build time and used by the `wt skill` command.

Publishing uses **npm Trusted Publishers (OIDC)** — no `NPM_TOKEN` secret.
The workflow grants `id-token: write` and uses Node 24 (npm ≥ 11.5.1 required;
provenance is automatic for this public repo/package). A trusted publisher must
be configured on the package's npmjs.com settings (org `cestoliv`, repo
`worktrees`, workflow file `publish.yml`). Because that page only exists once
the package does, the **first publish is a one-time manual bootstrap**
(`npm publish --access public` after `npm login`); all later publishes are
tokenless via the workflow.

## Linting & Formatting Rules

Biome is the sole linter/formatter. Key style: single quotes, 2-space indent, trailing commas (all). Both `npm run lint` and `npm run build` must pass cleanly before any work is considered done. After code changes, always run `npm run lint` and `npm test`, then `npm run build` so the user can immediately test with the `wt` CLI.

## Architecture

### Entry point & commands

`src/cli.ts` registers Commander commands and uses **dynamic imports** for each:

- `wt` (default, no subcommand) → `src/commands/list.ts` — interactive TUI
- `wt create [branch]` → `src/commands/create.ts`. The full create flow lives
  here as reusable exports: `prepareWorktree` (repo/branch resolution +
  worktree creation + `setup_commands`) and `openConfiguredIde` (open the
  worktree in the configured IDE + report). `prepareWorktree` returns a
  `status: 'created' | 'exists'` — when the path already exists as a registered
  worktree it returns early (no fetch/create) and the command prompts via the
  shared `promptExistingWorktree` (open IDE / start agent / quit; injectable for
  tests as `CreateOptions.existingWorktreePrompt`); a path that exists but is
  not a worktree is a hard error. `createWorktree` is
  `prepareWorktree` + (on `exists`) prompt + `openConfiguredIde`.
- `wt agent <branch> <plan_prompt>` → `src/commands/agent.ts` — the AI-first
  path. Reuses `prepareWorktree` + `openConfiguredIde` (no duplicated create
  logic) and extends them by auto-starting the configured AI agent in Zed via
  the extracted `startAgentInWorktree` helper (macOS-only automation via
  `src/lib/zed.ts`); falls back to a plain `openConfiguredIde` when
  Zed/`agent_command` is unavailable. On an existing worktree it prompts with
  `promptExistingWorktree` (the agent option included) and reuses
  `startAgentInWorktree` for the "open and start agent" choice.
- `wt config [--path]` → `src/commands/config.ts` — opens the config file in `$EDITOR`, or prints the path with `--path`
- `wt skill` → `src/commands/skill.ts` — prints the bundled SKILL.md to stdout

### Library layer (`src/lib/`)

| File          | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git.ts`      | All `git worktree` shell calls via `execFileSync`. Exports `parseWorktreeList` separately (pure, no fs) to allow unit-testing without real repos.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `config.ts`   | Typed config schema (`WtConfig`), read/write via the `conf` package (persisted to `~/Library/Preferences/wt-nodejs/config.json` on macOS). `getEffectiveConfig(repoPath)` merges global defaults → global config → per-repo overrides.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `registry.ts` | Maintains the `repos[]` list in config — repos auto-register themselves on first `wt` invocation inside them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `tui.ts`      | Terminal UI: pure functions (`filterItems`, `groupByRepo`, `renderList`) + interactive `runInteractiveList` using raw stdin. The worktree list is viewport-aware so it never overflows short terminals: `buildListLayout` splits output into a pinned `header`/`footer` and a scrollable `body` (with per-item line `itemSpans`), `clampScroll` keeps the selected item visible with edge-anchored scrolling, and `composeView` slices the body to `process.stdout.rows` and adds `↑/↓ more` indicators. `runInteractiveList` persists the scroll offset across renders and re-renders on terminal `resize`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ide.ts`      | Launches the configured IDE via `spawn` with `detached: true`. `unref()` is called only after the `spawn` event fires (not immediately) to ensure error events can still surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `setup.ts`    | Exports the generic sequential shell runner `runCommands(commands, cwd)` (via `spawn` with `shell: true`, `stdio: 'inherit'`, stops on first non-zero exit). Used for `setup_commands` on create (`create.ts`) and `teardown_commands` just before delete (`list.ts` `onDelete`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `zed.ts`      | Zed automation for `wt agent`: pure builders (`buildAgentTask`, `parseChord`, `buildOsascript`, `buildGuiHelperScript`, `parseGuiResult`, `isHeadlessSession`, keymap/task upserts) + side-effecting wrappers (`writeAgentTask`, `ensureKeymap`, `cleanupAgentTask`, darwin-gated `triggerChord`; the osascript runner is `defaultRunner`, which picks `runViaGuiHelper` over SSH or `runOsascriptDirect` otherwise). Exports `AGENT_TASK_LABEL`. Over SSH (`isHeadlessSession`), the keystroke can't reach the GUI from SSH's namespace, so it is handed to Launch Services (`open -a Terminal` runs a helper inside the logged-in user's Aqua session and writes its result to a polled temp file) instead of spawning osascript directly (which times out, `-1712`); the runner has a 30s timeout backstop. |

### Config & config layers

Config lives in a single global JSON file managed by `conf`. `WtConfig` has top-level defaults plus `repo_overrides: Record<string, Partial<RepoConfig>>` for per-repo overrides. `getEffectiveConfig(repoPath)` merges them at call time.

### Two operating modes

`list.ts` detects whether the CWD is inside a git repo:

- **Repo mode**: shows worktrees for the current repo only; `C` to create is enabled.
- **Global mode**: shows worktrees across all registered repos (fallback when not in a repo).

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
