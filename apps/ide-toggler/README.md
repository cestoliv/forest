# ide-toggler

A native macOS panel that shows every open Zed window alongside its live Claude Code activity state, so you always know at a glance which project needs your attention — and can jump to it with a single click.

<!-- TODO: add screenshot of the panel -->

ide-toggler sits as a floating, always-on-top panel. It enumerates your open Zed windows by project folder name, watches Claude Code's session files in real time, and highlights any window where Claude is blocked, busy, or done. When a session finishes and goes idle it plays a chime and runs an icon animation so you notice even if the panel is out of focus.

## Features

- **Window list by folder** — every open Zed window appears as a row labelled by its project folder name. Works across multiple Zed instances.
- **Click to raise** — click any row to bring that Zed window to the front and focus it, even if it is on another Space.
- **Four live states**, updated in real time as Claude Code sessions change:
  - `needs-attention` — at least one session is waiting on a permission prompt (Claude blocked)
  - `working` — at least one session is actively computing or running a shell command
  - `idle` — all sessions for this window are waiting for your next message
  - `no-agent` — the window is open but no Claude Code session is associated with it
- **Idle chime + animation** — when a window transitions from working to idle, the macOS "Glass" sound plays and the status icon animates. The animation always runs; the sound can be muted.
- **Always-on-top floating panel** — uses a non-activating `NSPanel` at floating level that joins all Spaces, so it stays visible without ever stealing focus from Zed.
- **Three ordering modes** — sort the window list by status priority (default), alphabetically, or most-recently-active.
- **Persistent settings** — order mode and mute preference are stored in `UserDefaults` and survive relaunches.

## Repository layout

The app is implemented natively per platform; all implementations follow one shared
behavioral contract in [`SPEC.md`](SPEC.md).

```
SPEC.md     Cross-platform behavioral contract (the source of truth).
macos/      macOS reference implementation — Swift Package (IdeTogglerCore +
            IdeTogglerApp), built into IdeToggler.app via scripts/make_app.sh.
linux/      GNOME Shell extension (GJS) + a Node test suite for its pure logic.
```

## Requirements

- **macOS 13 Ventura or later**
- **Swift 5.9+ / Xcode** (for building from source)
- **Accessibility permission** — required to enumerate and raise Zed windows (see First Launch below)
- **Claude Code running inside Zed's integrated terminal** — ide-toggler reads session files from `~/.claude/sessions/{pid}.json`. Sessions started in an external terminal are ignored unless their working directory matches a Zed window folder.

## Build & Run

```bash
cd macos
bash scripts/make_app.sh && open IdeToggler.app
```

This compiles a release binary and assembles `IdeToggler.app` inside `macos/`, then launches it.

### First Launch — Accessibility Permission

The app needs Accessibility access to list and raise Zed windows. On first launch an alert will appear with an **Open System Settings** button. Alternatively:

1. Open **System Settings → Privacy & Security → Accessibility**
2. Enable **ide-toggler** (or **IdeToggler**)
3. Relaunch the app

Without this permission the panel will open but the window list will remain empty.

### Development

```bash
cd macos

# Build (debug)
swift build

# Run the test suite (headless, no Accessibility permission required)
swift test
```

## Linux (GNOME Shell extension)

On GNOME the panel ships as a Shell extension (GJS). See
[`linux/README.md`](linux/README.md) for development details and
[`SPEC.md`](SPEC.md) §9 for the GNOME-specific behavior.

### Install from a GitHub Release (recommended)

1. Download `ide-toggler@cestoliv.com.shell-extension.zip` from the
   [latest release](../../releases/latest).
2. Install and enable it:

   ```bash
   gnome-extensions install --force ide-toggler@cestoliv.com.shell-extension.zip
   gnome-extensions enable ide-toggler@cestoliv.com
   ```

3. Reload GNOME Shell so it picks up the new extension:
   - **Wayland:** log out and back in.
   - **X11:** press `Alt`+`F2`, type `r`, then Enter.

> If `gnome-extensions enable` reports the extension is not found, reload the
> shell first (step 3), then run the enable command again.

### Install from extensions.gnome.org

<!-- TODO: add the EGO listing link once the first submission clears review -->

Once the first submission clears review, the extension will be installable in one
click from [extensions.gnome.org](https://extensions.gnome.org/).

## How It Works

1. **Window enumeration** — the macOS Accessibility API (`AXUIElementCreateApplication`) is called for each running `dev.zed.Zed` process. Each window's title is parsed on the `" — "` (em-dash) separator to extract the project folder name, and each window is keyed by its stable `CGWindowID` for reliable click-to-raise.
2. **Session watching** — FSEvents watches `~/.claude/sessions/`. On every change all `*.json` files are re-read. Files whose recorded PID no longer responds to `kill -0` (crashed Claude) are discarded. Each remaining file produces a `Session(pid, cwd, status)`.
3. **Aggregation** — a pure `StatusAggregator` joins windows to sessions on `basename(session.cwd) == window.folder`. Multiple sessions for the same window collapse to a single `WindowState` by priority: `needs-attention > working > idle > no-agent`. The aggregator also detects `working → idle` transitions per window and fires the chime/animation.

## Architecture

```
IdeTogglerCore          Pure Swift — models, aggregation logic, protocols.
                        Fully unit-tested (52 tests), no AppKit/AX imports.

IdeTogglerApp           OS adapters + SwiftUI UI.
                        AXWindowSource, FSEventSessionSource, AVAudioChimePlayer,
                        StatusAggregatorStore (ObservableObject), PanelController,
                        PanelView, SettingsView.

ideToggler              Executable entry point — wires adapters together and
                        starts the NSApplication run loop.
```

The adapter/protocol split means the core aggregation logic is tested with lightweight mocks; no Accessibility permission or GUI is needed for `swift test`.

## Privacy & Safety

ide-toggler is **strictly read-only with respect to your windows and processes**. It:

- reads window titles and session JSON files
- raises/focuses a window when you click its row

It **never** closes, quits, sends input to, or otherwise mutates any Zed window, Claude process, or file. This constraint is enforced throughout the codebase (see the Hard Safety Constraint in the design spec).

## License

MIT — see [LICENSE](LICENSE).
