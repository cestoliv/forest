# Config open survives invalid JSON — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `wt config` and `agent-spawner config` must open the config file even
when its JSON is invalid. Before opening, beautify the file when it parses.
After the editor closes, print any JSON syntax error and exit 1.

**Problem:** `agent-spawner`'s `printConfigPath`/`openConfig`
(`src/spawner/commands/config.ts:5,9`) build a `Conf` store only to read
`.path`, and `Conf`'s constructor parses the file. Invalid JSON therefore
crashes the one command that could fix it. `wt` already avoids this with the
plain `getConfigFilePath` helper (`src/wt/lib/config.ts:46`). Neither tool
beautifies the file or reports a parse error after the edit.

**Architecture:** One shared module, `src/config-file.ts`, owns
format-then-open-then-validate. Both `commands/config.ts` files become thin
path resolvers over it. `agent-spawner` gains the same `getConfigFilePath`
helper `wt` has, plus `wt`'s friendly `createStore` error wrapper.

**Tech stack:** Node/TypeScript (ESM, `.js` import extensions), Commander,
Vitest (single-fork, serial), Biome.

## Global constraints

- **ESM-only:** every internal import uses a `.js` extension, even for `.ts`
  sources.
- **Byte-match `conf`'s serializer:** `conf` writes
  `JSON.stringify(value, undefined, '\t')` with **no trailing newline**
  (`node_modules/conf/dist/source/index.js:379`). The beautifier writes the
  same shape, so it never fights the next `store.set`.
- **Never crash on a missing or corrupt file:** the beautifier and the
  validator both treat an unreadable file as "nothing to do". Only a file that
  exists and fails `JSON.parse` is an error.
- **Exit codes:** valid JSON after close exits with the editor's code. Invalid
  JSON exits 1.
- **Biome style:** single quotes, 2-space indent, trailing commas (all).
  `npm run lint`, `npm test` and `npm run build` must all pass.
- **Comments:** explain why, never what. Add one only where the code cannot
  speak for itself.
- All paths below are relative to `packages/cli/`.
- Commit each task. The controller squashes the branch to one commit before
  opening the pull request.

---

### Task 1: The shared config-file module

**Files:**

- Create: `src/config-file.ts`
- Test: `src/config-file.test.ts`

**Interfaces produced (Task 2 consumes these):**

- `formatConfigFile(configPath: string): void`
- `readConfigParseError(configPath: string): string | undefined`
- `openConfigFile(configPath: string, commandName: string): ChildProcess`

- [ ] **Step 1: Write the failing tests**

Create `src/config-file.test.ts`. Follow the style of
`src/wt/commands/config.test.ts`: a `mkdtempSync` temp dir per test,
`vi.spyOn` for `console`/`process.exit`, `EDITOR=true` as a no-op editor that
exits immediately, and `await new Promise((r) => child.on('close', r))` to wait
on the real child rather than a timer.

Cover exactly these cases:

`formatConfigFile`

1. Rewrites valid but ugly JSON as tab-indented JSON with no trailing newline.
   Write `{"a":1,"b":{"c":2}}`, then expect the file to equal
   `JSON.stringify({ a: 1, b: { c: 2 } }, undefined, '\t')`.
2. Leaves an already-formatted file byte-identical.
3. Leaves corrupt JSON untouched: write `{bad json!!!}`, expect the exact same
   text afterwards.
4. Does not throw when the file does not exist.

`readConfigParseError`

