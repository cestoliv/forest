import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
import IdeTogglerCore

/// Private AX SPI: resolves the stable CGWindowID for an AX window element.
/// CGWindowID is globally unique and stable for a window's lifetime, unlike the
/// window's position in the AX windows array (which reorders with z-order/focus).
@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ identifier: UnsafeMutablePointer<CGWindowID>) -> AXError

/// Enumerates windows of all running dev.zed.Zed processes via the Accessibility API.
/// SAFETY: read-only enumeration. Reads kAXWindowsAttribute + kAXTitleAttribute only.
/// It NEVER closes, quits, or sends input to Zed. The only AX action used anywhere is
/// kAXRaiseAction, and that lives in AXWindowRaiser, not here.
public final class AXWindowSource: WindowSource {
    public var onChange: (() -> Void)?

    private let bundleID = "dev.zed.Zed"
    private var timer: Timer?
    private var observer: NSObjectProtocol?
    // Maps ZedWindow.id -> the live AXUIElement for raising.
    private(set) var elementsByID: [String: AXUIElement] = [:]

    public init() {}

    public func currentWindows() -> [ZedWindow] {
        var windows: [ZedWindow] = []
        var newElements: [String: AXUIElement] = [:]

        let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
        for app in apps {
            let axApp = AXUIElementCreateApplication(app.processIdentifier)
            var value: CFTypeRef?
            guard AXUIElementCopyAttributeValue(
                axApp, kAXWindowsAttribute as CFString, &value) == .success,
                  let axWindows = value as? [AXUIElement] else { continue }

            for axWindow in axWindows {
                var titleRef: CFTypeRef?
                AXUIElementCopyAttributeValue(axWindow, kAXTitleAttribute as CFString, &titleRef)
                let title = (titleRef as? String) ?? ""
                guard let folder = TitleParser.folder(fromTitle: title) else { continue }

                // Stable id from the window's CGWindowID (unique + stable for the window's
                // lifetime), so transition detection and click-to-raise resolve consistently
                // across refreshes even when AX array order changes with z-order/focus.
                var windowID: CGWindowID = 0
                let id: String
                if _AXUIElementGetWindow(axWindow, &windowID) == .success {
                    id = "zed-win-\(windowID)"
                } else {
                    // Fallback (should not normally happen): stable across refreshes without
                    // relying on array index, though folders collide if duplicated within a pid.
                    id = "zed-\(app.processIdentifier)-\(folder)"
                }
                windows.append(ZedWindow(id: id, folder: folder))
                newElements[id] = axWindow
            }
        }
        elementsByID = newElements
        return windows
    }

    public func start() {
        // Refresh on app activation + a low-frequency timer (windows change rarely).
        observer = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil, queue: .main) { [weak self] _ in self?.onChange?() }
        timer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            self?.onChange?()
        }
    }

    deinit {
        if let observer = observer {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
        }
        timer?.invalidate()
    }
}
