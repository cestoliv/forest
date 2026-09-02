---
name: wt-worktree-manager
description: Use the wt CLI to create, browse, open, and delete git worktrees across repos. Use when the user asks to manage worktrees, create isolated branches, or configure worktree defaults.
---

# wt — Git Worktree Manager

`wt` is a CLI for managing git worktrees. It provides an interactive TUI to browse, create, open in your IDE, and delete worktrees across multiple repos.

## Commands

### `wt` (no subcommand)

Launch the interactive TUI. Always shows worktrees across all registered repos, no matter where it is run. The current repo (if any) is auto-registered for discovery, but is never used to scope the list to a single repo.

**Keybindings in the TUI:**

- Arrow keys — navigate
- `Enter` — open worktree in IDE (exits the TUI)
- `D` — delete worktree (the main worktree is tagged `(main)` and cannot be deleted — only linked worktrees can; the worktree you're currently in **can** be deleted, and on exit a warning notes your shell is left in a removed directory — `cd` out)
- `P` — prune all merged or closed-PR worktrees (per-branch confirmation)
- `C` — create a new worktree
- `A` — create a worktree and start an AI agent in it
- type to search · `Backspace` — edit search
- `Q` / `Esc` — quit

`C` and `A` are step-by-step wizards. They **always** start by prompting for the
repo (picker), then the branch. `A` then adds two more steps:

- `C` — **worktree (repo → branch)**
- `A` — **worktree (repo → branch) → plan prompt → permission mode**

Pressing `Esc` at any step goes back to the previous step (your earlier answers
are preserved); pressing `Esc` on the first step returns to the list.

After a create or agent action the TUI **refreshes and stays open** on the list
(your search and cursor are preserved) rather than exiting — only `Enter` (open)
and `Q`/`Esc` exit.

Because `a`/`A`, `c`/`C`, `d`/`D`, and `p`/`P` are reserved as command keys,
those letters can't be typed into the search box.

### `wt create [branch] [--repo <path>] [--ide <ide>]`

Create a new worktree. Always prompts you to pick the target repo from the registered repos first (the current repo is auto-registered for discovery but never assumed). If `branch` is omitted, prompts for it too. In a non-interactive shell it exits non-zero because the repo picker needs a TTY.

Pass `--repo <path>` to target a repo explicitly and skip the picker. The path is resolved against the current directory and validated as a git repo root; a path that is not a git repository errors (`✗ <path> is not a git repository`) and nothing is created. The resolved repo is also registered for future discovery.

Pass `--ide <ide>` (`zed` or `orca`) to override the configured `ide` for this run (precedence: `--ide` → `config.ide` → the default `zed`). `--ide orca` opens the worktree in Orca — it registers the repo (`orca repo add`) and opens a terminal on the worktree (`orca terminal create`) instead of spawning an editor.

The branch name (typed at the prompt or passed as `[branch]`) is slugified into a valid git branch name first: spaces and characters git forbids in a ref become dashes, so free-form input like `detection issues 13-07` works instead of failing with `fatal: … is not a valid branch name`. Already-valid names (including namespaced ones like `feat/login`) are unchanged; you're told the final name when it differs.

The worktree is created as a sibling directory to the repo: `<parent>/<repo-name>-<branch-name>`.

After creation, `wt` runs any configured `setup_commands` and opens the worktree in your IDE.

If the worktree path already exists, `wt create` doesn't error — it prompts you
to **open it in the IDE** or **quit**. (In a non-interactive shell it errors
with a non-zero exit instead of prompting.)

### `wt agent <branch> <plan_prompt> [--mode <mode>] [--model <model>] [--repo <path>] [--ide <ide>]`

Create a worktree (same as `wt create`) **and** auto-start an AI agent in Zed's
integrated terminal (or an Orca terminal — see `--ide` below), pre-filled with
`<plan_prompt>` and left interactive for you to take over.

```bash
wt agent feature/login 'Read the codebase, then propose a plan for login.'
wt agent feature/fix 'Fix the bug in payment processing' --mode auto
wt agent refactor/api 'Refactor the API layer' --mode default
wt agent feature/login 'Plan login' --repo ~/dev/my-project   # skip the picker
wt agent feature/login 'Plan login' --ide orca                # start in Orca, not Zed
wt agent big-refactor 'Plan the refactor' --model fable        # use a bigger model for one run
```

Like `wt create`, it always prompts for the target repo unless `--repo <path>`
is given (same validation: the path must be a git repo root, else it errors and
creates nothing).

The `--mode` flag sets Claude Code's permission mode (defaults to `default`;
change the default with the `agent_mode` config key):

