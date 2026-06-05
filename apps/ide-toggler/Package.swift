// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "ideToggler",
    platforms: [.macOS(.v13)],
    targets: [
        .target(name: "IdeTogglerCore"),
        .target(
            name: "IdeTogglerApp",
            dependencies: ["IdeTogglerCore"]
        ),
        .executableTarget(
            name: "ideToggler",
            dependencies: ["IdeTogglerCore", "IdeTogglerApp"]
        ),
        .testTarget(
            name: "IdeTogglerCoreTests",
            dependencies: ["IdeTogglerCore"]
        ),
        .testTarget(
            name: "IdeTogglerAppTests",
            dependencies: ["IdeTogglerApp", "IdeTogglerCore"]
        ),
    ]
)
