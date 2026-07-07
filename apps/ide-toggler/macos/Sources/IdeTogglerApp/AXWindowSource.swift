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

/// Enumerates windows of all configured editor processes (see EditorApp.all) via the
/// Accessibility API.
/// SAFETY: read-only enumeration. Reads kAXWindowsAttribute + kAXTitleAttribute plus a
/// couple of read-only window attributes (close button, fullscreen) used to skip native
/// open/save panels. It NEVER closes, quits, or sends input to any editor. The only AX
/// action used anywhere is kAXRaiseAction, and that lives in AXWindowRaiser, not here.
public final class AXWindowSource: WindowSource {
    public var onChange: (() -> Void)?

    private let editors: [EditorApp]
    private var timer: Timer?
    private var observer: NSObjectProtocol?
    // Maps EditorWindow.id -> the live AXUIElement for raising.
    private(set) var elementsByID: [String: AXUIElement] = [:]

    public init(editors: [EditorApp] = EditorApp.all) {
        self.editors = editors
    }

    public func currentWindows() -> [EditorWindow] {
        var windows: [EditorWindow] = []
        var newElements: [String: AXUIElement] = [:]

        for editor in editors {
            for bundleID in editor.bundleIDs {
                let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
                for app in apps {
                    let axApp = AXUIElementCreateApplication(app.processIdentifier)
                    var value: CFTypeRef?
                    guard AXUIElementCopyAttributeValue(
                        axApp, kAXWindowsAttribute as CFString, &value) == .success,
                          let axWindows = value as? [AXUIElement] else { continue }

                    for axWindow in axWindows {
                        guard Self.isProjectWindow(axWindow) else { continue }

                        var titleRef: CFTypeRef?
                        AXUIElementCopyAttributeValue(axWindow, kAXTitleAttribute as CFString, &titleRef)
                        let title = (titleRef as? String) ?? ""
                        guard let folder = TitleParser.folder(fromTitle: title, using: editor) else { continue }

                        // Stable id from the window's CGWindowID (unique + stable for the window's
                        // lifetime), so transition detection and click-to-raise resolve consistently
                        // across refreshes even when AX array order changes with z-order/focus.
                        // The IDE prefix keeps ids unique across editors.
                        var windowID: CGWindowID = 0
                        let id: String
                        if _AXUIElementGetWindow(axWindow, &windowID) == .success {
                            id = "\(editor.kind.rawValue)-win-\(windowID)"
                        } else {
                            // Fallback (should not normally happen): stable across refreshes without
                            // relying on array index, though folders collide if duplicated within a pid.
                            id = "\(editor.kind.rawValue)-\(app.processIdentifier)-\(folder)"
                        }
                        // Skip if id is already taken: _AXUIElementGetWindow fallback can
                        // produce colliding ids for same-folder windows when the SPI fails.
                        guard newElements[id] == nil else { continue }
                        windows.append(EditorWindow(id: id, folder: folder, ide: editor.kind))
                        newElements[id] = axWindow
                    }
                }
            }
        }
        elementsByID = newElements
        return windows
    }

    /// Structural filter for native open/save panels (e.g. Zed's "Open"): those are the
    /// one kind of chrome reliably distinguishable by window structure — they carry none
    /// of the traffic-light buttons a real window has. Everything else (real projects, but
    /// also About/Welcome/Release-Notes windows) has a close button; those non-project
    /// windows are filtered by title in Core instead.
    ///
    /// NOTE: subrole is deliberately NOT used. JetBrains reports real project windows as
    /// AXDialog vs AXStandardWindow inconsistently (it flips when a modal like the About
    /// box is open), so gating on AXStandardWindow would intermittently hide real projects.
    static func isProjectWindow(_ window: AXUIElement) -> Bool {
        if copyBool(window, "AXFullScreen") == true { return true }  // fullscreen hides buttons
        return hasAttribute(window, kAXCloseButtonAttribute as String)
    }

    private static func copyBool(_ element: AXUIElement, _ attribute: String) -> Bool? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &ref) == .success
        else { return nil }
        return ref as? Bool
    }

    private static func hasAttribute(_ element: AXUIElement, _ attribute: String) -> Bool {
        var ref: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, attribute as CFString, &ref) == .success && ref != nil
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
