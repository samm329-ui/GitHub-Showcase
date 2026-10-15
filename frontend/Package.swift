// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "ShowcaseFrontend",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "ShowcaseFrontend", targets: ["ShowcaseFrontend"])
    ],
    targets: [
        .executableTarget(
            name: "ShowcaseFrontend",
            path: "Sources"
        )
    ]
)
