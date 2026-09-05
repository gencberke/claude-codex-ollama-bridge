import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import {
  isOllamaReject,
  normalizeOllamaResponse,
  ollamaSseTransform,
  prepareOllamaWire,
} from "./codex/ollama.js";
import {
  collectOllamaWireToolNames,
  createOllamaTerminalTrack,
  declareOllamaWireTools,
  emptyOllamaToolDeclaration,
  formatOllamaGuardLog,
  guardOllamaJsonResponse,
  inspectOllamaSseEvent,
  ollamaGuardFailedEvent,
  ollamaGuardHttpBody,
  ollamaGuardMessage,
  ollamaGuardSseTerminal,
  ollamaNonSuccessCode,
  observeOllamaSseFrame,
  sanitizeOllamaNonSuccessTerminal,
  type OllamaResponseGuardState,
  type OllamaToolDeclaration,
  readOllamaNonSuccessReason,
  readOllamaPreservedErrorCode,
} from "./codex/ollama-response-boundary.js";
import { PROMOTED_LEAF_CAP } from "./codex/tool-search.js";
import type { JsonObject } from "./core/json.js";

function declarationOf(tools: unknown): OllamaToolDeclaration {
  return declareOllamaWireTools({ tools });
}

function functionCall(name: unknown, extra: JsonObject = {}): JsonObject {
  return { type: "function_call", name, call_id: "c1", arguments: "{}", ...extra };
}

function jsonResponse(output: unknown[]): JsonObject {
  return {
    id: "resp_1",
    object: "response",
    status: "completed",
    model: "deepseek-v4-flash:0731-cloud",
    output,
  };
}

function wireDeclaration(payload: JsonObject): OllamaToolDeclaration {
  const wire = prepareOllamaWire(payload);
  assert.equal(isOllamaReject(wire), false);
  if (isOllamaReject(wire)) throw new Error("expected wire");
  return wire.declaration;
}

async function collectTransform(raw: string, transform: import("node:stream").Transform): Promise<string> {
  const chunks: Buffer[] = [];
  transform.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  await new Promise<void>((resolve, reject) => {
    transform.once("error", reject);
    transform.once("end", resolve);
    Readable.from([Buffer.from(raw, "utf8")]).pipe(transform);
  });
  return Buffer.concat(chunks).toString("utf8");
}

