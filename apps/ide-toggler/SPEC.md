# ide-toggler — behavioral spec

This is the shared contract for every platform implementation. macOS (Swift/SwiftUI)
is the reference implementation; the Linux and Windows apps reimplement this logic in
their own native stacks (no shared binary). Keep all three in sync with this document.

The app is an always-on-top panel listing the open windows of supported editors, one row
per window, each tagged with the project folder and the live supported-agent status for
that project. Clicking a row raises/focuses that editor window. The app is **read-only**
toward editors and agents: the only outward action is raising a window.

---

## 1. Supported editors (catalog)

Each editor is described by: how to find its processes/windows per OS, how to parse its
window title, and which titles are non-project chrome.

| Editor | `IDEKind` | macOS bundle id(s) | Linux `WM_CLASS` / `app_id` | Windows exe |
|---|---|---|---|---|
| Zed | `zed` | `dev.zed.Zed` | `dev.zed.Zed` / `zed` | `zed.exe` |
| VSCode | `vscode` | `com.microsoft.VSCode`, `com.microsoft.VSCodeInsiders`, `com.visualstudio.code.oss` | `code` / `Code` (`code-insiders`, `code-oss`) | `Code.exe` |
| WebStorm | `jetBrains` | `com.jetbrains.WebStorm` | `jetbrains-webstorm` | `webstorm64.exe` |

`IDEKind` is a stable identifier (used in window ids and the per-row badge). The
non-macOS identifiers are starting points — **verify them on the target platform**, they
have not all been confirmed against a running app.

---

## 2. Window enumeration

For every configured editor, enumerate its top-level windows and, for each, read the
window **title**. Build a window record:

```
EditorWindow {
  id:     string   // stable per-window key, prefixed by IDE: "<ide>-win-<nativeWindowId>"
  folder: string   // project folder parsed from the title (see §3)
  ide:    IDEKind
}
```

- `id` MUST be stable across refreshes for a given window (transition detection and
  click-to-raise rely on it) and unique across editors — hence the `<ide>-` prefix. Use
  the OS's stable window handle (macOS `CGWindowID`, X11 window XID, Win32 `HWND`).
- A window whose title yields no folder (see §3) is dropped.

### 2.1 Non-project window filtering

Editors expose auxiliary windows that are not projects (open/save panels, About box,
welcome/getting-started, release notes). Two filters, because they differ in kind:

1. **Structural — native open/save panels.** These are the only chrome reliably
   distinguishable by window structure: they have none of the standard window controls.
   Rule (macOS): keep a window only if it has a close button **or** is fullscreen
   (fullscreen hides the controls). Do **not** rely on window subrole/type: JetBrains
   reports real project windows inconsistently (it flips them to `AXDialog` when a modal
   is open), so gating on a "standard window" type intermittently hides real projects.
2. **Title blocklist — About / Welcome / Release-Notes.** These are structurally
   identical to real project windows, so they can only be caught by title. Each editor
   carries an exact-match list and a prefix-match list, applied to the trimmed title
   before parsing:

   | Editor | exact | prefix |
   |---|---|---|
   | Zed | `About Zed`, `empty project` | — |
   | VSCode | `Welcome`, `Get Started` | `Release Notes:` |
   | WebStorm | `About WebStorm`, `Open File or Project` | `Welcome to ` |

   The blocklist is checked **twice**: against the raw trimmed title *and* against the
   parsed folder (rootName). This matters for VSCode on Linux, where the window title
   always carries the app-name suffix (`Welcome - Visual Studio Code`), so the raw title
   never matches `Welcome` exactly — but the parsed rootName does. macOS chrome titles
   have no suffix (`Welcome`) and are caught on the raw pass; the second pass keeps the
   two platforms identical. A real project with that tab focused
   (`Welcome - Musique - Visual Studio Code` → `Musique`) is unaffected.

   **These strings are locale- and version-specific** — a known-fragile best-effort.
   Extend the lists when new chrome titles appear.

**Known gap:** an editor window with *no folder open* whose title is not in the blocklist
is indistinguishable from a folder-only project window — no OS API exposes "has a
workspace folder" for Electron/IntelliJ apps. Such a window will appear as a row with no
agent status. Accepted limitation.

---

## 3. Title → project folder parsing