5. Returns `undefined` for valid JSON.
6. Returns `undefined` when the file does not exist.
7. Returns a message for `{bad json!!!}`, and for an empty file (the bug
   report's own case, `Unexpected end of JSON input`).

`openConfigFile`

8. Logs `Config: <path>`, beautifies before spawning (assert the file is
   reformatted), and exits 0 on close when the JSON is valid.
9. Exits 1 on close when the JSON is invalid, and prints the path and the
   parse error message via `console.error`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/config-file.test.ts`
Expected: FAIL — `src/config-file.ts` does not exist.

- [ ] **Step 3: Write the module**

Create `src/config-file.ts`:

```typescript
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

// No file yet: `conf` writes the defaults the first time it reads the store.
function readConfigText(configPath: string): string | undefined {
  try {
    return readFileSync(configPath, 'utf8');
  } catch {
    return undefined;
  }
}

/** Rewrite the config tab-indented, the exact shape `conf` serializes to. */
export function formatConfigFile(configPath: string): void {
  const text = readConfigText(configPath);
  if (text === undefined) return;

  let formatted: string;
  try {
    formatted = JSON.stringify(JSON.parse(text), undefined, '\t');
  } catch {
    return; // Corrupt JSON is the user's to fix in the editor.
  }

  if (formatted !== text) writeFileSync(configPath, formatted);
}

export function readConfigParseError(configPath: string): string | undefined {
  const text = readConfigText(configPath);
  if (text === undefined) return undefined;

  try {
    JSON.parse(text);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

export function openConfigFile(
  configPath: string,
  commandName: string,
): ChildProcess {
  console.log(`Config: ${configPath}`);
  formatConfigFile(configPath);

  const editor = process.env.EDITOR ?? 'nano';
  const child = spawn(editor, [configPath], { stdio: 'inherit' });
  child.on('error', (err) => {
    console.error(`Failed to open editor: ${err.message}`);
    process.exit(1);
  });
  child.on('close', (code) => {
    const parseError = readConfigParseError(configPath);
    if (!parseError) {
      process.exit(code ?? 0);
      return;
    }
    console.error(`✗ Invalid JSON in ${configPath}`);
    console.error(`  ${parseError}`);
    console.error(`  Run \`${commandName} config\` again to fix it.`);
    process.exit(1);
  });
  return child;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/config-file.test.ts`

- [ ] **Step 5: Checkpoint**

Run `npm run lint` and `npx vitest run src/config-file.test.ts`, then commit.

---

### Task 2: Wire both tools onto the shared module

**Files:**

- Modify: `src/wt/commands/config.ts`
- Modify: `src/spawner/lib/config.ts:52` (`createStore`), plus a new
  `getConfigFilePath` export
- Modify: `src/spawner/commands/config.ts`
- Test: `src/wt/commands/config.test.ts` (existing),
  `src/spawner/lib/config.test.ts` (existing),
  `src/spawner/commands/config.test.ts` (create)

**Interfaces consumed:** `openConfigFile` from Task 1's `src/config-file.ts`.

- [ ] **Step 1: Write the failing tests**

Create `src/spawner/commands/config.test.ts`, mirroring
`src/wt/commands/config.test.ts` (the same temp-dir, `EDITOR=true` and
`process.exit` spy patterns). Cover:

1. `printConfigPath(tmpDir)` logs `getConfigFilePath(tmpDir)`.
2. `printConfigPath(tmpDir)` still logs the path when `config.json` holds
   `{bad json!!!}` — this is the crash from the bug report.
3. `openConfig(tmpDir)` logs a line containing the path and opens the editor
   when `config.json` holds `{bad json!!!}`.

In `src/spawner/lib/config.test.ts`, add two tests:

4. `getConfigFilePath()` equals `createStore().path`, and
   `getConfigFilePath(cwd)` equals `createStore(cwd).path`. This pins the
   assumption that `env-paths`' default `nodejs` suffix matches what `conf`
   computes — if `conf` ever changes its path scheme, this test says so
   instead of the commands opening the wrong file.
5. `createStore(cwd)` on a corrupt `config.json` throws an error whose message
   contains `Error reading config file:` and the config path, not a raw
   `SyntaxError`.

In `src/wt/commands/config.test.ts`, add one test:

6. `openConfig(tmpDir)` beautifies a valid one-line `config.json` before the
   editor opens.

And update one existing test. `openConfig without valid config > opens editor
even when config JSON is corrupt` (`src/wt/commands/config.test.ts:88-110`)
asserts `process.exit(0)` on a corrupt file, which is the pre-change contract.
Change it to assert `process.exit(1)` and that `console.error` received the
parse error. Keep its "the editor still opens" assertion as it is.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/spawner/commands/config.test.ts src/spawner/lib/config.test.ts src/wt/commands/config.test.ts`

- [ ] **Step 3: Rewrite `src/wt/commands/config.ts`**

```typescript
// src/commands/config.ts
import type { ChildProcess } from 'node:child_process';
import { openConfigFile } from '../../config-file.js';
import { getConfigFilePath } from '../lib/config.js';

export function printConfigPath(cwd?: string): void {
  const configPath = getConfigFilePath(cwd);
  console.log(configPath);
}

export function openConfig(cwd?: string): ChildProcess {
  return openConfigFile(getConfigFilePath(cwd), 'wt');
}
```

- [ ] **Step 4: Add the path helper and the error wrapper to `src/spawner/lib/config.ts`**

Add the `env-paths` import beside the existing `node:os`/`node:path`/`conf`
imports (`env-paths` is already a dependency — `src/wt/lib/config.ts:4` uses
it), keeping Biome's import order:

```typescript
import envPaths from 'env-paths';
```

Above `createStore`, add:

```typescript
const DEFAULT_CONFIG_DIR = envPaths('agent-spawner').config;

export function getConfigFilePath(cwd?: string): string {
  const dir = cwd ?? DEFAULT_CONFIG_DIR;
  return path.join(dir, 'config.json');
}
```

Then wrap `createStore`'s body the way `src/wt/lib/config.ts:51-64` does, so
`run`, `install` and `logs` report the bad file instead of printing a raw
`JSON.parse` stack trace:

```typescript
export function createStore(cwd?: string): Conf<AgentSpawnerConfig> {
  try {
    return new Conf<AgentSpawnerConfig>({
      projectName: 'agent-spawner',
      defaults: DEFAULT_CONFIG,
      ...(cwd ? { cwd } : {}),
    });
  } catch (error) {
    const configPath = getConfigFilePath(cwd);
    throw new Error(
      `Error reading config file: ${configPath}\n${error instanceof Error ? error.message : error}`,
    );
  }
}
```

- [ ] **Step 5: Rewrite `src/spawner/commands/config.ts`**

```typescript
import type { ChildProcess } from 'node:child_process';
import { openConfigFile } from '../../config-file.js';
import { getConfigFilePath } from '../lib/config.js';

export function printConfigPath(cwd?: string): void {
  console.log(getConfigFilePath(cwd));
}

export function openConfig(cwd?: string): ChildProcess {
  return openConfigFile(getConfigFilePath(cwd), 'agent-spawner');
}
```

`src/spawner/cli.ts:46-50` calls both with no argument, so it needs no change.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/spawner/commands/config.test.ts src/spawner/lib/config.test.ts src/wt/commands/config.test.ts`

- [ ] **Step 7: Checkpoint**

Run `npm run lint`, `npm test` and `npm run build`, then commit.

## Verification

The suite covers the corrupt-file paths through the temp-dir `cwd` argument.
For an end-to-end check, run the built binaries against a corrupt real config,
from `packages/cli/`:

```bash
npm run build
cp "$(node dist/spawner.js config --path)" /tmp/config.json.bak   # keep the real one
echo -n '' > "$(node dist/spawner.js config --path)"              # the bug's own case
node dist/spawner.js config --path                                # prints a path, no stack trace
EDITOR=true node dist/spawner.js config; echo "exit=$?"           # exit=1 + the parse error
cp /tmp/config.json.bak "$(node dist/spawner.js config --path)"   # restore
```

## Out of scope

- Schema or semantic validation of the config after the edit. `loadConfig`
  already reports semantic errors (`src/spawner/lib/config.ts:66`); this change
  reports JSON syntax errors only.
- Reopening the editor in a loop until the file parses. The command prints the
  error and exits 1 (decided with the user).
