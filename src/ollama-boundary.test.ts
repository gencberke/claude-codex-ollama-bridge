import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyOllamaRequestBoundary,
  classifyOllamaError,
  mapOllamaReasoningEffort,
  normalizeOllamaErrorBody,
  normalizeOllamaReasoning,
  OLLAMA_0_32_15_RESPONSES_REQUEST_FIELDS,
  OLLAMA_ADVISORY_FIELDS,
  OLLAMA_REQUEST_ALLOWLIST,
} from "./ollama-boundary.js";
import { isOllamaReject, prepareOllamaWire, sanitizeOllamaPayload } from "./ollama.js";
import { buildOllamaSummarizerPayload } from "./compaction.js";
import { extractOllamaUsage } from "./request-metrics.js";
import type { JsonObject } from "./types.js";
import { isRecord } from "./types.js";

function wireKeys(payload: JsonObject, supportsReasoning = true): string[] {
  const wire = prepareOllamaWire(payload, { supportsReasoning });
  assert.equal(isOllamaReject(wire), false);
  if (isOllamaReject(wire)) return [];
  return Object.keys(wire.payload).sort();
}

describe("Ollama request boundary", () => {
  it("partitions the pinned 0.33.1 ResponsesRequest fields without inventing extras", () => {
    const allow = new Set<string>(OLLAMA_REQUEST_ALLOWLIST);
    const advisory = new Set<string>(OLLAMA_ADVISORY_FIELDS);
    const pinned = new Set<string>(OLLAMA_0_32_15_RESPONSES_REQUEST_FIELDS);
    assert.equal(pinned.has("tool_choice"), false);
    for (const field of OLLAMA_REQUEST_ALLOWLIST) {
      assert.equal(pinned.has(field), true, `allowlisted ${field} is not on 0.33.1 ResponsesRequest`);
    }
    for (const field of OLLAMA_0_32_15_RESPONSES_REQUEST_FIELDS) {
      if (field === "conversation") {
        assert.equal(allow.has(field), false);
        assert.equal(advisory.has(field), false);
        continue;
      }
      assert.equal(
        allow.has(field) || advisory.has(field),
        true,
        `0.33.1 field ${field} is neither allowlisted nor advisory`,
      );
    }
    const conversation = applyOllamaRequestBoundary({ model: "m", input: "hi", conversation: { id: "c1" } });
    assert.equal(isOllamaReject(conversation), true);
    const dropped = applyOllamaRequestBoundary({
      model: "m",
      input: "hi",
      background: true,
      include: ["file_search_call.results"],
    });
    assert.equal(isOllamaReject(dropped), false);
    if (isOllamaReject(dropped)) return;
    assert.deepEqual(dropped.dropped.sort(), ["background", "include"]);
  });

  it("keeps the reviewed Responses key set and drops advisory fields", () => {
    const bounded = applyOllamaRequestBoundary({
      model: "deepseek-v4-flash:0731-cloud",
      input: "hi",
      instructions: "be brief",
      max_output_tokens: 32,
      reasoning: { effort: "high" },
      temperature: 0.2,
      text: { format: { type: "text" } },
      top_p: 0.9,
      truncation: "disabled",
      tools: [],
      stream: false,
      store: false,
      metadata: { x: 1 },
      client_metadata: { session: "codex" },
      stream_options: { include_usage: true },
      service_tier: "priority",
    });
    assert.equal(isOllamaReject(bounded), false);
    if (isOllamaReject(bounded)) return;
    assert.deepEqual(Object.keys(bounded.payload).sort(), [
      "input",
      "instructions",
      "max_output_tokens",
      "model",
      "reasoning",
      "stream",
      "temperature",
      "text",
      "tools",
      "top_p",
      "truncation",
    ]);
    assert.equal(bounded.dropped.includes("store"), true);
    assert.equal(bounded.dropped.includes("metadata"), true);
    assert.equal(bounded.dropped.includes("client_metadata"), true);
    assert.equal(bounded.dropped.includes("stream_options"), true);
    assert.equal("client_metadata" in bounded.payload, false);
    assert.equal("stream_options" in bounded.payload, false);
  });

  it("rejects unknown and conversation fields, and unimplemented text.format types", () => {
    const unknown = applyOllamaRequestBoundary({
      model: "m",
      input: "hi",
      foo_future: true,
    });
    assert.equal(isOllamaReject(unknown), true);
    if (!isOllamaReject(unknown)) return;
    assert.equal(unknown.body.error.code, "ollama_field_unsupported");

    const conversation = applyOllamaRequestBoundary({
      model: "m",
      input: "hi",
      conversation: { id: "c1" },
    });
    assert.equal(isOllamaReject(conversation), true);
    if (!isOllamaReject(conversation)) return;
    assert.equal(conversation.body.error.code, "conversation_unsupported");

    const format = applyOllamaRequestBoundary({
      model: "m",
      input: "hi",
      text: { format: { type: "json_object" } },
    });
    assert.equal(isOllamaReject(format), true);
    if (!isOllamaReject(format)) return;
    assert.equal(format.body.error.code, "ollama_text_format_unsupported");
  });

  it('drops only tool_choice="auto" and rejects every correctness-affecting choice', () => {
    const automatic = applyOllamaRequestBoundary({
      model: "m",
      input: "hi",
      tools: [{ type: "function", name: "shell" }],
      tool_choice: "auto",
    });
    assert.equal(isOllamaReject(automatic), false);
    if (isOllamaReject(automatic)) return;
    assert.deepEqual(automatic.dropped, ["tool_choice"]);
    assert.equal("tool_choice" in automatic.payload, false);

    for (const toolChoice of [
      "required",
      "none",
      { type: "function", name: "shell" },
      { type: "custom", name: "shell" },
    ]) {
      const unsupported = applyOllamaRequestBoundary({
        model: "m",
        input: "hi",
        tool_choice: toolChoice,
      });
      assert.equal(isOllamaReject(unsupported), true);
      if (!isOllamaReject(unsupported)) continue;
      assert.equal(unsupported.status, 400);
      assert.equal(unsupported.body.error.code, "ollama_tool_choice_unsupported");
      assert.match(unsupported.body.error.message, /will not change/);
    }

    for (const toolChoice of [undefined, null, "shell", "", 1, true, ["shell"]]) {
      const malformed = applyOllamaRequestBoundary({
        model: "m",
        input: "hi",
        tool_choice: toolChoice,
      });
      assert.equal(isOllamaReject(malformed), true);
      if (!isOllamaReject(malformed)) continue;
      assert.equal(malformed.status, 400);
      assert.equal(malformed.body.error.code, "ollama_tool_choice_invalid");
      assert.match(malformed.body.error.message, /must be "auto"/);
    }
  });

  it("maps reasoning per the contract and strips effort on non-reasoning rows", () => {
    assert.equal(mapOllamaReasoningEffort("none"), "none");
    assert.equal(mapOllamaReasoningEffort("low"), "low");
    assert.equal(mapOllamaReasoningEffort("high"), "high");
    assert.equal(mapOllamaReasoningEffort("max"), "max");
    assert.equal(mapOllamaReasoningEffort("xhigh"), "high");
    assert.equal(mapOllamaReasoningEffort("medium"), "high");
    assert.equal(mapOllamaReasoningEffort("minimal"), "high");
    assert.equal(mapOllamaReasoningEffort("weird"), undefined);

    const glm = "glm-5.3-flash:cloud";
    assert.equal(mapOllamaReasoningEffort("low", glm), "low");
    assert.equal(mapOllamaReasoningEffort("high", glm), "high");
    assert.equal(mapOllamaReasoningEffort("max", glm), "max");
    assert.equal(mapOllamaReasoningEffort("none", glm), "low");
    assert.equal(mapOllamaReasoningEffort("off", glm), "low");
    assert.equal(mapOllamaReasoningEffort("minimal", glm), "low");
    assert.equal(mapOllamaReasoningEffort("medium", glm), "high");
    assert.equal(mapOllamaReasoningEffort("xhigh", glm), "max");

    const missing: JsonObject = { model: "m", input: "hi" };
    normalizeOllamaReasoning(missing, true);
    assert.deepEqual(missing.reasoning, { effort: "high" });

    const glmMissing: JsonObject = { model: glm, input: "hi" };
    normalizeOllamaReasoning(glmMissing, true);
    assert.deepEqual(glmMissing.reasoning, { effort: "max" });

    const inherited: JsonObject = { model: "m", input: "hi", reasoning: { effort: "xhigh" } };
    normalizeOllamaReasoning(inherited, false);
    assert.equal("reasoning" in inherited, false);

    const explicitMax = sanitizeOllamaPayload({
      model: "ollama/deepseek-v4-flash:0731-cloud",
      input: "hi",
      reasoning: { effort: "max" },
    });
    assert.deepEqual(explicitMax.reasoning, { effort: "max" });

    const glmDisabled: JsonObject = {
      model: "ollama/glm-5.3-flash:cloud",
      input: "hi",
      reasoning: { effort: "none" },
    };
    normalizeOllamaReasoning(glmDisabled, true);
    assert.deepEqual(glmDisabled.reasoning, { effort: "low" });

    const glmWire = sanitizeOllamaPayload({
      model: "ollama/glm-5.3-flash:cloud",
      input: "hi",
    });
    assert.equal(glmWire.model, "glm-5.3-flash:cloud");
    assert.deepEqual(glmWire.reasoning, { effort: "max" });

    const nestedWins = sanitizeOllamaPayload({
      model: "ollama/deepseek-v4-flash:0731-cloud",
      input: "hi",
      reasoning: { effort: "low" },
      reasoning_effort: "max",
    });
    assert.deepEqual(nestedWins.reasoning, { effort: "low" });
    assert.equal("reasoning_effort" in nestedWins, false);

    const stripped = sanitizeOllamaPayload(
      {
        model: "ollama/qwen2.5:7b",
        input: "hi",
        reasoning: { effort: "high" },
      },
      { supportsReasoning: false },
    );
    assert.equal("reasoning" in stripped, false);
  });

  it("snapshots outbound key sets for ordinary, tools, compact, and continued requests", () => {
    assert.deepEqual(
      wireKeys({
        model: "ollama/m",
        input: "hi",
        store: false,
        metadata: {},
        client_metadata: { app: "chatgpt" },
        stream_options: { include_usage: true },
      }),
      ["input", "model", "reasoning"],
    );
    assert.deepEqual(
      wireKeys({
        model: "ollama/m",
        input: "hi",
        tools: [{ type: "function", name: "shell" }],
        parallel_tool_calls: true,
      }),
      ["input", "model", "reasoning", "tools"],
    );
    assert.deepEqual(
      wireKeys(
        buildOllamaSummarizerPayload({
          compactModel: "ollama/deepseek-v4-flash:0731-cloud",
          history: [{ type: "message", role: "user", content: [{ type: "input_text", text: "old" }] }],
        }),
      ),
      ["input", "instructions", "model", "reasoning", "stream"],
    );
    assert.deepEqual(
      wireKeys({
        model: "ollama/m",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "next" }] }],
        previous_response_id: "resp_1",
      }),
      ["input", "model", "reasoning"],
    );
    assert.deepEqual(wireKeys({ model: "ollama/m", input: "hi" }, false), ["input", "model"]);
  });

  it("keeps json_schema text.format and does not invent missing usage totals", () => {
    const bounded = applyOllamaRequestBoundary({
      model: "m",
      input: "hi",
      text: { format: { type: "json_schema", name: "x", schema: { type: "object" } } },
    });
    assert.equal(isOllamaReject(bounded), false);

    const partial = extractOllamaUsage({ usage: { input_tokens: 10 } });
    assert.equal(partial?.inputTokens, 10);
    assert.equal(partial?.outputTokens, undefined);
    assert.equal(partial?.totalTokens, undefined);
    assert.equal(extractOllamaUsage({ output: [{ type: "message", content: "secret" }] }), undefined);
  });

  it("normalizes 429 quota and rate-limit bodies and preserves Retry-After", () => {
    const rate = normalizeOllamaErrorBody(
      429,
      Buffer.from(JSON.stringify({ error: { message: "rate limit: too many concurrent" } })),
      "12",
    );
    const rateError = isRecord(rate.error) ? rate.error : {};
    assert.equal(rateError.code, "ollama_rate_limited");
    assert.equal(rateError.retry_after, "12");
    assert.match(String(rateError.message), /retry later|concurrency/i);
    assert.doesNotMatch(String(rateError.message), /cob start fixes/);

    const quota = normalizeOllamaErrorBody(429, Buffer.from("quota exceeded"), undefined);
    const quotaError = isRecord(quota.error) ? quota.error : {};
    assert.equal(quotaError.code, "ollama_quota_exhausted");
    assert.match(String(quotaError.message), /replenish quota/);

    const plain = normalizeOllamaErrorBody(502, Buffer.from("not-json {"), undefined);
    const plainError = isRecord(plain.error) ? plain.error : {};
    assert.equal(plainError.code, "ollama_upstream_error");
    assert.equal(classifyOllamaError(429, ""), "rate");
  });
});
