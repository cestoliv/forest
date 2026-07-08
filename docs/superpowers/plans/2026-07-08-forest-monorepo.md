# Forest Monorepo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge `worktrees`, `agent-spawner`, and `ide-toggler` into one `forest` repository — the two Node CLIs as a single npm package `@cestoliv/forest` (bins `wt` + `agent-spawner`), `ide-toggler` as a native app with its own pipeline — preserving git history for the two tools that have repos.

**Architecture:** Plain polyglot monorepo (no workspace tooling): `packages/cli/` holds the one combined npm package; `apps/ide-toggler/` holds the native app. History is preserved via `git-filter-repo` path rewrites + `--allow-unrelated-histories` merges. The daemon calls `wt`'s agent flow in-process via a new library-safe `runAgent`, replacing the old subprocess call. CI is a single path-aware workflow with one required aggregator gate.

**Tech Stack:** Node 20+ / TypeScript / tsup / biome / vitest (CLI); Swift/SwiftPM + GNOME JS + Python (ide-toggler); GitHub Actions; git-filter-repo.

## Global Constraints

- **Node engine floor:** `>=20`. CI uses Node 24 for publish (OIDC needs npm ≥ 11.5.1).
- **Combined package name:** `@cestoliv/forest`, version starts at `0.1.0`, `"type": "module"`, `publishConfig.access = "public"`.
- **Bins:** exactly `{ "wt": "./dist/wt.js", "agent-spawner": "./dist/spawner.js" }`.
- **Build define:** a single `__VERSION__` global (replaces `__WT_VERSION__` and `__AS_VERSION__`); keep `__WT_SKILL__`.
- **Source layout inside the package:** `packages/cli/src/wt/`, `packages/cli/src/spawner/`, `packages/cli/src/shared/`. Relative imports within each tree are unchanged because whole trees move together.
- **ide-toggler release tag scheme:** `ide-toggler-v*` (never bare `v*`).
- **Commit policy (overrides the writing-plans default):** do all work on a branch `chore/forest-monorepo`. Tasks 1–3 intrinsically create commits (git history merges — that is their deliverable). Tasks 4–9 must **not** auto-commit; they accumulate in the working tree and each ends with a verification gate. The user commits/amends when ready. Never commit to `main`.
- **No workspace tooling** (no pnpm/turbo/nx). Do not add a root `package.json`.
- **Scratchpad for throwaway clones:** `/private/tmp/claude-501/-Users-cestoliv-Documents-Development-forest/f95b2105-91dc-4cc3-bc18-c12c144f8195/scratchpad`.

---

### Task 1: Scaffold `forest` + import `worktrees` history into `packages/cli/`

**Files:**
- Create: `/Users/cestoliv/Documents/Development/forest/.gitignore`
- Create: `/Users/cestoliv/Documents/Development/forest/README.md` (placeholder; finalized in Task 8)
- Import (history-preserving): all of `worktrees` → `packages/cli/` with `src/` → `src/wt/`

**Interfaces:**
- Produces: `packages/cli/package.json`, `packages/cli/src/wt/**` (was `worktrees/src/**`), `packages/cli/SKILL.md`, `packages/cli/{biome.json,tsconfig.json,tsup.config.ts,vitest.config.ts,CLAUDE.md,README.md}`.

- [ ] **Step 1: Ensure git-filter-repo is available**

Run:
```bash
git filter-repo --version || brew install git-filter-repo || pipx install git-filter-repo
git filter-repo --version
```
Expected: prints a version (e.g. `git-filter-repo 2.x`).

- [ ] **Step 2: Initialize the forest repo on the work branch**

Run:
```bash
cd /Users/cestoliv/Documents/Development/forest
git init -b main
printf '%s\n' 'node_modules/' 'dist/' '.build/' '__pycache__/' '*.pyc' '.DS_Store' '.claude/' > .gitignore
printf '%s\n' '# forest' '' 'Monorepo for wt / agent-spawner (packages/cli) and ide-toggler (apps/ide-toggler).' > README.md
git add .gitignore README.md
git commit -m "chore: initialize forest monorepo"
git checkout -b chore/forest-monorepo
```
Expected: initial commit created; now on branch `chore/forest-monorepo`.

- [ ] **Step 3: Filter a fresh worktrees clone into the target layout**

