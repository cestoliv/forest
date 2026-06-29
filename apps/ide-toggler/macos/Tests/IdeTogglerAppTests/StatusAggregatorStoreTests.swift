import XCTest
@testable import IdeTogglerApp
@testable import IdeTogglerCore

private extension EditorWindow {
    /// Test convenience: defaults ide to .zed (matching is IDE-agnostic here).
    init(id: String, folder: String) { self.init(id: id, folder: folder, ide: .zed) }
}

// Local mocks (app target can't see core test target's Mocks.swift).
private final class MockWindowSource: WindowSource {
    var windows: [EditorWindow]; var onChange: (() -> Void)?
    init(_ w: [EditorWindow]) { windows = w }
    func currentWindows() -> [EditorWindow] { windows }
    func start() {}
    func emit(_ w: [EditorWindow]) { windows = w; onChange?() }
}
private final class MockSessionSource: SessionSource {
    var sessions: [Session]; var activityMap: [Int32: Date]; var onChange: (() -> Void)?
    init(_ s: [Session], _ a: [Int32: Date] = [:]) { sessions = s; activityMap = a }
    func currentSessions() -> [Session] { sessions }
    func activity() -> [Int32: Date] { activityMap }
    func start() {}
    func emit(_ s: [Session], _ a: [Int32: Date] = [:]) { sessions = s; activityMap = a; onChange?() }
}
private final class SpyChime: ChimePlayer {
    var count = 0; func playChime() { count += 1 }
}
private final class SpyStateStore: StateTimestampStore {
    var saved: [String: StateEntry]
    private let seed: [String: StateEntry]
    init(seed: [String: StateEntry] = [:]) { self.seed = seed; self.saved = seed }
    func load() -> [String: StateEntry] { seed }
    func save(_ entries: [String: StateEntry]) { saved = entries }
}

final class StatusAggregatorStoreTests: XCTestCase {
    func test_initialRows_reflectJoinedState() {
        let win = MockWindowSource([EditorWindow(id: "w1", folder: "proj")])
        let sess = MockSessionSource([Session(pid: 1, cwd: "/x/proj", status: .busy)])
        let store = StatusAggregatorStore(
            windowSource: win, sessionSource: sess,
            chime: SpyChime(), settings: Settings(orderMode: .alphabetical, muted: false))
        store.refresh()
        XCTAssertEqual(store.rows.first?.state, .working)
    }

    func test_workingToIdleTransition_callsChimeWhenUnmuted() {
        let win = MockWindowSource([EditorWindow(id: "w1", folder: "proj")])
        let sess = MockSessionSource([Session(pid: 1, cwd: "/x/proj", status: .busy)])
        let chime = SpyChime()
        let store = StatusAggregatorStore(
            windowSource: win, sessionSource: sess,
            chime: chime, settings: Settings(orderMode: .alphabetical, muted: false))
        store.refresh()                                   // working
        sess.emit([Session(pid: 1, cwd: "/x/proj", status: .idle)])  // -> idle
        XCTAssertEqual(chime.count, 1)
    }

    func test_workingToIdleTransition_noChimeWhenMuted() {
        let win = MockWindowSource([EditorWindow(id: "w1", folder: "proj")])
        let sess = MockSessionSource([Session(pid: 1, cwd: "/x/proj", status: .busy)])
        let chime = SpyChime()
        let store = StatusAggregatorStore(
            windowSource: win, sessionSource: sess,
            chime: chime, settings: Settings(orderMode: .alphabetical, muted: true))
        store.refresh()
        sess.emit([Session(pid: 1, cwd: "/x/proj", status: .idle)])
        XCTAssertEqual(chime.count, 0)
    }

    func test_changingOrderMode_reorders() {
        let win = MockWindowSource([
            EditorWindow(id: "w1", folder: "zeta"), EditorWindow(id: "w2", folder: "alpha")])
        let sess = MockSessionSource([])
        let store = StatusAggregatorStore(
            windowSource: win, sessionSource: sess,
            chime: SpyChime(), settings: Settings(orderMode: .alphabetical, muted: false))
        store.refresh()
        XCTAssertEqual(store.rows.map { $0.window.folder }, ["alpha", "zeta"])
    }

