import Foundation
import Combine
import IdeTogglerCore

/// Single source of truth for the UI. Joins window + session sources through the pure
/// Aggregator, detects working->idle transitions, fires the chime + animation, and
/// publishes ordered rows. SAFETY: holds no mutating system calls itself; raising is
/// delegated to a WindowRaising injected into the UI.
public final class StatusAggregatorStore: ObservableObject {
    @Published public private(set) var rows: [WindowRow] = []
    /// Window ids that just transitioned working->idle, for the UI to animate.
    @Published public private(set) var animatingWindowIDs: Set<String> = []
    @Published public var settings: Settings {
        didSet { refresh() }
    }

    private let windowSource: WindowSource
    private let sessionSource: SessionSource
    private let chime: ChimePlayer
    private var previousStates: [String: WindowState] = [:]

    public init(
        windowSource: WindowSource,
        sessionSource: SessionSource,
        chime: ChimePlayer,
        settings: Settings
    ) {
        self.windowSource = windowSource
        self.sessionSource = sessionSource
        self.chime = chime
        self.settings = settings
        self.windowSource.onChange = { [weak self] in self?.refresh() }
        self.sessionSource.onChange = { [weak self] in self?.refresh() }
    }

    public func start() {
        windowSource.start()
        sessionSource.start()
        refresh()
    }

    public func refresh() {
        assert(Thread.isMainThread, "refresh() must be called on the main thread")
        let windows = windowSource.currentWindows()
        let sessions = sessionSource.currentSessions()
        let activity = sessionSource.activity()

        let newRows = Aggregator.rows(
            windows: windows, sessions: sessions,
            mode: settings.orderMode, now: Date(), activity: activity)

        let newStates = Aggregator.stateSnapshot(rows: newRows)
        let transitions = Aggregator.workingToIdleTransitions(
            previous: previousStates, current: newStates)

        if !transitions.isEmpty {
            // Animation ALWAYS plays; sound respects mute.
            animatingWindowIDs = Set(transitions)
            if !settings.muted { chime.playChime() }
            // Auto-clear once the pulse has played. This lives here, not in the view,
            // so cleanup happens regardless of which rows are mounted: in compact mode
            // only one row renders, so a view-driven timer would strand the ids of any
            // hidden window that just transitioned (and could leave it stuck scaled if
            // it later became the compact row).
            for id in transitions {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                    self?.clearAnimation(for: id)
                }
            }
        }

        previousStates = newStates
        rows = newRows
    }

    public func clearAnimation(for id: String) {
        animatingWindowIDs.remove(id)
    }

    /// Row to show in compact mode. Prefers a needs-attention window (the most recent
    /// among them, or the first in current display order if none have activity);
    /// otherwise the most-recently-active window; falls back to the first row (respects
    /// orderMode) when no window has activity; nil when empty.
    public var compactRow: WindowRow? {
        func mostRecent(_ rs: [WindowRow]) -> WindowRow? {
            rs.compactMap { r in r.lastActive.map { (r, $0) } }
              .max(by: { $0.1 < $1.1 })?.0
        }
        let needs = rows.filter { $0.state == .needsAttention }
        if let r = mostRecent(needs) ?? needs.first { return r }
        return mostRecent(rows) ?? rows.first
    }
}
