import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertValidOllamaFollowUpInput,
  buildOllamaSummarizerPayload,
  classifyCompactionTrigger,
  COB_OLLAMA_COMPACT_INSTRUCTIONS,
  extractOllamaCompactSummary,
  findCompactionInputItem,
  nativeCompactRequest,
  nativeCompactionResponseError,
  ollamaFollowUpInputError,
  ollamaSummaryHandoffItem,
  projectNativeCompactInput,
  projectOllamaInputValue,
  projectOllamaSummarizerHistory,
  resolveCompactPlan,
  resolveNativeCompactModel,
  unsupportedOllamaCompactMediaError,
} from "./compaction.js";
import type { JsonObject } from "./types.js";

const native = new Set(["codex-mini", "o3"]);

describe("compaction plan", () => {
  it("passes native thread compact through unchanged", () => {
    const plan = resolveCompactPlan({
      threadModel: "o3",
      target: "native",
      policy: { provider: "native" },
      nativeSlugs: native,
    });
    assert.equal(plan.kind, "passthrough-native");
  });

  it("summarizes Ollama threads by default and keeps native GPT passthrough", () => {
    const plan = resolveCompactPlan({
      threadModel: "ollama/deepseek-v4-flash:cloud",
      target: "ollama",
      policy: { provider: "native" },
      nativeSlugs: new Set(),
    });
    assert.deepEqual(plan, {
      kind: "summarize-ollama",
      compactModel: "ollama/deepseek-v4-flash:cloud",
    });
    assert.equal(
      resolveCompactPlan({
        threadModel: "ollama/deepseek-v4-flash:cloud",
        target: "ollama",
        policy: { provider: "native", ollamaModel: "ollama/deepseek-v4-flash:0731-cloud" },
        nativeSlugs: native,
      }).kind,
      "summarize-ollama",
    );
  });

  it("does not reuse compaction.model as the Ollama summarizer", () => {
    const plan = resolveCompactPlan({
      threadModel: "ollama/deepseek-v4-flash:cloud",
      target: "ollama",
      policy: { provider: "native", model: "codex-mini" },
      nativeSlugs: native,
    });
    assert.deepEqual(plan, {
      kind: "summarize-ollama",
      compactModel: "ollama/deepseek-v4-flash:cloud",
    });
  });

  it("errors when native-for-ollama has no catalogued native compactor", () => {
    const plan = resolveCompactPlan({
      threadModel: "ollama/deepseek-v4-flash:cloud",
      target: "ollama",
      policy: { provider: "native", ollamaThreads: "native" },
      nativeSlugs: new Set(),
    });
    assert.equal(plan.kind, "error");
    if (plan.kind === "error") assert.equal(plan.code, "compaction_model_unavailable");
  });

  it("selects a catalogued native compactor, not a gpt-* hardcode", () => {
    assert.equal(resolveNativeCompactModel(undefined, native), "codex-mini");
    assert.equal(
      resolveNativeCompactModel(undefined, new Set(["gpt-5.6-sol", "gpt-5.6-luna"])),
      "gpt-5.6-luna",
    );
    assert.equal(resolveNativeCompactModel("o3", native), "o3");
    assert.equal(resolveNativeCompactModel("missing", native), undefined);
    const plan = resolveCompactPlan({
      threadModel: "ollama/deepseek-v4-flash:cloud",
      target: "ollama",
      policy: { provider: "native", ollamaThreads: "native" },
      nativeSlugs: native,
    });
    assert.deepEqual(plan, { kind: "native-for-ollama", compactModel: "codex-mini" });
  });

  it("strips previous_response_id on Ollama-thread compact requests", () => {
    const rewritten = nativeCompactRequest(
      { model: "ollama/deepseek-v4-flash:cloud", previous_response_id: "resp_123", input: [] },
      "codex-mini",
    );
    assert.equal(rewritten.model, "codex-mini");
    assert.equal("previous_response_id" in rewritten, false);
    assert.equal(rewritten.store, false);
  });
});

