---
name: wt-worktree-manager
description: Use the wt CLI to create, browse, open, and delete git worktrees across repos. Use when the user asks to manage worktrees, create isolated branches, or configure worktree defaults.
---

# wt — Git Worktree Manager

`wt` is a CLI for managing git worktrees. It provides an interactive TUI to browse, create, open in your IDE, and delete worktrees across multiple repos.

## Commands

### `wt` (no subcommand)

Launch the interactive TUI. Shows worktrees for the current repo (repo mode) or all registered repos (global mode, when run outside a repo).

**Keybindings in the TUI:**

- Arrow keys / `j`/`k` — navigate
- `Enter` — open worktree in IDE
- `d` — delete worktree
- `c` — create new worktree (repo mode only)
- `/` — search
- `q` / `Esc` — quit

### `wt create [branch]`

Create a new worktree. If `branch` is omitted, prompts interactively.

The worktree is created as a sibling directory to the repo: `<parent>/<repo-name>-<branch-name>`.

After creation, `wt` runs any configured `setup_commands` and opens the worktree in your IDE.

If the worktree path already exists, `wt create` doesn't error — it prompts you
to **open it in the IDE** or **quit**. (In a non-interactive shell it errors
with a non-zero exit instead of prompting.)

### `wt agent <branch> <plan_prompt> [--mode <mode>]`

Create a worktree (same as `wt create`) **and** auto-start an AI agent in Zed's
integrated terminal, pre-filled with `<plan_prompt>` and left interactive for
you to take over.

```bash
wt agent feature/login 'Read the codebase, then propose a plan for login.'
wt agent feature/fix 'Fix the bug in payment processing' --mode auto
wt agent refactor/api 'Refactor the API layer' --mode default
```

The `--mode` flag sets Claude Code's permission mode (defaults to `plan`):

- `default` — Standard interactive mode with approval for each action
- `acceptEdits` — Allow file changes but keep command execution controlled
- `plan` — Architecture-first mode with no surprise mutations (default)
- `auto` — Claude's safety model makes decisions instead of prompting
- `dontAsk` — Minimal interruptions in trusted environments
- `bypassPermissions` — Skip all permission checks (dangerous, CI/sandbox only)

It writes a temporary `.zed/tasks.json` running
`<agent_command> --permission-mode <mode> '<plan_prompt>'`, ensures a global Zed keymap chord
(`agent_trigger_chord`) spawns that task, opens Zed, presses the chord via
`osascript`, then removes the temporary task so the repo is left clean.

**macOS + Zed only.** Requires Accessibility permission for the app that runs
`wt` (Zed itself, when run from its integrated terminal). If it isn't granted,
`wt agent` opens the _Privacy & Security → Accessibility_ settings pane and waits
for you to grant it and confirm, then retries automatically. On other platforms
(or when `ide` is not `zed`) the worktree is still created and opened, but the
agent is not auto-started.

Over SSH it still works, provided the same user has an active graphical login on
the Mac: the keystroke is run inside the GUI session via Launch Services
(`open -a Terminal` briefly flashes a Terminal window). Grant Accessibility to
Terminal (not Zed) the first time. With no one logged in graphically there is
nothing to drive, so it falls back to the manual "press the chord in Zed"
message.

If the worktree path already exists, `wt agent` prompts you to **open it in the
IDE**, **open it and start the agent**, or **quit** — instead of erroring. (In a
non-interactive shell it errors with a non-zero exit instead of prompting.)

### `wt config`

Open the global config file in `$EDITOR` (defaults to `nano`).

```bash
wt config          # open in editor
wt config --path   # print config file path only
```

### `wt skill`

Print this skill file to stdout. Useful for piping to agents or copying to a project.

## Configuration

Config is stored as JSON. Get the path with `wt config --path`.

### Schema

| Key                   | Type       | Default                           | Description                                                                                                                                                               |
| --------------------- | ---------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worktree_path`       | `string`   | `"../"`                           | Where to place new worktrees, relative to the repo root                                                                                                                   |
| `base_branch`         | `string`   | `"origin/main"`                   | Branch to base new worktrees on                                                                                                                                           |
| `setup_commands`      | `string[]` | `[]`                              | Commands to run in a new worktree after creation (e.g. `["npm install"]`)                                                                                                 |
| `teardown_commands`   | `string[]` | `[]`                              | Commands to run in a worktree just before it is deleted (e.g. `["docker compose down -v"]`); on failure you are prompted whether to delete anyway                         |
| `ide`                 | `string`   | `"zed"`                           | IDE command to open worktrees with                                                                                                                                        |
| `ide_open_args`       | `string[]` | `["-n"]`                          | Arguments passed to the IDE command                                                                                                                                       |
| `agent_command`       | `string`   | `"claude --permission-mode plan"` | Base command `wt agent` runs in Zed; any `--permission-mode` flag is replaced by the `--mode` option (defaults to `plan`), then `<plan_prompt>` is appended single-quoted |
| `agent_trigger_chord` | `string`   | `"ctrl-shift-cmd-c"`              | Zed keymap chord `wt agent` installs/presses to spawn the agent task                                                                                                      |
| `repos`               | `string[]` | `[]`                              | Registered repo paths (auto-populated on first use)                                                                                                                       |
| `repo_overrides`      | `object`   | `{}`                              | Per-repo config overrides (see below)                                                                                                                                     |

### Per-repo overrides

Override any field (`worktree_path`, `base_branch`, `setup_commands`, `teardown_commands`, `ide`, `ide_open_args`, `agent_command`, `agent_trigger_chord`) for a specific repo:

```json
{
  "base_branch": "origin/main",
  "ide": "zed",
  "repo_overrides": {
    "/path/to/my-repo": {
      "base_branch": "origin/develop",
      "setup_commands": ["npm install", "npm run build"]
    }
  }
}
```

## Common workflows

### Create a worktree for a new feature

```bash
cd /path/to/repo
wt create feature/my-branch
```

### Configure setup commands for a repo

```bash
wt config
# Then add to the JSON:
# "repo_overrides": {
#   "/path/to/repo": {
#     "setup_commands": ["npm install"]
#   }
# }
```

### Browse all worktrees across repos

Run `wt` from any directory outside a git repo to see worktrees from all registered repos.
