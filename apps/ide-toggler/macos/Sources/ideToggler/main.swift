import AppKit
import SwiftUI
import ApplicationServices
import IdeTogglerCore
import IdeTogglerApp

final class AppDelegate: NSObject, NSApplicationDelegate {
    let panelController = PanelController()
    var store: StatusAggregatorStore!

    func applicationDidFinishLaunching(_ notification: Notification) {
        let settingsStore = UserDefaultsSettingsStore()
        let windowSource = AXWindowSource()
        let raiser = AXWindowRaiser(source: windowSource)
        let sessionSource = CompositeSessionSource([
            FSEventSessionSource(),
            FSEventCodexSessionSource(),
        ])
        let chime = AVAudioChimePlayer()

        let store = StatusAggregatorStore(
            windowSource: windowSource,
            sessionSource: sessionSource,
            chime: chime,
            settings: settingsStore.load())
        self.store = store
        store.start()

        // Show the panel first so the app is visibly running regardless of trust;
        // the window source polls every 5s, so granting access repopulates it live.
        panelController.show(store: store, raiser: raiser, settingsStore: settingsStore)

        // SAFETY: read-only permission probe. Does not signal/close anything.
        if !AXIsProcessTrusted() {
            promptForAccessibility()
        }
    }

    private func promptForAccessibility() {
        let alert = NSAlert()
        alert.messageText = "Accessibility permission needed"
        alert.informativeText = """
        ide-toggler needs Accessibility access to list and raise editor windows.
        Open System Settings → Privacy & Security → Accessibility and enable ide-toggler.
        """
        alert.addButton(withTitle: "Open System Settings")
        alert.addButton(withTitle: "Later")
        if alert.runModal() == .alertFirstButtonReturn {
            if let url = URL(string:
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
                NSWorkspace.shared.open(url)
            }
        }
        // Re-prompt the system trust dialog too.
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
        _ = AXIsProcessTrustedWithOptions(opts as CFDictionary)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)   // menu-bar agent style; no Dock icon
let delegate = AppDelegate()
app.delegate = delegate
app.run()
