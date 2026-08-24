import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractOllamaUsage,
  formatOllamaUsage,
  formatOllamaWireMetrics,
  formatRequestMetrics,
  jsonUtf8Bytes,
  sha256Hex8,
  summarizeRequest,
} from "./request-metrics.js";

describe("request-metrics", () => {
  it("splits payload bytes by top-level field and hashes tools without logging schemas", () => {
    const tools = [
      {
        type: "function",
        name: "exec_command",
        description: "secret-looking schema text that must not appear in the log",
        parameters: { type: "object" },
      },
      {
        type: "namespace",
        name: "codex_app",
        tools: [{ type: "function", name: "automation_update", parameters: { type: "object" } }],
      },
    ];
    const payload = {
      model: "ollama/deepseek-v4-flash:0731-cloud",
      instructions: "short cob instructions",
      tools,
      input: [
        { type: "message", role: "developer", content: "app-context" },
        { type: "message", role: "user", content: "hey" },
      ],
      reasoning: { effort: "high" },
    };
    const metrics = summarizeRequest(payload, 4096);
    assert.equal(metrics.decodedBytes, 4096);
    assert.equal(metrics.toolsCount, 2);
    assert.equal(metrics.inputCount, 2);
    assert.equal(metrics.previousResponseId, false);
    assert.equal(metrics.reasoningEffort, "high");
    assert.equal(metrics.toolsSha, sha256Hex8(tools));
    assert.equal(metrics.instructionsSha, sha256Hex8("short cob instructions"));
    assert.equal(metrics.inputByType["message:developer"], 1);
    assert.equal(metrics.inputByType["message:user"], 1);
    assert.equal(metrics.toolBytesByName[0]?.name, "exec_command");
    const line = formatRequestMetrics(metrics);
    assert.match(line, /decoded_bytes=4096/);
    assert.match(line, /tools_n=2/);
    assert.match(line, /b_tools=/);
    assert.match(line, /effort=high/);
    assert.match(line, /prev_id=0/);
    assert.match(line, /input_by=message:developer:1,message:user:1/);
    assert.match(line, /tool_bytes_top=\d+/);
    assert.equal(line.includes("exec_command"), false);
    assert.equal(line.includes("automation_update"), false);
    assert.equal(line.includes("secret-looking"), false);
    assert.equal(line.includes("app-context"), false);
  });

  it("keeps tools_sha stable when only input changes", () => {
    const tools = [{ type: "function", name: "exec_command" }];
    const first = summarizeRequest({ tools, input: [{ type: "message", role: "user", content: "a" }] }, 10);
    const second = summarizeRequest(
      {
        tools,
        input: [
          { type: "message", role: "user", content: "a" },
          { type: "message", role: "user", content: "b" },
        ],
      },
      20,
    );
    assert.equal(first.toolsSha, second.toolsSha);
    assert.notEqual(first.inputBytes, second.inputBytes);
  });

  it("does not put previous_response_id values in the metrics line", () => {
    const line = formatRequestMetrics(
      summarizeRequest({ previous_response_id: "resp_should_never_appear", input: "hi" }, 8),
    );
    assert.match(line, /prev_id=1/);
    assert.equal(line.includes("resp_should_never_appear"), false);
  });

  it("extracts Ollama usage without copying output text", () => {
    const metrics = extractOllamaUsage({
      id: "resp_1",
      object: "response",
      output: [{ type: "message", content: "hello there secret" }],
      usage: {
        input_tokens: 61612,
        output_tokens: 480,
        total_tokens: 62092,
        cached_input_tokens: 0,
      },
      prompt_eval_duration: 1_500_000_000,
      eval_duration: 800_000_000,
    });
    assert.deepEqual(metrics, {
      inputTokens: 61612,
      outputTokens: 480,
      cachedInputTokens: 0,
      totalTokens: 62092,
      promptEvalCount: undefined,
      promptEvalDurationMs: 1500,
      evalDurationMs: 800,
    });
    const line = formatOllamaUsage(metrics!);
    assert.equal(line.includes("hello"), false);
    assert.match(line, /in=61612/);
    assert.match(line, /prompt_eval_ms=1500/);
  });

  it("maps exact prompt_eval_count/eval_count and omits invented usage", () => {
    const mapped = extractOllamaUsage({
      prompt_eval_count: 12,
      eval_count: 3,
    });
    assert.deepEqual(mapped?.inputTokens, 12);
    assert.deepEqual(mapped?.outputTokens, 3);
    assert.deepEqual(mapped?.totalTokens, 15);
    assert.equal(extractOllamaUsage({ output: [] }), undefined);
  });

  it("keeps large-tool snapshot output stable while serializing each field once", () => {
    const tools = Array.from({ length: 80 }, (_, index) => ({
      type: "function",
      name: `tool_${index}`,
      description: "schema-secret-must-not-appear",
      parameters: { type: "object", properties: { q: { type: "string" } } },
    }));
    const payload = {
      model: "ollama/deepseek-v4-flash:0731-cloud",
      instructions: "short cob instructions",
      tools,
      input: [{ type: "message", role: "user", content: "hey" }],
    };
    const first = formatRequestMetrics(summarizeRequest(payload, 50_000));
    const second = formatRequestMetrics(summarizeRequest(payload, 50_000));
    assert.equal(first, second);
    assert.equal(first.includes("schema-secret-must-not-appear"), false);
    assert.match(first, /tools_n=80/);
    assert.match(first, /tool_bytes_top=\d+/);
    assert.doesNotMatch(first, /tool_\d+/);
  });

  it("jsonUtf8Bytes matches Buffer length of JSON.stringify", () => {
    const value = { a: 1, b: ["x"] };
    assert.equal(jsonUtf8Bytes(value), Buffer.byteLength(JSON.stringify(value), "utf8"));
    assert.equal(jsonUtf8Bytes(undefined), 0);
  });

  it("formats Ollama wire metrics without schemas or response ids", () => {
    const line = formatOllamaWireMetrics({
      wireBytes: 2048,
      toolsCount: 18,
      toolsBytes: 18000,
      toolsSha: "abcd1234",
      toolBytesByName: [{ name: "multi_agent_v1__spawn_agent", bytes: 6800 }],
      promotedN: 1,
      promotedBytes: 6800,
      skippedCap: 0,
      skippedInvalid: 0,
      skippedUnsupported: 0,
      collisions: 0,
      aliasSha: "deadbeef",
      aliasesAdded: 1,
      aliasesRemoved: 0,
      aliasesReplaced: 0,
      usedAliasMissing: 0,
    });
    assert.match(line, /wire_bytes=2048/);
    assert.match(line, /tools_n=18/);
    assert.match(line, /promoted_n=1/);
    assert.match(line, /promoted_bytes=6800/);
    assert.match(line, /alias_sha=deadbeef/);
    assert.match(line, /alias_added=1/);
    assert.match(line, /used_alias_missing=0/);
    assert.match(line, /tool_bytes_top=6800/);
    assert.equal(line.includes("multi_agent_v1__spawn_agent"), false);
    assert.equal(line.includes("Spawn a sub-agent"), false);
    assert.equal(line.includes("previous_response_id"), false);
  });
});
