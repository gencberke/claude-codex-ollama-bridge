import Foundation
import Testing
@testable import CobMenu

@Suite("Cob menu")
struct CobMenuTests {
    @Test func statusAndConfigRejectUnknownSchema() {
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(StatusDocument.self, from: Data(#"{"schema_version":2}"#.utf8))
        }
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(ConfigDocument.self, from: Data(#"{"schema_version":2}"#.utf8))
        }
    }

    @Test @MainActor func overallBrokenStatusIsNeverShownAsHealthy() throws {
        let data = Data(#"{"schema_version":1,"kind":"broken","install":{"version":"0.3.1"},"gateway":{"running":true,"healthy":true,"port":18790,"pid":1},"catalog":{"freshness":"fresh"}}"#.utf8)
        let controller = CobController()
        controller.status = try JSONDecoder().decode(StatusDocument.self, from: data)
        #expect(controller.statusKind == "attention")
    }

    @Test func processCapturesEachStreamAt64KiB() {
        let result = CobProcess.run(
            path: "/bin/sh",
            arguments: ["-c", "head -c 100000 /dev/zero; head -c 100000 /dev/zero >&2"],
            stdin: nil,
        )
        #expect(result.status == 0)
        #expect(result.stdout.count == maxCommandOutput)
        #expect(result.stderr.count == maxCommandOutput)
    }

    @Test func ollamaDraftReorderUsesOnlyOllamaRows() {
        var state = ModelDraftState(
            models: ["native/model", "ollama/first", "ollama/second", "ollama/third"],
            ollamaSlugs: ["ollama/first", "ollama/second", "ollama/third"],
        )
        state.moveOllama("ollama/second", by: -1)
        #expect(state.models == ["native/model", "ollama/second", "ollama/first", "ollama/third"])
        state.moveOllama("ollama/second", by: -1)
        #expect(state.models == ["native/model", "ollama/second", "ollama/first", "ollama/third"])
    }

    @Test func invalidCachedCobPathIsCleared() {
        var state = CobPathSelectionState(cachedPath: "/tmp/invalid-cob")
        state.clearIf("/tmp/invalid-cob")
        #expect(state.cachedPath == nil)
        state.cachedPath = "/tmp/other-cob"
        state.clearIf("/tmp/invalid-cob")
        #expect(state.cachedPath == "/tmp/other-cob")
    }

    @Test func executableIdentityChangesWhenFileChanges() throws {
        let directory = try FileManager.default.createTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let executable = directory.appendingPathComponent("cob")
        try Data("one".utf8).write(to: executable)
        let first = CobExecutableIdentity(path: executable.path)
        #expect(first != nil)
        #expect(first == CobExecutableIdentity(path: executable.path))

        try Data("different size".utf8).write(to: executable)
        #expect(first != CobExecutableIdentity(path: executable.path))
    }

    @Test func environmentLockedPatchFieldsCanBeOmitted() throws {
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
        #expect(object?.keys.contains("expected_revision") == true)
        #expect(object?["expected_revision"] is NSNull)
        #expect((object?["compaction"] as? [String: Any])?["ollama_model"] == nil)
    }

    @Test func boundedLogReadsTailAndHandlesRotationAndTruncate() throws {
        let directory = try FileManager.default.createTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let current = directory.appendingPathComponent("cob-gateway.log")
        let archive = directory.appendingPathComponent("cob-gateway.log.1")
        try Data(repeating: 65, count: maxLogBytes + 100).write(to: archive)
        try Data("old\nnew-current\n".utf8).write(to: current)
        let initialSignature = BoundedLog.signature(current: current.path, archive: archive.path)
        #expect(initialSignature == BoundedLog.signature(current: current.path, archive: archive.path))
        let text = BoundedLog.read(current: current.path, archive: archive.path)
        #expect(text.contains("new-current"))
        #expect(text.utf8.count <= maxLogBytes + maxLogLines)

        try Data("archive-after-rotation\n".utf8).write(to: archive)
        try Data("truncated\n".utf8).write(to: current)
        #expect(initialSignature != BoundedLog.signature(current: current.path, archive: archive.path))
        #expect(BoundedLog.read(current: current.path, archive: archive.path).contains("truncated"))
    }
}

private extension FileManager {
    func createTemporaryDirectory() throws -> URL {
        let url = temporaryDirectory.appendingPathComponent("cob-menu-tests-\(UUID().uuidString)")
        try createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}
