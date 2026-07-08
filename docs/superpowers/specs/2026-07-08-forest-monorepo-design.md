# Forest Monorepo — Design

**Date:** 2026-07-08
**Status:** Approved (design phase)

## Goal

Merge three related tools into a single repository (`forest`) so that
development is unified — one PR can touch any tool, and the shared CLI ships as
one update. Preserve git history for the two tools that already have repos.
Keep every tool's CI/CD working. Design the layout so more tools can be added
later without restructuring.

The three tools:

| Tool | Stack | Existing repo | Distribution |
|------|-------|---------------|--------------|
| **worktrees (`wt`)** | Node/TS · tsup · biome · vitest | `github.com/cestoliv/worktrees` | npm `@cestoliv/wt` (OIDC publish) |
| **agent-spawner** | Node/TS · tsup · biome · vitest (identical stack) | none | npm `@cestoliv/agent-spawner` (no CI yet) |
| **ide-toggler** | Swift (macOS) + GNOME JS extension (Linux) + Python packaging | `github.com/cestoliv/ide-toggler` | GitHub Releases + GNOME store (git tags) |

`worktrees` and `agent-spawner` share an identical toolchain and are coupled at
runtime (the daemon drives `wt agent`). `ide-toggler` is native and released via
a completely different pipeline.

## Decisions

1. **npm packaging:** one combined package `@cestoliv/forest` ships both the
   `wt` and `agent-spawner` binaries at a single shared version. `npm i -g
   @cestoliv/forest` provides both commands; one version bump updates both.
2. **Repo layout:** `packages/` + `apps/` convention (room to grow).
3. **Old npm packages:** `npm deprecate` both `@cestoliv/wt` and
   `@cestoliv/agent-spawner`, pointing to `@cestoliv/forest`. They remain
   installable; new installs see a migration notice.
4. **wt ↔ agent-spawner integration:** direct in-process function call
   (not a subprocess). Requires making `wt agent` library-safe.
5. **Shared code:** start minimal — only genuinely-duplicated helpers.
6. **Tags:** `ide-toggler-v*` for the native app's releases (avoids collisions).
7. **Versioning:** new package starts at `0.1.0`. No workspace tooling
   (single npm package → plain directories + path-filtered CI).

## Repository Layout

```
forest/
├─ packages/
│  └─ cli/                 # @cestoliv/forest — the combined CLI package
│     ├─ src/
│     │  ├─ wt/            # worktrees source (was worktrees/src/*)
│     │  ├─ spawner/       # agent-spawner source (was agent-spawner/src/*)
│     │  └─ shared/        # small shared helpers (styling, version banner)
│     ├─ package.json      # one package, two bins, one version
│     ├─ tsconfig.json
│     ├─ tsup.config.ts
│     ├─ biome.json
│     ├─ vitest.config.ts
│     ├─ SKILL.md          # embedded into the wt build (unchanged)
│     ├─ CLAUDE.md         # consolidated from both tools' CLAUDE.md
│     └─ README.md
├─ apps/
│  └─ ide-toggler/         # native app — moved in unchanged internally
│     ├─ macos/            # Swift (SwiftPM)
│     ├─ linux/            # GNOME extension + Python packaging
│     └─ README.md
├─ docs/
│  └─ superpowers/specs/   # this document
├─ .github/workflows/
│  ├─ ci.yml
│  ├─ publish-cli.yml
│  └─ release-ide-toggler.yml
├─ README.md               # monorepo overview, links to each tool's README
└─ .gitignore
```

## Git History Preservation

Use `git-filter-repo` to rewrite each source repo so its files already sit
under the target prefix, then merge both into `forest` with
`--allow-unrelated-histories`:

1. `git init` in `forest`.
2. Clone `worktrees`, rewrite paths to `packages/cli/` (with `src/` → `src/wt/`),
   merge into `forest`. `git log`/`git blame` on `packages/cli/**` retain full
   history.
3. Clone `ide-toggler`, rewrite paths to `apps/ide-toggler/`, merge into
   `forest`. History retained on `apps/ide-toggler/**`.