- `default` — Standard interactive mode with approval for each action (default)
- `acceptEdits` — Allow file changes but keep command execution controlled
- `plan` — Architecture-first mode with no surprise mutations
- `auto` — Claude's safety model makes decisions instead of prompting
- `dontAsk` — Minimal interruptions in trusted environments
- `bypassPermissions` — Skip all permission checks (dangerous, CI/sandbox only)

The `--model` flag sets the model Claude Code runs the agent on (e.g. `fable`,
`opus`; overrides the `agent_model` config key, default `""` unset — no
validation, any string is accepted). When omitted (and `agent_model` unset), no
`--model` is passed and Claude Code uses its own default.

The launch target is the `ide` config key (default `zed`), overridable per run
with `--ide zed|orca` (precedence: `--ide` → `config.ide` → `zed`).

**Zed (`ide: zed`).** It writes a temporary `.zed/tasks.json` running
`<agent_command> --permission-mode <mode> --model <model> '<plan_prompt>'`
(`--model <model>` is only injected when a model is set, via `--model` or
`agent_model`), ensures a global Zed keymap chord
(`agent_trigger_chord`) spawns that task, opens Zed, presses the chord via
`osascript`, then removes the temporary task so the repo is left clean.

**macOS + Zed only.** Requires Accessibility permission for the app that runs
`wt` (Zed itself, when run from its integrated terminal). If it isn't granted,
`wt agent` opens the _Privacy & Security → Accessibility_ settings pane and waits
for you to grant it and confirm, then retries automatically.

