import Foundation
import IdeTogglerCore

public final class UserDefaultsSettingsStore: SettingsStore {
    private enum Key {
        static let orderMode = "ide-toggler.orderMode"
        static let muted = "ide-toggler.muted"
        static let compactMode = "ide-toggler.compactMode"
    }
    private let defaults: UserDefaults
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    public func load() -> Settings {
        let mode = (defaults.string(forKey: Key.orderMode))
            .flatMap(OrderMode.init(rawValue:)) ?? .statusPriority
        let muted = defaults.bool(forKey: Key.muted)  // defaults to false
        let compact = defaults.bool(forKey: Key.compactMode)  // defaults to false
        return Settings(orderMode: mode, muted: muted, compactMode: compact)
    }

    public func save(_ settings: Settings) {
        defaults.set(settings.orderMode.rawValue, forKey: Key.orderMode)
        defaults.set(settings.muted, forKey: Key.muted)
        defaults.set(settings.compactMode, forKey: Key.compactMode)
    }
}