describe("compaction v2", () => {
  it("requires exactly one terminal trigger and keeps it transient", () => {
    assert.deepEqual(classifyCompactionTrigger({ input: [{ type: "message" }] }), { kind: "none" });
    assert.deepEqual(
      classifyCompactionTrigger({ input: [{ type: "message" }, { type: "compaction_trigger" }] }),
      { kind: "trigger", inputWithoutTrigger: [{ type: "message" }] },
    );
    assert.equal(
      classifyCompactionTrigger({ input: [{ type: "compaction_trigger" }, { type: "message" }] }).kind,
      "error",
    );
    assert.equal(
      classifyCompactionTrigger({ input: [{ type: "compaction_trigger" }, { type: "compaction_trigger" }] }).kind,
      "error",
    );
  });

  it("validates an opaque native compaction response without decrypting it", () => {
    const valid = {
      id: "compact-1",
      object: "response",
      status: "completed",
      output: [{ type: "compaction", id: "item-1", encrypted_content: "opaque-native-state" }],
    };
    assert.equal(nativeCompactionResponseError(valid), undefined);
    assert.match(
      nativeCompactionResponseError({ ...valid, output: [] }) ?? "",
      /exactly one compaction/,
    );
    assert.match(
      nativeCompactionResponseError({ ...valid, output: [{ type: "compaction" }] }) ?? "",
      /encrypted_content/,
    );
  });

  it("resolves compaction input separately instead of rewriting it", () => {
    const payload = {
      input: [
        { type: "compaction", id: "item-1", encrypted_content: "opaque-native-state" },
        { type: "function_call_output", call_id: "c1", output: "ok" },
      ],
    };
    assert.equal(findCompactionInputItem(payload)?.id, "item-1");
    const projected = projectOllamaInputValue(payload.input);
    assert.equal(JSON.stringify(projected).includes("opaque-native-state"), false);
    assert.match(ollamaFollowUpInputError(projected) ?? "", /compaction/);
    assert.throws(() => assertValidOllamaFollowUpInput(projected), /compaction/);
  });

  it("keeps input shape safe while preserving tool payload fields", () => {
    const input = projectOllamaInputValue([
      { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] },
      { type: "function_call", arguments: JSON.stringify({ model: "keep-me" }) },
    ]);
    assertValidOllamaFollowUpInput(input);
    const values = input as { type: string; content?: { type: string }[]; arguments?: string }[];
    assert.equal(values[0]?.content?.[0]?.type, "input_text");
    assert.equal(values[1]?.arguments, JSON.stringify({ model: "keep-me" }));
  });

  it("restores assistant output_text for native compact without touching user input_text", () => {
    const projected = projectOllamaInputValue([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello" }] },
    ]);
    const native = projectNativeCompactInput(projected) as {
      role?: string;
      content?: { type: string; text: string }[];
    }[];
    assert.equal(native[0]?.role, "user");
    assert.equal(native[0]?.content?.[0]?.type, "input_text");
    assert.equal(native[1]?.role, "assistant");
    assert.equal(native[1]?.content?.[0]?.type, "output_text");
    assert.equal(native[1]?.content?.[0]?.text, "hello");
    assert.equal(JSON.stringify(native).includes("encrypted_content"), false);
    assertValidOllamaFollowUpInput(projected);
  });

  it("strips stored item ids and drops id-only reasoning on native compact input", () => {
    const native = projectNativeCompactInput([
      { type: "message", id: "msg_user", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "reasoning", id: "rs_859731" },
      { type: "item_reference", id: "rs_859731" },
      {
        type: "reasoning",
        id: "rs_keep",
        summary: [{ type: "summary_text", text: "thought" }],
      },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "shell",
        arguments: "{}",
      },
      {
        type: "message",
        id: "msg_assistant",
        role: "assistant",
        content: [{ type: "input_text", text: "hello" }],
      },
    ]) as JsonObject[];
    assert.equal(native.length, 4);
    assert.equal(native[0]?.id, undefined);
    assert.equal(native[0]?.role, "user");
    assert.equal(native[1]?.type, "reasoning");
    assert.equal(native[1]?.id, undefined);
    assert.equal((native[1]?.summary as JsonObject[])?.[0]?.text, "thought");
    assert.equal(native[2]?.type, "function_call");
    assert.equal(native[2]?.id, undefined);
    assert.equal(native[2]?.call_id, "call_1");
    assert.equal(native[3]?.role, "assistant");
    assert.equal((native[3]?.content as JsonObject[])?.[0]?.type, "output_text");
    assert.equal(JSON.stringify(native).includes("rs_859731"), false);
  });

  it("rejects output_text and output-only status on Ollama follow-up input", () => {
    assert.match(
      ollamaFollowUpInputError({
        type: "message",
        role: "developer",
        content: [{ type: "output_text", text: "nope" }],
      }) ?? "",
      /output_text/,
    );
    assert.match(
      ollamaFollowUpInputError({
        type: "message",
        role: "developer",
        status: "completed",
        content: [{ type: "input_text", text: "nope" }],
      }) ?? "",
      /status/,
    );
    assert.match(
      ollamaFollowUpInputError({
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "ok" }],
        nested: { encrypted_content: "gAAAAA" },
      }) ?? "",
      /encrypted_content/,
    );
  });

  it("builds an allowlisted Ollama summarizer request without tools or the trigger", () => {
    const payload = buildOllamaSummarizerPayload({
      compactModel: "ollama/deepseek-v4-flash:cloud",
      history: [{ type: "message", role: "user", content: [{ type: "input_text", text: "task" }] }],
    });
    assert.equal(payload.model, "ollama/deepseek-v4-flash:cloud");
    assert.equal(payload.stream, false);
    assert.equal(payload.store, false);
    assert.equal(payload.tools, undefined);
    assert.equal(JSON.stringify(payload).includes("compaction_trigger"), false);
    assert.match(JSON.stringify(payload.input), /task/);
    assert.match(String(payload.instructions), /handoff/);
    const first = (payload.input as { role?: string; content?: { text?: string }[] }[])[0];
    assert.equal(first?.role, "developer");
    assert.equal(first?.content?.[0]?.text, COB_OLLAMA_COMPACT_INSTRUCTIONS);
    const handoff = ollamaSummaryHandoffItem("keep going");
    assertValidOllamaFollowUpInput(handoff);
    assert.equal(handoff.role, "assistant");
    const handoffContent = handoff.content as { type?: string }[];
    assert.equal(handoffContent[0]?.type, "input_text");
  });

  it("extracts a completed Ollama summary and fails closed on empty, truncated, or tool output", () => {
    assert.deepEqual(
      extractOllamaCompactSummary({
        id: "sum-1",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "  later  " }] }],
      }),
      { kind: "ok", text: "later" },
    );
    assert.deepEqual(
      extractOllamaCompactSummary({
        status: "completed",
        output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "handoff from thought" }] }],
      }),
      { kind: "ok", text: "handoff from thought" },
    );
    assert.equal(extractOllamaCompactSummary({ status: "completed", output: [] }).kind, "error");
    assert.equal(
      extractOllamaCompactSummary({
        status: "incomplete",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "cut" }] }],
      }).kind,
      "error",
    );
    assert.equal(
      extractOllamaCompactSummary({
        status: "completed",
        output: [{ type: "function_call", name: "shell", arguments: "{}" }],
      }).kind,
      "error",
    );
  });

  it("fails closed on unsupported multimodal compact history", () => {
    assert.match(
      unsupportedOllamaCompactMediaError([
        { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,xx" }] },
      ]) ?? "",
      /input_image/,
    );
    assert.equal(
      unsupportedOllamaCompactMediaError([
        { type: "message", role: "user", content: [{ type: "input_text", text: "ok" }] },
      ]),
      undefined,
    );
  });

  it("drops Codex pointer items and flattens Ollama-unknown types for the summarizer", () => {
    const projected = projectOllamaSummarizerHistory([
      { type: "message", role: "user", content: [{ type: "input_text", text: "task" }] },
      { type: "item_reference", id: "rs_1" },
      { type: "reasoning", id: "rs_empty" },
      { type: "reasoning", summary: [{ type: "summary_text", text: "thought" }] },
      { type: "web_search_call", id: "ws_1", status: "completed", query: "ollama compact" },
      { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
    ]) as { type?: string; role?: string; content?: { text?: string }[]; name?: string; summary?: unknown }[];
    assert.equal(
      projected.some((item) => item.type === "item_reference" || item.type === "web_search_call"),
      false,
    );
    assert.equal(projected[0]?.role, "user");
    assert.equal(projected[1]?.type, "reasoning");
    assert.match(JSON.stringify(projected), /compact item web_search_call/);
    assert.match(JSON.stringify(projected), /ollama compact/);
    assert.equal(projected.some((item) => item.type === "function_call" && item.name === "shell"), true);
    const payload = buildOllamaSummarizerPayload({
      compactModel: "ollama/x",
      history: [{ type: "item_reference", id: "rs_1" }, { type: "web_search_call", status: "completed" }],
    });
    assert.equal(JSON.stringify(payload.input).includes('"type":"item_reference"'), false);
    assert.equal(JSON.stringify(payload.input).includes('"type":"web_search_call"'), false);
  });
});
