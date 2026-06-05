import AppKit
import SwiftUI
import IdeTogglerCore

/// Hosts PanelView in a floating NSPanel that never steals focus and joins all spaces.
public final class PanelController {
    private var panel: NSPanel?

    public init() {}

    public func show(store: StatusAggregatorStore, raiser: WindowRaising, settingsStore: SettingsStore) {
        let hosting = NSHostingController(rootView: PanelView(store: store, raiser: raiser, settingsStore: settingsStore))
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 240, height: 300),
            styleMask: [.titled, .closable, .nonactivatingPanel, .utilityWindow],
            backing: .buffered, defer: false)
        panel.title = "ide-toggler"
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true   // never steal focus from Zed
        panel.hidesOnDeactivate = false
        panel.contentViewController = hosting
        panel.orderFrontRegardless()
        self.panel = panel
    }
}
