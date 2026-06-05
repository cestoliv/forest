import XCTest
@testable import IdeTogglerApp
@testable import IdeTogglerCore

// Local mocks (app target can't see core test target's Mocks.swift).
private final class MockWindowSource: WindowSource {
    var windows: [ZedWindow]; var onChange: (() -> Void)?
    init(_ w: [ZedWindow]) { windows = w }
    func currentWindows() -> [ZedWindow] { windows }
    func start() {}
    func emit(_ w: [ZedWindow]) { windows = w; onChange?() }
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

final class StatusAggregatorStoreTests: XCTestCase {
    func test_initialRows_reflectJoinedState() {
        let win = MockWindowSource([ZedWindow(id: "w1", folder: "proj")])
        let sess = MockSessionSource([Session(pid: 1, cwd: "/x/proj", status: .busy)])
        let store = StatusAggregatorStore(
            windowSource: win, sessionSource: sess,
            chime: SpyChime(), settings: Settings(orderMode: .alphabetical, muted: false))
        store.refresh()
        XCTAssertEqual(store.rows.first?.state, .working)
    }

    func test_workingToIdleTransition_callsChimeWhenUnmuted() {
        let win = MockWindowSource([ZedWindow(id: "w1", folder: "proj")])
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
        let win = MockWindowSource([ZedWindow(id: "w1", folder: "proj")])
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
            ZedWindow(id: "w1", folder: "zeta"), ZedWindow(id: "w2", folder: "alpha")])
        let sess = MockSessionSource([])
        let store = StatusAggregatorStore(
            windowSource: win, sessionSource: sess,
            chime: SpyChime(), settings: Settings(orderMode: .alphabetical, muted: false))
        store.refresh()
        XCTAssertEqual(store.rows.map { $0.window.folder }, ["alpha", "zeta"])
    }

    /// Carry-forward fix D: changing ONLY the order mode must NOT fire a chime and
    /// must NOT add to animatingWindowIDs — order-mode switches are not transitions.
    func test_orderModeChange_doesNotChimeOrAnimate() {
        let win = MockWindowSource([ZedWindow(id: "w1", folder: "alpha")])
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
        XCTAssertTrue(store.animatingWindowIDs.isEmpty,
                      "order-mode change must not add to animatingWindowIDs")
    }
}
