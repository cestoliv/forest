# `wt agent --model` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `--model <model>` flag (with a matching per-repo `agent_model` config key) to `wt agent` that injects `--model <model>` into the `claude` command line for a run.

**Architecture:** Thread `model` through the exact same seams `mode` already uses — `cli.ts` → `createAgentWorktree` (agent.ts) → `startAgentInWorktree` → the Zed (`buildAgentTask`) and Orca (`buildAgentCommandLine`) paths — plus the `agent-api.ts` daemon seam. The single command-string source of truth, `buildAgentCommandLine` (orca.ts), injects `--model` right after its existing `--permission-mode` handling. No validation (open string); no TUI wizard step.

**Tech Stack:** Node/TypeScript (ESM, `.js` import extensions), Commander, Vitest (single-fork, serial), Biome.

## Global Constraints

- **ESM-only:** all internal imports use `.js` extensions even for `.ts` sources.
- **No validation of model:** any non-empty string passes through; empty/unset means "do not inject `--model`". This is deliberately unlike `--mode` (a closed `VALID_MODES` enum).
- **Default unchanged:** when the resolved model is empty, the built command line must be byte-for-byte identical to today.
- **Precedence:** `--model` flag → `agent_model` config → `''` (unset).
- **Biome style:** single quotes, 2-space indent, trailing commas (all). `npm run lint`, `npm test`, and `npm run build` must all pass.
- **Commit policy (user's global git rule — overrides the writing-plans "Commit" step):** do **NOT** create commits during execution. Each task ends by running lint + tests as its checkpoint; the user commits/amends the single branch commit themselves when they decide the feature is done. Never run `git commit`.
- All paths below are relative to `packages/cli/`.

---

### Task 1: Add the `agent_model` config key

**Files:**
- Modify: `src/wt/lib/config.ts:6-16` (`RepoConfig` interface), `src/wt/lib/config.ts:25-38` (`DEFAULT_CONFIG`)
- Test: `src/wt/lib/config.test.ts`

**Interfaces:**
- Produces: `RepoConfig.agent_model: string`; `DEFAULT_CONFIG.agent_model = ''`. Because it lives on `RepoConfig` (not the `WtConfig`-only keys), `getEffectiveConfig` merges per-repo overrides for it automatically.

- [ ] **Step 1: Write the failing test**

In `src/wt/lib/config.test.ts`, add a test asserting the default and per-repo override behavior. Match the existing test style in that file (it uses a temp `createStore(cwd)` / `getEffectiveConfig`).

```typescript
it('agent_model defaults to empty and is per-repo overridable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-cfg-'));
  const store = createStore(dir);
  expect(getEffectiveConfig('/some/repo', store).agent_model).toBe('');

  setGlobalConfig(
    { repo_overrides: { '/some/repo': { agent_model: 'fable' } } },
    store,
  );
  expect(getEffectiveConfig('/some/repo', store).agent_model).toBe('fable');
  expect(getEffectiveConfig('/other/repo', store).agent_model).toBe('');
});
```

(Reuse whatever imports the file already has — `createStore`, `getEffectiveConfig`, `setGlobalConfig`, `fs`, `os`, `path`. Add only those not already imported.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/wt/lib/config.test.ts`
Expected: FAIL — `agent_model` is `undefined`, not `''`.

- [ ] **Step 3: Add the field and default**

In `src/wt/lib/config.ts`, add to the `RepoConfig` interface (after `agent_mode: string;`):

```typescript
  agent_model: string;
```

And in `DEFAULT_CONFIG`, after `agent_mode: 'default',`:

```typescript
  agent_model: '',
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/wt/lib/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint (no commit)**

Run: `npm run lint && npx vitest run src/wt/lib/config.test.ts`
Expected: lint clean, tests pass. Do **not** commit.

---

### Task 2: Inject `--model` in `buildAgentCommandLine`

**Files:**
- Modify: `src/wt/lib/orca.ts:31-52` (`buildAgentCommandLine`) and its doc comment `src/wt/lib/orca.ts:16-30`
- Test: `src/wt/lib/orca.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildAgentCommandLine(agentCommand: string, prompt: string, mode?: string, appendPrompt = true, model?: string): string`. When `model` is a non-empty string, strips any existing `--model <x>` from the base command and appends `--model <model>`, mirroring the `--permission-mode` handling. `model` is the **5th** parameter (after `appendPrompt`) so existing 4-arg callers keep working.

- [ ] **Step 1: Write the failing tests**

In `src/wt/lib/orca.test.ts`, in the `buildAgentCommandLine` describe block, add:

```typescript
it('injects --model when a model is provided', () => {
  expect(buildAgentCommandLine('claude', 'hi', undefined, true, 'fable')).toBe(
    "claude --model fable 'hi'",
  );
});

it('omits --model when model is empty or undefined', () => {
  expect(buildAgentCommandLine('claude', 'hi', undefined, true, '')).toBe(
    "claude 'hi'",
  );
  expect(buildAgentCommandLine('claude', 'hi')).toBe("claude 'hi'");
});

it('de-duplicates an existing --model flag', () => {
  expect(
    buildAgentCommandLine('claude --model opus', 'hi', undefined, true, 'fable'),
  ).toBe("claude --model fable 'hi'");
});

it('injects --permission-mode and --model together', () => {
  expect(buildAgentCommandLine('claude', 'hi', 'auto', true, 'fable')).toBe(
    "claude --permission-mode auto --model fable 'hi'",
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/wt/lib/orca.test.ts -t "model"`
Expected: FAIL — `--model` never appears (extra arg ignored).

- [ ] **Step 3: Implement the injection**

Replace the body of `buildAgentCommandLine` in `src/wt/lib/orca.ts`. Add the `model` parameter and inject after the existing mode block:

```typescript
export function buildAgentCommandLine(
  agentCommand: string,
  prompt: string,
  mode?: string,
  appendPrompt = true,
  model?: string,
): string {
  let finalCommand = agentCommand;

  // Only modify the command if a mode is explicitly provided.
  if (mode) {
    // Remove any existing --permission-mode flag to avoid duplicates.
    const baseCommand = finalCommand
      .replace(/--permission-mode\s+\S+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    finalCommand = `${baseCommand} --permission-mode ${mode}`.trim();
  }

  // Only modify the command if a model is explicitly provided (non-empty).
  if (model) {
    // Remove any existing --model flag to avoid duplicates.
    const baseCommand = finalCommand
      .replace(/--model\s+\S+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    finalCommand = `${baseCommand} --model ${model}`.trim();
  }

  return appendPrompt
    ? `${finalCommand} '${prompt.replace(/'/g, "'\\''")}'`
    : finalCommand;
}
```

Note the mode block now reads/writes `finalCommand` (not `agentCommand`) so the two injections compose. Update the doc comment (lines 16-30) to mention that `--model <model>` is likewise injected (existing one removed) when a non-empty `model` is given.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/wt/lib/orca.test.ts`
Expected: PASS (new model tests + all existing mode/prompt tests unchanged).