Run:
```bash
SCRATCH=/private/tmp/claude-501/-Users-cestoliv-Documents-Development-forest/f95b2105-91dc-4cc3-bc18-c12c144f8195/scratchpad
rm -rf "$SCRATCH/worktrees-clone"
git clone /Users/cestoliv/Documents/Development/worktrees "$SCRATCH/worktrees-clone"
cd "$SCRATCH/worktrees-clone"
git filter-repo --path-rename src/:src/wt/
git filter-repo --to-subdirectory-filter packages/cli
git ls-files | grep -E 'packages/cli/(package.json|src/wt/cli.ts)'
```
Expected: lists `packages/cli/package.json` and `packages/cli/src/wt/cli.ts` (history rewritten so files live under the new prefix).

- [ ] **Step 4: Merge the filtered history into forest**

Run:
```bash
cd /Users/cestoliv/Documents/Development/forest
git remote add wt-src "$SCRATCH/worktrees-clone"
git fetch wt-src
git merge --allow-unrelated-histories --no-edit wt-src/main
git remote remove wt-src
```
Expected: merge commit created; no conflicts (imported paths are all new).

- [ ] **Step 5: Verify history and layout survived**

Run:
```bash
cd /Users/cestoliv/Documents/Development/forest
test -f packages/cli/src/wt/cli.ts && echo "LAYOUT OK"
git log --oneline -- packages/cli/src/wt/commands/agent.ts | head -3
```
Expected: prints `LAYOUT OK` and multiple historical commits for the moved `agent.ts` (proves `git log` follows the relocated file).

---

### Task 2: Import `ide-toggler` history into `apps/ide-toggler/`

**Files:**
- Import (history-preserving): all of `ide-toggler` → `apps/ide-toggler/` (internal `macos/`, `linux/`, `docs/` unchanged)

**Interfaces:**
- Produces: `apps/ide-toggler/macos/**`, `apps/ide-toggler/linux/**`, `apps/ide-toggler/README.md`.

- [ ] **Step 1: Filter a fresh ide-toggler clone under the app prefix**

Run:
```bash
SCRATCH=/private/tmp/claude-501/-Users-cestoliv-Documents-Development-forest/f95b2105-91dc-4cc3-bc18-c12c144f8195/scratchpad
rm -rf "$SCRATCH/ide-toggler-clone"
git clone /Users/cestoliv/Documents/Development/ide-toggler "$SCRATCH/ide-toggler-clone"
cd "$SCRATCH/ide-toggler-clone"
git filter-repo --to-subdirectory-filter apps/ide-toggler
git ls-files | grep -E 'apps/ide-toggler/(macos/Package.swift|linux/package.json)'
```
Expected: lists `apps/ide-toggler/macos/Package.swift` and `apps/ide-toggler/linux/package.json`.

- [ ] **Step 2: Merge the filtered history into forest**

Run:
```bash
cd /Users/cestoliv/Documents/Development/forest
git remote add ide-src "$SCRATCH/ide-toggler-clone"
git fetch ide-src
git merge --allow-unrelated-histories --no-edit ide-src/main
git remote remove ide-src
```
Expected: merge commit created; no conflicts.

- [ ] **Step 3: Verify history and layout**

Run:
```bash
cd /Users/cestoliv/Documents/Development/forest
test -f apps/ide-toggler/macos/Package.swift && echo "IDE LAYOUT OK"
git log --oneline -- apps/ide-toggler/linux/gnome-extension/ide-toggler@cestoliv.com/extension.js | head -3
```
Expected: prints `IDE LAYOUT OK` and historical commits for the extension file.

---

### Task 3: Add `agent-spawner` source into `packages/cli/src/spawner/`

**Files:**
- Create (copy, no history): `packages/cli/src/spawner/**` from `agent-spawner/src/**`
- Create: `packages/cli/config.example.json` (from `agent-spawner/config.example.json`)

**Interfaces:**
- Produces: `packages/cli/src/spawner/cli.ts`, `packages/cli/src/spawner/lib/dispatch.ts` (exports `dispatchTask`, `type SpawnAgent`, `type DispatchDeps`), `packages/cli/src/spawner/lib/config.ts` (exports `AgentSpawnerConfig`), and the rest of the daemon.

- [ ] **Step 1: Copy the agent-spawner source tree in**

