import Foundation
import IdeTogglerCore

/// Persists per-window state-entry timestamps as one JSON-encoded blob in UserDefaults,
/// mirroring `UserDefaultsSettingsStore`. The map is keyed by EditorWindow.id; the store
/// overwrites it wholesale on each save, so windows that have disappeared are pruned.
public final class UserDefaultsStateTimestampStore: StateTimestampStore {
    private enum Key { static let entries = "ide-toggler.stateEntries" }
    private let defaults: UserDefaults
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    public func load() -> [String: StateEntry] {
        guard let data = defaults.data(forKey: Key.entries),
              let decoded = try? JSONDecoder().decode([String: StateEntry].self, from: data)
        else { return [:] }
        return decoded
    }

    public func save(_ entries: [String: StateEntry]) {
        guard let data = try? JSONEncoder().encode(entries) else { return }
        defaults.set(data, forKey: Key.entries)
    }
}