**Orca (`ide: orca`).** Instead of the Zed automation, it registers the repo
(`orca repo add --path <repoRoot>`) and starts the agent in a terminal attached
to the worktree (`orca terminal create --worktree path:<worktree> --command
'<agent_command> --permission-mode <mode> --model <model> '\''<plan_prompt>'\'''`) — the exact
same command string the Zed path builds. No keymap or Accessibility needed. A
launch counts as started only when `orca terminal create` exits 0 **and** its
JSON reports `ok: true`. If Orca's runtime is not running it launches it (`orca
open`) and polls `orca status` for a few seconds; it proceeds once reachable,
and only falls back to an actionable error if it never comes up. Interactive
`wt agent`/`wt create` runs also switch Orca to the new terminal (best-effort,
via `orca terminal switch`); the `agent-spawner` daemon does not (avoids
stealing focus on each dispatch).

On other platforms, or when `ide` is neither `zed` nor `orca`, the worktree is
still created and opened, but the agent is not auto-started.

Over SSH it still works, provided the same user has an active graphical login on
the Mac: the keystroke is run inside the GUI session via Launch Services
(`open -a Terminal` briefly flashes a Terminal window). Grant Accessibility to
Terminal (not Zed) the first time. With no one logged in graphically there is
nothing to drive, so it falls back to the manual "press the chord in Zed"
message.

If the worktree path already exists, `wt agent` prompts you to **open it in the
IDE**, **open it and start the agent**, or **quit** — instead of erroring. With
nobody to answer that prompt (a piped or scripted run, or the `agent-spawner`
daemon) it starts the agent in the existing worktree, which is what a human
picks there. `wt create` has no agent to fall back on, so a non-interactive run
still errors with a non-zero exit.

### `wt prune`

Remove every worktree whose branch has already been merged into the base
branch (`base_branch`, default `origin/main`), **or** whose PR/MR was closed
without merging (dead branch). Each candidate is confirmed
individually — and force-confirmed when git refuses (submodules / uncommitted
changes), exactly like a manual `d` delete. The branch itself is left intact;
only the worktree is removed.

The current worktree (the one you ran `wt` from) is pruned like any other — the
behaviour does not depend on your launch directory. Only `main` is protected. If
prune (or `d`) removes the worktree you're standing in, your shell is left in a
directory that no longer exists; a warning printed as `wt` returns to the shell
says so and suggests a still-existing directory to `cd` into. The per-branch
confirmation is the guard before that happens.

Every worktree removal (prune **and** the TUI `d` key) first best-effort stops
the worktree's Orca agent/terminal (`orca terminal stop --worktree
path:<worktree>`), before `teardown_commands` and before `git worktree remove` —
a live agent PTY inside the worktree would otherwise keep it busy. It only
probes `orca status` and never launches Orca; if Orca is down, not installed, or
never saw that worktree (e.g. a Zed worktree), it is a silent no-op and can
never fail a deletion.

```bash
wt prune   # review and remove merged worktrees, one prompt per branch
```

Detection uses four signals; any one is enough, and the two offline ones run
first so the network is often not touched at all.

1. **Patch id** (`git cherry`, offline): every commit on the branch already has
   a patch-equivalent in base — a single-commit branch **squash-merged** through
   a PR, or a rebase-merge.
2. **No unique commits** (offline): the branch adds nothing base doesn't have —
   a **fast-forward / merge-commit** merge, or a branch sitting on base's tip.
   Git cannot tell that apart from a fresh worktree holding only *uncommitted*
   work, so this only counts when the worktree is **clean** and the branch was
   **pushed**. (Consequence: a never-pushed worktree is never pruned on this
   path, even if abandoned.)
3. **Merged PR/MR on the forge** (via `gh` for GitHub, `glab` for GitLab incl.
   self-hosted, auto-detected from the remote). Required when the forge rebased
   the squash onto a newer base: the patch id then matches nothing and the
   branch is still *ahead* of base, so neither offline signal fires.
4. **Closed-unmerged PR/MR** on the forge — the branch is dead (the fix landed
   another way). Like (3) it does no git ancestry checks, so it too can prune a
   branch ahead of base. It requires that **no** PR/MR from the same branch is
   still open: closing a PR and opening a fresh one from the same branch is
   routine, and the superseded PR must not read as a death notice for a branch
   that is still in review.

(3) and (4) only count a PR/MR whose target branch is the configured
`base_branch`, so a branch merged into `develop` is not prunable against `main`.
Both are skipped for never-pushed branches, and every signal fails closed
(CLI missing, offline, unresolvable base ref ⇒ not pruned). `wt prune`
best-effort fetches the remote first so detection sees up-to-date refs. Because
the forge is matched by **branch name**, a branch recreated under the name of an
old merged/closed PR can be flagged — the per-branch confirmation prompt is the
backstop. Always runs across all registered repos (each against its own
`base_branch`). The TUI exposes the same action under the `p` key.

Once at least one worktree is removed, prune fast-forwards each affected repo's
**main worktree** (`git pull --ff-only`) so the primary checkout picks up the
merged changes. It only ever fast-forwards — never fabricating a merge/conflict
in the primary checkout — and skips-with-a-note (never fails the prune) when the
main worktree isn't on `base_branch`, has uncommitted changes, has no matching
remote, or the fast-forward fails (message surfaced, pull manually). Pass
`--no-pull` to skip it; the TUI `p` key **always** auto-pulls (`--no-pull` is
CLI-only).

### `wt count`

Print the total number of worktrees across every registered repo, plus a
per-repo breakdown (sorted by count descending, then repo name). Only linked
worktrees count — each repo's main checkout doesn't. Every registered repo gets
a row, including one with zero linked worktrees.

```bash
wt count
```

```
Total: 4 worktrees

  forest     2
  overload   1
  website    1
