import Foundation

public enum Aggregator {
    /// Basename of a cwd path, tolerating a trailing slash.
    static func basename(ofCwd cwd: String) -> String {
        let trimmed = cwd.hasSuffix("/") ? String(cwd.dropLast()) : cwd
        return (trimmed as NSString).lastPathComponent
    }

    /// Sessions whose cwd basename matches this window's folder.
    static func sessions(for window: EditorWindow, in sessions: [Session]) -> [Session] {
        sessions.filter { basename(ofCwd: $0.cwd) == window.folder }
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
    /// recently-active ordering and lastActive can be computed.
    public static func rows(
        windows: [EditorWindow],
        sessions: [Session],
        mode: OrderMode,
        now: Date?,
        activity: [Int32: Date] = [:]
    ) -> [WindowRow] {
        let unordered = windows.map { win -> WindowRow in
            let matched = self.sessions(for: win, in: sessions)
            let lastActive = matched.compactMap { activity[$0.pid] }.max()
            return WindowRow(window: win,
                             state: state(for: win, sessions: sessions),
                             lastActive: lastActive)
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
        }
    }

    /// Window ids that moved specifically from .working to .idle between snapshots.
    /// Returns a sorted array for deterministic test/notify behavior.
    public static func workingToIdleTransitions(
        previous: [String: WindowState],
        current: [String: WindowState]
    ) -> [String] {
        current.compactMap { id, state -> String? in
            guard state == .idle, previous[id] == .working else { return nil }
            return id
        }
        .sorted()
    }

    /// Convenience: snapshot of id -> state for a set of rows.
    public static func stateSnapshot(rows: [WindowRow]) -> [String: WindowState] {
        Dictionary(uniqueKeysWithValues: rows.map { ($0.window.id, $0.state) })
    }
}