Each editor encodes the project folder differently. Match against the **native window
title** the OS reports (which can differ from the editor's own custom title-bar UI text).

- **Zed** — `"<folder> — <detail>"`, em-dash `U+2014` with surrounding spaces, folder on
  the **left**. Take the substring before the first ` — `; if none, the whole title.
- **WebStorm / JetBrains** — `"<project> [<path>] - <file>"`, project on the **left**.
  Take the substring before the first ` [`, else before the first ` - ` (space-hyphen-space),
  else the whole title.
- **VSCode** — `"${dirty}${activeEditorShort}${sep}${rootName}${sep}${appName}"`, but the
  **separator and the rootName's position differ by platform**:
  - **macOS** native AX window title: em-dash ` — ` (`U+2014`), **no** app-name suffix,
    `rootName` **last** (e.g. `.env — mobile`). (The documented `window.title` default —
    hyphen, includes app name — describes VSCode's *custom title-bar UI*, not the AX title.)
  - **Linux** window title (`_NET_WM_NAME`): hyphen ` - `, app-name suffix **present**,
    `rootName` is the segment **just before it** (e.g. `Welcome - Musique - Visual Studio Code`,
    where `Welcome` is the active editor/tab and `Musique` the project).

  Rule (covers both): strip a trailing ` — <appName>` / ` - <appName>` (longest first;
  `Visual Studio Code - Insiders`, `Visual Studio Code`, `Code - OSS`), then split on
  **either** separator and take the **last** non-empty segment. That yields `rootName` once
  the app name is gone and drops the leading active-editor/file part. Folder names with
  internal hyphens (`mobile-eslint-rules`) survive because ` - ` requires surrounding spaces.

In all cases the result is trimmed; an empty result means "no folder" (window dropped).

**Caveat:** VSCode's `window.title` is user-configurable. If reordered/dropped, the folder
may parse wrong — the window still lists and is focusable, it just won't join agent status.

---

## 4. Session sources (agent status)

ide-toggler supports Claude Code and Codex. Both sources normalize into the same
session shape:

```
Session { pid: int, cwd: string, status: AgentStatus }
activity: map<pid, updatedAt>   // for recently-active ordering
```

### Claude Code

Watch the directory `~/.claude/sessions/` (`%USERPROFILE%\.claude\sessions\` on Windows)
for `*.json` files, one per Claude session, named `{pid}.json`. Re-read on change
(macOS `FSEvents`, Linux `inotify`, Windows `ReadDirectoryChangesW`/`FileSystemWatcher`).

Each file contains (other keys exist and are ignored):

```json
{ "pid": 10985, "cwd": "/abs/path/to/project", "status": "idle", "updatedAt": 1780644168474 }
```

- `updatedAt` / `startedAt` are epoch **milliseconds**.
- A session is kept only if its process is **alive**: POSIX `kill(pid, 0) == 0 || errno
  == EPERM`; Windows `OpenProcess`/`Process.GetProcessById`. Stale files are ignored.
- `status` raw values: `busy`, `shell`, `waiting`, `idle`. Unknown values → drop the session.

### Codex

Watch `~/.codex/sessions/` for `*.jsonl` rollout files. Codex keeps historical
rollouts, so a rollout is kept only if its `session_meta.payload.cwd` exactly matches a
currently running `codex` process working directory (normalized for trailing slashes).

Each rollout is parsed line-by-line. Malformed lines are ignored. The source uses:

- `session_meta.payload.id` and `session_meta.payload.cwd` for identity and project cwd.
- `event_msg.payload.type == "task_started"` to mark an active turn.
- `event_msg.payload.type == "task_complete"` to mark the turn idle.
- pending user-blocking `response_item` function calls (`request_user_input`, approval
  calls, or escalated `exec_command`) to mark `waiting`.

Codex status mapping:

- unresolved user-blocking call → `waiting`
- latest `task_started` without later `task_complete` → `busy`
- otherwise → `idle`

Codex rollouts do not expose a Claude-style PID per thread, so implementations assign a
stable synthetic positive integer from the thread id for aggregation/activity maps.

---

## 5. Joining sessions to windows

- **Match:** a session belongs to a window when `basename(session.cwd) == window.folder`
  or `window.folder` is an exact path component of `session.cwd` (so agents launched from
  a project subdirectory still attach to the project root row). IDE-agnostic. The same
  folder open in two editors matches both windows — both show the status; that's intended
  (each is focusable).
- **Collapse** a window's matched sessions into one `WindowState` by priority:
  1. `needsAttention` — any matched session is `waiting`
  2. `working` — any is `busy` or `shell`
  3. `idle` — all matched sessions are `idle`
  4. `noAgent` — no matched session
- **Transition cue:** when a window goes `working → idle`, play the idle chime (unless
  muted) and blink the row until acknowledged (cleared on click).

**Known limitation:** matching is by basename only, so same-named folders in different
paths collapse together. Slightly more likely across editors. Out of scope unless
path-aware matching is added (only JetBrains titles reliably expose a full path).

---

## 6. Raising a window

On row click, bring that editor window to the front and focus its app. Resolve the window
by its `id` to the native handle and:

- **macOS** — `AXUIElementPerformAction(window, kAXRaiseAction)` + `NSRunningApplication.activate()`.
- **Linux/X11** — `_NET_ACTIVE_WINDOW` client message (as `wmctrl`/`xdotool` do).
- **Linux/Wayland** — **not generally possible.** Apps can't focus another app's existing
  window by design (XDG-Activation tokens only flow at launch). Works on wlroots compositors
  (sway/Hyprland) via `wlr-foreign-toplevel-management` or IPC; on GNOME/KDE Wayland it needs
  a privileged shell extension. Detect the session type and degrade gracefully.
- **Windows** — `SetForegroundWindow` (+ `ShowWindow(SW_RESTORE)` if minimized). The call
  originates from a user click (foreground-input context), so it generally succeeds; fall
  back to the `AttachThreadInput` trick if needed.

The panel itself must never steal focus from the editor (macOS: non-activating floating
panel; Windows: `WS_EX_NOACTIVATE` + `WS_EX_TOOLWINDOW`; Linux: always-on-top hint /
layer-shell).

---

## 7. Ordering & presentation

- **Order modes:** `statusPriority` (default — by collapsed state rank, then folder name
  case-insensitive), `alphabetical` (folder name), `recentlyActive` (max `updatedAt` of
  matched sessions desc; windows with no activity sort last, then alphabetical).
- **Grouping:** in `statusPriority` mode rows are grouped under headers
  Needs you / Working / Idle (idle and noAgent collapse into "Idle"). Flat list otherwise.
- **IDE badge:** show a per-row IDE badge (`ZED` / `VS` / `WS`) **only when more than one
  IDEKind is present** across the visible rows; otherwise omit it (no value when all rows
  are the same editor).
- **Settings:** order mode, mute, compact mode — persisted locally.

---

## 8. Platform status

- **macOS** (`macos/`) — reference implementation (Swift Package: `IdeTogglerCore` pure
  logic + `IdeTogglerApp` AX/AppKit/SwiftUI adapters). Complete for Zed/VSCode/WebStorm.
- **Windows** — planned: C#/.NET + WPF, Win32 `EnumWindows`/`SetForegroundWindow`.
- **Linux** (`linux/`) — GNOME Shell extension (GJS/St). The window enumeration,
  title→folder parsing, session source, matching, ordering, chime/blink and the floating
  panel all run in-process inside the extension; raising a window uses the shell's
  privileged `Main.activateWindow` (so the §6 GNOME/Wayland focus limitation does not
  apply here). The pure logic (catalog, title parsing, session validation, aggregation)
  lives in gi-free modules under `lib/` and is unit-tested with `node --test` (`linux/tests/`);
  the gi-bound code (Cairo status icons, top-bar indicator, the orchestrating
  `extension.js`) is not. X11 + wlroots-Wayland remain feasible as a separate GTK4 build.

## 9. Platform divergences

These are intentional per-platform differences from the shared contract above.

- **Linux/GNOME — hide-to-top-bar affordance (GNOME-only).** The GNOME build adds a
  close button in the panel footer that *hides* the floating panel and installs a GNOME
  top-bar (status-area) indicator; clicking that indicator re-shows the panel and removes
  the indicator. The hidden/shown state is persisted locally (in the extension's config
  JSON) and restored on load. The macOS build has no equivalent (its panel is shown/hidden
  through the standard macOS window/menu-bar affordances). This does not affect any of the
  shared logic (enumeration, parsing, matching, ordering); it is purely a presentation
  affordance unique to the GNOME shell environment.
