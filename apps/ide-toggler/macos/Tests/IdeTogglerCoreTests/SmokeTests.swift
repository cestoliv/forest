import XCTest
@testable import IdeTogglerCore

final class SmokeTests: XCTestCase {
    func test_coreMarker_isOk() {
        XCTAssertEqual(IdeTogglerCoreMarker.ok, .ok)
    }
}
