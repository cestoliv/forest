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

/// Opaque handle to a window for raising. `Core` never imports AppKit/AX,
/// so the AX element is referenced indirectly by id; the adapter resolves it.
public struct ZedWindow: Equatable, Sendable {
    public let id: String        // stable per-window key (adapter-assigned)
    public let folder: String    // parsed project folder name
    public init(id: String, folder: String) {
        self.id = id; self.folder = folder
    }
}

/// One row the UI renders.
public struct WindowRow: Equatable, Sendable {
    public let window: ZedWindow
    public let state: WindowState
    /// Most recent session activity time for this window, for recently-active ordering.
    public let lastActive: Date?
    public init(window: ZedWindow, state: WindowState, lastActive: Date?) {
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
    public init(orderMode: OrderMode = .statusPriority, muted: Bool = false) {
        self.orderMode = orderMode; self.muted = muted
    }
}
