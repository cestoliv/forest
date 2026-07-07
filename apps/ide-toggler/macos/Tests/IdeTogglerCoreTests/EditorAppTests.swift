import XCTest
@testable import IdeTogglerCore

/// Guards the IDE catalog. A typo in a bundle ID is a silent failure (the editor's
/// windows just never appear), so pin the exact identifiers and strategies here.
final class EditorAppTests: XCTestCase {
    func test_catalogCoversAllKinds() {
        XCTAssertEqual(EditorApp.all.map(\.kind), [.zed, .vscode, .jetBrains])
    }

    func test_zed() {
        XCTAssertEqual(EditorApp.zed.bundleIDs, ["dev.zed.Zed"])
        XCTAssertEqual(EditorApp.zed.titleStrategy, .beforeEmDash)
    }

    func test_vscode() {
        XCTAssertEqual(EditorApp.vscode.bundleIDs,
                       ["com.microsoft.VSCode", "com.microsoft.VSCodeInsiders", "com.visualstudio.code.oss"])
        XCTAssertEqual(EditorApp.vscode.titleStrategy, .vscodeRootName)
        XCTAssertTrue(EditorApp.vscode.appNameSuffixes.contains("Visual Studio Code"))
    }

    func test_jetBrains() {
        XCTAssertEqual(EditorApp.jetBrains.bundleIDs, ["com.jetbrains.WebStorm"])
        XCTAssertEqual(EditorApp.jetBrains.titleStrategy, .beforeFirstBracketOrHyphen)
    }
}
