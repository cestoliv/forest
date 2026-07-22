# `wt agent --model` — override the agent's model

## Problem

`wt agent <branch> <plan_prompt>` starts a Claude Code agent using whatever
model Claude Code defaults to. There is no way to run a single agent on a
different model — e.g. reaching for a bigger model exceptionally for a large
task — short of editing `agent_command` in config.

## Goal

Add a `--model <model>` flag to `wt agent` that injects `--model <model>` into
the `claude` command line for that run, plus a matching `agent_model` config
key (per-repo overridable) that acts as the default when the flag is omitted.

This mirrors the existing `--mode` / `agent_mode` mechanism at every seam.

## Decisions

- **Config fallback:** add an `agent_model` config key, per-repo overridable —
  fully consistent with `agent_mode`. Precedence: `--model` flag → `agent_model`
  config → unset.
- **Validation:** none. Any string passes through (`fable`, `opus`, `sonnet`,
  `haiku`, full ids like `claude-opus-4-8`, …). Model aliases change often and
  Claude Code validates them itself. This differs from `--mode`, which is a
  closed enum (`VALID_MODES`).
- **TUI:** no new wizard step. The `A` (agent) wizard stays worktree → plan →
  mode. A TUI-launched agent still honours `agent_model` through the config
  fallback in `createAgentWorktree` (exactly as `agent_mode` already works
  there), so the config key is respected everywhere without lengthening the
  interactive path.

## Behaviour

- `wt agent feat/x "plan" --model fable` runs the agent on `fable` for that run.
- When neither `--model` nor `agent_model` is set (the default — `agent_model`
  defaults to `''`), **no** `--model` flag is injected and the command line is
  byte-for-byte unchanged from today (Claude Code uses its own default model).
- `--model` and `--mode` compose: the injected command line is
  `claude --permission-mode <mode> --model <model> '<prompt>'`.
- An existing `--model <x>` already present in `agent_command` is stripped
  before injection to avoid duplicates (same as `--permission-mode`).

## Changes

Threaded to parallel `mode` at every seam:

- **`lib/config.ts`** — add `agent_model: string` to `RepoConfig` (so
  `getEffectiveConfig` merges per-repo overrides). Default `agent_model: ''` in
  `DEFAULT_CONFIG`. Empty string means "do not pass `--model`".
- **`lib/orca.ts` `buildAgentCommandLine`** — add a `model?: string` parameter.
  When non-empty, strip any existing `--model\s+\S+` from the base command and
  inject `--model <model>`, identically to the `--permission-mode` handling.
  Both flags can be injected together (`--permission-mode` first, then
  `--model`). This is the single source of truth for the command string
  (Zed + Orca), so both paths stay byte-for-byte identical.
- **`lib/zed.ts` `buildAgentTask`** — add a `model?: string` parameter, forward
  it to `buildAgentCommandLine`.
- **`commands/create.ts` `CreateOptions`** — add `model?: string`.
- **`commands/agent.ts` `createAgentWorktree`** — resolve
  `const model = options.model ?? config.agent_model ?? ''`. No validation step
  (unlike mode — model is open). Thread `model` into `startAgentInWorktree`,
  and from there into both the Zed path (`buildAgentTask`) and
  `startAgentInOrcaWorktree` (`buildAgentCommandLine`).
- **`agent-api.ts` `RunAgentOptions`** — add `model?: string`, forward into
  `createAgentWorktree` so the in-process daemon seam can pass it (no new daemon
  caller required as part of this change; the seam just stays complete).
- **`cli.ts`** — add `--model <model>` option to the `agent` command
  (description: "Model to run the agent on (e.g. fable, opus); overrides the
  configured agent_model"), pass `model: options.model` into
  `createAgentWorktree`.

Model is **injected** by `buildAgentCommandLine`, not exposed as a `{{…}}`
template variable — same as `mode`. No `template.ts` change.

## Tests

- `lib/orca.test.ts` — `buildAgentCommandLine`: model injected when non-empty;
  omitted when empty/undefined (command unchanged); an existing `--model` is
  de-duplicated; `--model` and `--permission-mode` coexist correctly.
- `lib/zed.test.ts` — `buildAgentTask` forwards `model` into the command.
- `commands/agent.test.ts` — `--model` flag and `agent_model` config fallback
  both reach the built command line; flag wins over config; empty resolves to
  no `--model`.

## Docs

- `packages/cli/CLAUDE.md` — the `wt agent` command bullet (new `--model` flag),
  the config schema section (new `agent_model` key), and the "Command
  templating" / command-line-injection description if it enumerates injected
  flags.
- `packages/cli/README.md` — the `wt agent` usage / flags.
- `packages/cli/SKILL.md` — the agent command reference (flags + config key).

## Out of scope

- No TUI wizard step for model.
- No validation / fixed model list.
- No new `agent-spawner` routing field for model (the `agent-api` seam accepts
  it, but wiring a per-route model into the daemon is a separate change).
