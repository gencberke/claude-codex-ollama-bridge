import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import {
  APPLY_PATCH_TOOL_NAME,
  COB_APPLY_PATCH_ALIAS,
  prepareApplyPatchToOllama,
  validateApplyPatchPayload,
  type ApplyPatchBridge,
} from "./codex/experimental/apply-patch.js";
import {
  declareOllamaWireTools,
  formatOllamaGuardLog,
  guardOllamaJsonResponse,
  ollamaGuardHttpBody,
  type OllamaResponseGuardState,
} from "./codex/ollama-response-boundary.js";
import { normalizeOllamaResponse, ollamaSseTransform } from "./codex/ollama.js";
import type { JsonObject } from "./core/json.js";

const PATCH_GRAMMAR = "start: /[^\\n]*/";

function customPatchTool(overrides: JsonObject = {}): JsonObject {
  return {
    type: "custom",
    name: APPLY_PATCH_TOOL_NAME,
    format: { type: "grammar", syntax: "lark", definition: PATCH_GRAMMAR },
    ...overrides,
  };
}

function patchPayload(overrides: JsonObject = {}): JsonObject {
  return {
    model: "ollama/deepseek-v4-flash:0731-cloud",
    tools: [customPatchTool()],
    input: "Apply the requested change.",
    ...overrides,
  };
}

function patchCall(input = "*** Begin Patch\n*** End Patch\n"): JsonObject {
  return {
    type: "custom_tool_call",
    id: "item_1",
    call_id: "call_1",
    name: APPLY_PATCH_TOOL_NAME,
    input,
  };
}

function patchOutput(): JsonObject {
  return {
    type: "custom_tool_call_output",
    call_id: "call_1",
    output: "Applied",
  };
}

function applyPatchBridge(payload = patchPayload()): ApplyPatchBridge {
  const result = prepareApplyPatchToOllama(payload, { enabled: true });
  assert.equal("status" in result, false);
  if ("status" in result) throw new Error("expected apply_patch bridge");
  return result.bridge;
}

async function collectTransform(raw: string, transform: NodeJS.ReadWriteStream): Promise<string> {
  const chunks: Buffer[] = [];
  const sink = new (await import("node:stream")).Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  await new Promise<void>((resolve, reject) => {
    sink.once("finish", resolve);
    sink.once("error", reject);
    Readable.from([Buffer.from(raw)]).pipe(transform).pipe(sink);
  });
  return Buffer.concat(chunks).toString("utf8");
}

