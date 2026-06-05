import XCTest
@testable import IdeTogglerCore

final class TitleParserTests: XCTestCase {
    func test_takesSubstringBeforeEmDashSeparator() {
        // Zed format: "<folder> — <file/path>"
        XCTAssertEqual(TitleParser.folder(fromTitle: "ide-toggler — main.swift"), "ide-toggler")
    }

    func test_trimsWhitespace() {
        XCTAssertEqual(TitleParser.folder(fromTitle: "  my-project   — README.md"), "my-project")
    }

    func test_noSeparator_returnsTrimmedWholeTitle() {
        XCTAssertEqual(TitleParser.folder(fromTitle: "Untitled"), "Untitled")
    }

    func test_emptyTitle_returnsNil() {
        XCTAssertNil(TitleParser.folder(fromTitle: ""))
    }

    func test_whitespaceOnlyTitle_returnsNil() {
        XCTAssertNil(TitleParser.folder(fromTitle: "   "))
    }

    func test_multipleSeparators_usesFirst() {
        XCTAssertEqual(TitleParser.folder(fromTitle: "proj — a — b"), "proj")
    }
}
