# wt

A fast TUI for git worktrees — browse, create, open, and delete without leaving
the terminal. Plus **one-command AI agents**:

```bash
wt agent fix-auth "Plan the auth refactor"
```

→ spins up an isolated worktree and launches Claude in Zed, pre-loaded with your
prompt.

## Install

```bash
npm install -g @cestoliv/wt   # also the update command
```

Requires Node.js 20+ and Git. The command is `wt`.

## Let your AI assistant set it up

Already using an AI coding assistant (Claude Code, Cursor, …)? Paste this prompt
— it reads `wt skill` to learn the tool, then configures `wt` for you:

```text
Run `wt skill` to learn how the `wt` CLI works and what its config options are.
Then configure it for me: choose sensible values for my editor, base branch,
setup commands, and the `wt agent` settings — ask me about anything you can't
infer from this project. Write the result to the config file (find its path with
`wt config --path`), then show me the final config.
```

## Quick start

```bash
wt                                        # Browse worktrees (interactive TUI)
wt create my-feat                         # New worktree, opens your IDE
wt agent my-feat "Plan the feature"       # New worktree + AI agent in Zed (macOS)
wt agent fix-bug "Fix bug" --mode auto    # Use auto mode instead of plan
wt config                                 # Edit config in $EDITOR
wt skill                                  # Print the skill file (for AI agents)
```

## `wt agent <branch> <plan_prompt> [--mode <mode>]` — the standout

```bash
wt agent feat/login "Read the codebase, then propose a plan for login."
wt agent fix-bug "Fix the auth bug" --mode auto
wt agent refactor "Refactor API layer" --mode default
```

Creates a worktree exactly like `wt create`, then auto-starts your agent
(default `claude --permission-mode plan`) in Zed's integrated terminal —
pre-filled with your prompt and left interactive for you to take over.

**Available modes** (`--mode`, defaults to `plan`):

- `default` — Standard interactive mode with approval for each action
- `acceptEdits` — Allow file changes but keep command execution controlled
- `plan` — Architecture-first mode with no surprise mutations (default)
- `auto` — Claude's safety model makes decisions instead of prompting
- `dontAsk` — Minimal interruptions in trusted environments
- `bypassPermissions` — Skip all permission checks (dangerous, CI/sandbox only)

Under the hood it writes a temporary `.zed/tasks.json`, installs a global Zed
keymap chord, opens Zed and fires the chord via `osascript`, then removes the
temp task so the repo stays clean.

**Requires** macOS, Zed, and Accessibility permission for the app running `wt`.
Not granted yet? `wt agent` opens _System Settings → Privacy & Security →
Accessibility_, waits while you grant it (you may need to quit and reopen the
app), then retries automatically. On other platforms — or when `ide` isn't
`zed` — the worktree is still created and opened, just without the agent.

If the path already exists, `wt agent` offers to open it — or open it and start
the agent — instead of erroring (in a non-interactive shell it exits non-zero).

> **Tip:** trust the parent directory of your worktrees in Claude once, and
> every worktree created beneath it starts hands-free.

## Browse — `wt`

An interactive, fuzzy-searchable list of your worktrees:

```
MY-PROJECT
  ▶ main            ~/dev/my-project
      fix: resolve auth bug (2h ago)
    feat/dashboard  ~/dev/my-project-feat-dashboard
      wip: add chart component (1d ago)

↕ navigate · Enter open · D delete · C create · Q quit
```

Type to fuzzy-filter branches instantly. Inside a repo it shows that repo's
worktrees (and `C` creates one); run it outside any repo to browse worktrees
across all registered repos.

## Create — `wt create [branch]`

```bash
wt create feat/login   # From base branch (origin/main by default)
wt create              # Prompts for a branch name
```

Creates a worktree as a sibling directory (`../my-project-feat-login`), runs your
`setup_commands`, and opens it in your IDE. Run it outside a repo to pick from
registered repos.

If the path already exists, `wt create` offers to open it in your IDE instead of
erroring (in a non-interactive shell it exits non-zero).

## Configuration

Edit with `wt config` (`wt config --path` prints the file location —
`~/Library/Preferences/wt-nodejs/config.json` on macOS).

| Key                   | Default                           | Description                                                                         |
| --------------------- | --------------------------------- | ----------------------------------------------------------------------------------- |
| `ide`                 | `"zed"`                           | Editor to open worktrees with                                                       |
| `ide_open_args`       | `["-n"]`                          | Extra args passed to the IDE command                                                |
| `base_branch`         | `"origin/main"`                   | Branch new worktrees are created from                                               |
| `worktree_path`       | `"../"`                           | Where worktrees are placed (relative to repo)                                       |
| `setup_commands`      | `[]`                              | Commands to run in new worktrees                                                    |
| `agent_command`       | `"claude --permission-mode plan"` | Base command; `--permission-mode` replaced by `--mode` option, then prompt appended |
| `agent_trigger_chord` | `"ctrl-shift-cmd-c"`              | Zed keymap chord `wt agent` installs and presses                                    |
| `repo_overrides`      | `{}`                              | Per-repo overrides for any key above                                                |

Override any key per repo:

```json
{
  "repo_overrides": {
    "/path/to/repo": {
      "base_branch": "origin/develop",
      "setup_commands": ["pnpm install", "pnpm build"]
    }
  }
}
```

## Pre-release builds

Add the `publish-dev` label to a PR to publish that branch as a unique, pinned
prerelease (e.g. `0.1.0-pr12.gabc1234`); the exact install command is posted as a
PR comment. There's no rolling `dev` channel — each build is a distinct version
you install explicitly.

## License

MIT
