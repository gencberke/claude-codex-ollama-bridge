// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CobMenu",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "CobMenu", targets: ["CobMenu"])],
    targets: [
        .executableTarget(name: "CobMenu"),
        .testTarget(name: "CobMenuTests", dependencies: ["CobMenu"]),
    ]
)
