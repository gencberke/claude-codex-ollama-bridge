import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ollamaCompactHandoffSkeleton } from "./codex/compaction/summary.js";
import {
  buildRunCorpus,
  classifyCodexNonzeroExit,
  classifyG24RunExit,
  correlateG24CompactionEpisodes,
  G24_FIXTURE_NONCE,
  G24_ISOLATED_WINDOW,
  G24_POSTCOMPACT_RETRIGGER_CLASSIFICATION,
  G24_WINDOW_FLOOR_CLASSIFICATION,
  g24EvidenceReceipt,
  g24NoncePresent,
  g24PostcompactRetriggerPending,
  g24PostcompactRetriggerTriggered,
  g24WindowFloorTriggered,
  writeFailureEvidence,
  type Capture,
  type G24CheckpointRecord,
} from "./eval-g24-child-run.js";
import { g24CorpusSha256 } from "./eval-g24-corpus.js";
import { idSha8 } from "./eval-receipt.js";

const SENTINEL = "SENTINEL_USER_CONTENT_MUST_NOT_BE_LOGGED";

function summarizerResponse(text: string): string {
  return JSON.stringify({
    id: "sum-1",
    object: "response",
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
  });
}

function turnResponse(id: string, usage?: Record<string, unknown>): string {
  return JSON.stringify({ id, object: "response", status: "completed", ...(usage ? { usage } : {}) });
}

function summarizerCapture(text = ollamaCompactHandoffSkeleton({ Completed: "handoff" })): Capture {
  return { kind: "summarizer", requestBody: "{}", responseBody: summarizerResponse(text) };
}

function turnCapture(id: string, usage?: Record<string, unknown>): Capture {
  return { kind: "turn", requestBody: "{}", responseBody: turnResponse(id, usage) };
}

