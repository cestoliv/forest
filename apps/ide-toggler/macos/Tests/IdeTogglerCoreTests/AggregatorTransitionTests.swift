import XCTest
@testable import IdeTogglerCore

final class AggregatorTransitionTests: XCTestCase {
    func test_workingToIdle_emitsTransitionForThatWindow() {
        let prev: [String: WindowState] = ["w1": .working]
        let curr: [String: WindowState] = ["w1": .idle]
        XCTAssertEqual(Aggregator.workingToIdleTransitions(previous: prev, current: curr), ["w1"])
    }

    func test_workingToNoAgent_emitsTransitionForThatWindow() {
        let prev: [String: WindowState] = ["w1": .working]
        let curr: [String: WindowState] = ["w1": .noAgent]
        XCTAssertEqual(Aggregator.workingToIdleTransitions(previous: prev, current: curr), ["w1"])
    }

    func test_stayingWorking_emitsNothing() {
        let prev: [String: WindowState] = ["w1": .working]
        let curr: [String: WindowState] = ["w1": .working]
        XCTAssertEqual(Aggregator.workingToIdleTransitions(previous: prev, current: curr), [])
    }

    func test_idleToWorking_emitsNothing() {
        let prev: [String: WindowState] = ["w1": .idle]
        let curr: [String: WindowState] = ["w1": .working]
        XCTAssertEqual(Aggregator.workingToIdleTransitions(previous: prev, current: curr), [])
    }

    func test_workingToNeedsAttention_isNotWorkingToIdle() {
        let prev: [String: WindowState] = ["w1": .working]
        let curr: [String: WindowState] = ["w1": .needsAttention]
        XCTAssertEqual(Aggregator.workingToIdleTransitions(previous: prev, current: curr), [])
    }

    func test_newWindowAppearingIdle_emitsNothing() {
        let prev: [String: WindowState] = [:]
        let curr: [String: WindowState] = ["w1": .idle]
        XCTAssertEqual(Aggregator.workingToIdleTransitions(previous: prev, current: curr), [])
    }

    func test_newWindowAppearingNoAgent_emitsNothing() {
        let prev: [String: WindowState] = [:]
        let curr: [String: WindowState] = ["w1": .noAgent]
        XCTAssertEqual(Aggregator.workingToIdleTransitions(previous: prev, current: curr), [])
    }

    func test_multipleWindows_onlyTransitioningOnesEmit() {
        let prev: [String: WindowState] = ["w1": .working, "w2": .working, "w3": .idle]
        let curr: [String: WindowState] = ["w1": .idle,    "w2": .noAgent, "w3": .working]
        XCTAssertEqual(Aggregator.workingToIdleTransitions(previous: prev, current: curr), ["w1", "w2"])
    }

    func test_windowDisappearing_emitsNothing() {
        let prev: [String: WindowState] = ["w1": .working]
        let curr: [String: WindowState] = [:]
        XCTAssertEqual(Aggregator.workingToIdleTransitions(previous: prev, current: curr), [])
    }
}
