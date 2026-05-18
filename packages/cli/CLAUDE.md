# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Run CLI without building (tsx)
npm run build        # Compile to dist/ and chmod +x dist/cli.js
npm test             # Run all tests (vitest, single-fork, serial)
npm run lint         # Biome lint check
npm run format       # Biome auto-format
```

Run a single test file:

```bash
npx vitest run src/lib/git.test.ts
```

After building, the CLI is available as `wt` (via the `bin` field in package.json).

## Linting & Formatting Rules

Biome is the sole linter/formatter. Key style: single quotes, 2-space indent, trailing commas (all). Both `npm run lint` and `npm run build` must pass cleanly before any work is considered done. After code changes, always run `npm run lint` and `npm test`, then `npm run build` so the user can immediately test with the `wt` CLI.

## Architecture

### Entry point & commands

`src/cli.ts` registers three Commander commands and uses **dynamic imports** for each:

- `wt` (default, no subcommand) → `src/commands/list.ts` — interactive TUI
- `wt create [branch]` → `src/commands/create.ts`
- `wt config` → `src/commands/config.ts` — opens the config file in `$EDITOR`

### Library layer (`src/lib/`)

| File          | Role                                                                                                                                                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git.ts`      | All `git worktree` shell calls via `execFileSync`. Exports `parseWorktreeList` separately (pure, no fs) to allow unit-testing without real repos.                                                                                      |
| `config.ts`   | Typed config schema (`WtConfig`), read/write via the `conf` package (persisted to `~/Library/Preferences/wt-nodejs/config.json` on macOS). `getEffectiveConfig(repoPath)` merges global defaults → global config → per-repo overrides. |
| `registry.ts` | Maintains the `repos[]` list in config — repos auto-register themselves on first `wt` invocation inside them.                                                                                                                          |
| `tui.ts`      | Terminal UI: pure functions (`filterItems`, `groupByRepo`, `renderList`) + interactive `runInteractiveList` using raw stdin.                                                                                                           |
| `ide.ts`      | Launches the configured IDE via `spawn` with `detached: true`. `unref()` is called only after the `spawn` event fires (not immediately) to ensure error events can still surface.                                                      |
| `setup.ts`    | Runs `setup_commands` in the new worktree via `spawn` with `shell: true`.                                                                                                                                                              |

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

## Module System

The project is ESM-only (`"type": "module"`, `moduleResolution: NodeNext`). All internal imports must use `.js` extensions even when importing `.ts` source files.
