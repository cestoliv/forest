import Foundation

public enum Aggregator {
    /// Basename of a cwd path, tolerating a trailing slash.
    static func basename(ofCwd cwd: String) -> String {
        let trimmed = cwd.hasSuffix("/") ? String(cwd.dropLast()) : cwd
        return (trimmed as NSString).lastPathComponent
    }

    /// A session started inside a project subdirectory should still attach to the
    /// editor window for the project root, whose title usually exposes only the
    /// root folder name.
    static func cwd(_ cwd: String, matchesFolder folder: String) -> Bool {
        guard !folder.isEmpty else { return false }
        if basename(ofCwd: cwd) == folder { return true }
        return (cwd as NSString).pathComponents.contains(folder)
    }

    /// Sessions whose cwd matches this window's folder.
    static func sessions(for window: EditorWindow, in sessions: [Session]) -> [Session] {
        sessions.filter { cwd($0.cwd, matchesFolder: window.folder) }
    }

    /// Collapse a window's matched sessions into one WindowState by priority.
    public static func state(for window: EditorWindow, sessions allSessions: [Session]) -> WindowState {
        let matched = sessions(for: window, in: allSessions)
        if matched.isEmpty { return .noAgent }
        // Priority: needsAttention > working > idle (no-agent already excluded).
        if matched.contains(where: { $0.status == .waiting }) { return .needsAttention }
        if matched.contains(where: { $0.status == .busy || $0.status == .shell }) { return .working }
        return .idle
    }

    /// Build ordered rows. `activity` maps session pid -> last-updated time so
    /// recently-active ordering and lastActive can be computed. `stateEnteredAt` maps
    /// window id -> the time that window entered its current state (drives the live
    /// timer and `stuckDuration` ordering); `noAgent` rows carry no duration.
    public static func rows(
        windows: [EditorWindow],
        sessions: [Session],
        mode: OrderMode,
        now: Date?,
        activity: [Int32: Date] = [:],
        stateEnteredAt: [String: Date] = [:]
    ) -> [WindowRow] {
        let unordered = windows.map { win -> WindowRow in
            let matched = self.sessions(for: win, in: sessions)
            let lastActive = matched.compactMap { activity[$0.pid] }.max()
            let state = state(for: win, sessions: sessions)
            let entered = state == .noAgent ? nil : stateEnteredAt[win.id]
            return WindowRow(window: win,
                             state: state,
                             lastActive: lastActive,
                             stateEnteredAt: entered)
        }
        return order(rows: unordered, mode: mode)
    }

    /// Stable priority rank for status-priority ordering (lower = higher in list).
    static func priorityRank(_ state: WindowState) -> Int {
        switch state {
        case .needsAttention: return 0
        case .working:        return 1
        case .idle:           return 2
        case .noAgent:        return 3
        }
    }

    public static func order(rows: [WindowRow], mode: OrderMode) -> [WindowRow] {
        switch mode {
        case .alphabetical:
            return rows.sorted {
                $0.window.folder.localizedCaseInsensitiveCompare($1.window.folder) == .orderedAscending
            }
        case .statusPriority:
            return rows.sorted { a, b in
                let ra = priorityRank(a.state), rb = priorityRank(b.state)
                if ra != rb { return ra < rb }
                return a.window.folder.localizedCaseInsensitiveCompare(b.window.folder) == .orderedAscending
            }
        case .recentlyActive:
            return rows.sorted { a, b in
                switch (a.lastActive, b.lastActive) {
                case let (x?, y?): return x > y
                case (_?, nil):    return true   // has activity -> before nil
                case (nil, _?):    return false
                case (nil, nil):
                    return a.window.folder.localizedCaseInsensitiveCompare(b.window.folder) == .orderedAscending
                }
            }
        case .stuckDuration:
            return rows.sorted { a, b in
                switch (a.stateEnteredAt, b.stateEnteredAt) {
                case let (x?, y?):
                    if x != y { return x < y }   // entered earlier -> stuck longer -> first
                    return a.window.folder.localizedCaseInsensitiveCompare(b.window.folder) == .orderedAscending
                case (_?, nil):    return true   // has a duration -> before noAgent
                case (nil, _?):    return false
                case (nil, nil):
                    return a.window.folder.localizedCaseInsensitiveCompare(b.window.folder) == .orderedAscending
                }
            }
        }
    }

    /// Per-window state-entry times, given the previous snapshot and the new states.
    /// A window keeps its previous `enteredAt` while its state is unchanged; on any
    /// state change (or a brand-new window) the entry time resets to `now`. Pure and
    /// independent of `workingToIdleTransitions` (which is only the chime trigger).
    /// Seed `previous` from persisted state on launch to keep timers running across an
    /// app restart (entries whose persisted state no longer matches reset to `now`).
    public static func stateEntryTimes(
        previous: [String: StateEntry],
        current: [String: WindowState],
        now: Date
    ) -> [String: Date] {
        var result: [String: Date] = [:]
        for (id, state) in current {
            if let prev = previous[id], prev.state == state {
                result[id] = prev.enteredAt
            } else {
                result[id] = now
            }
        }
        return result
    }

    /// Window ids that moved from .working back to the quiet idle group between
    /// snapshots. Codex can disappear as a live session immediately after writing
    /// task completion, which surfaces as .noAgent rather than a literal .idle.
    /// Returns a sorted array for deterministic test/notify behavior.
    public static func workingToIdleTransitions(
        previous: [String: WindowState],
        current: [String: WindowState]
    ) -> [String] {
        current.compactMap { id, state -> String? in
            guard (state == .idle || state == .noAgent),
                  previous[id] == .working else { return nil }
            return id
        }
        .sorted()
    }

    /// Convenience: snapshot of id -> state for a set of rows.
    public static func stateSnapshot(rows: [WindowRow]) -> [String: WindowState] {
        Dictionary(rows.map { ($0.window.id, $0.state) }, uniquingKeysWith: { _, new in new })
    }
}
