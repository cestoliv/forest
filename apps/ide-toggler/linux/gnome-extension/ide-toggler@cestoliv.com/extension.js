import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Meta from "gi://Meta";
import St from "gi://St";
import Clutter from "gi://Clutter";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

import { editorForWmClass } from "./lib/editors.js";
import { folderFromTitle } from "./lib/titleParser.js";
import {
  latestCodexSessionsByCwd,
  normalizePath,
  parseCodexRolloutJsonl,
  parseSessionObject,
} from "./lib/sessions.js";
import {
  ORDER_MODES,
  groupForState,
  buildRows,
  compactRow,
  detectTransitions,
  nextBlinkSet,
} from "./lib/aggregator.js";
import {
  setCairo,
  makeStatusIcon,
  loopingTransition,
} from "./lib/statusIcons.js";
import { IdeTogglerIndicator } from "./lib/indicator.js";

const BUS_NAME = "com.cestoliv.IdeToggler";
const OBJECT_PATH = "/com/cestoliv/IdeToggler";

const IFACE_XML = `
<node>
  <interface name="com.cestoliv.IdeToggler">
    <method name="ListWindows">
      <arg type="a(ssssb)" direction="out" name="windows"/>
    </method>
    <method name="ActivateWindow">
      <arg type="s" direction="in" name="id"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <signal name="WindowsChanged"/>
  </interface>
</node>`;

