import XCTest
@testable import IdeTogglerCore

final class TitleParserTests: XCTestCase {
    // MARK: Zed — "<folder> — <detail>" (em-dash)
    func test_zed_takesSubstringBeforeEmDashSeparator() {
        XCTAssertEqual(TitleParser.folder(fromTitle: "ide-toggler — main.swift", using: .zed), "ide-toggler")
    }

    func test_zed_trimsWhitespace() {
        XCTAssertEqual(TitleParser.folder(fromTitle: "  my-project   — README.md", using: .zed), "my-project")
    }

    func test_zed_noSeparator_returnsTrimmedWholeTitle() {
        XCTAssertEqual(TitleParser.folder(fromTitle: "Untitled", using: .zed), "Untitled")
    }

    func test_zed_emptyTitle_returnsNil() {
        XCTAssertNil(TitleParser.folder(fromTitle: "", using: .zed))
    }

    func test_zed_whitespaceOnlyTitle_returnsNil() {
        XCTAssertNil(TitleParser.folder(fromTitle: "   ", using: .zed))
    }

    func test_zed_multipleSeparators_usesFirst() {
        XCTAssertEqual(TitleParser.folder(fromTitle: "proj — a — b", using: .zed), "proj")
    }

    // MARK: JetBrains/WebStorm — "<project> [<path>] - <file>"
    func test_jetBrains_bracketedPath() {
        XCTAssertEqual(
            TitleParser.folder(fromTitle: "my-project [~/dev/my-project] - src/index.ts", using: .jetBrains),
            "my-project")
    }

    func test_jetBrains_noBracket_usesHyphen() {
        XCTAssertEqual(
            TitleParser.folder(fromTitle: "my-project - file.ts", using: .jetBrains),
            "my-project")
    }

    func test_jetBrains_projectOnly_returnsWhole() {
        XCTAssertEqual(TitleParser.folder(fromTitle: "my-project", using: .jetBrains), "my-project")
    }

    // MARK: VSCode — native macOS AX title is "${dirty}${file} — ${rootName}"
    // (em-dash separator, project on the RIGHT, no app-name suffix). The app name
    // only appears in VSCode's own custom title-bar UI, not the AX window title.
    func test_vscode_fileAndFolder_realDefault() {
        // The exact title observed from a default-config VSCode window (the bug repro).
        XCTAssertEqual(
            TitleParser.folder(fromTitle: ".env — mobile", using: .vscode),
            "mobile")
    }

    func test_vscode_dirtyIndicator() {
        XCTAssertEqual(
            TitleParser.folder(fromTitle: "● App.tsx — my-project", using: .vscode),
            "my-project")
    }

    func test_vscode_folderWithHyphens() {
        // Em-dash split must not touch hyphens inside the folder name.
        XCTAssertEqual(
            TitleParser.folder(fromTitle: "App.tsx — mobile-eslint-rules", using: .vscode),
            "mobile-eslint-rules")
    }

    func test_vscode_folderOnly_noActiveEditor() {
        XCTAssertEqual(
            TitleParser.folder(fromTitle: "mobile", using: .vscode),
            "mobile")
    }

    func test_vscode_appNameSuffixStrippedDefensively() {
        // Defensive: if a build/config does append " — <appName>", strip it.
        XCTAssertEqual(
            TitleParser.folder(fromTitle: "file.ts — my-project — Visual Studio Code", using: .vscode),
            "my-project")
    }

    func test_vscode_insidersSuffixStrippedDefensively() {
        XCTAssertEqual(
            TitleParser.folder(fromTitle: "file.ts — my-project — Visual Studio Code - Insiders", using: .vscode),
            "my-project")
    }

    func test_vscode_appNameOnly_returnsNil() {
        XCTAssertNil(TitleParser.folder(fromTitle: "Visual Studio Code", using: .vscode))
    }

    // MARK: VSCode — Linux window title is " - "-separated with the app-name suffix
    // present and rootName just before it (project NOT last until the app name is
    // stripped). The leading active-editor/file part must be dropped.
    func test_vscode_linux_activeFileProjectAppName() {
        // The exact title observed on Ubuntu (the status-detection bug repro).
        XCTAssertEqual(
            TitleParser.folder(fromTitle: "Welcome - Musique - Visual Studio Code", using: .vscode),
            "Musique")
    }

    func test_vscode_linux_projectAndAppName_noActiveEditor() {
        XCTAssertEqual(
            TitleParser.folder(fromTitle: "Musique - Visual Studio Code", using: .vscode),
            "Musique")
    }

    func test_vscode_linux_fileProjectAppName() {
        XCTAssertEqual(
            TitleParser.folder(fromTitle: "index.js - my-project - Visual Studio Code", using: .vscode),
            "my-project")
    }

    func test_vscode_linux_folderWithInternalHyphens() {
        XCTAssertEqual(
            TitleParser.folder(fromTitle: "App.tsx - mobile-eslint-rules - Visual Studio Code", using: .vscode),
            "mobile-eslint-rules")
    }

    // MARK: Non-project chrome windows are rejected (best-effort title blocklist)
    func test_zed_aboutAndWelcomeRejected() {
        XCTAssertNil(TitleParser.folder(fromTitle: "About Zed", using: .zed))
        XCTAssertNil(TitleParser.folder(fromTitle: "empty project", using: .zed))
    }

    func test_vscode_chromeRejected() {
        XCTAssertNil(TitleParser.folder(fromTitle: "Welcome", using: .vscode))
        XCTAssertNil(TitleParser.folder(fromTitle: "Get Started", using: .vscode))
        XCTAssertNil(TitleParser.folder(fromTitle: "Release Notes: 1.123.0", using: .vscode))
    }

    func test_jetBrains_chromeRejected() {
        XCTAssertNil(TitleParser.folder(fromTitle: "About WebStorm", using: .jetBrains))
        XCTAssertNil(TitleParser.folder(fromTitle: "Open File or Project", using: .jetBrains))
        XCTAssertNil(TitleParser.folder(fromTitle: "Welcome to WebStorm", using: .jetBrains))
    }

    // Linux chrome titles carry the app-name suffix, so the blocklist must catch the
    // parsed rootName (the raw title isn't an exact match).
    func test_vscode_linux_welcomeWithAppNameSuffixRejected() {
        XCTAssertNil(TitleParser.folder(fromTitle: "Welcome - Visual Studio Code", using: .vscode))
        XCTAssertNil(TitleParser.folder(fromTitle: "Get Started - Visual Studio Code", using: .vscode))
    }

    func test_vscode_linux_welcomeTabInRealProjectKept() {
        XCTAssertEqual(
            TitleParser.folder(fromTitle: "Welcome - Musique - Visual Studio Code", using: .vscode),
            "Musique")
    }

    func test_blocklistIsPerIDE_doesNotAffectOtherEditors() {
        // "Welcome" is VSCode chrome but a perfectly valid Zed folder name.
        XCTAssertEqual(TitleParser.folder(fromTitle: "Welcome", using: .zed), "Welcome")
        // A real project must still parse even though chrome rules exist.
        XCTAssertEqual(TitleParser.folder(fromTitle: ".env — mobile", using: .vscode), "mobile")
    }
}
