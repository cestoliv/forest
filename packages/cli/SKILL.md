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

| Key              | Type       | Default         | Description                                                               |
| ---------------- | ---------- | --------------- | ------------------------------------------------------------------------- |
| `worktree_path`  | `string`   | `"../"`         | Where to place new worktrees, relative to the repo root                   |
| `base_branch`    | `string`   | `"origin/main"` | Branch to base new worktrees on                                           |
| `setup_commands` | `string[]` | `[]`            | Commands to run in a new worktree after creation (e.g. `["npm install"]`) |
| `ide`            | `string`   | `"zed"`         | IDE command to open worktrees with                                        |
| `ide_open_args`  | `string[]` | `["-n"]`        | Arguments passed to the IDE command                                       |
| `repos`          | `string[]` | `[]`            | Registered repo paths (auto-populated on first use)                       |
| `repo_overrides` | `object`   | `{}`            | Per-repo config overrides (see below)                                     |

### Per-repo overrides

Override any field (`worktree_path`, `base_branch`, `setup_commands`, `ide`, `ide_open_args`) for a specific repo:

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