Run:
```bash
cd /Users/cestoliv/Documents/Development/forest
mkdir -p packages/cli/src/spawner
cp -R /Users/cestoliv/Documents/Development/agent-spawner/src/. packages/cli/src/spawner/
cp /Users/cestoliv/Documents/Development/agent-spawner/config.example.json packages/cli/config.example.json
ls packages/cli/src/spawner/cli.ts packages/cli/src/spawner/lib/dispatch.ts
```
Expected: both paths listed.

- [ ] **Step 2: Verify no path collisions with the wt tree**

Run:
```bash
cd /Users/cestoliv/Documents/Development/forest
ls packages/cli/src
```
Expected: shows `wt` and `spawner` as sibling directories (each keeps its own `globals.d.ts`, `test-utils.ts` — no clash).

- [ ] **Step 3: Gate — nothing else changed yet**

Run:
```bash
cd /Users/cestoliv/Documents/Development/forest
git status --short packages/cli/src/spawner | head
```
Expected: the new spawner files appear as untracked (`??`). Do **not** commit (per commit policy).

---

### Task 4: Produce the combined package (`package.json`, configs, `__VERSION__`) and get it green

**Files:**
- Modify: `packages/cli/package.json` (merge in agent-spawner's needs, single version, two bins)
- Modify: `packages/cli/tsup.config.ts` (two named entries, unified define)
- Create: `packages/cli/src/globals.d.ts` (unified) ; Delete the two per-tree `globals.d.ts`
- Modify: source files referencing `__WT_VERSION__` / `__AS_VERSION__` → `__VERSION__`
- Keep: `packages/cli/{biome.json,tsconfig.json,vitest.config.ts}` (worktrees' versions; already cover `src/**`)

**Interfaces:**
- Consumes: Task 1 (`packages/cli/package.json`, wt configs), Task 3 (spawner source).
- Produces: a buildable single package whose `tsup` emits `dist/wt.js` + `dist/spawner.js`.

- [ ] **Step 1: Write the combined `package.json`**

Replace `packages/cli/package.json` with:
```json
{
  "name": "@cestoliv/forest",
  "version": "0.1.0",
  "description": "wt (git worktrees + AI agents) and agent-spawner (Todoist daemon) in one package.",
  "repository": { "type": "git", "url": "git+https://github.com/cestoliv/forest.git" },
  "engines": { "node": ">=20" },
  "type": "module",
  "bin": { "wt": "./dist/wt.js", "agent-spawner": "./dist/spawner.js" },
  "files": ["dist", "SKILL.md"],
  "publishConfig": { "access": "public" },
  "scripts": {
    "dev:wt": "tsx src/wt/cli.ts",
    "dev:spawner": "tsx src/spawner/cli.ts",
    "build": "tsup && chmod +x dist/wt.js dist/spawner.js",
    "prepublishOnly": "npm run build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "format": "biome format --write ."
  },
  "dependencies": {
    "@clack/prompts": "^1.0.1",
    "commander": "^14.0.3",
    "conf": "^15.1.0",
    "fuse.js": "^7.1.0",
    "jsonc-parser": "^3.3.1",
    "picocolors": "^1.1.1"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.4.4",
    "@types/node": "^22.0.0",
    "tsup": "^8.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.0.0",
    "vitest": "^4.1.0"
  }
}
```
(Note: agent-spawner's deps `commander`/`conf`/`picocolors` are already present; nothing new to add. vitest pinned to worktrees' `^4.1.0`.)

- [ ] **Step 2: Write the unified `tsup.config.ts`**

Replace `packages/cli/tsup.config.ts` with:
```ts
import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);

export default defineConfig({
  entry: { wt: 'src/wt/cli.ts', spawner: 'src/spawner/cli.ts' },
  format: ['esm'],
  target: 'node20',
  clean: true,
  shims: true,
  define: {
    __VERSION__: JSON.stringify(version),
    __WT_SKILL__: JSON.stringify(
      readFileSync(new URL('./SKILL.md', import.meta.url), 'utf8'),
    ),
  },
  banner: { js: '#!/usr/bin/env node' },
});
```
(The object `entry` form makes tsup emit `dist/wt.js` and `dist/spawner.js` — avoids the `cli.js` name collision.)

- [ ] **Step 3: Write the unified globals and delete the per-tree ones**

Create `packages/cli/src/globals.d.ts`:
```ts
declare const __VERSION__: string;
declare const __WT_SKILL__: string;
```
Run:
```bash
cd /Users/cestoliv/Documents/Development/forest/packages/cli
rm -f src/wt/globals.d.ts src/spawner/globals.d.ts
```

- [ ] **Step 4: Repoint version references to `__VERSION__`**

Run:
```bash
cd /Users/cestoliv/Documents/Development/forest/packages/cli
grep -rl '__WT_VERSION__\|__AS_VERSION__' src
```
For each file listed, replace `__WT_VERSION__` and `__AS_VERSION__` with `__VERSION__`. Then verify none remain:
```bash
grep -rn '__WT_VERSION__\|__AS_VERSION__' src ; echo "exit: $?"
```
Expected: no matches (grep exit 1).

- [ ] **Step 5: Install and run the full gate**

Run:
```bash
cd /Users/cestoliv/Documents/Development/forest/packages/cli
npm install
npm run lint
npm run typecheck
npm test
npm run build
ls dist/wt.js dist/spawner.js
```
Expected: lint/typecheck/test all pass (existing worktrees + agent-spawner tests still green — the daemon still uses its subprocess `spawnWtAgent` at this point), build emits both bins.

---

### Task 5: Make `wt agent` library-safe (`runAgent` + reporter, no `process.exit`)

**Files:**
- Create: `packages/cli/src/wt/agent-api.ts`
- Modify: `packages/cli/src/wt/commands/agent.ts` (thread `report`, throw instead of `process.exit`)
- Modify: `packages/cli/src/wt/commands/create.ts` (add `report?` to `CreateOptions`; only if the ide-not-zed/agent branches there log — see step 3)
- Modify: `packages/cli/src/wt/cli.ts` (agent command calls `runAgent`)
- Modify: `packages/cli/src/wt/commands/agent.test.ts` (2 assertions → reporter collector; add invalid-mode test)

**Interfaces:**
- Produces:
  ```ts
  export type Reporter = (msg: string) => void;
  export interface AgentResult { ok: boolean; output: string }
  export interface RunAgentOptions {
    repoPath: string; branch: string; prompt: string; mode?: string;
  }
  export function runAgent(opts: RunAgentOptions): Promise<AgentResult>;
  ```
  Task 6 (daemon) consumes `runAgent` + `AgentResult`.

- [ ] **Step 1: Add `report` to `CreateOptions` and thread it into the agent flow**

In `packages/cli/src/wt/commands/create.ts`, add to the `CreateOptions` interface:
```ts
  /** Sink for human-readable progress/error lines. Defaults to console. */
  report?: (msg: string) => void;
```

In `packages/cli/src/wt/commands/agent.ts`, at the top of `createAgentWorktree`, resolve a reporter and stop calling `process.exit`:
```ts
export async function createAgentWorktree(
  branch: string | undefined,
  planPrompt: string,
  options: CreateOptions = {},
): Promise<void> {
  const report = options.report ?? ((m: string) => console.log(m));
  const mode = options.mode ?? 'plan';
  if (!VALID_MODES.includes(mode as AgentMode)) {
    // Was process.exit(1) — throw so a library caller (the daemon) is not killed.
    throw new Error(
      `Invalid mode "${mode}". Valid modes: ${VALID_MODES.join(', ')}`,
    );
  }
  const prepared = await prepareWorktree(branch, options);
  if (!prepared) return;
  const { status, config, worktreePath } = prepared;
  if (status === 'exists') {
    const prompt = options.existingWorktreePrompt ?? promptExistingWorktree;
    const action = await prompt(worktreePath, { allowAgent: true });
    if (action === 'quit') return;
    if (action === 'open') {
      await openConfiguredIde(config, worktreePath);
      return;
    }
  }
  await startAgentInWorktree(config, worktreePath, planPrompt, mode, report);
}
```
Change `startAgentInWorktree`'s signature to accept the reporter and replace its `console.log`/`console.warn`/`console.error` calls (and those in `reportTriggerFailure`) with `report(...)`:
```ts
async function startAgentInWorktree(
  config: RepoConfig,
  worktreePath: string,
  planPrompt: string,
  mode: string,
  report: (msg: string) => void,
): Promise<void> {
```
Replace every `console.log(X)` / `console.warn(X)` / `console.error(X)` inside `startAgentInWorktree` and `reportTriggerFailure` with `report(X)` (pass `report` into `reportTriggerFailure` too). Leave the `clack.confirm` interactive block as-is (it is TTY-gated and never runs in the daemon).

- [ ] **Step 2: Create the library entry `agent-api.ts`**

Create `packages/cli/src/wt/agent-api.ts`:
```ts
import { createAgentWorktree } from './commands/agent.js';

export type Reporter = (msg: string) => void;
export interface AgentResult {
  ok: boolean;
  output: string;
}
export interface RunAgentOptions {
  repoPath: string;
  branch: string;
  prompt: string;
  mode?: string;
}

/**
 * Library-safe entry to the `wt agent` flow: resolves the repo from `repoPath`
 * (no interactive picker), runs the worktree + agent automation, and returns a
 * structured result with all progress/error lines collected in `output`.
 * Never calls process.exit; a throw becomes `{ ok: false }`.
 */
export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const lines: string[] = [];
  const report: Reporter = (m) => lines.push(m);
  try {
    await createAgentWorktree(opts.branch, opts.prompt, {
      cwd: opts.repoPath,
      mode: opts.mode ?? 'plan',
      report,
    });
    return { ok: true, output: lines.join('\n') };
  } catch (err) {
    lines.push(err instanceof Error ? err.message : String(err));
    return { ok: false, output: lines.join('\n') };
  }
}
```

- [ ] **Step 3: Keep the CLI on the live-output path (just handle the new throw)**

The CLI wants **live** console output, so it keeps calling `createAgentWorktree`
directly (its default reporter writes straight to the console). `runAgent` (the
buffered/collecting entry) is for the daemon only. The only change the CLI needs
is a `try/catch` for the now-throwing invalid mode. In
`packages/cli/src/wt/cli.ts`, change the agent action:
```ts
  .action(
    async (branch: string, planPrompt: string, options: { mode: string }) => {
      const { createAgentWorktree } = await import('./commands/agent.js');
      try {
        await createAgentWorktree(branch, planPrompt, { mode: options.mode });
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    },
  );
```

- [ ] **Step 4: Write the failing test for the reporter/throw contract**

In `packages/cli/src/wt/commands/agent.test.ts`, update the two console-asserting tests and add a new one.

Replace the `'errors but still opens Zed when agent_command is empty'` test body's assertion with a reporter collector:
```ts
  it('reports (not console.error) but still opens Zed when agent_command is empty', async () => {
    const store = configure({ agent_command: '' });
    const lines: string[] = [];

    await createAgentWorktree('feature', 'do stuff', {
      cwd: repoDir,
      store,
      report: (m) => lines.push(m),
    });

    expect(lines.join('\n')).toContain('No agent_command');
    expect(openIde).toHaveBeenCalledWith('zed', [], expect.any(String));
    expect(writeAgentTask).not.toHaveBeenCalled();
  });
```
Replace the `'keeps the task (no cleanup) when the chord cannot be triggered'` assertion:
```ts
    const lines: string[] = [];
    await createAgentWorktree('feature', 'do stuff', {
      cwd: repoDir, store, report: (m) => lines.push(m),
    });
    expect(triggerChord).toHaveBeenCalled();
    expect(cleanupAgentTask).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('press');
```
Add a new test:
```ts
  it('throws on an invalid mode instead of exiting', async () => {
    const store = configure();
    await expect(
      createAgentWorktree('feature', 'do stuff', {
        cwd: repoDir, store, mode: 'nope',
      }),
    ).rejects.toThrow(/Invalid mode/);
  });
```

- [ ] **Step 5: Run the agent tests**

Run:
```bash
cd /Users/cestoliv/Documents/Development/forest/packages/cli
npx vitest run src/wt/commands/agent.test.ts
```
Expected: PASS (all cases, including the new invalid-mode throw).

- [ ] **Step 6: Full gate**

Run:
```bash
cd /Users/cestoliv/Documents/Development/forest/packages/cli
npm run lint && npm run typecheck && npm test
```
Expected: all pass.

---

### Task 6: Switch the daemon to the in-process call + crash isolation

**Files:**
- Modify: `packages/cli/src/spawner/lib/dispatch.ts` (new `runWtAgent`, delete `spawnWtAgent`, guard `dispatchTask`)
- Modify: `packages/cli/src/spawner/lib/dispatch.test.ts` (drop subprocess tests, add throw-isolation test)
- Modify: wherever `spawnWtAgent` is injected into `DispatchDeps` (grep to find; likely `run.ts` / `loop.ts`)

**Interfaces:**
- Consumes: `runAgent`, `AgentResult` from Task 5 (`../../wt/agent-api.js`).
- Produces: `runWtAgent: SpawnAgent` and a `dispatchTask` that maps any thrown error from `spawnAgent` to `Agent Error` without stopping the loop.

- [ ] **Step 1: Find the injection site**

Run:
```bash
cd /Users/cestoliv/Documents/Development/forest/packages/cli
grep -rn 'spawnWtAgent\|spawnAgent' src/spawner
```
Expected: usages in `dispatch.ts` (definition), `dispatch.test.ts`, and the wiring file (e.g. `lib/loop.ts` or `commands/run.ts`). Note the wiring file path for Step 4.

- [ ] **Step 2: Write the failing throw-isolation test**

In `packages/cli/src/spawner/lib/dispatch.test.ts`: remove the `spawnWtAgent` import and any test that mocks `node:child_process` / asserts on `spawn`. Add:
```ts
  it('labels the task Agent Error when the in-process agent throws (loop survives)', async () => {
    const d = deps({
      spawnAgent: async () => {
        throw new Error('kaboom');
      },
    });
    const task = makeTask({
      project_id: 'OVL',
      labels: ['agent-ready', 'mobile'],
    });

    await expect(dispatchTask(task, d)).resolves.toBeUndefined();

    const errored = d.api.updated.at(-1);
    expect(errored?.labels).toContain('agent-error');
    expect(d.api.comments.at(-1)?.content).toContain('kaboom');
  });
```
(Adjust `makeTask` args / label names to match `test-utils.ts` and `FIXTURE_LABELS`.)

- [ ] **Step 3: Implement `runWtAgent`, the guard, and delete `spawnWtAgent`**

In `packages/cli/src/spawner/lib/dispatch.ts`:
- Remove `import { spawn } from 'node:child_process';` and the entire `spawnWtAgent` export.
- Add at the top:
```ts
import { runAgent } from '../../wt/agent-api.js';
```
- Add the new implementation:
```ts
// Calls wt's agent flow in-process (same package). runAgent already maps
// failures to { ok:false }, but we still guard against an unexpected throw so a
// single bad task can never take down the daemon poll loop.
export const runWtAgent: SpawnAgent = async (branch, prompt, repoPath) => {
  try {
    return await runAgent({ repoPath, branch, prompt });
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
};
```
- Wrap the call site inside `dispatchTask` so a throw is mapped to a failed result:
```ts
  let result: { ok: boolean; output: string };
  try {
    result = await spawnAgent(branch, prompt, path);
  } catch (err) {
    result = { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
```
(Replace the existing `const result = await spawnAgent(branch, prompt, path);` line.)

- [ ] **Step 4: Repoint the wiring to `runWtAgent`**

In the wiring file found in Step 1, replace `spawnWtAgent` with `runWtAgent` in the `DispatchDeps` construction (import and usage).

- [ ] **Step 5: Run the daemon tests**

Run:
```bash
cd /Users/cestoliv/Documents/Development/forest/packages/cli
npx vitest run src/spawner/lib/dispatch.test.ts
```
Expected: PASS, including the new throw-isolation test; no reference to `spawn`/`spawnWtAgent` remains.

- [ ] **Step 6: Full gate + build**

Run:
```bash
cd /Users/cestoliv/Documents/Development/forest/packages/cli
npm run lint && npm run typecheck && npm test && npm run build
node dist/wt.js --version && node dist/spawner.js --help >/dev/null && echo "BINS OK"
```
Expected: all pass; both bins execute; prints `BINS OK`.

---

### Task 7: CI/CD — one path-aware workflow + publish + release

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/publish-cli.yml`
- Create: `.github/workflows/release-ide-toggler.yml`

**Interfaces:**
- Consumes: `packages/cli/` package scripts; `apps/ide-toggler/` build/test commands (from the original ide-toggler workflows).
- Produces: a single required status check `ci-ok`.

- [ ] **Step 1: Write `ci.yml` (paths-filter + aggregator gate)**

Create `.github/workflows/ci.yml`:
```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  changes:
    runs-on: ubuntu-latest
    outputs:
      cli: ${{ steps.f.outputs.cli }}
      ide: ${{ steps.f.outputs.ide }}
    steps:
      - uses: actions/checkout@v4
      - uses: dorny/paths-filter@v3
        id: f
        with:
          filters: |
            cli:
              - 'packages/cli/**'
            ide:
              - 'apps/ide-toggler/**'

  cli:
    needs: changes
    if: needs.changes.outputs.cli == 'true'
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: packages/cli
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
          cache-dependency-path: packages/cli/package-lock.json
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test

  ide-toggler-macos:
    needs: changes
    if: needs.changes.outputs.ide == 'true'
    runs-on: macos-14
    defaults:
      run:
        working-directory: apps/ide-toggler/macos
    steps:
      - uses: actions/checkout@v4
      - run: swift --version
      - run: swift build
      - run: swift test

  ide-toggler-linux:
    needs: changes
    if: needs.changes.outputs.ide == 'true'
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: apps/ide-toggler/linux
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - uses: actions/setup-python@v4
        with:
          python-version: "3.12"
      - run: node --test
      - name: Static analysis (shexli)
        run: |
          python3 -m pip install -q shexli "tree-sitter<0.26"
          EXT="$GITHUB_WORKSPACE/apps/ide-toggler/linux/gnome-extension/ide-toggler@cestoliv.com"
          shexli --format text "$EXT"
          shexli --format json "$EXT" > shexli-report.json
          errors=$(jq '.summary.severity_counts.error // 0' shexli-report.json)
          echo "shexli error-level findings: $errors"
          if [ "$errors" -gt 0 ]; then
            echo "::error::shexli reported $errors error-level finding(s)"
            exit 1
          fi

  ci-ok:
    # Single required status check. Passes only if no needed job failed or was
    # cancelled; skipped area jobs (unchanged paths) count as success.
    needs: [cli, ide-toggler-macos, ide-toggler-linux]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - name: Verify no upstream job failed
        run: |
          r='${{ needs.cli.result }} ${{ needs.ide-toggler-macos.result }} ${{ needs.ide-toggler-linux.result }}'
          echo "results: $r"
          for x in $r; do
            if [ "$x" = "failure" ] || [ "$x" = "cancelled" ]; then
              echo "::error::a required job did not pass ($x)"; exit 1
            fi
          done
          echo "all good"
```

- [ ] **Step 2: Write `publish-cli.yml`**

Create `.github/workflows/publish-cli.yml` — port worktrees' `publish.yml`, scoped to `packages/cli` (set `working-directory: packages/cli` on every `run` step; add `paths: ['packages/cli/**']` under the `push` trigger; change the PR comment package name to `@cestoliv/forest`; keep the OIDC/`id-token: write` release job and the `publish-dev` label prerelease job exactly as in the original). Use `cache-dependency-path: packages/cli/package-lock.json` on `setup-node`.

- [ ] **Step 3: Write `release-ide-toggler.yml`**

Create `.github/workflows/release-ide-toggler.yml` — port ide-toggler's `release.yml` unchanged **except**:
- Trigger: `on: { push: { tags: ['ide-toggler-v*'] } }`.
- Version extraction: `VERSION="${GITHUB_REF_NAME#ide-toggler-v}"`.
- Prefix every path with `apps/ide-toggler/` (`working-directory: apps/ide-toggler/linux` for the test step; `EXT="$GITHUB_WORKSPACE/apps/ide-toggler/linux/gnome-extension/ide-toggler@cestoliv.com"`; the pack step `cd apps/ide-toggler/linux/gnome-extension/...`).

- [ ] **Step 4: Validate workflow YAML**

Run:
```bash
cd /Users/cestoliv/Documents/Development/forest
for f in .github/workflows/*.yml; do python3 -c "import sys,yaml;yaml.safe_load(open('$f'))" && echo "OK $f"; done
```
Expected: `OK` for all three files (valid YAML). If PyYAML is unavailable, run `npx --yes js-yaml .github/workflows/ci.yml >/dev/null` per file instead.

---

### Task 8: Consolidate docs & ignore files

**Files:**
- Modify: `/Users/cestoliv/Documents/Development/forest/README.md`
- Create: `/Users/cestoliv/Documents/Development/forest/CLAUDE.md` (short, repo-wide)
- Modify: `packages/cli/CLAUDE.md` (merge agent-spawner's guidance in)
- Modify: `/Users/cestoliv/Documents/Development/forest/.gitignore` (fold in both tools' ignores)

**Interfaces:**
- Consumes: existing `packages/cli/README.md`, `apps/ide-toggler/README.md`.
- Produces: a navigable root README and a repo-wide CLAUDE.md.

- [ ] **Step 1: Write the root README**

Replace `README.md` with an overview that states the monorepo purpose and links to `packages/cli/README.md` and `apps/ide-toggler/README.md`, plus the install line `npm i -g @cestoliv/forest` (provides `wt` + `agent-spawner`).

- [ ] **Step 2: Merge agent-spawner's CLAUDE.md into the CLI one**

Append the agent-spawner-specific guidance (from `/Users/cestoliv/Documents/Development/agent-spawner/CLAUDE.md`) into `packages/cli/CLAUDE.md` under a clear `## agent-spawner` heading; keep the existing wt guidance.

- [ ] **Step 3: Write the repo-wide CLAUDE.md**

Create root `CLAUDE.md` describing the layout (`packages/cli`, `apps/ide-toggler`), the "one package, two bins" model, the `ide-toggler-v*` tag scheme, and where per-tool docs live.

- [ ] **Step 4: Fold in ignores**

Ensure `.gitignore` contains the union from both tools (already covers node_modules, dist, `.build/`, `__pycache__`, `.DS_Store`; add anything ide-toggler's `.gitignore` had that is missing, e.g. Swift `.swiftpm/`, `*.xcodeproj` artifacts if present).

- [ ] **Step 5: Sanity gate**

Run:
```bash
cd /Users/cestoliv/Documents/Development/forest
grep -q '@cestoliv/forest' README.md && echo "README OK"
test -f CLAUDE.md && echo "CLAUDE OK"
```
Expected: `README OK` and `CLAUDE OK`.

---

### Task 9: Go-live operations (manual, after the repo is pushed & publishing works)

**Files:** none (npm registry + GitHub operations)

**Interfaces:** none.

- [ ] **Step 1: Create the GitHub repo and push**

Create `github.com/cestoliv/forest`, add it as `origin`, push `chore/forest-monorepo`, open a PR into `main` (respecting the protected-main + CI-gate workflow). Set the branch-protection **required status check to `ci-ok`**.

- [ ] **Step 2: Verify the first publish**

After merge to `main`, confirm `publish-cli.yml` publishes `@cestoliv/forest@0.1.0` (OIDC, provenance). Then:
```bash
npm view @cestoliv/forest version
```
Expected: `0.1.0`.

- [ ] **Step 3: Deprecate the old packages**

Run:
```bash
npm deprecate @cestoliv/wt "Merged into @cestoliv/forest — install: npm i -g @cestoliv/forest (provides wt)."
npm deprecate @cestoliv/agent-spawner "Merged into @cestoliv/forest — install: npm i -g @cestoliv/forest (provides agent-spawner)."
```
Expected: no error; new installs of the old packages now show the deprecation notice.

- [ ] **Step 4: Verify the ide-toggler release path**

Push a tag `ide-toggler-v<current-version>` and confirm `release-ide-toggler.yml` builds and attaches the `.shell-extension.zip` to a GitHub Release.

---

## Notes for the implementer

- **Do not run `npm publish` locally.** Publishing happens only via CI (OIDC trusted publishing). Task 9 Step 2 just verifies it.
- **macOS Accessibility (verify manually, not in CI):** after Task 6, the agent chord is pressed by the `agent-spawner`/node (launchd) process rather than a spawned `wt`. Run `agent-spawner run` in the foreground once and confirm the first-run Accessibility grant still lets the Zed chord fire. This is the one behavior the automated tests cannot cover.
- **If a `git merge --allow-unrelated-histories` reports conflicts** in Tasks 1–2, it means a path collision (unexpected — imported paths are namespaced). Abort with `git merge --abort` and re-check the filter-repo prefixes before retrying.