describe("Ollama final tool declaration", () => {
  it("declares only names present on the final outbound tools[]", () => {
    const declaration = declarationOf([
      { type: "function", name: "exec_command" },
      { type: "namespace", name: "ignored", tools: [{ type: "function", name: "nested" }] },
      { type: "function", function: { name: "apply_patch" } },
    ]);
    assert.deepEqual([...declaration.names], ["exec_command", "ignored.nested", "apply_patch"]);
    assert.equal(declaration.count, 3);
    assert.equal(declaration.sha8.length, 8);
    assert.equal(collectOllamaWireToolNames("not-an-array").length, 0);
  });

  it("matches Ollama's recursive dot qualification for namespace tools", () => {
    const declaration = declarationOf([
      {
        type: "namespace",
        name: "mcp__codex_apps__github",
        tools: [{ type: "function", name: "_get_repo" }],
      },
      {
        type: "namespace",
        name: "outer",
        tools: [
          {
            type: "namespace",
            name: "inner",
            tools: [
              { type: "function", name: "leaf" },
              { type: "function", name: "inner.prequalified" },
            ],
          },
        ],
      },
    ]);
    assert.deepEqual(
      [...declaration.names],
      [
        "mcp__codex_apps__github._get_repo",
        "outer.inner.leaf",
        "outer.inner.prequalified",
      ],
    );
    assert.equal(
      guardOllamaJsonResponse(
        jsonResponse([functionCall("mcp__codex_apps__github._get_repo")]),
        declaration,
      ),
      undefined,
    );
    assert.equal(
      guardOllamaJsonResponse(jsonResponse([functionCall("_get_repo")]), declaration)?.code,
      "ollama_undeclared_tool_call",
    );
  });

  it("guards the Ollama-qualified name and restores the Codex namespace identity", () => {
    const wire = prepareOllamaWire({
      model: "ollama/deepseek-v4-flash:0731-cloud",
      tools: [
        {
          type: "namespace",
          name: "mcp__codex_apps__github",
          tools: [
            {
              type: "function",
              name: "_get_repo",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
      ],
      input: "inspect",
    });
    assert.equal(isOllamaReject(wire), false);
    if (isOllamaReject(wire)) throw new Error("expected wire");
    const response = jsonResponse([
      functionCall("mcp__codex_apps__github._get_repo", { arguments: "{}" }),
    ]);
    assert.equal(guardOllamaJsonResponse(response, wire.declaration), undefined);
    const restored = normalizeOllamaResponse(
      response,
      "ollama/deepseek-v4-flash:0731-cloud",
      wire.bridge,
    ) as JsonObject;
    assert.deepEqual(restored.output, [
      {
        type: "function_call",
        name: "_get_repo",
        namespace: "mcp__codex_apps__github",
        call_id: "c1",
        arguments: "{}",
      },
    ]);
  });

  it("authorizes no client-executed call when the outbound catalog is empty", () => {
    const empty = emptyOllamaToolDeclaration();
    assert.equal(empty.count, 0);
    assert.equal(empty.names.size, 0);
    const failure = guardOllamaJsonResponse(jsonResponse([functionCall("exec_command")]), empty);
    assert.equal(failure?.code, "ollama_undeclared_tool_call");
  });

  it("declares converted tool_search and promoted aliases, not skipped leaves", () => {
    const leaves = Array.from({ length: PROMOTED_LEAF_CAP + 1 }, (_, index) => ({
      type: "function",
      name: `leaf_${index}`,
      parameters: { type: "object", properties: {} },
    }));
    const declaration = wireDeclaration({
      model: "ollama/m",
      tools: [{ type: "tool_search", description: "Find tools." }],
      input: [
        { type: "tool_search_call", call_id: "s1", execution: "client", arguments: { query: "leaf" } },
        {
          type: "tool_search_output",
          call_id: "s1",
          status: "completed",
          execution: "client",
          tools: leaves,
        },
      ],
    });
    assert.equal(declaration.names.has("tool_search"), true);
    assert.equal(declaration.names.has("leaf_0"), true);
    assert.equal(declaration.names.has(`leaf_${PROMOTED_LEAF_CAP}`), false);
    assert.equal(declaration.count, PROMOTED_LEAF_CAP + 1);
  });

  it("does not declare an inbound name removed by collision or missing from the wire", () => {
    const declaration = wireDeclaration({
      model: "ollama/m",
      tools: [
        { type: "tool_search" },
        { type: "function", name: "multi_agent_v1__spawn_agent", parameters: { type: "object", properties: {} } },
      ],
      input: [
        { type: "tool_search_call", call_id: "s1", execution: "client", arguments: { query: "spawn" } },
        {
          type: "tool_search_output",
          call_id: "s1",
          status: "completed",
          execution: "client",
          tools: [
            {
              type: "namespace",
              name: "multi_agent_v1",
              tools: [
                {
                  type: "function",
                  name: "spawn_agent",
                  parameters: { type: "object", properties: { task: { type: "string" } } },
                },
              ],
            },
          ],
        },
      ],
    });
    assert.equal(declaration.names.has("multi_agent_v1__spawn_agent"), true);
    assert.equal(declaration.names.has("spawn_agent"), false);
    assert.equal(
      guardOllamaJsonResponse(jsonResponse([functionCall("spawn_agent")]), declaration)?.code,
      "ollama_undeclared_tool_call",
    );
  });
});

describe("Ollama non-success terminals", () => {
  it("classifies failed, incomplete, and typed error terminals", () => {
    const cases = [
      [{ type: "response.failed", response: { status: "failed" } }, "failed"],
      [{ type: "response.incomplete", response: { status: "incomplete" } }, "incomplete"],
      [{ type: "error", error: { message: "SECRET_PROVIDER_ERROR" } }, "error"],
    ] as const;
    for (const [frame, expected] of cases) {
      const track = createOllamaTerminalTrack();
      assert.equal(observeOllamaSseFrame(track, frame), "withhold");
      assert.equal(track.phase, "held-non-success");
      assert.equal(track.nonSuccessKind, expected);
    }
  });

  it("replaces provider error detail with a cob-owned terminal error", () => {
    const terminal = sanitizeOllamaNonSuccessTerminal(
      { type: "error", error: { code: "SECRET_CODE", message: "SECRET_PROVIDER_ERROR" } },
      "error",
    );
    assert.deepEqual(terminal, {
      type: "error",
      error: {
        type: "server_error",
        code: ollamaNonSuccessCode("error"),
        message: "Ollama response failed; retry or resend the full context.",
      },
    });
    assert.equal(JSON.stringify(terminal).includes("SECRET"), false);
  });
});

describe("Ollama non-success reason", () => {
  it("reads only a closed vocabulary and never carries provider text", () => {
    assert.equal(
      readOllamaNonSuccessReason({ response: { incomplete_details: { reason: "max_output_tokens" } } }),
      "max_output_tokens",
    );
    // status_details is the alternate carrier; both resolve the same way.
    assert.equal(
      readOllamaNonSuccessReason({ response: { status_details: { reason: "content_filter" } } }),
      "content_filter",
    );
    // Anything unrecognized collapses to `other`, so an upstream string can
    // never reach a diagnostic, a log line, or a client.
    assert.equal(
      readOllamaNonSuccessReason({
        response: { incomplete_details: { reason: "upstream said: user prompt was rejected" } },
      }),
      "other",
    );
    assert.equal(readOllamaNonSuccessReason({ response: { status: "failed" } }), undefined);
    assert.equal(readOllamaNonSuccessReason({ response: { incomplete_details: { reason: 42 } } }), undefined);
  });
});

describe("Ollama provider error semantics", () => {
  it("preserves a supported provider code and drops everything else", () => {
    // Codex decides retryable-vs-fatal from this code. Collapsing a context or
    // quota failure into the generic code turns a fatal error into a retryable
    // one and can make the controller repeat work that cannot succeed.
    const context = { response: { error: { code: "context_length_exceeded", message: "raw upstream text" } } };
    assert.equal(readOllamaPreservedErrorCode(context), "context_length_exceeded");
    const sanitized = sanitizeOllamaNonSuccessTerminal(context, "failed");
    const error = (sanitized.response as { error: { code: string; message: string } }).error;
    assert.equal(error.code, "context_length_exceeded");
    assert.equal(error.message.includes("raw upstream text"), false, "provider text must never be relayed");

    // An unlisted code falls back to the generic cob-owned identifier.
    const unlisted = { response: { error: { code: "some_new_upstream_code" } } };
    assert.equal(readOllamaPreservedErrorCode(unlisted), undefined);
    const generic = sanitizeOllamaNonSuccessTerminal(unlisted, "failed");
    assert.equal((generic.response as { error: { code: string } }).error.code, "ollama_response_failed");
  });
});

describe("Ollama JSON response guard", () => {
  const declared = declarationOf([
    { type: "function", name: "exec_command" },
    { type: "function", name: "write_stdin" },
  ]);

  it("accepts a converted tool_search call only when that function reached the wire", () => {
    const withSearch = wireDeclaration({
      model: "ollama/m",
      tools: [{ type: "tool_search", description: "Find tools." }],
      input: "hi",
    });
    assert.equal(withSearch.names.has("tool_search"), true);
    assert.equal(
      guardOllamaJsonResponse(jsonResponse([functionCall("tool_search")]), withSearch),
      undefined,
    );
    const withoutSearch = wireDeclaration({
      model: "ollama/m",
      tools: [{ type: "function", name: "exec_command", parameters: { type: "object", properties: {} } }],
      input: "hi",
    });
    assert.equal(withoutSearch.names.has("tool_search"), false);
    assert.equal(
      guardOllamaJsonResponse(jsonResponse([functionCall("tool_search")]), withoutSearch)?.code,
      "ollama_undeclared_tool_call",
    );
  });

  it("accepts a declared function_call and a message-only response with or without usage", () => {
    assert.equal(
      guardOllamaJsonResponse(jsonResponse([functionCall("exec_command")]), declared),
      undefined,
    );
    assert.equal(
      guardOllamaJsonResponse(jsonResponse([functionCall("write_stdin")]), declared),
      undefined,
    );
    assert.equal(
      guardOllamaJsonResponse(
        { ...jsonResponse([{ type: "message", role: "assistant", content: "ok" }]), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        declared,
      ),
      undefined,
    );
    assert.equal(
      guardOllamaJsonResponse(jsonResponse([{ type: "message", role: "assistant", content: "ok" }]), declared),
      undefined,
    );
  });

  it("rejects undeclared, invalid, empty, and unreviewed client calls before any restore", () => {
    const cases: Array<{ output: unknown; code: string; kind: string }> = [
      { output: [functionCall("apply_patch")], code: "ollama_undeclared_tool_call", kind: "undeclared" },
      { output: [functionCall("")], code: "ollama_tool_call_invalid", kind: "empty_name" },
      { output: [functionCall("   ")], code: "ollama_tool_call_invalid", kind: "empty_name" },
      { output: [functionCall(1)], code: "ollama_tool_call_invalid", kind: "invalid_name" },
      { output: [{ type: "function_call", call_id: "c1" }], code: "ollama_tool_call_invalid", kind: "invalid_name" },
      { output: [{ type: "custom_tool_call", name: "exec_command" }], code: "ollama_tool_call_invalid", kind: "invalid_type" },
      { output: [{ type: "tool_search_call", name: "tool_search" }], code: "ollama_tool_call_invalid", kind: "invalid_type" },
      { output: [{ type: "local_shell_call", name: "exec_command" }], code: "ollama_tool_call_invalid", kind: "invalid_type" },
      { output: [{ type: "shell_call", name: "shell" }], code: "ollama_tool_call_invalid", kind: "invalid_type" },
    ];
    for (const entry of cases) {
      const failure = guardOllamaJsonResponse(jsonResponse(entry.output as unknown[]), declared);
      assert.equal(failure?.code, entry.code, JSON.stringify(entry));
      assert.equal(failure?.kind, entry.kind, JSON.stringify(entry));
    }
  });

  it("keeps function_call_output and ignores non-call items", () => {
    assert.equal(
      guardOllamaJsonResponse(
        jsonResponse([
          { type: "function_call_output", call_id: "c1", output: "ok" },
          { type: "message", role: "assistant", content: "done" },
        ]),
        declared,
      ),
      undefined,
    );
  });
});

describe("Ollama SSE response guard", () => {
  const declared = declarationOf([{ type: "function", name: "exec_command" }]);

  it("trips on added, done, and terminal snapshots, and stays sticky", () => {
    const undeclared = functionCall("apply_patch");
    assert.equal(
      inspectOllamaSseEvent({ type: "response.output_item.added", item: undeclared }, declared)?.code,
      "ollama_undeclared_tool_call",
    );
    assert.equal(
      inspectOllamaSseEvent({ type: "response.output_item.done", item: undeclared }, declared)?.code,
      "ollama_undeclared_tool_call",
    );
    assert.equal(
      inspectOllamaSseEvent(
        { type: "response.completed", response: jsonResponse([undeclared]) },
        declared,
      )?.code,
      "ollama_undeclared_tool_call",
    );
    assert.equal(
      inspectOllamaSseEvent(
        { type: "response.incomplete", response: jsonResponse([undeclared]) },
        declared,
      )?.code,
      "ollama_undeclared_tool_call",
    );
    assert.equal(inspectOllamaSseEvent({ type: "response.failed", response: { status: "failed" } }, declared), undefined);
    assert.equal(
      inspectOllamaSseEvent({ type: "response.output_text.delta", delta: "hi" }, declared),
      undefined,
    );
    assert.equal(
      inspectOllamaSseEvent({ type: "response.output_item.added", item: functionCall("exec_command") }, declared),
      undefined,
    );
  });

  it("does not let a later empty completed snapshot clear a rejection", async () => {
    const guard: OllamaResponseGuardState = {};
    const raw = [
      `data: ${JSON.stringify({ type: "response.output_item.added", item: functionCall("apply_patch") })}`,
      `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", delta: "secret-args" })}`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", object: "response", output: [] } })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n";
    const text = await collectTransform(
      raw,
      ollamaSseTransform("ollama/m", { suppressDone: true }, undefined, declared, guard),
    );
    assert.equal(guard.failure?.code, "ollama_undeclared_tool_call");
    assert.equal(text.includes("apply_patch"), false);
    assert.equal(text.includes("response.completed"), false);
    assert.equal(text.includes("secret-args"), false);
    assert.equal(text.includes("[DONE]"), false);
  });

  it("forwards a valid declared stream with identical bytes outside held terminal frames", async () => {
    const item = functionCall("exec_command");
    const prefix = [
      `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_1" } })}`,
      `data: ${JSON.stringify({ type: "response.output_item.added", item })}`,
    ].join("\n\n") + "\n\n";
    const raw = `${prefix}${[
      `data: ${JSON.stringify({ type: "response.completed", response: jsonResponse([item]) })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"}`;
    const guard: OllamaResponseGuardState = {};
    const guarded = await collectTransform(
      raw,
      ollamaSseTransform("ollama/m", undefined, undefined, declared, guard),
    );
    const baseline = await collectTransform(prefix, ollamaSseTransform("ollama/m"));
    assert.equal(guard.failure, undefined);
    // Ordinary pre-terminal frames keep their exact bytes.
    assert.equal(guarded.trimEnd(), baseline.trimEnd());
    // The one terminal and the upstream [DONE] are withheld; cob owns the
    // client-facing [DONE] after its checkpoint publishes.
    assert.equal(guarded.includes("response.completed"), false);
    assert.equal(guarded.includes("[DONE]"), false);
    assert.equal(guard.terminal?.phase, "held-completed");
    const held = guard.terminal?.heldTerminal;
    assert.ok(held);
    assert.deepEqual(normalizeOllamaResponse(held, "ollama/m", undefined, undefined), {
      type: "response.completed",
      response: { ...jsonResponse([item]), model: "ollama/m" },
    });
    assert.deepEqual(guard.terminal?.completedCandidate, jsonResponse([item]));
  });
});

describe("Ollama guard diagnostics", () => {
  it("keeps guard logs and client errors content-free", () => {
    const declared = declarationOf([{ type: "function", name: "exec_command" }]);
    const ugly = `apply_patch\nSECRET=token\r\n${"x".repeat(200)}`;
    const failure = guardOllamaJsonResponse(jsonResponse([functionCall(ugly)]), declared);
    assert.ok(failure);
    const log = formatOllamaGuardLog(failure, declared);
    const body = ollamaGuardHttpBody(failure);
    const event = ollamaGuardFailedEvent(failure);
    const sse = ollamaGuardSseTerminal(failure);
    assert.equal(log.includes(ugly), false);
    assert.equal(log.includes("SECRET=token"), false);
    assert.equal(log.includes("apply_patch"), false);
    assert.match(log, /code=ollama_undeclared_tool_call/);
    assert.match(log, /name_len=/);
    assert.match(log, /name_sha=/);
    assert.match(log, /declared_n=1/);
    assert.equal(isRecordError(body), true);
    assert.equal((body.error as JsonObject).type, "upstream_error");
    assert.equal((body.error as JsonObject).code, "ollama_undeclared_tool_call");
    assert.equal(String((body.error as JsonObject).message).includes("\n"), false);
    assert.ok(ollamaGuardMessage(failure).length > 0);
    assert.equal(event.type, "response.failed");
    assert.equal(sse.includes("data: [DONE]"), true);
    assert.equal([...sse.matchAll(/response\.failed/g)].length, 1);
    assert.equal([...sse.matchAll(/data: \[DONE\]/g)].length, 1);
  });
});

describe("Ollama tool-search argument guard", () => {
  const declared = declarationOf([{ type: "function", name: "tool_search" }]);

  it("rejects malformed, scalar, and array tool_search arguments fail-closed", () => {
    const rejected = ["not-json", "{", '"scalar"', "5", "12.5", "true", "null", "[1,2]", '{"query":"x"'];
    let last: ReturnType<typeof guardOllamaJsonResponse>;
    for (const args of rejected) {
      const failure = guardOllamaJsonResponse(
        jsonResponse([functionCall("tool_search", { arguments: args })]),
        declared,
      );
      assert.ok(failure, `expected a guard failure for argument shape`);
      assert.equal(failure.code, "ollama_tool_call_invalid");
      assert.equal((failure as { kind?: string }).kind, "invalid_arguments");
      last = failure;
    }
    const message = ollamaGuardMessage(last!);
    assert.equal(message.includes("query"), false);
    assert.equal(message.includes("scalar"), false);
    assert.equal(message, "Ollama returned a client tool call with malformed arguments.");
  });

  it("inspects tool_search arguments on SSE output items too", () => {
    const failure = inspectOllamaSseEvent(
      { type: "response.output_item.added", item: functionCall("tool_search", { arguments: "not-json" }) },
      declared,
    );
    assert.ok(failure);
    assert.equal(failure?.code, "ollama_tool_call_invalid");
    assert.equal((failure as { kind?: string }).kind, "invalid_arguments");
  });

  it("accepts absent, empty, object, and valid JSON object arguments", () => {
    const accepted: unknown[] = [undefined, "", "   ", "{}", "  {}  ", '{"query":"x"}', { query: "x" }];
    for (const args of accepted) {
      const failure = guardOllamaJsonResponse(
        jsonResponse([functionCall("tool_search", { arguments: args })]),
        declared,
      );
      assert.equal(failure, undefined);
    }
  });

  it("leaves non-tool_search calls on the name-only contract", () => {
    const execDeclared = declarationOf([{ type: "function", name: "exec_command" }]);
    assert.equal(
      guardOllamaJsonResponse(jsonResponse([functionCall("exec_command", { arguments: "not-json" })]), execDeclared),
      undefined,
    );
  });
});

function isRecordError(value: JsonObject): value is JsonObject & { error: JsonObject } {
  return Boolean(value.error && typeof value.error === "object");
}
