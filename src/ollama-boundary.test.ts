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
} from "./codex/ollama-boundary.js";
import { forwardOllamaResponses, isOllamaReject, prepareOllamaPayload, prepareOllamaWire, sanitizeOllamaPayload } from "./codex/ollama.js";
import { OLLAMA_DIALECT } from "./codex/ollama-dialect.js";
import { buildOllamaSummarizerPayload } from "./codex/compaction/summary.js";
import { extractOllamaUsage, sha256Hex8, summarizeRequest } from "./codex/request-metrics.js";
import type { JsonObject } from "./core/json.js";
import { isRecord } from "./core/json.js";

function wireKeys(payload: JsonObject, supportsReasoning = true): string[] {
  const wire = prepareOllamaWire(payload, { supportsReasoning });
  assert.equal(isOllamaReject(wire), false);
  if (isOllamaReject(wire)) return [];
  return Object.keys(wire.payload).sort();
}

describe("Ollama request boundary", () => {
  it("partitions the pinned 0.33.2 ResponsesRequest fields without inventing extras", () => {
    const allow = new Set<string>(OLLAMA_REQUEST_ALLOWLIST);
    const advisory = new Set<string>(OLLAMA_ADVISORY_FIELDS);
    const pinned = new Set<string>(OLLAMA_0_32_15_RESPONSES_REQUEST_FIELDS);
    assert.equal(pinned.has("tool_choice"), false);
    for (const field of OLLAMA_REQUEST_ALLOWLIST) {
      assert.equal(pinned.has(field), true, `allowlisted ${field} is not on 0.33.2 ResponsesRequest`);
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
        `0.33.2 field ${field} is neither allowlisted nor advisory`,
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
      ["input", "instructions", "model", "reasoning", "stream", "temperature"],
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

  it("redacts credentials and user paths from generic Ollama error text", () => {
    const sanitized = normalizeOllamaErrorBody(
      502,
      Buffer.from(
        JSON.stringify({
          error: {
            message:
              "model load failed for Bearer sk-secret-token at /Users/alice/secret/model.gguf and C:\\Users\\bob\\junk",
          },
        }),
      ),
      undefined,
    );
    const error = isRecord(sanitized.error) ? sanitized.error : {};
    const message = String(error.message);
    assert.match(message, /model load failed/);
    assert.equal(message.includes("sk-secret-token"), false);
    assert.equal(message.includes("/Users/alice/secret"), false);
    assert.equal(message.includes("\\Users\\bob"), false);
    assert.match(message, /\[redacted-credential\]/);
    assert.match(message, /\[redacted-path\]/);
    assert.equal(message.includes("\n"), false);
  });

  it("falls back to the generic HTTP message for empty or oversized Ollama error text", () => {
    const oversized = normalizeOllamaErrorBody(
      500,
      Buffer.from(JSON.stringify({ error: { message: "x".repeat(3000) } })),
      undefined,
    );
    const oversizeError = isRecord(oversized.error) ? oversized.error : {};
    assert.equal(oversizeError.code, "ollama_upstream_error");
    assert.equal(oversizeError.message, "Ollama returned HTTP 500");

    const empty = normalizeOllamaErrorBody(502, Buffer.from("   \n"), undefined);
    const emptyError = isRecord(empty.error) ? empty.error : {};
    assert.equal(emptyError.message, "Ollama returned HTTP 502");

    const benign = normalizeOllamaErrorBody(
      503,
      Buffer.from(JSON.stringify({ error: { message: "engine is loading" } })),
      undefined,
    );
    const benignError = isRecord(benign.error) ? benign.error : {};
    assert.equal(benignError.message, "engine is loading");
  });

  it("keeps quota and rate messages fixed even when the upstream body mentions secrets", () => {
    const quota = normalizeOllamaErrorBody(
      429,
      Buffer.from(
        JSON.stringify({ error: { message: "quota exhausted for Bearer sk-secret at /Users/alice/x" } }),
      ),
      "7",
    );
    const quotaError = isRecord(quota.error) ? quota.error : {};
    assert.equal(quotaError.code, "ollama_quota_exhausted");
    assert.match(String(quotaError.message), /replenish quota/);
    assert.equal(String(quotaError.message).includes("Alice"), false);
    assert.equal(quotaError.retry_after, "7");
  });
});

describe("route-dependent structured output", () => {
  const cloudModel = "ollama/deepseek-v4-flash:0731-cloud";
  const localModel = "ollama/local-instruct";
  const jsonSchemaText = {
    format: {
      type: "json_schema",
      name: "x",
      schema: { type: "object", properties: { secret_prop: { type: "string" } } },
    },
  };

  it("rejects json_schema on a verified cloud route with a content-free message", () => {
    const wire = prepareOllamaWire({ model: cloudModel, input: "hi", text: jsonSchemaText });
    assert.equal(isOllamaReject(wire), true);
    if (!isOllamaReject(wire)) return;
    assert.equal(wire.status, 400);
    assert.equal(wire.body.error.code, "ollama_text_format_cloud_unsupported");
    const body = JSON.stringify(wire.body);
    assert.equal(body.includes("secret_prop"), false);
    assert.match(String(wire.body.error.message), /Ollama Cloud/);
  });

  it("never dispatches a rejected cloud json_schema request to the upstream", async () => {
    let upstreamCalls = 0;
    const forwarded = await forwardOllamaResponses({
      payload: { model: cloudModel, input: "hi", text: jsonSchemaText },
      fetchImpl: async () => {
        upstreamCalls += 1;
        throw new Error("upstream must not be called");
      },
    });
    assert.equal(isOllamaReject(forwarded), true);
    assert.equal(upstreamCalls, 0);
  });

  it("keeps json_schema forwarded unchanged on the reviewed local route", () => {
    const wire = prepareOllamaWire({ model: localModel, input: "hi", text: jsonSchemaText });
    assert.equal(isOllamaReject(wire), false);
    if (isOllamaReject(wire)) return;
    assert.deepEqual(wire.payload.text, jsonSchemaText);
  });

  it("keeps plain text format compatible on cloud and local routes", () => {
    for (const model of [cloudModel, localModel]) {
      const wire = prepareOllamaWire({ model, input: "hi", text: { format: { type: "text" } } });
      assert.equal(isOllamaReject(wire), false, model);
      if (isOllamaReject(wire)) continue;
      assert.deepEqual(wire.payload.text, { format: { type: "text" } });
    }
  });

  it("still rejects unknown text.format types and does not widen the allowlist", () => {
    for (const model of [cloudModel, localModel]) {
      const wire = prepareOllamaWire({ model, input: "hi", text: { format: { type: "json_object" } } });
      assert.equal(isOllamaReject(wire), true, model);
      if (!isOllamaReject(wire)) continue;
      assert.equal(wire.body.error.code, "ollama_text_format_unsupported");
    }
    const dialectCapabilities = OLLAMA_DIALECT.capabilities;
    assert.equal(dialectCapabilities.structuredTextJsonSchema, "route-dependent");
    assert.equal(dialectCapabilities.structuredTextJsonSchemaLocal, "supported");
    assert.equal(dialectCapabilities.structuredTextJsonSchemaCloud, "unsupported");
    assert.equal(dialectCapabilities.structuredTextPlainText, "supported");
  });
});

describe("request-side traversal budget", () => {
  function deepRequest(depth: number): JsonObject {
    let value: unknown = "leaf";
    for (let index = 0; index < depth; index += 1) value = [value];
    return { model: "ollama/m", input: value } as JsonObject;
  }

  it("rejects a 200-level request with a stable 400 before upstream dispatch", async () => {
    const rejected = prepareOllamaWire(deepRequest(200));
    assert.equal(isOllamaReject(rejected), true);
    if (!isOllamaReject(rejected)) return;
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, "ollama_json_traversal_overflow");
    assert.equal(JSON.stringify(rejected.body).includes("leaf"), false);

    let upstreamCalls = 0;
    const forwarded = await forwardOllamaResponses({
      payload: deepRequest(200),
      fetchImpl: async () => {
        upstreamCalls += 1;
        throw new Error("upstream must not be called");
      },
    });
    assert.equal(isOllamaReject(forwarded), true);
    assert.equal(upstreamCalls, 0);
  });

  it("keeps a 120-level request valid", () => {
    const wire = prepareOllamaWire(deepRequest(120));
    assert.equal(isOllamaReject(wire), false);
  });

  it("stops a wide request at the node ceiling without fully rewriting it", () => {
    const wide = {
      model: "ollama/m",
      input: Array.from({ length: 100_001 }, (_unused, index) => ({ index })),
    } as JsonObject;
    const rejected = prepareOllamaWire(wide);
    assert.equal(isOllamaReject(rejected), true);
    if (!isOllamaReject(rejected)) return;
    assert.equal(rejected.body.error.code, "ollama_json_traversal_overflow");
  });

  it("rejects a deep encrypted/strip traversal with the stable 400, never a RangeError", () => {
    const rejected = prepareOllamaPayload(deepRequest(5_000));
    assert.equal(isOllamaReject(rejected), true);
    if (!isOllamaReject(rejected)) return;
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, "ollama_json_traversal_overflow");
    assert.equal(JSON.stringify(rejected.body).includes("leaf"), false);
  });
});

describe("hosted tool request filtering on final wire", () => {
  it("omits hosted web_search from final serialized Ollama fetch body and calls upstream once", async () => {
    let upstreamCalls = 0;
    let interceptedBody: string | undefined;
    let interceptedAccept: string | undefined;

    const payload: JsonObject = {
      model: "ollama/deepseek-v4-flash:0731-cloud",
      stream: false,
      tools: [
        { type: "web_search" },
        { type: "function", name: "lookup_item", parameters: { type: "object" } },
      ],
    };

    const forwarded = await forwardOllamaResponses({
      payload,
      fetchImpl: async (_url, init) => {
        upstreamCalls += 1;
        const headers = (init?.headers ?? {}) as Record<string, string>;
        interceptedAccept = headers.Accept ?? headers.accept;
        interceptedBody = typeof init?.body === "string"
          ? init.body
          : Buffer.isBuffer(init?.body)
            ? (init.body as Buffer).toString("utf8")
            : undefined;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    assert.equal(isOllamaReject(forwarded), false);
    if (isOllamaReject(forwarded)) return;
    assert.equal(upstreamCalls, 1);
    assert.equal(forwarded.bridge.hostedToolsDroppedN, 1);
    assert.equal(interceptedAccept, "application/json");
    assert.ok(interceptedBody);

    const parsed = JSON.parse(interceptedBody) as JsonObject;
    assert.equal(Array.isArray(parsed.tools), true);
    const wireTools = parsed.tools as JsonObject[];
    assert.equal(wireTools.length, 1);
    assert.equal(wireTools.some((t) => t.type === "web_search"), false);
    assert.equal(wireTools[0]!.name, "lookup_item");

    const summary = summarizeRequest(parsed, Buffer.byteLength(interceptedBody, "utf8"));
    assert.equal(summary.toolsCount, 1);
    assert.equal(summary.toolsSha, sha256Hex8(parsed.tools));
    assert.equal(forwarded.declaration.count, 1);
    assert.equal(forwarded.declaration.names.has("lookup_item"), true);
    assert.equal(forwarded.declaration.names.has("web_search"), false);
  });

  it("derives the streaming Accept header from stream:true on the final wire", async () => {
    let upstreamCalls = 0;
    let interceptedAccept: string | undefined;
    const forwarded = await forwardOllamaResponses({
      payload: {
        model: "ollama/deepseek-v4-flash:0731-cloud",
        stream: true,
      },
      fetchImpl: async (_url, init) => {
        upstreamCalls += 1;
        interceptedAccept = init.headers.accept;
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    assert.equal(isOllamaReject(forwarded), false);
    if (isOllamaReject(forwarded)) return;
    assert.equal(upstreamCalls, 1);
    assert.equal(forwarded.stream, true);
    assert.equal(interceptedAccept, "text/event-stream");
  });
});
