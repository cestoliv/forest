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
        }

        previousStates = newStates
        rows = newRows
    }

    public func clearAnimation(for id: String) {
        animatingWindowIDs.remove(id)
    }
}
