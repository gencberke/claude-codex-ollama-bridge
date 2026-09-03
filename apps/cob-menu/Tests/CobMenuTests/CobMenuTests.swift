#if canImport(XCTest)
import Foundation
import XCTest
@testable import CobMenu

final class CobMenuTests: XCTestCase {
    func testStatusAndConfigRejectUnknownSchema() {
        XCTAssertThrowsError(try JSONDecoder().decode(StatusDocument.self, from: Data(#"{"schema_version":2}"#.utf8)))
        XCTAssertThrowsError(try JSONDecoder().decode(ConfigDocument.self, from: Data(#"{"schema_version":2}"#.utf8)))
    }

    func testProcessCapturesEachStreamAt64KiB() {
        let result = CobProcess.run(
            path: "/bin/sh",
            arguments: ["-c", "head -c 100000 /dev/zero; head -c 100000 /dev/zero >&2"],
            stdin: nil,
        )
        XCTAssertEqual(result.status, 0)
        XCTAssertEqual(result.stdout.count, maxCommandOutput)
        XCTAssertEqual(result.stderr.count, maxCommandOutput)
    }

    func testOllamaDraftReorderUsesOnlyOllamaRows() {
        var state = ModelDraftState(
            models: ["native/model", "ollama/first", "ollama/second", "ollama/third"],
            ollamaSlugs: ["ollama/first", "ollama/second", "ollama/third"],
        )
        state.moveOllama("ollama/second", by: -1)
        XCTAssertEqual(state.models, ["native/model", "ollama/second", "ollama/first", "ollama/third"])
        state.moveOllama("ollama/second", by: -1)
        XCTAssertEqual(state.models, ["native/model", "ollama/second", "ollama/first", "ollama/third"])
    }

    func testInvalidCachedCobPathIsCleared() {
        var state = CobPathSelectionState(cachedPath: "/tmp/invalid-cob")
        state.clearIf("/tmp/invalid-cob")
        XCTAssertNil(state.cachedPath)
        state.cachedPath = "/tmp/other-cob"
        state.clearIf("/tmp/invalid-cob")
        XCTAssertEqual(state.cachedPath, "/tmp/other-cob")
    }

    func testEnvironmentLockedPatchFieldsCanBeOmitted() throws {
        let patch = ConfigPatch(
            schemaVersion: 1,
            expectedRevision: nil,
            compaction: ConfigPatch.Compaction(
                ollamaThreads: nil,
                ollamaModel: "ollama/compact",
                ollamaEffort: nil,
                includeOllamaModel: false,
                includeOllamaEffort: false,
            ),
            subagents: nil,
            catalog: nil,
        )
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as? [String: Any]
        XCTAssertTrue(object?.keys.contains("expected_revision") == true)
        XCTAssertTrue(object?["expected_revision"] is NSNull)
        XCTAssertNil((object?["compaction"] as? [String: Any])?["ollama_model"])
    }

    func testBoundedLogReadsTailAndHandlesRotationAndTruncate() throws {
        let directory = try XCTUnwrap(FileManager.default.createTemporaryDirectory())
        defer { try? FileManager.default.removeItem(at: directory) }
        let current = directory.appendingPathComponent("cob-gateway.log")
        let archive = directory.appendingPathComponent("cob-gateway.log.1")
        try Data(repeating: 65, count: maxLogBytes + 100).write(to: archive)
        try Data("old\nnew-current\n".utf8).write(to: current)
        let initialSignature = BoundedLog.signature(current: current.path, archive: archive.path)
        XCTAssertEqual(initialSignature, BoundedLog.signature(current: current.path, archive: archive.path))
        let text = BoundedLog.read(current: current.path, archive: archive.path)
        XCTAssertTrue(text.contains("new-current"))
        XCTAssertLessThanOrEqual(text.utf8.count, maxLogBytes + maxLogLines)

        try Data("archive-after-rotation\n".utf8).write(to: archive)
        try Data("truncated\n".utf8).write(to: current)
        XCTAssertNotEqual(initialSignature, BoundedLog.signature(current: current.path, archive: archive.path))
        XCTAssertTrue(BoundedLog.read(current: current.path, archive: archive.path).contains("truncated"))
    }
}

private extension FileManager {
    func createTemporaryDirectory() throws -> URL {
        let url = temporaryDirectory.appendingPathComponent("cob-menu-tests-\(UUID().uuidString)")
        try createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}
#endif