describe("G24 nonzero codex exit classification", () => {
  it("classifies a nonzero exit after an incomplete handoff as FAIL, without the summary body", () => {
    const verdict = classifyCodexNonzeroExit({
      signal: null,
      latestSummarizerResponse: summarizerResponse("plain recap"),
    });
    assert.equal(verdict.kind, "fail");
    assert.equal(verdict.code, "compaction_summary_incomplete");
    assert.ok(!verdict.reason.includes("plain recap"));
  });

  it("keeps transport/precondition exits INCONCLUSIVE", () => {
    const completeHandoff = classifyCodexNonzeroExit({
      signal: "SIGKILL",
      latestSummarizerResponse: summarizerResponse(ollamaCompactHandoffSkeleton({ Completed: "handoff after baseline" })),
    });
    assert.equal(completeHandoff.kind, "inconclusive");
    assert.equal(completeHandoff.code, "codex_exec_failed");

    const noSummarizer = classifyCodexNonzeroExit({ signal: null, latestSummarizerResponse: undefined });
    assert.equal(noSummarizer.kind, "inconclusive");
    assert.equal(noSummarizer.code, "codex_exec_failed");

    const malformedResponse = classifyCodexNonzeroExit({
      signal: null,
      latestSummarizerResponse: "not json",
    });
    assert.equal(malformedResponse.kind, "inconclusive");
    assert.equal(malformedResponse.code, "codex_exec_failed");
  });

  it("writes a structural failure receipt: no stderr text, only byte count and SHA-256", () => {
    const verdict = classifyCodexNonzeroExit({ signal: null, latestSummarizerResponse: undefined });
    const evidenceDir = mkdtempSync(join(tmpdir(), "cob-g24-fail-"));
    const failurePath = writeFailureEvidence(evidenceDir, {
      codexStatus: 1,
      signal: null,
      hasSessionId: false,
      stderr: `${SENTINEL} tail`,
      latestSummarizer: { kind: "summarizer", requestBody: "{}", responseBody: summarizerResponse("plain recap") },
      verdict,
    });
    const raw = readFileSync(failurePath, "utf8");
    assert.ok(!raw.includes(SENTINEL));
    const receipt = JSON.parse(raw) as {
      transcriptFormatVersion: number;
      stderrBytes: number;
      stderrSha256: string;
      classification: { kind: string; code: string };
      handoffSummarySha256: string | null;
    };
    assert.equal(receipt.transcriptFormatVersion, 2);
    assert.equal(receipt.stderrBytes, Buffer.byteLength(`${SENTINEL} tail`, "utf8"));
    assert.match(receipt.stderrSha256, /^[0-9a-f]{64}$/);
    assert.equal(receipt.classification.kind, "inconclusive");
    assert.equal(receipt.classification.code, "codex_exec_failed");
    assert.equal((receipt as unknown as { terminationOwner: string }).terminationOwner, "unowned");
    assert.equal((receipt as unknown as { terminationReason: string }).terminationReason, "unowned");
    assert.match(receipt.handoffSummarySha256 ?? "", /^[0-9a-f]{64}$/);
  });

  it("records owned termination explicitly and never infers ownership from a signal", () => {
    const unowned = classifyCodexNonzeroExit({ signal: "SIGTERM" });
    assert.equal(unowned.code, "codex_exec_failed");
    const owned = classifyCodexNonzeroExit({ signal: "SIGKILL", terminationOwner: "harness" });
    assert.equal(owned.kind, "inconclusive");
    assert.equal(owned.code, "g24_harness_terminated");
    const timeout = classifyCodexNonzeroExit({
      signal: "SIGKILL",
      terminationOwner: "harness",
      terminationReason: "timeout",
    });
    assert.equal(timeout.code, "g24_harness_terminated");
  });

  it("keeps proven window-floor evidence authoritative over an unowned signal", () => {
    const verdict = classifyG24RunExit({
      signal: "SIGTERM",
      latestSummarizerResponse: summarizerResponse("plain recap"),
      windowFloorTriggered: true,
    });
    assert.equal(verdict.kind, "inconclusive");
    assert.equal(verdict.code, "g24_window_below_postcompact_floor");
  });

  it("classifies a structural post-compact retrigger with intervening turns", () => {
    const captures: Capture[] = [
      summarizerCapture(),
      turnCapture("turn-1", { input_tokens: G24_ISOLATED_WINDOW - 2 }),
      turnCapture("turn-2", { input_tokens: 1 }),
      { kind: "summarizer", requestBody: "{}", responseBody: "", terminationReason: "postcompact_retrigger" },
    ];
    assert.equal(g24PostcompactRetriggerPending(captures.slice(0, 3)), true);
    assert.equal(g24PostcompactRetriggerTriggered(captures), true);
    const verdict = classifyG24RunExit({
      signal: "SIGTERM",
      windowFloorTriggered: false,
      postcompactRetriggerTriggered: true,
      latestSummarizerActualSecond: false,
    });
    assert.deepEqual(verdict, G24_POSTCOMPACT_RETRIGGER_CLASSIFICATION);
  });

  it("does not let structural retrigger classification mask a real incomplete summary", () => {
    const verdict = classifyG24RunExit({
      signal: "SIGTERM",
      latestSummarizerResponse: summarizerResponse("plain recap"),
      windowFloorTriggered: true,
      postcompactRetriggerTriggered: false,
      latestSummarizerActualSecond: true,
    });
    assert.equal(verdict.kind, "fail");
    assert.equal(verdict.code, "compaction_summary_incomplete");
  });

  it("builds the workdir corpus from the pinned corpus with one canonical hash", () => {
    const corpus = buildRunCorpus();
    // The pinned conversation fixture is executed inside file A.
    assert.ok(corpus.fileA.includes('"g24-corpus: list the three cob surfaces"'));
    // One canonical corpus hash: the pinned corpus hash, not a second
    // file-derived hash.
    assert.equal(corpus.canonicalSha256, g24CorpusSha256());
    // Deterministic across calls.
    const again = buildRunCorpus();
    assert.equal(again.fileA, corpus.fileA);
    assert.equal(again.fileB, corpus.fileB);
  });

  it("uses an independent fixed fixture nonce, never summarizer output", () => {
    // A summarizer-style "Completed:" line is not the nonce.
    assert.equal(g24NoncePresent("Completed: handoff line from the summarizer"), false);
    // The fixed marker is detected verbatim.
    assert.equal(g24NoncePresent(`some transcript\n${G24_FIXTURE_NONCE}`), true);
    assert.ok(G24_FIXTURE_NONCE.length >= 8);
    assert.equal(G24_FIXTURE_NONCE, "COB_G24_NONCE_20260831_FIXED_A7F3");
  });

  it("keeps the success evidence receipt content-free", () => {
    const captures: Capture[] = [
      {
        kind: "summarizer",
        requestBody: `{"instructions":"${SENTINEL} compact instructions"}`,
        responseBody: `{"output":"${SENTINEL} summary"}`,
      },
      { kind: "turn", requestBody: `{"input":"${SENTINEL} continuation"}`, responseBody: `{"id":"resp-abc123"}` },
    ];
    const receipt = g24EvidenceReceipt({
      model: "ollama/x",
      childSessionId: "12345678-90ab-cdef-1234-567890abcdef",
      requestId: "g24-run-1",
      corpusSha256: "a".repeat(64),
      window: G24_ISOLATED_WINDOW,
      codexStatus: 0,
      stdout: `${SENTINEL} stdout transcript`,
      stderr: `${SENTINEL} stderr transcript`,
      captures,
      checkpointTotal: 4,
      hasCompactionReplacement: true,
      postCompactTurns: 2,
      continuationChainOk: true,
      handoffSummary: `${SENTINEL} Goal: finish`,
      scorer: { verdict: "pass", code: "compact_and_two_continuations", reason: "ok", replayRatio: 0.03 },
    });
    const raw = JSON.stringify(receipt);
    assert.equal(raw.includes(SENTINEL), false);
    assert.equal(raw.includes("12345678-90ab-cdef"), false);
    assert.equal(raw.includes("resp-abc123"), false);
    // The raw request/run id never reaches the receipt; only its short hash.
    assert.equal(raw.includes("g24-run-1"), false);
    // The raw model slug never reaches the receipt; only its short hash.
    assert.equal(raw.includes("ollama/x"), false);
    // Only hashes/bytes/codes/booleans/aggregates are retained.
    const run = receipt.run as {
      modelSha8: string;
      childSha8: string;
      hasSessionId: boolean;
      requestIdSha8: string;
      corpusSha256: string;
    };
    assert.match(run.modelSha8, /^[0-9a-f]{8}$/);
    assert.equal(run.modelSha8, idSha8("ollama/x"));
    assert.match(run.childSha8, /^[0-9a-f]{8}$/);
    assert.equal(run.requestIdSha8, idSha8("g24-run-1"));
    assert.equal(run.hasSessionId, true);
    assert.equal(run.corpusSha256, "a".repeat(64));
    const firstCapture = (receipt.captures as Record<string, unknown>[])[0]!;
    assert.equal(firstCapture.requestHead, undefined);
    assert.match(firstCapture.requestSha256 as string, /^[0-9a-f]{64}$/);
    const checkpoints = receipt.checkpoints as Record<string, unknown>;
    assert.equal(checkpoints.total, 4);
    assert.equal(checkpoints.continuationChainOk, true);
  });
});

