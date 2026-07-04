import Foundation
import Combine
import IdeTogglerCore

/// Single source of truth for the UI. Joins window + session sources through the pure
/// Aggregator, detects working->idle transitions, fires the chime + animation, and
/// publishes ordered rows. SAFETY: holds no mutating system calls itself; raising is
/// delegated to a WindowRaising injected into the UI.
public final class StatusAggregatorStore: ObservableObject {
    @Published public private(set) var rows: [WindowRow] = []
    /// Window ids that should blink in the list: the project(s) that most recently
    /// transitioned working->idle. Persists until another project moves, the row is
    /// clicked, the window leaves the idle state, or the window disappears.
    @Published public private(set) var blinkingWindowIDs: Set<String> = []
    @Published public var settings: Settings {
        didSet { refresh() }
    }

    private let windowSource: WindowSource
    private let sessionSource: SessionSource
    private let chime: ChimePlayer
    private let stateStore: StateTimestampStore
    private var previousStates: [String: WindowState] = [:]
    /// Per-window state + entry time, carried across refreshes and persisted so the
    /// per-row timer survives an app restart. Seeded from disk on launch.
    private var stateEntries: [String: StateEntry]

    public init(
        windowSource: WindowSource,
        sessionSource: SessionSource,
        chime: ChimePlayer,
        settings: Settings,
        stateStore: StateTimestampStore = InMemoryStateTimestampStore()
    ) {
        self.windowSource = windowSource
        self.sessionSource = sessionSource
        self.chime = chime
        self.stateStore = stateStore
        self.stateEntries = stateStore.load()
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
        let now = Date()

        // An empty enumeration means the window list is temporarily unavailable (e.g. the
        // screen is locked / the Mac is asleep, so the AX API returns nothing) — NOT that
        // every editor closed. Preserve the per-row timer origins (no rebuild, no prune, no
        // save) so each timer resumes its real elapsed value on unlock; just clear the visible
        // rows/blink. A non-empty enumeration below prunes genuinely-closed windows as before.
        if windows.isEmpty && !stateEntries.isEmpty {
            if !blinkingWindowIDs.isEmpty { blinkingWindowIDs = [] }
            previousStates = [:]
            rows = []
            return
        }

        // Resolve each window's state, then carry/reset its state-entry time (the timer
        // origin). Done before ordering so `stuckDuration` and the row timer can use it.
        let currentStates = Dictionary(
            uniqueKeysWithValues: windows.map { ($0.id, Aggregator.state(for: $0, sessions: sessions)) })
        let entryTimes = Aggregator.stateEntryTimes(
            previous: stateEntries, current: currentStates, now: now)
        stateEntries = currentStates.reduce(into: [:]) { acc, kv in
            acc[kv.key] = StateEntry(state: kv.value, enteredAt: entryTimes[kv.key] ?? now)
        }
        stateStore.save(stateEntries)  // prunes vanished windows (only current ids kept)

        let newRows = Aggregator.rows(
            windows: windows, sessions: sessions,
            mode: settings.orderMode, now: now, activity: activity,
            stateEnteredAt: entryTimes)

        let newStates = Aggregator.stateSnapshot(rows: newRows)
        let transitions = Aggregator.workingToIdleTransitions(
            previous: previousStates, current: newStates)

        // Prune blinkers that disappeared or are no longer in the quiet idle group
        // (clear-on-any-change / clear-on-close). A new working->idle-group transition
        // then replaces the set, so the "last moved" project blinks and any previous
        // blinker stops.
        let quietIDs = Set(newRows.filter { $0.state == .idle || $0.state == .noAgent }.map(\.window.id))
        var nextBlink = blinkingWindowIDs.intersection(quietIDs)
        if !transitions.isEmpty {
            nextBlink = Set(transitions)
            if !settings.muted { chime.playChime() }  // blink always shows; sound respects mute
        }
        if nextBlink != blinkingWindowIDs { blinkingWindowIDs = nextBlink }

        previousStates = newStates
        rows = newRows
    }

    public func clearBlink(for id: String) {
        blinkingWindowIDs.remove(id)
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
