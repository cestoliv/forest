# wt

A fast, interactive TUI for managing git worktrees.

Browse, create, open, and delete worktrees without leaving the terminal. Fuzzy search across branches, auto-open your IDE, and run setup commands on new worktrees — all from one tool.

## Install

```bash
npm install -g @cestoliv/wt
```

Requires Node.js 20+ and Git. The command is `wt`.

### Update

```bash
npm install -g @cestoliv/wt
```

### Pre-release builds

Add the `publish-dev` label to a PR to publish that branch as a unique,
pinned prerelease version (e.g. `0.1.0-pr12.gabc1234`). The exact install
command is posted as a comment on the PR. There is no rolling `dev` channel —
each build is a distinct version you install explicitly.

## Quick Start

```bash
# Inside any git repo
wt                  # Browse worktrees
wt create my-feat   # Create a new worktree and open it in your IDE
wt agent my-feat 'Plan the feature'  # Create + auto-start an AI agent in Zed (macOS)
wt config           # Edit config in $EDITOR
wt config --path    # Print config file path
wt skill            # Print skill file (for AI agents)
```

## Usage

### Browse worktrees — `wt`

Launches an interactive list of worktrees with fuzzy search.

```
MY-PROJECT
  ▶ main           ~/dev/my-project
      fix: resolve auth bug (2h ago)
    feat/dashboard  ~/dev/my-project-feat-dashboard
      wip: add chart component (1d ago)

↕ navigate · Enter open · D delete · C create · Q quit
```

| Key     | Action                          |
| ------- | ------------------------------- |
| `↑` `↓` | Navigate                        |
| `Enter` | Open worktree in IDE            |
| `D`     | Delete worktree (with confirm)  |
| `C`     | Create new worktree (repo mode) |
| `Q`     | Quit                            |

Type to fuzzy-filter branches instantly.

**Repo mode** (inside a git repo): shows worktrees for that repo.
**Global mode** (outside a repo): shows worktrees across all registered repos.

### Create a worktree — `wt create [branch]`

```bash
wt create feat/login    # Create from base branch (origin/main by default)
wt create               # Prompts for branch name
```

What happens:

1. Creates a worktree as a sibling directory: `../my-project-feat-login`
2. Runs configured setup commands (e.g., `npm install`)
3. Opens the worktree in your IDE

Run outside a repo to pick from registered repos via an interactive picker.

If the worktree path already exists, `wt create` prompts you to **open it in the
IDE** or **quit** instead of erroring. (In a non-interactive shell it errors
with a non-zero exit instead of prompting.)

### Start an AI agent — `wt agent <branch> <plan_prompt>` (macOS + Zed)

```bash
wt agent feat/login 'Read the codebase, then propose a plan for login.'
```

Creates the worktree exactly like `wt create`, then auto-starts an AI agent
(default `claude --permission-mode plan`) in Zed's integrated terminal,
pre-filled with your prompt and left interactive for you to take over.

How it works:

1. Writes a temporary `.zed/tasks.json` running `<agent_command> '<plan_prompt>'`.
2. Ensures a global Zed keymap chord (`agent_trigger_chord`) spawns that task.
3. Opens Zed, then presses the chord via `osascript`.
4. Removes the temporary task afterwards, leaving the repo clean.

**Requirements:** macOS, Zed, and **Accessibility** permission for the app that
runs `wt` (Zed itself, when run from its integrated terminal). If it isn't
granted yet, `wt agent` detects this, opens *System Settings → Privacy &
Security → Accessibility* for you, and waits — grant it (you may need to quit and
reopen the app), confirm, and `wt` retries automatically. On other platforms (or
when `ide` is not `zed`), the worktree is still created and opened, but the agent
is not auto-started.

If the worktree path already exists, `wt agent` prompts you to **open it in the
IDE**, **open it and start the agent**, or **quit** instead of erroring. (In a
non-interactive shell it errors with a non-zero exit instead of prompting.)

> Tip: trust the parent directory of your worktrees in Claude once (open it and
> accept the trust prompt) so every worktree created beneath it is trusted
> automatically and the agent starts hands-free.

### Edit config — `wt config`

Opens the config file in `$EDITOR`.

```bash
wt config           # Open in editor
wt config --path    # Print the config file path only
```

### Print skill file — `wt skill`

Prints the bundled skill documentation to stdout. Useful for piping to AI agents or copying into a project.

## Configuration

Config is stored at `~/Library/Preferences/wt-nodejs/config.json` (macOS).

```json
{
  "ide": "code",
  "ide_open_args": ["-n"],
  "base_branch": "origin/main",
  "worktree_path": "../",
  "setup_commands": ["npm install"],
  "repo_overrides": {
    "/path/to/special-repo": {
      "base_branch": "origin/develop",
      "setup_commands": ["pnpm install", "pnpm build"]
    }
  }
}
```

| Key              | Default         | Description                                   |
| ---------------- | --------------- | --------------------------------------------- |
| `ide`            | `"zed"`         | Editor to open worktrees with                 |
| `ide_open_args`  | `["-n"]`        | Extra args passed to the IDE command          |
| `base_branch`    | `"origin/main"` | Branch new worktrees are created from         |
| `worktree_path`  | `"../"`         | Where worktrees are placed (relative to repo) |
| `setup_commands` | `[]`            | Commands to run in new worktrees              |
| `agent_command`  | `"claude --permission-mode plan"` | Command `wt agent` runs in Zed (prompt appended) |
| `agent_trigger_chord` | `"ctrl-shift-cmd-c"` | Zed keymap chord `wt agent` installs/presses |
| `repo_overrides` | `{}`            | Per-repo overrides for any of the above       |

## License

MIT
