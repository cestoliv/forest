import XCTest
@testable import IdeTogglerApp
@testable import IdeTogglerCore

final class SettingsStoreTests: XCTestCase {
    private func freshDefaults() -> UserDefaults {
        let suite = "ide-toggler-tests-\(UUID().uuidString)"
        return UserDefaults(suiteName: suite)!
    }

    func test_defaultsWhenEmpty() {
        let store = UserDefaultsSettingsStore(defaults: freshDefaults())
        let s = store.load()
        XCTAssertEqual(s.orderMode, .statusPriority)
        XCTAssertFalse(s.muted)
    }

    func test_roundTrips() {
        let defaults = freshDefaults()
        let store = UserDefaultsSettingsStore(defaults: defaults)
        store.save(Settings(orderMode: .recentlyActive, muted: true))
        let reloaded = UserDefaultsSettingsStore(defaults: defaults).load()
        XCTAssertEqual(reloaded.orderMode, .recentlyActive)
        XCTAssertTrue(reloaded.muted)
    }
}
