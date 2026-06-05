import XCTest
@testable import IdeTogglerCore

final class AggregatorJoinTests: XCTestCase {
    func test_joinsSessionToWindowByBasenameOfCwd() {
        let win = ZedWindow(id: "w1", folder: "ide-toggler")
        let sess = Session(pid: 1, cwd: "/Users/me/Development/ide-toggler", status: .busy)
        let rows = Aggregator.rows(windows: [win], sessions: [sess], mode: .alphabetical, now: nil)
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].state, .working)
    }

    func test_windowWithNoMatchingSession_isNoAgent() {
        let win = ZedWindow(id: "w1", folder: "lonely")
        let rows = Aggregator.rows(windows: [win], sessions: [], mode: .alphabetical, now: nil)
        XCTAssertEqual(rows[0].state, .noAgent)
    }

    func test_sessionWithNoMatchingWindow_isIgnored() {
        // Claude in an external terminal: cwd basename matches no window folder.
        let win = ZedWindow(id: "w1", folder: "ide-toggler")
        let orphan = Session(pid: 2, cwd: "/tmp/other-thing", status: .busy)
        let rows = Aggregator.rows(windows: [win], sessions: [orphan], mode: .alphabetical, now: nil)
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].state, .noAgent)
    }

    func test_trailingSlashInCwd_stillMatches() {
        let win = ZedWindow(id: "w1", folder: "ide-toggler")
        let sess = Session(pid: 1, cwd: "/Users/me/ide-toggler/", status: .idle)
        let rows = Aggregator.rows(windows: [win], sessions: [sess], mode: .alphabetical, now: nil)
        XCTAssertEqual(rows[0].state, .idle)
    }
}
