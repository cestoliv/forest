import XCTest
@testable import IdeTogglerCore

final class PanelGeometryTests: XCTestCase {
    // A typical single laptop display, origin at zero.
    private let laptop = CGRect(x: 0, y: 0, width: 1440, height: 900)
    // An external monitor placed to the left of the laptop (negative x).
    private let external = CGRect(x: -1920, y: 0, width: 1920, height: 1080)

    func test_fullyVisibleOnAScreen_returnsNil() {
        let panel = CGRect(x: 1100, y: 520, width: 300, height: 360)
        XCTAssertNil(PanelGeometry.reachableFrame(for: panel, screens: [laptop]))
    }

    func test_offAllScreens_clampsFullyOntoRemainingScreen() {
        // Panel lived on the now-disconnected external monitor (negative x).
        let panel = CGRect(x: -1920 + 1608, y: 708, width: 300, height: 360)
        let corrected = PanelGeometry.reachableFrame(for: panel, screens: [laptop])
        let result = try! XCTUnwrap(corrected)
        XCTAssertTrue(laptop.contains(result), "panel should be fully inside the laptop screen")
        XCTAssertEqual(result.width, 300)
        XCTAssertEqual(result.height, 360)
    }

    func test_overhangingRightAndTopEdges_clampsJustInside_preservingSize() {
        let panel = CGRect(x: 1300, y: 700, width: 300, height: 360) // maxX 1600 > 1440, maxY 1060 > 900
        let result = try! XCTUnwrap(PanelGeometry.reachableFrame(for: panel, screens: [laptop]))
        XCTAssertEqual(result.maxX, laptop.maxX, accuracy: 0.001)
        XCTAssertEqual(result.maxY, laptop.maxY, accuracy: 0.001)
        XCTAssertEqual(result.width, 300)
        XCTAssertEqual(result.height, 360)
        XCTAssertTrue(laptop.contains(result))
    }

    func test_straddlingTwoScreens_clampsOntoLargerOverlap() {
        // Straddles the x=0 boundary: 160pt on the external monitor, 140pt on the laptop →
        // not fully contained in either; should clamp onto the external (larger overlap).
        let panel = CGRect(x: -160, y: 500, width: 300, height: 360)
        let result = try! XCTUnwrap(PanelGeometry.reachableFrame(for: panel, screens: [laptop, external]))
        XCTAssertTrue(external.contains(result), "should clamp onto the larger-overlap screen")
    }

    func test_largerThanScreen_keepsTopLeftVisible() {
        // Panel bigger than the only screen on both axes → top-left corner wins: the top
        // (maxY) and left (minX) edges stay onscreen, the overflow spills off bottom/right.
        let tiny = CGRect(x: 0, y: 0, width: 200, height: 200)
        let panel = CGRect(x: 50, y: 50, width: 300, height: 360)
        let result = try! XCTUnwrap(PanelGeometry.reachableFrame(for: panel, screens: [tiny]))
        XCTAssertEqual(result.minX, tiny.minX, accuracy: 0.001, "left edge stays visible")
        XCTAssertEqual(result.maxY, tiny.maxY, accuracy: 0.001, "top edge stays visible")
        XCTAssertEqual(result.width, 300)
        XCTAssertEqual(result.height, 360)
    }

    func test_zeroOverlapWithEveryScreen_clampsOntoFirstScreen() {
        // Panel sits entirely off every display (no overlap at all) → falls back to the
        // first screen and is clamped fully inside it.
        let panel = CGRect(x: 5000, y: 5000, width: 300, height: 360)
        let result = try! XCTUnwrap(PanelGeometry.reachableFrame(for: panel, screens: [laptop, external]))
        XCTAssertTrue(laptop.contains(result), "should clamp onto the first screen")
    }

    func test_emptyScreens_returnsNil() {
        let panel = CGRect(x: 0, y: 0, width: 300, height: 360)
        XCTAssertNil(PanelGeometry.reachableFrame(for: panel, screens: []))
    }
}