    // MARK: - State timer persistence

    func test_stateTimer_persistsAcrossRestart_whenStateMatches() {
        let past = Date(timeIntervalSince1970: 1000)
        let stateStore = SpyStateStore(seed: ["w1": StateEntry(state: .working, enteredAt: past)])
        let win = MockWindowSource([EditorWindow(id: "w1", folder: "proj")])
        let sess = MockSessionSource([Session(pid: 1, cwd: "/x/proj", status: .busy)])  // -> working
        let store = StatusAggregatorStore(
            windowSource: win, sessionSource: sess, chime: SpyChime(),
            settings: Settings(orderMode: .alphabetical, muted: false), stateStore: stateStore)
        store.refresh()
        XCTAssertEqual(store.rows.first?.stateEnteredAt, past,
                       "matching persisted state should keep the timer running across restart")
    }

    func test_stateTimer_resetsWhenPersistedStateMismatches() {
        let past = Date(timeIntervalSince1970: 1000)
        let stateStore = SpyStateStore(seed: ["w1": StateEntry(state: .idle, enteredAt: past)])
        let win = MockWindowSource([EditorWindow(id: "w1", folder: "proj")])
        let sess = MockSessionSource([Session(pid: 1, cwd: "/x/proj", status: .busy)])  // -> working
        let store = StatusAggregatorStore(
            windowSource: win, sessionSource: sess, chime: SpyChime(),
            settings: Settings(orderMode: .alphabetical, muted: false), stateStore: stateStore)
        store.refresh()
        let entered = try! XCTUnwrap(store.rows.first?.stateEnteredAt)
        XCTAssertNotEqual(entered, past)
        XCTAssertEqual(entered.timeIntervalSinceNow, 0, accuracy: 5,
                       "mismatched persisted state should reset the timer to now")
    }

    func test_stateEntries_pruneVanishedWindows() {
        let stateStore = SpyStateStore()
        let win = MockWindowSource([EditorWindow(id: "w1", folder: "proj")])
        let sess = MockSessionSource([Session(pid: 1, cwd: "/x/proj", status: .busy)])
        let store = StatusAggregatorStore(
            windowSource: win, sessionSource: sess, chime: SpyChime(),
            settings: Settings(orderMode: .alphabetical, muted: false), stateStore: stateStore)
        store.refresh()
        XCTAssertNotNil(stateStore.saved["w1"])
        win.emit([])  // window closed
        XCTAssertNil(stateStore.saved["w1"], "vanished window's entry should be pruned on save")
        XCTAssertTrue(stateStore.saved.isEmpty)
    }

    // MARK: - compactRow

    func test_compactRow_picksMostRecentlyActive() {
        let win = MockWindowSource([
            EditorWindow(id: "w1", folder: "alpha"), EditorWindow(id: "w2", folder: "beta")])
        let sess = MockSessionSource(
            [Session(pid: 1, cwd: "/x/alpha", status: .idle),
             Session(pid: 2, cwd: "/x/beta", status: .idle)],
            [1: Date(timeIntervalSince1970: 100), 2: Date(timeIntervalSince1970: 200)])
        let store = StatusAggregatorStore(
            windowSource: win, sessionSource: sess,
            chime: SpyChime(), settings: Settings(orderMode: .alphabetical, muted: false))
        store.refresh()
        XCTAssertEqual(store.compactRow?.window.id, "w2")  // beta is newer
    }

    func test_compactRow_prefersNeedsAttentionOverMoreRecent() {
        let win = MockWindowSource([
            EditorWindow(id: "w1", folder: "alpha"), EditorWindow(id: "w2", folder: "beta")])
        let sess = MockSessionSource(
            [Session(pid: 1, cwd: "/x/alpha", status: .waiting),  // needsAttention, older
             Session(pid: 2, cwd: "/x/beta", status: .idle)],     // idle, more recent
            [1: Date(timeIntervalSince1970: 100), 2: Date(timeIntervalSince1970: 200)])
        let store = StatusAggregatorStore(
            windowSource: win, sessionSource: sess,
            chime: SpyChime(), settings: Settings(orderMode: .alphabetical, muted: false))
        store.refresh()
        XCTAssertEqual(store.compactRow?.window.id, "w1")  // needs-you wins despite older
    }

