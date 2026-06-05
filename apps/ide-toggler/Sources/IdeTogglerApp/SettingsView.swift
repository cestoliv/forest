import SwiftUI
import IdeTogglerCore

public struct SettingsView: View {
    @ObservedObject var store: StatusAggregatorStore
    let settingsStore: SettingsStore

    public init(store: StatusAggregatorStore, settingsStore: SettingsStore) {
        self.store = store; self.settingsStore = settingsStore
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker("Order", selection: Binding(
                get: { store.settings.orderMode },
                set: { newMode in
                    store.settings.orderMode = newMode
                    settingsStore.save(store.settings)
                })) {
                Text("Status priority").tag(OrderMode.statusPriority)
                Text("Alphabetical").tag(OrderMode.alphabetical)
                Text("Recently active").tag(OrderMode.recentlyActive)
            }
            Toggle("Mute sound", isOn: Binding(
                get: { store.settings.muted },
                set: { muted in
                    store.settings.muted = muted
                    settingsStore.save(store.settings)
                }))
        }
        .tint(Palette.terracotta)
        .frame(width: 220)
        .preferredColorScheme(.dark)
    }
}