describe("Gate 5 apply_patch wire bridge", () => {
  it("is default-off and keeps explicit false fail-closed", () => {
    for (const policy of [undefined, { enabled: false }]) {
      const payload = patchPayload();
      const rejection = validateApplyPatchPayload(payload, policy);
      assert.equal(rejection?.body.error.code, "ollama_custom_tool_unsupported");
      assert.equal((payload.tools as JsonObject[])[0]?.type, "custom");
    }
  });

  it("accepts only the exact top-level grammar tool and emits one function alias", () => {
    const payload = patchPayload({ input: [patchCall(), patchOutput()] });
    const result = prepareApplyPatchToOllama(payload, { enabled: true });
    assert.equal("status" in result, false);
    if ("status" in result) return;
    assert.deepEqual(payload.tools, [{
      type: "function",
      name: COB_APPLY_PATCH_ALIAS,
      parameters: {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
        additionalProperties: false,
      },
    }]);
    assert.deepEqual((payload.input as JsonObject[])[0], {
      type: "function_call",
      id: "item_1",
      call_id: "call_1",
      name: COB_APPLY_PATCH_ALIAS,
      arguments: JSON.stringify({ input: "*** Begin Patch\n*** End Patch\n" }),
    });
    assert.deepEqual((payload.input as JsonObject[])[1], {
      type: "function_call_output",
      call_id: "call_1",
      output: "Applied",
    });
    assert.equal(result.bridge.declared, true);
  });

  it("rejects nested, duplicate, malformed, unknown, encrypted, and colliding definitions", () => {
    const cases: Array<{ payload: JsonObject; code: string }> = [
      {
        payload: patchPayload({ tools: [{ type: "namespace", name: "ns", tools: [customPatchTool()] }] }),
        code: "apply_patch_tool_invalid",
      },
      {
        payload: patchPayload({ tools: [customPatchTool(), customPatchTool()] }),
        code: "apply_patch_tool_invalid",
      },
      {
        payload: patchPayload({ tools: [customPatchTool({ format: { type: "text" } })] }),
        code: "apply_patch_tool_invalid",
      },
      {
        payload: patchPayload({ tools: [customPatchTool({ format: { type: "grammar", syntax: "lark", definition: "x", extra: "no" } })] }),
        code: "apply_patch_tool_invalid",
      },
      {
        payload: patchPayload({ tools: [{ type: "custom", name: "other", format: { type: "grammar", syntax: "lark", definition: "x" } }] }),
        code: "apply_patch_tool_invalid",
      },
      {
        payload: patchPayload({ tools: [customPatchTool(), { type: "function", name: COB_APPLY_PATCH_ALIAS }] }),
        code: "apply_patch_alias_collision",
      },
      {
        payload: patchPayload({ tools: [customPatchTool(), { type: "function", name: ` ${COB_APPLY_PATCH_ALIAS} ` }] }),
        code: "apply_patch_alias_collision",
      },
      {
        payload: patchPayload({ tools: [customPatchTool({ format: { type: "grammar", syntax: "lark", definition: "x", encrypted: true } })] }),
        code: "apply_patch_tool_invalid",
      },
    ];
    for (const entry of cases) {
      const rejection = validateApplyPatchPayload(entry.payload, true);
      assert.equal(rejection?.body.error.code, entry.code, entry.code);
    }
  });

  it("requires a string native input and rejects encrypted/unknown custom history", () => {
    for (const item of [
      { ...patchCall(), input: 1 },
      { ...patchCall(), input: { patch: "*** Begin Patch" } },
      { ...patchCall(), encrypted_content: "cipher" },
      { ...patchCall(), name: "other" },
      { ...patchOutput(), output: { encrypted_content: "cipher" } },
    ]) {
      const rejection = validateApplyPatchPayload(patchPayload({ input: [item] }), true);
      assert.ok(rejection);
      assert.equal(JSON.stringify(rejection).includes("cipher"), false);
      assert.equal(JSON.stringify(rejection).includes("*** Begin"), false);
    }
  });

  it("accepts and strips the exact Codex 0.149 internal history metadata", () => {
    const payload = patchPayload({
      input: [
        {
          ...patchCall(),
          internal_chat_message_metadata_passthrough: { turn_id: "turn_1" },
        },
        {
          ...patchOutput(),
          internal_chat_message_metadata_passthrough: { turn_id: "turn_1", create_time: 1.25 },
        },
      ],
    });
    const result = prepareApplyPatchToOllama(payload, true);
    assert.equal("status" in result, false);
    if ("status" in result) return;
    const input = payload.input as JsonObject[];
    assert.ok(input[0]);
    assert.ok(input[1]);
    assert.equal("internal_chat_message_metadata_passthrough" in input[0], false);
    assert.equal("internal_chat_message_metadata_passthrough" in input[1], false);

    const malformed = patchPayload({
      input: [{ ...patchCall(), internal_chat_message_metadata_passthrough: { turn_id: "turn_1", extra: "no" } }],
    });
    assert.equal(validateApplyPatchPayload(malformed, true)?.body.error.code, "apply_patch_input_invalid");
  });

  it("accepts only validated alias history from a resolved provider checkpoint", () => {
    const aliasArgs = JSON.stringify({ input: "*** Begin Patch\n*** End Patch\n" });
    const payload = patchPayload({
      input: [
        {
          type: "function_call",
          id: "item_1",
          call_id: "call_1",
          name: COB_APPLY_PATCH_ALIAS,
          arguments: aliasArgs,
        },
        patchOutput(),
      ],
    });
    assert.equal(validateApplyPatchPayload(payload, true)?.body.error.code, "apply_patch_alias_collision");
    const result = prepareApplyPatchToOllama(payload, true, { allowTrustedAliasHistory: true });
    assert.equal("status" in result, false);
    if ("status" in result) return;
    assert.equal((payload.input as JsonObject[])[0]?.name, COB_APPLY_PATCH_ALIAS);
    assert.equal((payload.input as JsonObject[])[1]?.type, "function_call_output");

    const malformed = patchPayload({
      input: [{
        type: "function_call",
        call_id: "call_1",
        name: COB_APPLY_PATCH_ALIAS,
        arguments: "not-json",
      }],
    });
    assert.equal(
      validateApplyPatchPayload(malformed, true, { allowTrustedAliasHistory: true })?.body.error.code,
      "apply_patch_alias_history_invalid",
    );
  });

  it("restores an Ollama JSON alias call to Codex custom_tool_call", () => {
    const payload = patchPayload();
    const bridge = applyPatchBridge(payload);
    const declaration = declareOllamaWireTools(payload, bridge);
    const response = {
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [{
        type: "function_call",
        id: "item_1",
        call_id: "call_1",
        name: COB_APPLY_PATCH_ALIAS,
        arguments: JSON.stringify({ input: "*** Begin Patch\n*** End Patch\n" }),
      }],
    };
    assert.equal(guardOllamaJsonResponse(response, declaration), undefined);
    const normalized = normalizeOllamaResponse(response, "ollama/deepseek-v4-flash:0731-cloud", undefined, bridge) as JsonObject;
    assert.deepEqual((normalized.output as JsonObject[])[0], {
      type: "custom_tool_call",
      id: "item_1",
      call_id: "call_1",
      name: APPLY_PATCH_TOOL_NAME,
      input: "*** Begin Patch\n*** End Patch\n",
    });
    assert.equal(JSON.stringify(normalized).includes(COB_APPLY_PATCH_ALIAS), false);
  });

  it("rejects JSON alias calls that share a call_id with different item ids before normalize", () => {
    const args = JSON.stringify({ input: "*** Begin Patch\n*** End Patch\n" });
    const payload = patchPayload();
    const bridge = applyPatchBridge(payload);
    const declaration = declareOllamaWireTools(payload, bridge);
    const response = {
      id: "resp_conflict",
      output: [
        { type: "function_call", id: "item_a", call_id: "shared", name: COB_APPLY_PATCH_ALIAS, arguments: args },
        { type: "function_call", id: "item_b", call_id: "shared", name: COB_APPLY_PATCH_ALIAS, arguments: args },
      ],
    };
    const failure = guardOllamaJsonResponse(response, declaration);
    assert.equal(failure?.code, "ollama_tool_call_invalid");
    assert.equal(JSON.stringify(ollamaGuardHttpBody(failure!)).includes(COB_APPLY_PATCH_ALIAS), false);
    assert.equal(JSON.stringify(ollamaGuardHttpBody(failure!)).includes("shared"), false);
  });

  it("buffers Ollama function argument deltas and emits native custom SSE items", async () => {
    const payload = patchPayload();
    const bridge = applyPatchBridge(payload);
    const declaration = declareOllamaWireTools(payload, bridge);
    const args = JSON.stringify({ input: "*** Begin Patch\n*** End Patch\n" });
    const raw = [
      `data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "item_1", call_id: "call_1", name: COB_APPLY_PATCH_ALIAS, arguments: "" } })}`,
      `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "item_1", output_index: 0, sequence_number: 12, delta: args.slice(0, 14) })}`,
      `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "item_1", output_index: 0, sequence_number: 13, delta: args.slice(14) })}`,
      `data: ${JSON.stringify({ type: "response.function_call_arguments.done", item_id: "item_1", output_index: 0, sequence_number: 14, arguments: args })}`,
      `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", id: "item_1", call_id: "call_1", name: COB_APPLY_PATCH_ALIAS, arguments: args } })}`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [{ type: "function_call", id: "item_1", call_id: "call_1", name: COB_APPLY_PATCH_ALIAS, arguments: args }] } })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    const guard: OllamaResponseGuardState = {};
    const text = await collectTransform(raw, ollamaSseTransform("ollama/m", undefined, undefined, declaration, guard));
    assert.equal(guard.failure, undefined);
    assert.equal(text.includes(COB_APPLY_PATCH_ALIAS), false);
    assert.equal(text.includes("response.function_call_arguments.delta"), false);
    assert.equal(text.includes("response.function_call_arguments.done"), false);
    assert.match(text, /custom_tool_call/);
    assert.match(text, /response.completed/);
    assert.match(text, /data: \[DONE\]/);
  });

  it("passes ordinary function argument deltas and done events while patch is active", async () => {
    const payload = patchPayload({ tools: [customPatchTool(), { type: "function", name: "exec_command" }] });
    const bridge = applyPatchBridge(payload);
    const declaration = declareOllamaWireTools(payload, bridge);
    const patchArgs = JSON.stringify({ input: "*** Begin Patch\n*** End Patch\n" });
    const ordinaryArgs = JSON.stringify({ command: "ls" });
    const raw = [
      `data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "patch_item", call_id: "patch_call", name: COB_APPLY_PATCH_ALIAS, arguments: "" } })}`,
      `data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "exec_item", call_id: "exec_call", name: "exec_command", arguments: "" } })}`,
      `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "exec_item", call_id: "exec_call", delta: ordinaryArgs })}`,
      `data: ${JSON.stringify({ type: "response.function_call_arguments.done", item_id: "exec_item", call_id: "exec_call", arguments: ordinaryArgs })}`,
      `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "patch_item", call_id: "patch_call", delta: patchArgs })}`,
      `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", id: "patch_item", call_id: "patch_call", name: COB_APPLY_PATCH_ALIAS, arguments: patchArgs } })}`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [{ type: "function_call", id: "patch_item", call_id: "patch_call", name: COB_APPLY_PATCH_ALIAS, arguments: patchArgs }, { type: "function_call", id: "exec_item", call_id: "exec_call", name: "exec_command", arguments: ordinaryArgs }] } })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    const guard: OllamaResponseGuardState = {};
    const text = await collectTransform(raw, ollamaSseTransform("ollama/m", undefined, undefined, declaration, guard));
    assert.equal(guard.failure, undefined);
    assert.match(text, /response\.function_call_arguments\.delta/);
    assert.match(text, /response\.function_call_arguments\.done/);
    assert.equal(text.includes(COB_APPLY_PATCH_ALIAS), false);
  });

  it("redacts alias/name/body details from Gate 5 guard errors", () => {
    const payload = patchPayload();
    const bridge = applyPatchBridge(payload);
    const declaration = declareOllamaWireTools(payload, bridge);
    const response = {
      id: "resp_secret",
      output: [{ type: "function_call", name: COB_APPLY_PATCH_ALIAS, call_id: "call_secret", arguments: "not-json-SECRET_HEREDOC" }],
    };
    const failure = guardOllamaJsonResponse(response, declaration);
    assert.ok(failure);
    const body = ollamaGuardHttpBody(failure);
    const log = formatOllamaGuardLog(failure, declaration);
    assert.equal(JSON.stringify(body).includes(COB_APPLY_PATCH_ALIAS), false);
    assert.equal(JSON.stringify(body).includes("SECRET_HEREDOC"), false);
    assert.equal(log.includes(COB_APPLY_PATCH_ALIAS), false);
    assert.equal(log.includes("call_secret"), false);
  });

  it("keeps an undeclared alias on the existing 502 guard path when disabled", () => {
    const declaration = declareOllamaWireTools({ tools: [{ type: "function", name: "exec_command" }] });
    const failure = guardOllamaJsonResponse({ output: [{ type: "function_call", name: APPLY_PATCH_TOOL_NAME }] }, declaration);
    assert.equal(failure?.code, "ollama_undeclared_tool_call");
  });
});
