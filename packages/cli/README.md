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

Requires Node.js 20+ and Git. The command is `wt`. Optionally install the
[`gh`](https://cli.github.com/) and/or [`glab`](https://gitlab.com/gitlab-org/cli)
CLIs (authenticated) to let `wt prune` confirm merges via merged PRs/MRs — see
[Prune](#prune--wt-prune).

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
wt agent fix-bug "Fix bug" --mode auto    # Use auto mode instead of the default
wt prune                                  # Remove merged worktrees (per-branch confirm)
wt config                                 # Edit config in $EDITOR
wt skill                                  # Print the skill file (for AI agents)
```

## `wt agent <branch> <plan_prompt> [--mode <mode>] [--repo <path>]` — the standout

```bash
wt agent feat/login "Read the codebase, then propose a plan for login."
wt agent fix-bug "Fix the auth bug" --mode auto
wt agent refactor "Refactor API layer" --mode default
```

Creates a worktree exactly like `wt create`, then auto-starts your agent
(default `claude`, run with `--permission-mode default`) in Zed's integrated
terminal — pre-filled with your prompt and left interactive for you to take over.

**Available modes** (`--mode`, defaults to `default`; change the default with
the `agent_mode` config key):

- `default` — Standard interactive mode with approval for each action (default)
- `acceptEdits` — Allow file changes but keep command execution controlled
- `plan` — Architecture-first mode with no surprise mutations
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
  ▶ main            (main)  ~/dev/my-project
      fix: resolve auth bug (2h ago)
    feat/dashboard  ~/dev/my-project-feat-dashboard
      wip: add chart component (1d ago)

↕ navigate · Enter open · D delete · P prune · C create · A agent · Q quit
```

Type to fuzzy-filter branches instantly. `wt` always shows worktrees across
**all registered repos**, regardless of where you run it — the current repo is
auto-registered for discovery, never used to scope the list.

`C` creates a worktree and `A` creates one and starts an AI agent in it — both
work from anywhere and are step-by-step wizards. They **always** prompt for the
repo first, then the branch (`C` stops there); `A` adds a plan prompt and a
permission mode — **worktree (repo → branch) → plan prompt → permission
mode**. Pressing `Esc` steps back to the previous question (answers preserved),
or back to the list from the first step. After creating, the list **refreshes
and stays open** (preserving your search and cursor) instead of exiting — only
`Enter` and `Q`/`Esc` leave the TUI. `P` prunes every worktree whose branch has
already been merged (see [`wt prune`](#prune--wt-prune) below). Note that
`a`/`c`/`d`/`p` are command keys, so they can't be typed into the search box.

The main worktree is tagged `(main)` and is protected — `D` only removes linked
worktrees, never the main repository.

## Create — `wt create [branch] [--repo <path>]`

```bash
wt create feat/login              # From base branch (origin/main by default)
wt create                         # Prompts for a branch name
wt create feat/login --repo ~/dev/my-project   # Skip the picker, target a repo
```

Creates a worktree as a sibling directory (`../my-project-feat-login`), runs your
`setup_commands`, and opens it in your IDE. It **always** prompts you to pick the
target repo from the registered repos (the current repo is auto-registered for
discovery but never assumed) — so in a non-interactive shell it exits non-zero
because the picker needs a TTY. Pass `--repo <path>` to name the target repo
explicitly and skip the picker (the path is validated as a git repo; a bad path
errors). `wt agent` accepts the same `--repo <path>` flag.

If the path already exists, `wt create` offers to open it in your IDE instead of
erroring (in a non-interactive shell it exits non-zero).

## Prune — `wt prune`

```bash
wt prune   # remove every merged worktree, one confirmation per branch
```

Cleans up the worktrees you're done with: it finds every worktree whose branch
has already been merged into the base branch (`base_branch`, default
`origin/main`) and removes it — **always confirming each branch individually**,
and force-confirming when git refuses (submodules or uncommitted changes), just
like a manual `D` delete. The branch itself stays; only the worktree is removed.
Your `teardown_commands` run before each removal.

Merge detection is tiered. Patch-id matches (via `git cherry`) catch a
single-commit branch **squash-merged** through a PR, offline. For the ambiguous
case — the branch tip is an ancestor of base but 0 commits ahead, which both a
**fast-forward / merge-commit** merge and a worktree holding only *uncommitted*
work produce — it consults the **forge**: a merged PR/MR (via `gh` for GitHub or
`glab` for GitLab, including self-hosted, auto-detected from the remote) is the
only reliable signal, so a branch with unmerged work-in-progress is never
mistaken for merged. If no forge CLI is available (or you're offline) such
branches are simply left alone. A worktree still sitting exactly on the base
commit is never offered. `wt prune` best-effort fetches
the remote first; if the base ref can't be resolved (offline, missing), it
removes nothing. The TUI exposes the same action under the `P` key. Always runs
across all registered repos (each against its own `base_branch`).

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
| `teardown_commands`   | `[]`                              | Commands to run in a worktree just before it is deleted (e.g. `["docker compose down -v"]`) |
| `agent_command`       | `"claude"`                        | Base command; `--permission-mode <mode>` injected, then prompt appended             |
| `agent_mode`          | `"default"`                       | Default permission mode for `wt agent` (overridden by `--mode`)                     |
| `agent_trigger_chord` | `"ctrl-shift-cmd-c"`              | Zed keymap chord `wt agent` installs and presses                                    |
| `auto_refresh_minutes`| `5`                               | How often the interactive list re-fetches worktrees (shows a "last refreshed" header); `0` disables it. **Global only** — not per-repo overridable |
| `repo_overrides`      | `{}`                              | Per-repo overrides for the keys above (except the global-only `auto_refresh_minutes`) |

Override any key per repo (except the global-only `auto_refresh_minutes`):

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