- [ ] **Step 5: Checkpoint (no commit)**

Run: `npm run lint && npx vitest run src/wt/lib/orca.test.ts`
Expected: lint clean, tests pass. Do **not** commit.

---

### Task 3: Thread `model` through zed, agent, create, agent-api, and cli

**Files:**
- Modify: `src/wt/lib/zed.ts:67-90` (`buildAgentTask`) and doc comment `src/wt/lib/zed.ts:60-66`
- Modify: `src/wt/commands/create.ts` (`CreateOptions` interface — add `model?: string`)
- Modify: `src/wt/commands/agent.ts` (`createAgentWorktree` resolve + thread; `startAgentInWorktree` + `startAgentInOrcaWorktree` signatures + call sites)
- Modify: `src/wt/agent-api.ts:9-18` (`RunAgentOptions`) and `:30-40` (forward into `createAgentWorktree`)
- Modify: `src/wt/cli.ts:37-64` (agent command `--model` option + pass-through)
- Test: `src/wt/lib/zed.test.ts`, `src/wt/commands/agent.test.ts`

**Interfaces:**
- Consumes: `buildAgentCommandLine(..., model?)` from Task 2; `RepoConfig.agent_model` from Task 1.
- Produces:
  - `buildAgentTask(agentCommand, prompt, label, mode?, appendPrompt?, model?)` — forwards `model` to `buildAgentCommandLine`.
  - `CreateOptions.model?: string`.
  - `RunAgentOptions.model?: string`.
  - Resolution in `createAgentWorktree`: `const model = options.model ?? config.agent_model ?? '';` passed into `startAgentInWorktree(config, worktreePath, planPrompt, mode, model, branch, repoRoot, report, focus)` and onward.