4. Add `agent-spawner` as plain new files under `packages/cli/src/spawner/`
   (no repo, so no history to keep).

The path rewrite for worktrees must account for the `src/` → `src/wt/` move so
that history follows the relocated files.

## Combined CLI Package (`@cestoliv/forest`)

### Binaries and build

- `package.json` `bin`:
  ```json
  { "wt": "./dist/wt.js", "agent-spawner": "./dist/spawner.js" }
  ```
- `tsup` builds two entrypoints (`src/wt/cli.ts` → `dist/wt.js`,
  `src/spawner/cli.ts` → `dist/spawner.js`), each with the `#!/usr/bin/env node`
  banner. `chmod +x` both in the build script.
- **Version define unified:** replace `__WT_VERSION__` and `__AS_VERSION__`
  with a single `__VERSION__` fed from the one `package.json`. Keep the
  `__WT_SKILL__` embed of `SKILL.md`.
- Dependencies: union of both packages' deps (already the same toolchain, so a
  clean merge). One `biome.json`, one `tsconfig.json`, one `vitest.config.ts`,
  all scoped to `packages/cli/`.

### Shared code

Start minimal. Only genuinely-duplicated helpers move to `src/shared/`
(picocolors styling, the version banner, and — if it is truly identical — the
`conf` config-path helper). Do **not** prematurely merge the two `lib/config.ts`
files; they model different config shapes.

### wt ↔ agent-spawner: direct in-process call

**Make `wt agent` library-safe, then call it directly from the daemon instead of
spawning a subprocess.**

- **Extract a reusable entry** in `packages/cli/src/wt/`, e.g.
  `runAgent({ repoPath, branch, prompt, mode }): Promise<AgentResult>` where
  `AgentResult = { ok: boolean; output: string }`. It resolves the repo via
  `prepareWorktree({ cwd: repoPath })` (no interactive picker) and runs the
  existing agent flow.
- **Two callers, one core:**
  - The `wt agent` CLI command calls `runAgent`, prints results, sets the exit
    code.
  - agent-spawner's injected `SpawnAgent` calls `runAgent` directly and maps
    `AgentResult` into its Todoist labelling. The old `spawnWtAgent`
    (subprocess) implementation is deleted.
- **Refactors this forces on the `wt` side (net improvements):**
  - Replace `process.exit(1)` and bare `console.*` in the agent flow with
    **returned results** plus an injected **reporter** (`report: (msg) => void`).
    The CLI passes a console reporter; the daemon passes a collector that
    accumulates `output` for the Todoist error comment. This mirrors the
    existing `log` injection in `dispatch.ts` and makes the flow unit-testable
    without spawning processes.
  - The bad-mode validation must **return a failed `AgentResult`** rather than
    `process.exit(1)`, so a malformed task can never kill the daemon.

### Crash isolation

In-process calls remove subprocess isolation: a throw deep in `runAgent` could
otherwise take down the daemon's poll loop. Mitigation: the daemon's
`dispatchTask` wraps the `runAgent` call in a `try/catch` that maps any throw to
`Agent Error` (identical outcome to a failed dispatch today), so a single bad
task cannot stop the loop.

### Accessibility grantee nuance (to verify)

`wt agent` presses a Zed chord via `osascript`, which needs macOS Accessibility.
As a subprocess the grantee was the `wt` process; called in-process it is the
`agent-spawner`/node (launchd) process. Because both are now the same combined
binary this should converge, but the implementation plan includes verifying the
grant still applies after the switch. The daemon already documents a first-run
Accessibility grant, which is the natural place to test it.

## ide-toggler (`apps/ide-toggler/`)

Moves in **unchanged internally** — Swift `macos/`, GNOME `linux/`, and Python
packaging scripts keep working as-is. It remains a native app + GNOME extension,
**not** part of the npm package, and keeps its own build/release model. Only the
CI file location changes (workflows move to the repo-root `.github/workflows/`
with path filters).

## CI/CD

