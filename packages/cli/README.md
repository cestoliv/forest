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
| `repo_overrides` | `{}`            | Per-repo overrides for any of the above       |

## License

MIT