    func test_compactRow_fallsBackToFirstRowWhenNoActivity() {
        let win = MockWindowSource([
            EditorWindow(id: "w1", folder: "zeta"), EditorWindow(id: "w2", folder: "alpha")])
        let sess = MockSessionSource([])  // no sessions, no activity
        let store = StatusAggregatorStore(
            windowSource: win, sessionSource: sess,
            chime: SpyChime(), settings: Settings(orderMode: .alphabetical, muted: false))
        store.refresh()
        XCTAssertEqual(store.compactRow?.window.folder, "alpha")  // rows.first (alphabetical)
    }

    func test_compactRow_nilWhenNoWindows() {
        let win = MockWindowSource([])
        let sess = MockSessionSource([])
        let store = StatusAggregatorStore(
            windowSource: win, sessionSource: sess,
            chime: SpyChime(), settings: Settings(orderMode: .alphabetical, muted: false))
        store.refresh()
        XCTAssertNil(store.compactRow)
    }

    func test_compactModeToggle_doesNotChimeOrAnimate() {
        let win = MockWindowSource([EditorWindow(id: "w1", folder: "alpha")])
        let sess = MockSessionSource([Session(pid: 1, cwd: "/x/alpha", status: .idle)])
        let chime = SpyChime()
        let store = StatusAggregatorStore(
            windowSource: win, sessionSource: sess,
            chime: chime, settings: Settings(orderMode: .statusPriority, muted: false))
        store.refresh()
        let countAfterBaseline = chime.count

        store.settings.compactMode = true  // didSet triggers refresh()

        XCTAssertEqual(chime.count, countAfterBaseline,
                       "compact-mode toggle must not play chime")
        XCTAssertTrue(store.blinkingWindowIDs.isEmpty,
                      "compact-mode toggle must not add to blinkingWindowIDs")
    }

    /// Carry-forward fix D: changing ONLY the order mode must NOT fire a chime and
    /// must NOT add to blinkingWindowIDs — order-mode switches are not transitions.
    func test_orderModeChange_doesNotChimeOrAnimate() {
        let win = MockWindowSource([EditorWindow(id: "w1", folder: "alpha")])
        let sess = MockSessionSource([Session(pid: 1, cwd: "/x/alpha", status: .idle)])
        let chime = SpyChime()
        let store = StatusAggregatorStore(
            windowSource: win, sessionSource: sess,
            chime: chime, settings: Settings(orderMode: .statusPriority, muted: false))
        store.refresh()  // establish baseline: idle state, no transition yet
        let countAfterBaseline = chime.count

        // Change order mode only — no session/window state changed.
        store.settings.orderMode = .alphabetical
        // settings didSet triggers refresh(); that must not detect a working->idle transition.

        XCTAssertEqual(chime.count, countAfterBaseline,
                       "order-mode change must not play chime")
        XCTAssertTrue(store.blinkingWindowIDs.isEmpty,
                      "order-mode change must not add to blinkingWindowIDs")
    }

    // MARK: - Blink ("last moved" attention cue)

    func test_workingToIdle_populatesBlinking() {
        let win = MockWindowSource([EditorWindow(id: "w1", folder: "proj")])
        let sess = MockSessionSource([Session(pid: 1, cwd: "/x/proj", status: .busy)])
        let store = StatusAggregatorStore(
            windowSource: win, sessionSource: sess,
            chime: SpyChime(), settings: Settings(orderMode: .alphabetical, muted: false))
        store.refresh()                                              // working
        sess.emit([Session(pid: 1, cwd: "/x/proj", status: .idle)]) // -> idle
        XCTAssertEqual(store.blinkingWindowIDs, ["w1"])
    }