`main` is protected and CI gates merges, so path filters must not leave a
required check permanently pending. Design:

### `ci.yml` — one path-aware workflow + a single required gate

- Runs on every push to `main` and every PR.
- A `changes` job uses `dorny/paths-filter` to detect which areas changed.
- Area jobs run conditionally on the filter output:
  - `cli` → `npm ci` + lint + typecheck + test (when `packages/cli/**` changed).
  - `ide-toggler-macos` → `swift build` + `swift test` on `macos-14` (when
    `apps/ide-toggler/**` changed).
  - `ide-toggler-linux` → `node --test` + shexli static analysis (same trigger).
- A final **`ci-ok`** aggregator job **always runs** and is the **single
  required status check** for branch protection. It succeeds only if every
  job that *did* run succeeded (and treats skipped jobs as passing). This
  resolves the "path filter vs required check" trap.

### `publish-cli.yml` — npm publish for `@cestoliv/forest`

Retarget the existing worktrees publish workflow to the combined package:

- Push to `main`: OIDC trusted publish under `latest`, gated on the
  `package.json` version already being unpublished (bump to release). Path
  filter: `packages/cli/**`.
- `publish-dev` PR label: publish a throwaway PR-scoped prerelease, comment the
  exact version on the PR, remove the label. Preserved as-is.

### `release-ide-toggler.yml` — GNOME extension release

The existing ide-toggler release workflow, with its trigger tag changed from
`v*` to **`ide-toggler-v*`** so app releases never collide with any future CLI
tags. It guards on `node --test`, injects the version from the tag, packages the
extension zip, runs shexli, and attaches the zip to a GitHub Release.

## Tooling & Docs

- **No workspace machinery** (no pnpm/turbo/nx). The CLIs are one package, so
  the "monorepo" is plain directories plus path-filtered CI. If a *second* npm
  package is ever added, workspaces can be introduced then (YAGNI now).
- Each tool keeps its own `README.md`; a root `README.md` gives the overview and
  links out.
- The two `CLAUDE.md` files consolidate into `packages/cli/CLAUDE.md`, with a
  short root `CLAUDE.md` for repo-wide conventions.
- `.gitignore` merged from the source repos (node_modules, dist, `.build/`,
  Swift/Xcode artifacts, Python `__pycache__`, `.DS_Store`).

## Out of Scope

- Rewriting or merging the two `lib/config.ts` config models.
- Any behavioral change to `wt` or `ide-toggler` beyond the `runAgent`
  extraction and the reporter/return-value refactor it requires.
- Cross-tool shared tooling beyond the small `src/shared/` helpers.
- Republishing the old npm packages as shims (deprecation only).

## Migration Checklist (for the implementation plan)

1. Scaffold `forest` git repo + layout.
2. Merge `worktrees` history into `packages/cli/` (paths rewritten, `src/` →
   `src/wt/`).
3. Merge `ide-toggler` history into `apps/ide-toggler/`.
4. Add `agent-spawner` source under `packages/cli/src/spawner/`.
5. Produce the combined `package.json` (two bins, one version `0.1.0`, unioned
   deps), unified `tsup`/`biome`/`tsconfig`/`vitest` configs, `__VERSION__`
   define.
6. Refactor `wt agent` into library-safe `runAgent` (returned results +
   injected reporter, no `process.exit`).
7. Reimplement the daemon's `SpawnAgent` to call `runAgent` in-process; add the
   `try/catch` crash-isolation guard; delete `spawnWtAgent`.
8. Move & rewrite CI into `.github/workflows/` (`ci.yml` with paths-filter +
   `ci-ok` gate, `publish-cli.yml`, `release-ide-toggler.yml`).
9. Consolidate docs (`README.md`, `CLAUDE.md`), merge `.gitignore`.
10. Verify: full `npm ci && lint && typecheck && test` for the CLI; `swift
    build/test` and `node --test`/shexli for ide-toggler; the Accessibility
    grant for the in-process agent call.
11. After the repo is live: `npm deprecate` the two old packages.
```
