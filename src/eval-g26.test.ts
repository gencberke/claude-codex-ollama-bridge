import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { modelSha8 } from "./codex/diagnostic-event.js";
import { evaluateG26Sidecar, parseG26Args, parseG26Jsonl } from "./eval-g26.js";

const MODEL = "ollama/private-model";
const MODEL_SHA8 = modelSha8(MODEL);
const FROM = "2026-09-02T10:00:00Z";
const TO = "2026-09-02T10:10:00Z";

function start(seq: number, fp = `fp-${seq}`): Record<string, unknown> {
  return {
    schema_version: 1,
    kind: "request_start",
    timestamp: `2026-09-02T10:00:${String(seq).padStart(2, "0")}.000Z`,
    pid: 7,
    request_seq: seq,
    request_fp8: fp,
    route: "ollama",
    model_sha8: MODEL_SHA8,
  };
}

function end(seq: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...start(seq),
    kind: "request_end",
    status: 200,
    upstream_status: 200,
    terminal: "completed",
    total_latency_ms: 100 + seq,
    provider_attempts: 1,
    gateway_retry_count: 0,
    outbound_stream: true,
    response_content_type_class: "sse",
    decoder_mode: "sse_header",
    hosted_tools_dropped_n: 1,
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    ...over,
  };
}

describe("G26 sidecar evaluator", () => {
  it("builds a content-free passing receipt from a dynamic window", () => {
    const receipt = evaluateG26Sidecar(
      [
        start(1),
        end(1),
        start(2),
        end(2),
        { ...start(3), model_sha8: "other" },
        { ...end(3), model_sha8: "other" },
      ],
      { lane: "A", from: FROM, to: TO, model: MODEL, expectedHostedDrop: 1 },
    );
    assert.equal(receipt.observable_transport_pass, true);
    assert.deepEqual(receipt.requests, { starts: 2, ends: 2, starts_without_end: 0, ends_without_start: 0 });
    assert.equal(receipt.transport.provider_attempts_total, 2);
    assert.equal(receipt.duplicates.repeat_excess, 0);
    assert.deepEqual(receipt.successful_usage, {
      records: 2,
      input_tokens: 20,
      output_tokens: 4,
      total_tokens: 24,
    });
    assert.deepEqual(receipt.reason_codes, []);
    const serialized = JSON.stringify(receipt);
    assert.equal(serialized.includes(MODEL), false);
    assert.equal(serialized.includes("fp-1"), false);
    assert.equal(serialized.includes("prompt"), false);
  });

  it("fails observable transport on retries, duplicates, decoder drift, and malformed JSONL", () => {
    const parsed = parseG26Jsonl(`${JSON.stringify(start(1, "same"))}\nnot-json\n`);
    assert.equal(parsed.invalidLineCount, 1);
    const receipt = evaluateG26Sidecar(
      [
        ...parsed.events,
        end(1, {
          request_fp8: "same",
          status: 502,
          upstream_status: 200,
          terminal: "invalid_json",
          provider_attempts: 2,
          gateway_retry_count: 1,
          response_content_type_class: "json",
          decoder_mode: "json",
          hosted_tools_dropped_n: 0,
          usage: undefined,
        }),
        start(2, "same"),
        end(2, { request_fp8: "same" }),
      ],
      { lane: "B", from: FROM, to: TO, model: MODEL, expectedHostedDrop: 1 },
      parsed.invalidLineCount,
    );
    assert.equal(receipt.observable_transport_pass, false);
    assert.equal(receipt.outcomes.invalid_json_count, 1);
    assert.equal(receipt.duplicates.fingerprints_repeated, 1);
    assert.equal(receipt.duplicates.max_repeat, 2);
    assert.deepEqual(receipt.reason_codes, [
      "decoder_mismatch",
      "duplicate_fingerprint",
      "gateway_retry",
      "hosted_drop_mismatch",
      "invalid_json",
      "malformed_jsonl",
      "non_200_outcome",
      "provider_retry_or_missing_attempt",
      "terminal_failure",
    ]);
  });

  it("requires explicit lane boundaries, model, hosted-drop expectation, and output", () => {
    const args = parseG26Args([
      "--input", "diagnostic.jsonl",
      "--lane", "B",
      "--from", FROM,
      "--to", TO,
      "--model", MODEL,
      "--expected-hosted-drop", "1",
      "--input", "diagnostic.jsonl.1",
      "--out", "receipt.json",
    ]);
    assert.equal(args.lane, "B");
    assert.deepEqual(args.inputs, ["diagnostic.jsonl", "diagnostic.jsonl.1"]);
    assert.equal(args.expectedHostedDrop, 1);
    assert.throws(() => parseG26Args(["--lane", "A"]), /missing G26 argument/);
    assert.throws(
      () => parseG26Args([
        "--input", "a",
        "--input", "b",
        "--input", "c",
        "--lane", "A",
        "--from", FROM,
        "--to", TO,
        "--model", MODEL,
        "--expected-hosted-drop", "1",
        "--out", "receipt.json",
      ]),
      /at most one active and one rotated input/,
    );
  });
});