    func test_workingToNoAgent_populatesBlinking() {
        let win = MockWindowSource([EditorWindow(id: "w1", folder: "proj")])
        let sess = MockSessionSource([Session(pid: 1, cwd: "/x/proj", status: .busy)])
        let store = StatusAggregatorStore(
            windowSource: win, sessionSource: sess,
            chime: SpyChime(), settings: Settings(orderMode: .alphabetical, muted: false))
        store.refresh()  // working
        sess.emit([])    // -> noAgent, as when Codex exits after completion
        XCTAssertEqual(store.rows.first?.state, .noAgent)
        XCTAssertEqual(store.blinkingWindowIDs, ["w1"])

        store.refresh()
        XCTAssertEqual(store.blinkingWindowIDs, ["w1"],
                       "blink should persist while the row remains in the quiet Idle group")
    }

    func test_secondTransition_replacesBlinking() {
        let win = MockWindowSource([
            EditorWindow(id: "w1", folder: "alpha"), EditorWindow(id: "w2", folder: "beta")])
        let sess = MockSessionSource([
            Session(pid: 1, cwd: "/x/alpha", status: .busy),
            Session(pid: 2, cwd: "/x/beta", status: .busy)])
        let store = StatusAggregatorStore(
            windowSource: win, sessionSource: sess,
            chime: SpyChime(), settings: Settings(orderMode: .alphabetical, muted: false))
        store.refresh()  // both working
        // w1 moves to idle.
        sess.emit([
            Session(pid: 1, cwd: "/x/alpha", status: .idle),
            Session(pid: 2, cwd: "/x/beta", status: .busy)])
        XCTAssertEqual(store.blinkingWindowIDs, ["w1"])
        // w2 moves to idle -> replaces the blinker (only the last-moved blinks).
        sess.emit([
            Session(pid: 1, cwd: "/x/alpha", status: .idle),
            Session(pid: 2, cwd: "/x/beta", status: .idle)])
        XCTAssertEqual(store.blinkingWindowIDs, ["w2"])
    }

    func test_clearBlink_removesID() {
        let win = MockWindowSource([EditorWindow(id: "w1", folder: "proj")])
        let sess = MockSessionSource([Session(pid: 1, cwd: "/x/proj", status: .busy)])
        let store = StatusAggregatorStore(
            windowSource: win, sessionSource: sess,
            chime: SpyChime(), settings: Settings(orderMode: .alphabetical, muted: false))
        store.refresh()
        sess.emit([Session(pid: 1, cwd: "/x/proj", status: .idle)])
        XCTAssertEqual(store.blinkingWindowIDs, ["w1"])
        store.clearBlink(for: "w1")
        XCTAssertTrue(store.blinkingWindowIDs.isEmpty)
    }

    func test_blinkClears_whenWindowLeavesIdle() {
        let win = MockWindowSource([EditorWindow(id: "w1", folder: "proj")])
        let sess = MockSessionSource([Session(pid: 1, cwd: "/x/proj", status: .busy)])
        let store = StatusAggregatorStore(
            windowSource: win, sessionSource: sess,
            chime: SpyChime(), settings: Settings(orderMode: .alphabetical, muted: false))
        store.refresh()
        sess.emit([Session(pid: 1, cwd: "/x/proj", status: .idle)])  // blinking
        XCTAssertEqual(store.blinkingWindowIDs, ["w1"])
        sess.emit([Session(pid: 1, cwd: "/x/proj", status: .busy)])  // back to working
        XCTAssertTrue(store.blinkingWindowIDs.isEmpty)
    }

    func test_blinkClears_whenWindowDisappears() {
        let win = MockWindowSource([EditorWindow(id: "w1", folder: "proj")])
        let sess = MockSessionSource([Session(pid: 1, cwd: "/x/proj", status: .busy)])
        let store = StatusAggregatorStore(
            windowSource: win, sessionSource: sess,
            chime: SpyChime(), settings: Settings(orderMode: .alphabetical, muted: false))
        store.refresh()
        sess.emit([Session(pid: 1, cwd: "/x/proj", status: .idle)])  // blinking
        XCTAssertEqual(store.blinkingWindowIDs, ["w1"])
        win.emit([])  // window closed
        XCTAssertTrue(store.blinkingWindowIDs.isEmpty)
    }
}