describe("G24 compaction episode correlation", () => {
  it("pairs each chronological valid summary with its own replacement lineage", () => {
    const captures: Capture[] = [
      summarizerCapture(),
      turnCapture("c11"),
      turnCapture("c12"),
      summarizerCapture(),
      turnCapture("c21"),
      turnCapture("c22"),
    ];
    const checkpoints: G24CheckpointRecord[] = [
      { responseId: "base1", isCompactionReplacement: false, createdAt: "2026-01-01T00:00:01Z" },
      { responseId: "r1", parentResponseId: "base1", isCompactionReplacement: true, createdAt: "2026-01-01T00:00:02Z" },
      { responseId: "c11", parentResponseId: "r1", isCompactionReplacement: false, createdAt: "2026-01-01T00:00:03Z" },
      { responseId: "c12", parentResponseId: "c11", isCompactionReplacement: false, createdAt: "2026-01-01T00:00:04Z" },
      { responseId: "base2", isCompactionReplacement: false, createdAt: "2026-01-01T00:00:05Z" },
      { responseId: "r2", parentResponseId: "base2", isCompactionReplacement: true, createdAt: "2026-01-01T00:00:06Z" },
      { responseId: "c21", parentResponseId: "r2", isCompactionReplacement: false, createdAt: "2026-01-01T00:00:07Z" },
      { responseId: "c22", parentResponseId: "c21", isCompactionReplacement: false, createdAt: "2026-01-01T00:00:08Z" },
    ];
    const result = correlateG24CompactionEpisodes(captures, checkpoints);
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      assert.equal(result.episode.replacement.responseId, "r1");
      assert.equal(result.episode.summarizerCaptureIndex, 0);
      assert.deepEqual(result.episode.continuations.map((record) => record.responseId), ["c11", "c12"]);
    }
  });

  it("classifies an episode with missing descendant evidence instead of pairing mismatched captures", () => {
    const result = correlateG24CompactionEpisodes(
      [summarizerCapture(), summarizerCapture()],
      [
        { responseId: "base", isCompactionReplacement: false, createdAt: "2026-01-01T00:00:01Z" },
        { responseId: "replacement", parentResponseId: "base", isCompactionReplacement: true, createdAt: "2026-01-01T00:00:02Z" },
      ],
    );
    assert.deepEqual(result, { kind: "missing", code: "compaction_continuation_incomplete" });
  });
});

describe("G24 post-compact window floor detector", () => {
  it("uses exact upstream usage and the immediate next summarizer", () => {
    const hugeRequest = "x".repeat(100_000);
    const captures: Capture[] = [
      summarizerCapture(),
      { ...turnCapture("turn", { input_tokens: G24_ISOLATED_WINDOW }), requestBody: hugeRequest },
      summarizerCapture(),
    ];
    assert.equal(g24WindowFloorTriggered(captures, G24_ISOLATED_WINDOW), true);
    assert.equal(G24_WINDOW_FLOOR_CLASSIFICATION.code, "g24_window_below_postcompact_floor");
  });

  it("keeps exact window-floor evidence across intervening turn captures", () => {
    const captures: Capture[] = [
      summarizerCapture(),
      turnCapture("turn-1", { input_tokens: G24_ISOLATED_WINDOW }),
      turnCapture("turn-2", { input_tokens: 1 }),
      summarizerCapture(),
    ];
    assert.equal(g24WindowFloorTriggered(captures, G24_ISOLATED_WINDOW), true);
  });

  it("does not substitute request bytes or approximate usage fields", () => {
    const captures: Capture[] = [
      summarizerCapture(),
      { ...turnCapture("turn", { prompt_eval_count: G24_ISOLATED_WINDOW + 1 }), requestBody: "x".repeat(100_000) },
      summarizerCapture(),
    ];
    assert.equal(g24WindowFloorTriggered(captures, G24_ISOLATED_WINDOW), false);
    const below = [summarizerCapture(), turnCapture("turn", { input_tokens: G24_ISOLATED_WINDOW - 1 }), summarizerCapture()];
    assert.equal(g24WindowFloorTriggered(below, G24_ISOLATED_WINDOW), false);
  });
});