- [ ] **Step 1: Write the failing zed test**

In `src/wt/lib/zed.test.ts`, in the `buildAgentTask` describe block, add:

```typescript
it('forwards model into the command line', () => {
  const task = buildAgentTask('claude', 'hi', 'wt-agent', 'auto', true, 'fable');
  expect(task.command).toBe("claude --permission-mode auto --model fable 'hi'");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/wt/lib/zed.test.ts -t "forwards model"`
Expected: FAIL — model not in command.

- [ ] **Step 3: Add `model` to `buildAgentTask`**

In `src/wt/lib/zed.ts`, change the signature and the `buildAgentCommandLine` call:

```typescript
export function buildAgentTask(
  agentCommand: string,
  prompt: string,
  label: string,
  mode?: string,
  appendPrompt = true,
  model?: string,
): ZedTask {
  const command = buildAgentCommandLine(
    agentCommand,
    prompt,
    mode,
    appendPrompt,
    model,
  );
```

(Leave the rest of the returned `ZedTask` object unchanged.) Update the doc comment (lines 60-66) to note it also injects `--model <model>`.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/wt/lib/zed.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `model?` to `CreateOptions`**

In `src/wt/commands/create.ts`, find the `CreateOptions` interface and add a field alongside `mode?`/`ide?` (keep the surrounding doc-comment style):

```typescript
  /** Model to run the agent on (e.g. `fable`, `opus`); overrides `agent_model`. */
  model?: string;
```

- [ ] **Step 6: Thread `model` through `agent.ts`**

In `src/wt/commands/agent.ts`, in `createAgentWorktree`, after the `mode` resolution block (around line 118), add:

```typescript
  // Resolve the model: --model flag → configured agent_model → unset ('').
  // No validation (open string); empty means "don't inject --model".
  const model = options.model ?? config.agent_model ?? '';
```

Update the `startAgentInWorktree` call (around line 129) to pass `model` right after `mode`:

```typescript
  const started = await startAgentInWorktree(
    config,
    worktreePath,
    planPrompt,
    mode,
    model,
    resolvedBranch,
    repoRoot,
    report,
    focus,
  );
```

Change `startAgentInWorktree`'s signature to accept `model: string` after `mode: string`, and update its internal call to `startAgentInOrcaWorktree(config, worktreePath, planPrompt, mode, model, branch, repoRoot, report, focus)`.

In the Zed branch of `startAgentInWorktree`, pass `model` into `buildAgentTask`:

```typescript
  const task = buildAgentTask(
    command,
    planPrompt,
    AGENT_TASK_LABEL,
    mode,
    appendPrompt,
    model,
  );
```

Change `startAgentInOrcaWorktree`'s signature to accept `model: string` after `mode: string`, and pass it into `buildAgentCommandLine`:

```typescript
  const commandLine = buildAgentCommandLine(
    command,
    planPrompt,
    mode,
    appendPrompt,
    model,
  );
```

- [ ] **Step 7: Thread `model` through `agent-api.ts`**

In `src/wt/agent-api.ts`, add to `RunAgentOptions`:

```typescript
  /** Model to run the agent on; overrides the configured `agent_model`. */
  model?: string;
```

And in the `createAgentWorktree` call inside `runAgent`, add `model: opts.model,` alongside `mode: opts.mode,`.

- [ ] **Step 8: Add the `--model` CLI flag**

In `src/wt/cli.ts`, on the `agent` command, add the option after `--mode`:

```typescript
  .option(
    '--model <model>',
    'Model to run the agent on (e.g. fable, opus); overrides the configured agent_model',
  )
```

Widen the action's `options` type to include `model?: string` and pass it through:

```typescript
    async (
      branch: string,
      planPrompt: string,
      options: { mode?: string; model?: string; repo?: string; ide?: string },
    ) => {
      const { createAgentWorktree } = await import('./commands/agent.js');
      await createAgentWorktree(branch, planPrompt, {
        mode: options.mode,
        model: options.model,
        repoRoot: options.repo,
        ide: options.ide,
        focus: true,
      });
    },
```

