import XCTest
@testable import IdeTogglerCore

final class AggregatorOrderingTests: XCTestCase {
    private func win(_ id: String, _ folder: String) -> EditorWindow { EditorWindow(id: id, folder: folder) }

    func test_alphabetical_sortsByFolderCaseInsensitive() {
        let rows = [
            WindowRow(window: win("a", "Zed"), state: .idle, lastActive: nil),
            WindowRow(window: win("b", "alpha"), state: .idle, lastActive: nil),
        ]
        let ordered = Aggregator.order(rows: rows, mode: .alphabetical)
        XCTAssertEqual(ordered.map { $0.window.folder }, ["alpha", "Zed"])
    }

    func test_statusPriority_ordersNeedsAttentionThenWorkingThenIdleThenNoAgent() {
        let rows = [
            WindowRow(window: win("1", "d"), state: .noAgent, lastActive: nil),
            WindowRow(window: win("2", "c"), state: .idle, lastActive: nil),
            WindowRow(window: win("3", "b"), state: .working, lastActive: nil),
            WindowRow(window: win("4", "a"), state: .needsAttention, lastActive: nil),
        ]
        let ordered = Aggregator.order(rows: rows, mode: .statusPriority)
        XCTAssertEqual(ordered.map { $0.state },
                       [.needsAttention, .working, .idle, .noAgent])
    }

    func test_statusPriority_tiesBrokenAlphabetically() {
        let rows = [
            WindowRow(window: win("1", "zeta"), state: .working, lastActive: nil),
            WindowRow(window: win("2", "alpha"), state: .working, lastActive: nil),
        ]
        let ordered = Aggregator.order(rows: rows, mode: .statusPriority)
        XCTAssertEqual(ordered.map { $0.window.folder }, ["alpha", "zeta"])
    }

    func test_recentlyActive_sortsMostRecentFirst_nilsLast() {
        let t0 = Date(timeIntervalSince1970: 100)
        let t1 = Date(timeIntervalSince1970: 200)
        let rows = [
            WindowRow(window: win("1", "old"), state: .idle, lastActive: t0),
            WindowRow(window: win("2", "new"), state: .idle, lastActive: t1),
            WindowRow(window: win("3", "never"), state: .noAgent, lastActive: nil),
        ]
        let ordered = Aggregator.order(rows: rows, mode: .recentlyActive)
        XCTAssertEqual(ordered.map { $0.window.folder }, ["new", "old", "never"])
    }

    func test_rows_populatesLastActiveFromMostRecentMatchedSession() {
        let w = win("w1", "proj")
        let early = Session(pid: 1, cwd: "/x/proj", status: .idle)
        let late = Session(pid: 2, cwd: "/x/proj", status: .idle)
        // lastActive supplied via the activity map argument
        let activity: [Int32: Date] = [1: Date(timeIntervalSince1970: 100),
                                       2: Date(timeIntervalSince1970: 300)]
        let rows = Aggregator.rows(windows: [w], sessions: [early, late],
                                   mode: .recentlyActive, now: nil, activity: activity)
        XCTAssertEqual(rows.first?.lastActive, Date(timeIntervalSince1970: 300))
    }
}
