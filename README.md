# forest

A monorepo for two independently-versioned developer tools:

- **[`packages/cli/`](packages/cli/README.md) — `@cestoliv/forest`.** One npm
  package, two binaries:
  - **`wt`** — a fast TUI for git worktrees (browse, create, open, delete) plus
    one-command AI agents (`wt agent`).
  - **`agent-spawner`** — a macOS daemon that polls Todoist for `Agent Ready`
    tasks and dispatches each one to a `wt agent` session, routed to the
    correct local repo. It calls into `wt`'s agent flow in-process (same
    package, no subprocess).
- **[`apps/ide-toggler/`](apps/ide-toggler/README.md) — ide-toggler.** A native
  macOS panel (+ GNOME Shell extension) that shows every open editor window
  alongside its live Claude Code / Codex activity state. Not part of the npm
  package — released independently via `ide-toggler-v*` git tags.

## Install

```bash
npm install -g @cestoliv/forest
```

Installs both `wt` and `agent-spawner`. See
[`packages/cli/README.md`](packages/cli/README.md) for usage, configuration,
and the AI-agent workflow of each command.

ide-toggler is built/installed separately — see
[`apps/ide-toggler/README.md`](apps/ide-toggler/README.md) for the macOS app
build steps and the GNOME extension install instructions.

## Layout

```
packages/cli/          @cestoliv/forest — wt (src/wt/) + agent-spawner (src/spawner/)
apps/ide-toggler/       ide-toggler — macOS app (macos/) + GNOME extension (linux/)
```

See [`CLAUDE.md`](CLAUDE.md) for repo-wide conventions (layout, release model,
where per-tool docs live), and each package's own README.md / CLAUDE.md for
tool-specific detail.
