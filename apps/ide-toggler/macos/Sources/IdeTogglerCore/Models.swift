import Foundation

/// Marker for smoke test — kept after Task 1 replaces the placeholder.
public enum IdeTogglerCoreMarker { case ok }

/// Raw status strings written by Claude Code sessions.
public enum AgentStatus: String, Equatable, Sendable {
    case busy
    case shell
    case waiting
    case idle
}

/// The four collapsed visual states for a window (priority order top-to-bottom).
public enum WindowState: String, Equatable, Sendable, CaseIterable {
    case needsAttention   // any session waiting
    case working          // any session busy/shell
    case idle             // all sessions idle
    case noAgent          // no session for this window
}

/// A decoded Claude session (already liveness-filtered upstream).
public struct Session: Equatable, Sendable {
    public let pid: Int32
    public let cwd: String
    public let status: AgentStatus
    public init(pid: Int32, cwd: String, status: AgentStatus) {
        self.pid = pid; self.cwd = cwd; self.status = status
    }
}

/// Which editor an open window belongs to (drives the per-row IDE badge and the
/// window-id prefix). Raw values are stable — they're embedded in window ids.
public enum IDEKind: String, Equatable, Sendable, CaseIterable {
    case zed
    case vscode
    case jetBrains   // WebStorm and other JetBrains IDEs
}

/// Per-IDE configuration: how to recognise its app processes (`bundleIDs`) and
/// how to extract the project folder from a window title (`titleStrategy`).
/// Pure data so the catalog is unit-testable without any system imports.
public struct EditorApp: Equatable, Sendable {
    public let kind: IDEKind
    public let bundleIDs: [String]
    public let titleStrategy: TitleStrategy
    /// Trailing app-name segments stripped before parsing (VSCode only).
    public let appNameSuffixes: [String]
    /// Window titles that are chrome, not projects (About box, welcome screen, etc.).
    /// Matched case-sensitively against the trimmed title. FRAGILE: these strings are
    /// locale- and version-specific, so they're a best-effort blocklist — see
    /// `nonProjectTitlePrefixes` for the prefix-matched variant. Native open/save panels
    /// are filtered structurally in the AX adapter, not here.
    public let nonProjectTitles: [String]
    /// Like `nonProjectTitles` but prefix-matched (e.g. "Release Notes:" for VSCode,
    /// "Welcome to " for JetBrains, whose chrome titles carry a version/app suffix).
    public let nonProjectTitlePrefixes: [String]
    public init(kind: IDEKind, bundleIDs: [String], titleStrategy: TitleStrategy,
                appNameSuffixes: [String] = [], nonProjectTitles: [String] = [],
                nonProjectTitlePrefixes: [String] = []) {
        self.kind = kind; self.bundleIDs = bundleIDs
        self.titleStrategy = titleStrategy; self.appNameSuffixes = appNameSuffixes
        self.nonProjectTitles = nonProjectTitles
        self.nonProjectTitlePrefixes = nonProjectTitlePrefixes
    }
}

extension EditorApp {
    public static let zed = EditorApp(
        kind: .zed,
        bundleIDs: ["dev.zed.Zed"],
        titleStrategy: .beforeEmDash,
        nonProjectTitles: ["About Zed", "empty project"])

    public static let vscode = EditorApp(
        kind: .vscode,
        bundleIDs: ["com.microsoft.VSCode", "com.microsoft.VSCodeInsiders",
                    "com.visualstudio.code.oss"],
        titleStrategy: .vscodeRootName,
        appNameSuffixes: ["Visual Studio Code - Insiders", "Visual Studio Code",
                          "Code - OSS"],
        nonProjectTitles: ["Welcome", "Get Started"],
        nonProjectTitlePrefixes: ["Release Notes:"])

    public static let jetBrains = EditorApp(
        kind: .jetBrains,
        bundleIDs: ["com.jetbrains.WebStorm"],
        titleStrategy: .beforeFirstBracketOrHyphen,
        nonProjectTitles: ["About WebStorm", "Open File or Project"],
        nonProjectTitlePrefixes: ["Welcome to "])

    /// The editors scanned, in display/scan order.
    public static let all: [EditorApp] = [.zed, .vscode, .jetBrains]
}

/// Opaque handle to a window for raising. `Core` never imports AppKit/AX,
/// so the AX element is referenced indirectly by id; the adapter resolves it.
public struct EditorWindow: Equatable, Sendable {
    public let id: String        // stable per-window key (adapter-assigned)
    public let folder: String    // parsed project folder name
    public let ide: IDEKind      // which editor this window belongs to
    public init(id: String, folder: String, ide: IDEKind) {
        self.id = id; self.folder = folder; self.ide = ide
    }
}

/// One row the UI renders.
public struct WindowRow: Equatable, Sendable {
    public let window: EditorWindow
    public let state: WindowState
    /// Most recent session activity time for this window, for recently-active ordering.
    public let lastActive: Date?
    public init(window: EditorWindow, state: WindowState, lastActive: Date?) {
        self.window = window; self.state = state; self.lastActive = lastActive
    }
}

public enum OrderMode: String, Equatable, Sendable, CaseIterable {
    case statusPriority   // default
    case alphabetical
    case recentlyActive
}

public struct Settings: Equatable, Sendable {
    public var orderMode: OrderMode
    public var muted: Bool
    public var compactMode: Bool
    public init(orderMode: OrderMode = .statusPriority, muted: Bool = false, compactMode: Bool = false) {
        self.orderMode = orderMode; self.muted = muted; self.compactMode = compactMode
    }
}