```

### `wt config`

Open the global config file in `$EDITOR` (defaults to `nano`). The file is
rewritten tab-indented before the editor opens. If the JSON is still invalid
when the editor closes, the parse error is printed and the command **exits
1** so you know to reopen and fix it.

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
| `setup_commands`      | `string[]` | `[]`                              | Commands to run in a new worktree after creation (e.g. `["npm install"]`). Supports `{{…}}` templating                                                                    |
| `teardown_commands`   | `string[]` | `[]`                              | Commands to run in a worktree just before it is deleted (e.g. `["docker compose down -v"]`); on failure you are prompted whether to delete anyway. Supports `{{…}}` templating |
| `ide`                 | `string`   | `"zed"`                           | Where to open worktrees / start the agent: `zed` (editor + task automation) or `orca` (via the Orca CLI). Override per run with `--ide` on `create`/`agent`               |
| `ide_open_args`       | `string[]` | `["-n"]`                          | Arguments passed to the IDE command (ignored for `ide: orca`, which uses the Orca CLI)                                                                                     |
| `agent_command`       | `string`   | `"claude"`                        | Base command `wt agent` runs in Zed; `--permission-mode <mode>` is injected (any existing one replaced). Supports `{{…}}` templating, including `{{prompt}}`: if present, the plan prompt is substituted there; if absent, `<plan_prompt>` is appended single-quoted |
| `agent_mode`          | `string`   | `"default"`                       | Default Claude Code permission mode for `wt agent`; the `--mode` flag overrides it. One of `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`        |
| `agent_model`         | `string`   | `""`                              | Model passed to the agent as `--model`; empty = not passed (Claude Code default)                                                                                          |
| `agent_trigger_chord` | `string`   | `"ctrl-shift-cmd-c"`              | Zed keymap chord `wt agent` installs/presses to spawn the agent task                                                                                                      |
| `auto_refresh_minutes`| `number`   | `5`                               | How often the interactive list (`wt`) re-fetches worktrees and updates the "last refreshed" header; `0` disables auto-refresh. **Global only** — not per-repo overridable |
| `repos`               | `string[]` | `[]`                              | Registered repo paths (auto-populated on first use)                                                                                                                       |
| `repo_overrides`      | `object`   | `{}`                              | Per-repo config overrides (see below)                                                                                                                                     |

### Per-repo overrides

Override any field (`worktree_path`, `base_branch`, `setup_commands`, `teardown_commands`, `ide`, `ide_open_args`, `agent_command`, `agent_mode`, `agent_model`, `agent_trigger_chord`) for a specific repo. `auto_refresh_minutes` is global-only and cannot be overridden per repo:

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

### Command templating

`setup_commands`, `teardown_commands`, and `agent_command` are expanded for
`{{…}}` placeholders just before they run. Whitespace inside the braces is
allowed (`{{ branch }}` == `{{branch}}`) and names are case-sensitive. An
unknown or unavailable variable is left **verbatim** (never blanked out).
Values are inserted raw (no shell-escaping), so quote them yourself if a value
could contain spaces.

| Variable        | Expands to                              | Available in                                     |
| --------------- | --------------------------------------- | ------------------------------------------------ |
| `{{branch}}`    | The worktree's branch name              | `setup_commands`, `teardown_commands`, `agent_command` |
| `{{project}}`   | The repo directory name (basename)      | `setup_commands`, `teardown_commands`, `agent_command` |
| `{{path}}`      | Absolute path to the worktree           | `setup_commands`, `teardown_commands`, `agent_command` |
| `{{repo_root}}` | Absolute path to the repo root          | `setup_commands`, `teardown_commands`, `agent_command` |
| `{{prompt}}`    | The agent plan prompt                   | `agent_command` only                             |

In `agent_command`, `{{prompt}}` is replaced by the plan prompt: if you include
it, the prompt is placed exactly there (and is **not** also auto-appended). If
you omit `{{prompt}}`, the prompt is appended automatically (single-quoted) at
the end, as before.

```json
{
  "agent_command": "claude --remote-control {{branch}}",
  "setup_commands": ["direnv allow {{path}}"]
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

### Pass the branch to your agent (templating)

```bash
wt config
# Then set:
# "agent_command": "claude --remote-control {{branch}}"
```

`wt agent feature/login '…'` now runs `claude --remote-control feature/login …`.

### Browse all worktrees across repos

Run `wt` from anywhere — it always lists worktrees from all registered repos.