- [ ] **Step 9: Write the failing agent thread-through test**

In `src/wt/commands/agent.test.ts`, follow the file's existing pattern for driving `createAgentWorktree` with an injected store and a fake IDE path that captures the built command (inspect the file first — reuse its existing harness/mocks rather than inventing new ones). Add tests asserting:
- `--model` flag reaches the built command line (`options.model = 'fable'` → command contains `--model fable`).
- `agent_model` config is used when the flag is absent.
- the flag wins over config.
- empty resolution injects no `--model`.

Write the test using the same mocking approach the neighboring `mode` tests in that file already use. If the file has no such capture harness, assert at the highest seam it does cover (e.g. spy on `buildAgentTask`/`buildAgentCommandLine`) — do not add real Zed/Orca side effects.

- [ ] **Step 10: Run it to verify it fails**

Run: `npx vitest run src/wt/commands/agent.test.ts -t "model"`
Expected: FAIL before the threading is complete (or PASS immediately if steps 5-8 are already in — in that case confirm the test genuinely exercises the flag by temporarily reverting one seam).

- [ ] **Step 11: Run the full suite**

Run: `npm test`
Expected: PASS — all existing + new tests.

- [ ] **Step 12: Checkpoint (no commit)**

Run: `npm run lint && npm test && npm run build`
Expected: lint clean, tests pass, build succeeds. Do **not** commit.

---

### Task 4: Documentation

**Files:**
- Modify: `packages/cli/CLAUDE.md` (the `wt agent` command bullet under "CLI Usage" and "Entry point & commands"; the config-schema / "always global" area listing `agent_mode`; the command-line-injection description)
- Modify: `packages/cli/README.md` (the `wt agent` signature line ~51, the examples ~44-57, the modes/config paragraph ~76-77, the config table ~260)
- Modify: `packages/cli/SKILL.md` (the `wt agent` signature line ~59, examples ~66-70, the `--mode` paragraph ~77-78, the injected-command-line note ~91/103, the config table ~222)

**Interfaces:**
- Consumes: the finished behavior from Tasks 1-3.
- Produces: docs only. No code, no tests.

- [ ] **Step 1: Update `packages/cli/CLAUDE.md`**

- In the `## Commands` → CLI Usage block, extend the `wt agent` line to document `--model <model>`: "Model to run the agent on (e.g. `fable`, `opus`); overrides the `agent_model` config key. When omitted (and `agent_model` unset), no `--model` is passed and Claude Code uses its default."
- Where the `agent_mode` config default is described, add `agent_model` (default `''`, per-repo overridable, empty = no `--model` injected).
- Where the injected command line is described (`buildAgentCommandLine` / `--permission-mode`), note `--model <model>` is injected the same way (existing `--model` de-duplicated) when non-empty.

- [ ] **Step 2: Update `packages/cli/README.md`**

- Add `[--model <model>]` to the `wt agent` signature heading (line ~51).
- Add an example: `wt agent big-refactor "Plan the refactor" --model fable   # use a bigger model for one run`.
- In the "Available modes" area, add a short "Model" note: `--model` overrides the `agent_model` config key (default unset → Claude Code's own default); any model string is accepted.
- Add an `agent_model` row to the config table (line ~260 area): default `""`, "Model passed to the agent as `--model`; empty = not passed (Claude Code default)".

- [ ] **Step 3: Update `packages/cli/SKILL.md`**

- Add `[--model <model>]` to the `wt agent` signature (line ~59).
- Add an example mirroring the README one (line ~66-70 block).
- Extend the `--mode` paragraph (line ~77-78) with a `--model` sentence.
- Update the injected-command-line note (`<agent_command> --permission-mode <mode> '<plan_prompt>'`, lines ~91/103) to include `--model <model>` when set.
- Add an `agent_model` row to the config table (line ~222 area): type `string`, default `""`, same description as README.

- [ ] **Step 4: Verify docs build / no broken references**

Run: `npm run build`
Expected: PASS — `SKILL.md` is embedded via `__WT_SKILL__`; a successful build confirms it's still valid.

- [ ] **Step 5: Checkpoint (no commit)**

Run: `npm run lint && npm test && npm run build`
Expected: all green. Do **not** commit. Report completion to the user for their review; they will decide when to commit the single branch commit.
