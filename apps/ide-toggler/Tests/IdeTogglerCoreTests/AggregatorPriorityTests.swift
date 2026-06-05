import XCTest
@testable import IdeTogglerCore

final class AggregatorPriorityTests: XCTestCase {
    private let win = ZedWindow(id: "w1", folder: "proj")
    private func sess(_ s: AgentStatus, pid: Int32 = 1) -> Session {
        Session(pid: pid, cwd: "/x/proj", status: s)
    }

    func test_waitingBeatsBusy() {
        let state = Aggregator.state(for: win, sessions: [sess(.busy, pid: 1), sess(.waiting, pid: 2)])
        XCTAssertEqual(state, .needsAttention)
    }

    func test_busyBeatsIdle() {
        let state = Aggregator.state(for: win, sessions: [sess(.idle, pid: 1), sess(.busy, pid: 2)])
        XCTAssertEqual(state, .working)
    }

    func test_shellCountsAsWorking_overIdle() {
        let state = Aggregator.state(for: win, sessions: [sess(.idle, pid: 1), sess(.shell, pid: 2)])
        XCTAssertEqual(state, .working)
    }

    func test_allIdle_isIdle() {
        let state = Aggregator.state(for: win, sessions: [sess(.idle, pid: 1), sess(.idle, pid: 2)])
        XCTAssertEqual(state, .idle)
    }

    func test_fullPriorityOrdering_needsAttentionWinsOverEverything() {
        let state = Aggregator.state(for: win, sessions: [
            sess(.idle, pid: 1), sess(.busy, pid: 2), sess(.shell, pid: 3), sess(.waiting, pid: 4)
        ])
        XCTAssertEqual(state, .needsAttention)
    }
}
