import SwiftUI
import IdeTogglerCore

public struct PanelView: View {
    @ObservedObject var store: StatusAggregatorStore
    let raiser: WindowRaising
    let settingsStore: SettingsStore
    @State private var showingSettings = false

    public init(store: StatusAggregatorStore, raiser: WindowRaising, settingsStore: SettingsStore) {
        self.store = store; self.raiser = raiser; self.settingsStore = settingsStore
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text("Zed Windows").font(.headline)
                Spacer()
                Button { showingSettings.toggle() } label: {
                    Image(systemName: "gearshape")
                }.buttonStyle(.plain)
            }.padding(.bottom, 4)

            ForEach(store.rows, id: \.window.id) { row in
                Button {
                    raiser.raise(windowID: row.window.id)
                } label: {
                    HStack {
                        Image(systemName: StatusIcon.symbol(for: row.state))
                            .foregroundColor(StatusIcon.color(for: row.state))
                            .scaleEffect(store.animatingWindowIDs.contains(row.window.id) ? 1.3 : 1.0)
                            .animation(.easeInOut(duration: 0.25).repeatCount(3, autoreverses: true),
                                       value: store.animatingWindowIDs.contains(row.window.id))
                        Text(row.window.folder)
                        Spacer()
                    }
                }
                .buttonStyle(.plain)
                .onChange(of: store.animatingWindowIDs.contains(row.window.id)) { animating in
                    if animating {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                            store.clearAnimation(for: row.window.id)
                        }
                    }
                }
            }
            if store.rows.isEmpty {
                Text("No Zed windows").foregroundColor(.secondary).font(.caption)
            }
        }
        .padding(10)
        .frame(minWidth: 220)
        .popover(isPresented: $showingSettings) {
            SettingsView(store: store, settingsStore: settingsStore).padding()
        }
    }
}