// Meta.WindowType -> string (kept for the DBus debugging API).
function windowTypeToString(type) {
  switch (type) {
    case Meta.WindowType.NORMAL:
      return "normal";
    case Meta.WindowType.DESKTOP:
      return "desktop";
    case Meta.WindowType.DOCK:
      return "dock";
    case Meta.WindowType.DIALOG:
      return "dialog";
    case Meta.WindowType.MODAL_DIALOG:
      return "modal_dialog";
    case Meta.WindowType.TOOLBAR:
      return "toolbar";
    case Meta.WindowType.MENU:
      return "menu";
    case Meta.WindowType.UTILITY:
      return "utility";
    case Meta.WindowType.SPLASHSCREEN:
      return "splashscreen";
    case Meta.WindowType.DROPDOWN_MENU:
      return "dropdown_menu";
    case Meta.WindowType.POPUP_MENU:
      return "popup_menu";
    case Meta.WindowType.TOOLTIP:
      return "tooltip";
    case Meta.WindowType.NOTIFICATION:
      return "notification";
    case Meta.WindowType.COMBO:
      return "combo";
    case Meta.WindowType.DND:
      return "dnd";
    case Meta.WindowType.OVERRIDE_OTHER:
      return "override_other";
    default:
      return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------
export default class IdeTogglerExtension extends Extension {
  enable() {
    setCairo(imports.cairo);

    // --- DBus (debugging) ---
    this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(IFACE_XML, this);
    this._dbusImpl.export(Gio.DBus.session, OBJECT_PATH);
    this._ownerId = Gio.bus_own_name(
      Gio.BusType.SESSION,
      BUS_NAME,
      Gio.BusNameOwnerFlags.NONE,
      null,
      null,
      null,
    );

    // --- state ---
    this._signalIds = [];
    this._windowSignals = new Map();
    this._uiDebounceId = 0;
    this._sessionDebounceId = 0;
    this._backstopId = 0;
    this._sessions = [];
    this._activity = new Map(); // pid -> updatedAt
    this._prevStates = new Map(); // window id -> state
    this._blinking = new Set(); // window ids that should blink
    this._iconActors = []; // animated icons to stop on refresh
    this._dragging = false; // grip-handle drag in progress
    this._dragGrab = null; // active Clutter pointer grab, if any

    // --- settings ---
    this._settingsPath = GLib.build_filenamev([
      GLib.get_user_config_dir(),
      "ide-toggler.json",
    ]);
    this._settings = this._loadSettings();

    // --- window tracking ---
    const display = global.display;
    this._signalIds.push([
      display,
      display.connect("window-created", (_d, win) => {
        this._trackWindow(win);
        this._scheduleUiRefresh();
      }),
    ]);
    for (const actor of global.get_window_actors()) {
      const win = actor.meta_window;
      if (win) this._trackWindow(win);
    }

    // --- session source ---
    this._claudeSessionsDir = GLib.build_filenamev([
      GLib.get_home_dir(),
      ".claude",
      "sessions",
    ]);
    this._codexSessionsDir = GLib.build_filenamev([
      GLib.get_home_dir(),
      ".codex",
      "sessions",
    ]);
    this._sessionMonitors = [];
    this._setupSessionMonitor();
    this._reloadSessions();

    // --- UI ---
    this._buildUi();

    this._signalIds.push([
      Main.layoutManager,
      Main.layoutManager.connect("monitors-changed", () =>
        this._positionPanel(),
      ),
    ]);

    // --- backstop refresh (5s) ---
    this._backstopId = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      5,
      () => {
        this._reloadSessions();
        this._refreshUi();
        return GLib.SOURCE_CONTINUE;
      },
    );

    this._refreshUi();
  }

  // --- settings persistence ---
  _defaultSettings() {
    return {
      orderMode: "statusPriority",
      muted: false,
      compactMode: false,
      hidden: false,
      // null position => default top-right placement.
      posX: null,
      posY: null,
    };
  }

  _loadSettings() {
    try {
      const file = Gio.File.new_for_path(this._settingsPath);
      const [ok, contents] = file.load_contents(null);
      if (!ok) return this._defaultSettings();
      const obj = JSON.parse(new TextDecoder().decode(contents));
      const s = this._defaultSettings();
      if (ORDER_MODES.includes(obj.orderMode)) s.orderMode = obj.orderMode;
      if (typeof obj.muted === "boolean") s.muted = obj.muted;
      if (typeof obj.compactMode === "boolean") s.compactMode = obj.compactMode;
      if (typeof obj.hidden === "boolean") s.hidden = obj.hidden;
      if (Number.isFinite(obj.posX)) s.posX = obj.posX;
      if (Number.isFinite(obj.posY)) s.posY = obj.posY;
      return s;
    } catch (_e) {
      return this._defaultSettings();
    }
  }

  _saveSettings() {
    try {
      const file = Gio.File.new_for_path(this._settingsPath);
      const data = JSON.stringify(this._settings);
      file.replace_contents(
        new TextEncoder().encode(data),
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null,
      );
    } catch (e) {
      logError(e, "ide-toggler: failed to save settings");
    }
  }

  // --- window signal tracking ---
  _trackWindow(win) {
    if (!win || this._windowSignals.has(win)) return;
    const ids = [];
    ids.push(
      win.connect("unmanaged", () => {
        this._untrackWindow(win);
        this._scheduleUiRefresh();
      }),
    );
    ids.push(win.connect("notify::title", () => this._scheduleUiRefresh()));
    ids.push(win.connect("notify::wm-class", () => this._scheduleUiRefresh()));
    this._windowSignals.set(win, ids);
  }

  _untrackWindow(win) {
    const ids = this._windowSignals.get(win);
    if (!ids) return;
    for (const id of ids) {
      try {
        win.disconnect(id);
      } catch (_e) {
        /* gone */
      }
    }
    this._windowSignals.delete(win);
  }

  // --- session monitoring ---
  _setupSessionMonitor() {
    for (const path of [this._claudeSessionsDir, this._codexSessionsDir]) {
      try {
        const dir = Gio.File.new_for_path(path);
        const monitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
        this._sessionMonitors.push(monitor);
        this._signalIds.push([
          monitor,
          monitor.connect("changed", () => this._scheduleSessionReload()),
        ]);
      } catch (e) {
        logError(e, `ide-toggler: failed to monitor sessions dir ${path}`);
      }
    }
  }

  _scheduleSessionReload() {
    if (this._sessionDebounceId) return;
    this._sessionDebounceId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      200,
      () => {
        this._sessionDebounceId = 0;
        this._reloadSessions();
        this._refreshUi();
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  _pidAlive(pid) {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    return Gio.File.new_for_path(`/proc/${pid}`).query_exists(null);
  }

  _reloadSessions() {
    const sessions = [];
    const activity = new Map();
    this._reloadClaudeSessions(sessions, activity);
    this._reloadCodexSessions(sessions, activity);
    this._sessions = sessions;
    this._activity = activity;
  }

  _reloadClaudeSessions(sessions, activity) {
    let dirEnum = null;
    try {
      const dir = Gio.File.new_for_path(this._claudeSessionsDir);
      dirEnum = dir.enumerate_children(
        "standard::name",
        Gio.FileQueryInfoFlags.NONE,
        null,
      );
      let info;
      while ((info = dirEnum.next_file(null)) !== null) {
        const name = info.get_name();
        if (!name.endsWith(".json")) continue;
        const path = GLib.build_filenamev([this._claudeSessionsDir, name]);
        const session = this._parseSession(path);
        if (!session) continue;
        if (!this._pidAlive(session.pid)) continue;
        sessions.push(session);
        if (Number.isFinite(session.updatedAt))
          activity.set(session.pid, session.updatedAt);
      }
    } catch (_e) {
      // dir missing / unreadable -> no sessions
    } finally {
      if (dirEnum) {
        try {
          dirEnum.close(null);
        } catch (_e) {
          /* ignore */
        }
      }
    }
  }

  _parseSession(path) {
    try {
      const obj = JSON.parse(this._readTextFile(path));
      return parseSessionObject(obj);
    } catch (_e) {
      return null;
    }
  }

  _reloadCodexSessions(sessions, activity) {
    const liveWorkspaces = this._liveCodexWorkspaces();
    if (!liveWorkspaces.size) return;
    const codexSessions = [];
    for (const path of this._codexRolloutPaths(this._codexSessionsDir)) {
      try {
        const session = parseCodexRolloutJsonl(
          this._readTextFile(path),
          liveWorkspaces,
        );
        if (!session) continue;
        codexSessions.push(session);
      } catch (_e) {
        // unreadable/corrupt rollout -> ignore
      }
    }
    for (const session of latestCodexSessionsByCwd(codexSessions)) {
      sessions.push(session);
      if (Number.isFinite(session.updatedAt))
        activity.set(session.pid, session.updatedAt);
    }
  }

  _readTextFile(path) {
    const file = Gio.File.new_for_path(path);
    const [ok, contents] = file.load_contents(null);
    if (!ok) throw new Error(`failed to read ${path}`);
    return new TextDecoder().decode(contents);
  }

  _codexRolloutPaths(rootPath) {
    const result = [];
    const visit = (dirPath) => {
      let dirEnum = null;
      try {
        const dir = Gio.File.new_for_path(dirPath);
        dirEnum = dir.enumerate_children(
          "standard::name,standard::type",
          Gio.FileQueryInfoFlags.NONE,
          null,
        );
        let info;
        while ((info = dirEnum.next_file(null)) !== null) {
          const name = info.get_name();
          const path = GLib.build_filenamev([dirPath, name]);
          if (info.get_file_type() === Gio.FileType.DIRECTORY) visit(path);
          else if (name.endsWith(".jsonl")) result.push(path);
        }
      } catch (_e) {
        // missing/unreadable directory -> no rollouts
      } finally {
        if (dirEnum) {
          try {
            dirEnum.close(null);
          } catch (_e) {
            /* ignore */
          }
        }
      }
    };
    visit(rootPath);
    return result;
  }

  _liveCodexWorkspaces() {
    const workspaces = new Set();
    let procEnum = null;
    try {
      const proc = Gio.File.new_for_path("/proc");
      procEnum = proc.enumerate_children(
        "standard::name,standard::type",
        Gio.FileQueryInfoFlags.NONE,
        null,
      );
      let info;
      while ((info = procEnum.next_file(null)) !== null) {
        const pid = info.get_name();
        if (!/^\d+$/.test(pid) || info.get_file_type() !== Gio.FileType.DIRECTORY)
          continue;
        let comm;
        try {
          comm = this._readTextFile(`/proc/${pid}/comm`).trim();
        } catch (_e) {
          continue;
        }
        if (comm !== "codex") continue;
        try {
          const cwd = GLib.file_read_link(`/proc/${pid}/cwd`);
          if (cwd) workspaces.add(normalizePath(cwd));
        } catch (_e) {
          // process exited or cwd not visible
        }
      }
    } catch (_e) {
      // /proc unavailable -> no live Codex sessions
    } finally {
      if (procEnum) {
        try {
          procEnum.close(null);
        } catch (_e) {
          /* ignore */
        }
      }
    }
    return workspaces;
  }

  // --- window enumeration ---
  _enumerateEditorWindows() {
    const windows = [];
    for (const actor of global.get_window_actors()) {
      const win = actor.meta_window;
      if (!win) continue;
      const editor = editorForWmClass(win.get_wm_class());
      if (!editor) continue;
      if (win.get_window_type() !== Meta.WindowType.NORMAL) continue;
      if (win.is_skip_taskbar()) continue;
      const title = win.get_title() || "";
      const folder = folderFromTitle(title, editor);
      if (!folder) continue;
      windows.push({
        id: `${editor.kind}-win-${win.get_id()}`,
        folder,
        ide: editor.kind,
        badge: editor.badge,
        metaWindow: win,
      });
    }
    return windows;
  }

  // --- build rows (delegates ordering/matching to the pure aggregator) ---
  _buildRows() {
    return buildRows({
      windows: this._enumerateEditorWindows(),
      sessions: this._sessions,
      activity: this._activity,
      orderMode: this._settings.orderMode,
    });
  }

  // ---------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------
  _buildUi() {
    this._panel = new St.BoxLayout({
      style_class: "ide-toggler-panel",
      orientation: Clutter.Orientation.VERTICAL,
      reactive: true,
      track_hover: true,
    });

    // Content goes DIRECTLY in the panel's vertical box (no ScrollView): a
    // vertical St.BoxLayout naturally hugs its children, like the macOS panel
    // which just grows with content. (The ScrollView was driving the full-height
    // regression.) If the list ever gets very long we can revisit capping.
    this._content = new St.BoxLayout({
      style_class: "ide-toggler-content",
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
    });
    this._panel.add_child(this._content);

    this._buildFooter();

    Main.layoutManager.addChrome(this._panel, {
      affectsStruts: false,
      trackFullscreen: true,
    });
    this._positionPanel();

    // Restore hidden state from settings.
    if (this._settings.hidden) this._hidePanel(true);
  }

  // --- drag to move (dedicated grip handle; grab-on-press) ---
  // The panel body is click-only and never starts a drag. Only the footer grip
  // handle drags: press grabs immediately (safe — the grip is not over rows or
  // footer buttons), motion moves the clamped panel, release always dismisses
  // the grab so it can never get stuck.
  _onHandlePress(event) {
    if (event.get_button() !== Clutter.BUTTON_PRIMARY)
      return Clutter.EVENT_PROPAGATE;

    const [stageX, stageY] = event.get_coords();
    const [panelX, panelY] = this._panel.get_position();
    this._dragOffsetX = stageX - panelX;
    this._dragOffsetY = stageY - panelY;
    this._dragging = true;
    this._panel.add_style_class_name("ide-toggler-panel-dragging");

    // Grab so motion/release route to the handle for the whole drag, even if
    // the pointer leaves the handle/panel bounds.
    try {
      if (global.stage.grab) this._dragGrab = global.stage.grab(this._handle);
    } catch (_e) {
      this._dragGrab = null;
    }
    return Clutter.EVENT_STOP;
  }

  _onHandleMotion(event) {
    if (!this._dragging) return Clutter.EVENT_PROPAGATE;
    const [stageX, stageY] = event.get_coords();
    let x = stageX - this._dragOffsetX;
    let y = stageY - this._dragOffsetY;
    [x, y] = this._clampToWorkArea(x, y);
    this._panel.set_position(Math.round(x), Math.round(y));
    return Clutter.EVENT_STOP;
  }

  _endHandleDrag() {
    if (this._dragGrab) {
      try {
        this._dragGrab.dismiss();
      } catch (_e) {
        /* ignore */
      }
      this._dragGrab = null;
    }
    if (!this._dragging) return Clutter.EVENT_PROPAGATE;
    this._dragging = false;
    if (this._panel) {
      this._panel.remove_style_class_name("ide-toggler-panel-dragging");
      const [x, y] = this._panel.get_position();
      this._settings.posX = Math.round(x);
      this._settings.posY = Math.round(y);
      this._saveSettings();
    }
    return Clutter.EVENT_STOP;
  }

  // Clamp a top-left position so the panel stays within the primary monitor
  // work area (keeps at least the panel fully on-screen).
  _clampToWorkArea(x, y) {
    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor) return [x, y];
    const work = Main.layoutManager.getWorkAreaForMonitor(
      Main.layoutManager.primaryIndex,
    );
    const area = work ?? monitor;
    const w = this._panel.width || 300;
    const h = this._panel.height || 0;
    const minX = area.x;
    const minY = area.y;
    const maxX = area.x + area.width - w;
    const maxY = area.y + area.height - h;
    return [
      Math.max(minX, Math.min(x, Math.max(minX, maxX))),
      Math.max(minY, Math.min(y, Math.max(minY, maxY))),
    ];
  }

  _buildFooter() {
    this._footer = new St.BoxLayout({
      style_class: "ide-toggler-footer",
      x_expand: true,
    });

    // Dedicated drag grip on the left. Non-button: a reactive icon that grabs
    // on press and drags the panel. Because it's a dedicated grip (not over
    // rows/footer buttons), grab-on-press here never steals clicks elsewhere.
    this._handle = new St.Icon({
      style_class: "ide-toggler-grip",
      icon_name: "view-more-horizontal-symbolic",
      icon_size: 16,
      reactive: true,
      track_hover: true,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._signalIds.push([
      this._handle,
      this._handle.connect("button-press-event", (_a, ev) =>
        this._onHandlePress(ev),
      ),
    ]);
    this._signalIds.push([
      this._handle,
      this._handle.connect("motion-event", (_a, ev) =>
        this._onHandleMotion(ev),
      ),
    ]);
    this._signalIds.push([
      this._handle,
      this._handle.connect("button-release-event", () => this._endHandleDrag()),
    ]);
    this._footer.add_child(this._handle);

    const spacer = new St.Widget({ x_expand: true });
    this._footer.add_child(spacer);

    this._compactBtn = new St.Button({
      style_class: "ide-toggler-footer-btn",
      child: new St.Icon({
        icon_name: this._settings.compactMode
          ? "view-fullscreen-symbolic"
          : "view-restore-symbolic",
        icon_size: 16,
      }),
      can_focus: true,
    });
    this._signalIds.push([
      this._compactBtn,
      this._compactBtn.connect("clicked", () => {
        this._settings.compactMode = !this._settings.compactMode;
        this._saveSettings();
        this._updateCompactIcon();
        this._refreshUi();
      }),
    ]);
    this._footer.add_child(this._compactBtn);

    this._gearBtn = new St.Button({
      style_class: "ide-toggler-footer-btn",
      child: new St.Icon({
        icon_name: "emblem-system-symbolic",
        icon_size: 16,
      }),
      can_focus: true,
    });
    this._signalIds.push([
      this._gearBtn,
      this._gearBtn.connect("clicked", () => this._toggleSettingsMenu()),
    ]);
    this._footer.add_child(this._gearBtn);

    // Close/hide button (GNOME-only): hides the panel and shows a top-bar
    // indicator to bring it back.
    this._closeBtn = new St.Button({
      style_class: "ide-toggler-footer-btn",
      child: new St.Icon({ icon_name: "window-close-symbolic", icon_size: 16 }),
      can_focus: true,
    });
    this._signalIds.push([
      this._closeBtn,
      this._closeBtn.connect("clicked", () => this._hidePanel()),
    ]);
    this._footer.add_child(this._closeBtn);

    this._buildSettingsMenu();
    this._panel.add_child(this._footer);
  }

  _updateCompactIcon() {
    const icon = this._compactBtn?.get_child();
    if (icon)
      icon.icon_name = this._settings.compactMode
        ? "view-fullscreen-symbolic"
        : "view-restore-symbolic";
  }

  _buildSettingsMenu() {
    this._settingsMenu = new PopupMenu.PopupMenu(
      this._gearBtn,
      0.5,
      St.Side.BOTTOM,
    );
    this._settingsMenu.actor.add_style_class_name("ide-toggler-settings-menu");

    const orderLabels = {
      statusPriority: "Status priority",
      alphabetical: "Alphabetical",
      recentlyActive: "Recently active",
    };
    this._orderItems = {};
    const orderHeader = new PopupMenu.PopupMenuItem("Order", {
      reactive: false,
    });
    orderHeader.label.add_style_class_name("ide-toggler-menu-header");
    this._settingsMenu.addMenuItem(orderHeader);
    for (const mode of ORDER_MODES) {
      const item = new PopupMenu.PopupMenuItem(orderLabels[mode]);
      item.setOrnament(
        this._settings.orderMode === mode
          ? PopupMenu.Ornament.DOT
          : PopupMenu.Ornament.NONE,
      );
      item.connect("activate", () => {
        this._settings.orderMode = mode;
        this._saveSettings();
        for (const m of ORDER_MODES) {
          this._orderItems[m].setOrnament(
            m === mode ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE,
          );
        }
        this._refreshUi();
      });
      this._orderItems[mode] = item;
      this._settingsMenu.addMenuItem(item);
    }

    this._settingsMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    this._muteItem = new PopupMenu.PopupSwitchMenuItem(
      "Mute sound",
      this._settings.muted,
    );
    this._muteItem.connect("toggled", (_i, state) => {
      this._settings.muted = state;
      this._saveSettings();
    });
    this._settingsMenu.addMenuItem(this._muteItem);

    Main.uiGroup.add_child(this._settingsMenu.actor);
    this._settingsMenu.close();

    this._settingsMenuManager = new PopupMenu.PopupMenuManager(this._gearBtn);
    this._settingsMenuManager.addMenu(this._settingsMenu);
  }

  _toggleSettingsMenu() {
    if (this._muteItem) this._muteItem.setToggleState(this._settings.muted);
    for (const m of ORDER_MODES) {
      this._orderItems[m]?.setOrnament(
        m === this._settings.orderMode
          ? PopupMenu.Ornament.DOT
          : PopupMenu.Ornament.NONE,
      );
    }
    this._settingsMenu.toggle();
  }

  _positionPanel() {
    if (!this._panel) return;
    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor) return;
    const margin = 12;
    const topInset = Main.panel?.height ?? 0;
    const panelWidth = 300;
    this._panel.set_width(panelWidth);
    // No height cap: the panel's vertical box hugs its content.

    let x, y;
    if (
      Number.isFinite(this._settings.posX) &&
      Number.isFinite(this._settings.posY)
    ) {
      // Respect a saved (dragged) position, but clamp it to the current
      // work area in case monitors changed.
      [x, y] = this._clampToWorkArea(this._settings.posX, this._settings.posY);
    } else {
      // Default: top-right of the primary monitor, under the top bar.
      x = monitor.x + monitor.width - panelWidth - margin;
      y = monitor.y + topInset + margin;
    }
    this._panel.set_position(Math.round(x), Math.round(y));
  }

  // --- hide to top-bar / restore ---
  _hidePanel(restoring = false) {
    if (this._panel) this._panel.hide();
    if (!this._indicator) {
      this._indicator = new IdeTogglerIndicator(() => this._showPanel());
      Main.panel.addToStatusArea("ide-toggler", this._indicator, 0, "right");
    }
    this._settings.hidden = true;
    if (!restoring) this._saveSettings();
  }

  _showPanel() {
    if (this._panel) this._panel.show();
    if (this._indicator) {
      this._indicator.destroy();
      this._indicator = null;
    }
    this._settings.hidden = false;
    this._saveSettings();
  }

  _scheduleUiRefresh() {
    if (this._uiDebounceId) return;
    this._uiDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
      this._uiDebounceId = 0;
      if (this._dbusImpl) this._dbusImpl.emit_signal("WindowsChanged", null);
      this._refreshUi();
      return GLib.SOURCE_REMOVE;
    });
  }

  _stopIconAnimations() {
    for (const icon of this._iconActors) {
      if (icon && icon._stop) icon._stop();
    }
    this._iconActors = [];
  }

  _refreshUi() {
    if (!this._content) return;

    const rows = this._buildRows();

    // --- transition detection: working -> idle ---
    const newStates = new Map();
    for (const r of rows) newStates.set(r.window.id, r.state);

    const transitions = detectTransitions(this._prevStates, newStates);
    this._blinking = nextBlinkSet(this._blinking, rows, transitions);
    if (transitions.length && !this._settings.muted) this._playChime();
    this._prevStates = newStates;

    // --- rebuild content ---
    this._stopIconAnimations();
    this._content.destroy_all_children();

    if (rows.length === 0) {
      const empty = new St.Label({
        style_class: "ide-toggler-empty",
        text: "No editor windows",
        x_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
      });
      this._content.add_child(empty);
      return;
    }

    const ideKinds = new Set(rows.map((r) => r.window.ide));
    const showBadges = ideKinds.size > 1;

    if (this._settings.compactMode) {
      this._content.add_child(this._makeCompactHeader(rows));
      const row = compactRow(rows);
      if (row) this._content.add_child(this._makeRow(row, showBadges));
      return;
    }

    // Group headers only make sense when the list is sorted by status, so they're
    // shown for statusPriority and the list is flat otherwise (mirrors macOS
    // PanelView.showsGroups). buildRows has already applied the chosen sort.
    if (this._settings.orderMode !== "statusPriority") {
      for (const r of rows)
        this._content.add_child(this._makeRow(r, showBadges));
      return;
    }

    const order = ["needs", "working", "idle"];
    const headerLabels = {
      needs: "Needs you",
      working: "Working",
      idle: "Idle",
    };
    const grouped = { needs: [], working: [], idle: [] };
    for (const r of rows) grouped[groupForState(r.state)].push(r);

    for (const g of order) {
      const groupRows = grouped[g];
      if (groupRows.length === 0) continue;
      this._content.add_child(
        this._makeGroupHeader(headerLabels[g], groupRows.length),
      );
      for (const r of groupRows)
        this._content.add_child(this._makeRow(r, showBadges));
    }
  }

  _makeGroupHeader(label, count) {
    const box = new St.BoxLayout({
      style_class: "ide-toggler-group-header",
      x_expand: true,
    });
    // Layout: [label][count pill][expanding spacer] so the label + count sit
    // left-aligned together (e.g. "IDLE [2]"), not pushed to opposite edges.
    const lbl = new St.Label({
      style_class: "ide-toggler-group-label",
      text: label.toUpperCase(),
      y_align: Clutter.ActorAlign.CENTER,
    });
    // Never truncate the header label; give it its natural width.
    lbl.clutter_text.set_ellipsize(0); // PANGO_ELLIPSIZE_NONE
    const pill = new St.Label({
      style_class: "ide-toggler-count-pill",
      text: String(count),
      y_align: Clutter.ActorAlign.CENTER,
    });
    // Visual up-nudge via transform (does NOT affect layout; a negative CSS
    // margin here underflowed St's height math to ~2^32 and broke the panel).
    pill.translation_y = -1.5;
    box.add_child(lbl);
    box.add_child(pill);
    box.add_child(new St.Widget({ x_expand: true }));
    return box;
  }

  _makeCompactHeader(rows) {
    const box = new St.BoxLayout({
      style_class: "ide-toggler-compact-header",
      x_expand: true,
    });
    const tally = { needs: 0, working: 0, idle: 0 };
    for (const r of rows) tally[groupForState(r.state)] += 1;
    const order = ["needs", "working", "idle"];
    const labels = { needs: "Needs you", working: "Working", idle: "Idle" };
    const parts = order.filter((g) => tally[g] > 0);
    parts.forEach((g, i) => {
      if (i > 0) {
        box.add_child(
          new St.Label({
            style_class: "ide-toggler-compact-dot",
            text: "·",
            y_align: Clutter.ActorAlign.CENTER,
          }),
        );
      }
      box.add_child(
        new St.Label({
          style_class: "ide-toggler-compact-part",
          text: `${labels[g]} ${tally[g]}`,
          y_align: Clutter.ActorAlign.CENTER,
        }),
      );
    });
    box.add_child(new St.Widget({ x_expand: true }));
    return box;
  }

  _makeRow(row, showBadge) {
    const btn = new St.Button({
      style_class: "ide-toggler-row",
      x_expand: true,
      can_focus: true,
      track_hover: true,
    });
    const isQuiet = row.state === "idle" || row.state === "noAgent";
    if (isQuiet) btn.add_style_class_name("ide-toggler-row-quiet");
    if (row.state === "needsAttention")
      btn.add_style_class_name("ide-toggler-row-needs");

    // Pulsing blink background (working->idle attention cue) behind the row
    // content, like macOS BlinkHighlight. A BinLayout wrapper stacks [blinkBg, btn];
    // blinkBg is a solid terracotta fill whose opacity oscillates while blinking.
    const wrapper = new St.Widget({
      x_expand: true,
      layout_manager: new Clutter.BinLayout(),
    });
    const blinkBg = new St.Widget({
      style_class: "ide-toggler-row-blink-bg",
      x_expand: true,
      y_expand: true,
      opacity: 0,
    });
    wrapper.add_child(blinkBg);

    const hbox = new St.BoxLayout({
      style_class: "ide-toggler-row-box",
      x_expand: true,
    });

    // Status icon (animated Cairo). Don't clip so the needs-you ping rings can
    // expand beyond the 14px footprint.
    const iconWrap = new St.Bin({
      width: 14,
      height: 14,
      y_align: Clutter.ActorAlign.CENTER,
    });
    iconWrap.set_clip_to_allocation(false);
    const icon = makeStatusIcon(row.state, 14);
    iconWrap.set_child(icon);
    if (icon._animate) {
      // Start the looping transitions immediately. add_transition with an
      // infinite repeat_count keeps running across map/unmap, so we don't
      // depend on notify::mapped timing. Re-arm on map as a safety net in
      // case the actor was created while off-stage.
      icon._animate();
      icon.connect("notify::mapped", () => {
        if (
          icon.mapped &&
          icon.get_transition("spin") === null &&
          icon.get_transition("ping-opacity") === null
        )
          icon._animate();
      });
      this._iconActors.push(icon);
    }
    hbox.add_child(iconWrap);

    // Folder name (dashes -> spaces for display only).
    const displayName = row.window.folder.replace(/-/g, " ");
    const name = new St.Label({
      style_class: "ide-toggler-row-name",
      text: displayName,
      x_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
    });
    name.clutter_text.set_line_wrap(false);
    name.clutter_text.set_ellipsize(3); // PANGO_ELLIPSIZE_END
    hbox.add_child(name);

    // Trailing group: the IDE badge sits flush to the right edge at rest, and the
    // chevron is collapsed to ZERO width by default — so it reserves no space and
    // leaves no empty gap. On hover it eases open (width + opacity), pushing the
    // badge left to make room (mirrors macOS, where the chevron is only in the
    // layout while hovering). spacing 0 so the badge hugs the chevron's lead gap.
    const trailing = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER });

    if (showBadge) {
      trailing.add_child(
        new St.Label({
          style_class: "ide-toggler-badge",
          text: row.window.badge,
          y_align: Clutter.ActorAlign.CENTER,
        }),
      );
    }

    // Chevron — transparent and zero-width at rest; eases open on hover. x_align
    // END + clipping reveals the glyph from the trailing edge as the width grows;
    // the ~6px of width beyond the 12px glyph is the lead gap from the badge.
    const CHEVRON_W = 18;
    const chevron = new St.Icon({
      style_class: "ide-toggler-chevron",
      icon_name: "go-next-symbolic",
      icon_size: 12,
      x_align: Clutter.ActorAlign.END,
      y_align: Clutter.ActorAlign.CENTER,
      opacity: 0,
      width: 0,
    });
    chevron.set_clip_to_allocation(true);
    trailing.add_child(chevron);
    btn.connect("notify::hover", () => {
      const on = btn.hover;
      chevron.ease({
        width: on ? CHEVRON_W : 0,
        opacity: on ? 140 : 0,
        duration: 180,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });
    });

    hbox.add_child(trailing);

    btn.set_child(hbox);

    const metaWindow = row.window.metaWindow;
    const id = row.window.id;
    btn.connect("clicked", () => {
      this._blinking.delete(id);
      blinkBg.remove_all_transitions();
      blinkBg.opacity = 0;
      if (metaWindow) {
        try {
          Main.activateWindow(metaWindow);
        } catch (e) {
          logError(e, "ide-toggler: activateWindow failed");
        }
      }
    });

    wrapper.add_child(btn);
    if (this._blinking.has(row.window.id)) {
      // Oscillate the terracotta fill's opacity forever while blinking
      // (~0.06 <-> 0.30 of full → St opacity 15 <-> 77), auto-reversing.
      blinkBg.opacity = 77;
      const t = loopingTransition(
        "opacity",
        77,
        15,
        650,
        Clutter.AnimationMode.EASE_IN_OUT_QUAD,
      );
      t.set_auto_reverse(true);
      blinkBg.add_transition("blink", t);
      blinkBg._stop = () => blinkBg.remove_all_transitions();
      this._iconActors.push(blinkBg);
    }
    return wrapper;
  }

  // --- chime: working -> idle ---
  _playChime() {
    try {
      if (!this._gsoundChecked) {
        this._gsoundChecked = true;
        try {
          const GSound = imports.gi.GSound;
          this._gsound = new GSound.Context();
          this._gsound.init(null);
        } catch (_e) {
          this._gsound = null;
        }
      }
      if (this._gsound) {
        this._gsound.play_simple({ "event.id": "complete" }, null);
        return;
      }
    } catch (_e) {
      this._gsound = null;
    }
    try {
      GLib.spawn_async(
        null,
        ["canberra-gtk-play", "-i", "complete"],
        null,
        GLib.SpawnFlags.SEARCH_PATH |
          GLib.SpawnFlags.STDOUT_TO_DEV_NULL |
          GLib.SpawnFlags.STDERR_TO_DEV_NULL,
        null,
      );
    } catch (_e) {
      // no sound backend — degrade silently
    }
  }

  // ---------------------------------------------------------------------
  // DBus (debugging)
  // ---------------------------------------------------------------------
  ListWindows() {
    const result = [];
    for (const actor of global.get_window_actors()) {
      const win = actor.meta_window;
      if (!win) continue;
      result.push([
        String(win.get_id()),
        win.get_wm_class() || "",
        win.get_title() || "",
        windowTypeToString(win.get_window_type()),
        win.is_skip_taskbar(),
      ]);
    }
    return result;
  }

  ActivateWindow(id) {
    for (const actor of global.get_window_actors()) {
      const win = actor.meta_window;
      if (!win) continue;
      if (String(win.get_id()) === id) {
        Main.activateWindow(win);
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------
  disable() {
    if (this._uiDebounceId) {
      GLib.source_remove(this._uiDebounceId);
      this._uiDebounceId = 0;
    }
    if (this._sessionDebounceId) {
      GLib.source_remove(this._sessionDebounceId);
      this._sessionDebounceId = 0;
    }
    if (this._backstopId) {
      GLib.source_remove(this._backstopId);
      this._backstopId = 0;
    }

    this._stopIconAnimations();

    if (this._signalIds) {
      for (const [obj, id] of this._signalIds) {
        try {
          obj.disconnect(id);
        } catch (_e) {
          /* ignore */
        }
      }
      this._signalIds = null;
    }

    if (this._windowSignals) {
      for (const [win, ids] of this._windowSignals) {
        for (const id of ids) {
          try {
            win.disconnect(id);
          } catch (_e) {
            /* ignore */
          }
        }
      }
      this._windowSignals.clear();
      this._windowSignals = null;
    }

    if (this._sessionMonitors) {
      for (const monitor of this._sessionMonitors) {
        try {
          monitor.cancel();
        } catch (_e) {
          /* ignore */
        }
      }
      this._sessionMonitors = null;
    }

    if (this._settingsMenu) {
      this._settingsMenu.destroy();
      this._settingsMenu = null;
    }
    this._settingsMenuManager = null;
    this._orderItems = null;
    this._muteItem = null;
    this._compactBtn = null;
    this._gearBtn = null;
    this._closeBtn = null;
    this._handle = null;
    this._footer = null;

    // Top-bar indicator.
    if (this._indicator) {
      this._indicator.destroy();
      this._indicator = null;
    }

    // Drag: always dismiss any active grab so the pointer can never get stuck.
    // The handle's own signal handlers are torn down with the panel actor.
    if (this._dragGrab) {
      try {
        this._dragGrab.dismiss();
      } catch (_e) {
        /* ignore */
      }
      this._dragGrab = null;
    }
    this._dragging = false;

    if (this._panel) {
      try {
        Main.layoutManager.removeChrome(this._panel);
      } catch (_e) {
        /* ignore */
      }
      this._panel.destroy();
      this._panel = null;
    }
    this._scroll = null;
    this._content = null;

    this._gsound = null;
    this._gsoundChecked = false;
    this._sessions = [];
    this._activity = null;
    this._prevStates = null;
    this._blinking = null;
    this._iconActors = [];

    if (this._ownerId) {
      Gio.bus_unown_name(this._ownerId);
      this._ownerId = 0;
    }
    if (this._dbusImpl) {
      this._dbusImpl.unexport();
      this._dbusImpl = null;
    }
  }
}
