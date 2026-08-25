import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import {
  formatNativePlaintextSpawnResponseDiagnostic,
  mapNativePlaintextSpawnJson,
  NativePlaintextSpawnError,
  nativePlaintextSpawnError,
  nativePlaintextSpawnSchemaSha256,
  nativePlaintextSpawnSseTransform,
  observeNativePlaintextSpawnResponse,
  NATIVE_PLAINTEXT_SEND_ALIAS,
  NATIVE_PLAINTEXT_FOLLOWUP_ALIAS,
  NATIVE_PLAINTEXT_SPAWN_ALIAS,
  prepareNativePlaintextSpawn,
} from "./native-plaintext-spawn.js";
import { isOllamaReject, prepareOllamaPayload } from "./ollama.js";
import type { JsonObject } from "./types.js";

function spawnTool(extra: JsonObject = {}): JsonObject {
  return {
    type: "function",
    name: "spawn_agent",
    description: "Spawn a child agent.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", encrypted: true, description: "Task message." },
        model: { type: "string" },
      },
      required: ["message", "model"],
      additionalProperties: false,
    },
    strict: true,
    ...extra,
  };
}

function collaborationTools(): JsonObject[] {
  return [
    {
      type: "function",
      name: "followup_task",
      description: "Follow up.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "Child agent id." },
          message: { type: "string", encrypted: true },
        },
        required: ["target", "message"],
        additionalProperties: false,
      },
      strict: false,
    },
    { type: "function", name: "interrupt_agent", description: "Interrupt." },
    { type: "function", name: "list_agents", description: "List agents." },
    {
      type: "function",
      name: "send_message",
      description: "Send a message.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "Child agent id." },
          message: { type: "string", encrypted: true },
        },
        required: ["target", "message"],
        additionalProperties: false,
      },
      strict: true,
    },
    spawnTool(),
    { type: "function", name: "wait_agent", description: "Wait." },
  ];
}

function collaborationNamespace(tools = collaborationTools()): JsonObject {
  return {
    type: "namespace",
    name: "collaboration",
    description: "Reserved collaboration tools.",
    tools,
  };
}

function functionsNamespace(): JsonObject {
  return {
    type: "namespace",
    name: "functions",
    description: "Ordinary functions.",
    tools: [{ type: "function", name: "exec_command", description: "Run a command." }],
  };
}

function gate1Input(tools = collaborationTools()): JsonObject[] {
  return [{
    type: "additional_tools",
    role: "developer",
    tools: [functionsNamespace(), collaborationNamespace(tools)],
  }];
}

function gate1Payload(tools = collaborationTools()): JsonObject {
  return { model: "gpt-5.6-sol", input: gate1Input(tools) };
}

function schemaPolicy(tools = collaborationTools()): { enabled: true; schemaSha256: string } {
  const namespace = collaborationNamespace(tools);
  return { enabled: true, schemaSha256: nativePlaintextSpawnSchemaSha256(namespace) };
}

async function collect(transform: import("node:stream").Transform, input: string): Promise<string> {
  const chunks: Buffer[] = [];
  transform.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  await new Promise<void>((resolve, reject) => {
    transform.once("error", reject);
    transform.once("end", resolve);
    Readable.from([Buffer.from(input, "utf8")]).pipe(transform);
  });
  return Buffer.concat(chunks).toString("utf8");
}

describe("native Sol plaintext spawn/send/followup Gate 1-3", () => {
  it("removes only the opted-in leaves, exposes ordered plaintext aliases, and restores identity", () => {
    const payload = gate1Payload();
    const prepared = prepareNativePlaintextSpawn(payload, schemaPolicy());
    assert.equal("status" in prepared, false);
    if ("status" in prepared || !prepared.context) return;
    const originalNamespace = ((payload.input as JsonObject[])[0]!.tools as JsonObject[])
      .find((tool) => tool.name === "collaboration")!;
    const originalMessageProperties = originalNamespace.tools as JsonObject[];
    assert.equal(
      (((originalMessageProperties.find((tool) => tool.name === "spawn_agent")!.parameters as JsonObject).properties as JsonObject)
        .message as JsonObject).encrypted,
      true,
    );
    assert.equal(
      (((originalMessageProperties.find((tool) => tool.name === "send_message")!.parameters as JsonObject).properties as JsonObject)
        .message as JsonObject).encrypted,
      true,
    );
    assert.equal(
      (((originalMessageProperties.find((tool) => tool.name === "followup_task")!.parameters as JsonObject).properties as JsonObject)
        .message as JsonObject).encrypted,
      true,
    );
    assert.equal("tools" in prepared.payload, false);
    const additional = (prepared.payload.input as JsonObject[])[0]!;
    const tools = additional.tools as JsonObject[];
    assert.deepEqual(tools[0], functionsNamespace());
    assert.deepEqual(tools.map((tool) => tool.name), [
      "functions",
      "collaboration",
      NATIVE_PLAINTEXT_SPAWN_ALIAS,
      NATIVE_PLAINTEXT_SEND_ALIAS,
      NATIVE_PLAINTEXT_FOLLOWUP_ALIAS,
    ]);
    const namespace = tools.find((tool) => tool.type === "namespace" && tool.name === "collaboration") as JsonObject;
    assert.deepEqual(
      (namespace.tools as JsonObject[]).map((tool) => tool.name),
      ["interrupt_agent", "list_agents", "wait_agent"],
    );
    assert.equal(tools.filter((tool) => tool.name === NATIVE_PLAINTEXT_SPAWN_ALIAS).length, 1);
    const aliases = tools.filter((tool) => tool.type === "function") as JsonObject[];
    const spawnAlias = aliases.find((tool) => tool.name === NATIVE_PLAINTEXT_SPAWN_ALIAS)!;
    const sendAlias = aliases.find((tool) => tool.name === NATIVE_PLAINTEXT_SEND_ALIAS)!;
    const spawnMessage = ((spawnAlias.parameters as JsonObject).properties as JsonObject).message as JsonObject;
    const sendProperties = (sendAlias.parameters as JsonObject).properties as JsonObject;
    assert.equal("encrypted" in spawnMessage, false);
    assert.equal("encrypted" in (sendProperties.message as JsonObject), false);
    assert.deepEqual(sendProperties.target, { type: "string", description: "Child agent id." });
    const followupAlias = aliases.find((tool) => tool.name === NATIVE_PLAINTEXT_FOLLOWUP_ALIAS)!;
    const followupProperties = (followupAlias.parameters as JsonObject).properties as JsonObject;
    assert.equal("encrypted" in (followupProperties.message as JsonObject), false);
    assert.deepEqual(followupProperties.target, { type: "string", description: "Child agent id." });

    const response = mapNativePlaintextSpawnJson(
      {
        id: "resp_1",
        object: "response",
        output: [
          {
            type: "function_call",
            name: NATIVE_PLAINTEXT_SPAWN_ALIAS,
            call_id: "call_1",
            arguments: JSON.stringify({ message: "line 1\r\nline 2 \"quoted\" 😀 e\u0301" }),
          },
        ],
      },
      prepared.context,
    ) as JsonObject;
    assert.deepEqual((response.output as JsonObject[])[0], {
      type: "function_call",
      name: "spawn_agent",
      namespace: "collaboration",
      call_id: "call_1",
      arguments: JSON.stringify({ message: "line 1\r\nline 2 \"quoted\" 😀 e\u0301" }),
      encrypted_function_args: [],
    });

    const sendMessage = "line A\r\nline B \"quoted\" 😀 e\u0301";
    const sendResponse = mapNativePlaintextSpawnJson(
      {
        type: "response",
        output: [{
          type: "function_call",
          name: NATIVE_PLAINTEXT_SEND_ALIAS,
          call_id: "call_send",
          arguments: JSON.stringify({ target: "child-0731", message: sendMessage }),
        }],
      },
      prepared.context,
    ) as JsonObject;
    const mappedSend = (sendResponse.output as JsonObject[])[0]!;
    assert.deepEqual(mappedSend, {
      type: "function_call",
      name: "send_message",
      namespace: "collaboration",
      call_id: "call_send",
      arguments: JSON.stringify({ target: "child-0731", message: sendMessage }),
      encrypted_function_args: [],
    });

    const followupMessage = "follow up\r\n😀";
    const followupResponse = mapNativePlaintextSpawnJson(
      {
        type: "response",
        output: [{
          type: "function_call",
          name: NATIVE_PLAINTEXT_FOLLOWUP_ALIAS,
          call_id: "call_followup",
          arguments: JSON.stringify({ target: "child-0731", message: followupMessage }),
        }],
      },
      prepared.context,
    ) as JsonObject;
    assert.deepEqual((followupResponse.output as JsonObject[])[0], {
      type: "function_call",
      name: "followup_task",
      namespace: "collaboration",
      call_id: "call_followup",
      arguments: JSON.stringify({ target: "child-0731", message: followupMessage }),
      encrypted_function_args: [],
    });
  });

  it("is default-off, Sol-only, and fail-closed on missing, mismatched, or colliding schemas", () => {
    const payload = gate1Payload();
    const disabled = prepareNativePlaintextSpawn(payload, { enabled: false });
    if ("status" in disabled) return;
    assert.equal(disabled.payload, payload);

    const otherModel = prepareNativePlaintextSpawn(
      { ...payload, model: "gpt-5.6-luna" },
      { enabled: true, schemaSha256: "0".repeat(64) },
    );
    if ("status" in otherModel) return;
    assert.equal(otherModel.payload.model, "gpt-5.6-luna");

    const changedSibling = collaborationTools().map((tool) =>
      tool.name === "send_message" ? { ...tool, description: "changed" } : tool,
    );
    const fingerprintDrift = prepareNativePlaintextSpawn(
      gate1Payload(changedSibling),
      schemaPolicy(),
    );
    assert.equal("status" in fingerprintDrift, true);
    if ("status" in fingerprintDrift) {
      assert.equal(fingerprintDrift.body.error.code, "native_plaintext_spawn_schema_mismatch");
      assert.equal(typeof fingerprintDrift.body.error.observed_schema_sha256, "string");
    }

    for (const [candidate, code] of [
      [{ model: "gpt-5.6-sol", input: [] }, "native_plaintext_spawn_schema_missing"],
      [payload, "native_plaintext_spawn_schema_mismatch"],
      [{
        model: "gpt-5.6-sol",
        input: [...gate1Input(), { type: "additional_tools", role: "developer", tools: [collaborationNamespace()] }],
      }, "native_plaintext_spawn_schema_ambiguous"],
    ] as const) {
      const policy = { enabled: true as const, schemaSha256: "0".repeat(64) };
      const result = prepareNativePlaintextSpawn(candidate as JsonObject, policy);
      assert.equal("status" in result, true);
      if ("status" in result) assert.equal(result.body.error.code, code);
    }

    for (const alias of [NATIVE_PLAINTEXT_SPAWN_ALIAS, NATIVE_PLAINTEXT_SEND_ALIAS, NATIVE_PLAINTEXT_FOLLOWUP_ALIAS]) {
      const collisionTools = [...collaborationTools(), { type: "function", name: alias }];
      const collision = prepareNativePlaintextSpawn(
        gate1Payload(collisionTools),
        schemaPolicy(),
      );
      assert.equal("status" in collision, true);
      if ("status" in collision) assert.equal(collision.body.error.code, "native_plaintext_spawn_alias_collision");
    }

    const siblingCollision = prepareNativePlaintextSpawn(
      {
        ...payload,
        input: [{
          ...(gate1Input()[0] as JsonObject),
          tools: [
            functionsNamespace(),
            { type: "namespace", name: "other", tools: [{ type: "function", name: NATIVE_PLAINTEXT_SEND_ALIAS }] },
            collaborationNamespace(),
          ],
        }],
      },
      schemaPolicy(),
    );
    assert.equal("status" in siblingCollision, true);
    if ("status" in siblingCollision) assert.equal(siblingCollision.body.error.code, "native_plaintext_spawn_alias_collision");

    const flat = prepareNativePlaintextSpawn(
      { model: "gpt-5.6-sol", tools: [spawnTool()] },
      { enabled: true, schemaSha256: "0".repeat(64) },
    );
    assert.equal("status" in flat, true);
    if ("status" in flat) assert.equal(flat.body.error.code, "native_plaintext_spawn_schema_shape");

    const dotted = prepareNativePlaintextSpawn(
      {
        model: "gpt-5.6-sol",
        input: [{ type: "additional_tools", role: "developer", tools: [{ type: "function", name: "collaboration.spawn_agent", parameters: spawnTool().parameters }] }],
      },
      { enabled: true, schemaSha256: "0".repeat(64) },
    );
    assert.equal("status" in dotted, true);
    if ("status" in dotted) assert.equal(dotted.body.error.code, "native_plaintext_spawn_schema_shape");

    const explicitNamespace = collaborationTools().map((tool) =>
      tool.name === "spawn_agent" ? { ...tool, namespace: "collaboration" } : tool,
    );
    const explicit = prepareNativePlaintextSpawn(
      gate1Payload(explicitNamespace),
      schemaPolicy(),
    );
    assert.equal("status" in explicit, true);
    if ("status" in explicit) assert.equal(explicit.body.error.code, "native_plaintext_spawn_schema_shape");

    const invalidSend = collaborationTools().map((tool) =>
      tool.name === "send_message"
        ? {
            ...tool,
            parameters: {
              ...(tool.parameters as JsonObject),
              properties: {
                ...((tool.parameters as JsonObject).properties as JsonObject),
                message: { type: "string" },
              },
            },
          }
        : tool,
    );
    const invalidSendResult = prepareNativePlaintextSpawn(
      gate1Payload(invalidSend),
      schemaPolicy(invalidSend),
    );
    assert.equal("status" in invalidSendResult, true);
    if ("status" in invalidSendResult) assert.equal(invalidSendResult.body.error.code, "native_plaintext_spawn_schema_shape");

    const optionalSendTarget = collaborationTools().map((tool) =>
      tool.name === "send_message"
        ? {
            ...tool,
            parameters: {
              ...(tool.parameters as JsonObject),
              required: ["message"],
            },
          }
        : tool,
    );
    const optionalSendTargetResult = prepareNativePlaintextSpawn(
      gate1Payload(optionalSendTarget),
      schemaPolicy(optionalSendTarget),
    );
    assert.equal("status" in optionalSendTargetResult, true);
    if ("status" in optionalSendTargetResult) {
      assert.equal(optionalSendTargetResult.body.error.code, "native_plaintext_spawn_schema_shape");
    }

    const invalidFollowup = collaborationTools().map((tool) =>
      tool.name === "followup_task"
        ? {
            ...tool,
            parameters: {
              ...(tool.parameters as JsonObject),
              properties: {
                ...((tool.parameters as JsonObject).properties as JsonObject),
                target: { type: "number" },
              },
            },
          }
        : tool,
    );
    const invalidFollowupResult = prepareNativePlaintextSpawn(
      gate1Payload(invalidFollowup),
      schemaPolicy(invalidFollowup),
    );
    assert.equal("status" in invalidFollowupResult, true);
    if ("status" in invalidFollowupResult) assert.equal(invalidFollowupResult.body.error.code, "native_plaintext_spawn_schema_shape");

    const duplicateSend = [...collaborationTools()];
    duplicateSend[4] = duplicateSend[3]!;
    const duplicateSendResult = prepareNativePlaintextSpawn(
      gate1Payload(duplicateSend),
      { enabled: true, schemaSha256: "0".repeat(64) },
    );
    assert.equal("status" in duplicateSendResult, true);
    if ("status" in duplicateSendResult) assert.equal(duplicateSendResult.body.error.code, "native_plaintext_spawn_schema_ambiguous");
  });

  it("restores JSON and CRLF SSE identities and rejects canonical or malformed output", async () => {
    const payload = gate1Payload();
    const prepared = prepareNativePlaintextSpawn(payload, schemaPolicy());
    assert.equal("status" in prepared, false);
    if ("status" in prepared || !prepared.context) return;
    const context = prepared.context;
    assert.throws(
      () => mapNativePlaintextSpawnJson({ type: "function_call", name: "collaboration.spawn_agent", arguments: "{}" }, context),
      /reserved collaboration identity/,
    );
    assert.throws(
      () => mapNativePlaintextSpawnJson({ type: "function_call", name: NATIVE_PLAINTEXT_SPAWN_ALIAS, arguments: "not-json" }, context),
      /arguments are invalid/,
    );
    assert.throws(
      () => mapNativePlaintextSpawnJson({ type: "function_call", name: NATIVE_PLAINTEXT_SEND_ALIAS, arguments: "not-json" }, context),
      /arguments are invalid/,
    );
    assert.throws(
      () =>
        mapNativePlaintextSpawnJson(
          {
            type: "function_call",
            name: NATIVE_PLAINTEXT_SPAWN_ALIAS,
            arguments: JSON.stringify({ message: "plain" }),
            encrypted_function_args: ["ciphertext"],
          },
          context,
        ),
      /encrypted function arguments/,
    );
    assert.throws(
      () =>
        mapNativePlaintextSpawnJson(
          {
            type: "function_call",
            name: NATIVE_PLAINTEXT_SEND_ALIAS,
            arguments: JSON.stringify({ target: "child", message: "plain" }),
            encrypted_function_args: ["ciphertext"],
          },
          context,
        ),
      /encrypted function arguments/,
    );
    assert.throws(
      () => mapNativePlaintextSpawnJson({ type: "function_call", name: "collaboration.send_message", arguments: "{}" }, context),
      /reserved collaboration identity/,
    );
    assert.throws(
      () => mapNativePlaintextSpawnJson({ type: "function_call", name: "collaboration.followup_task", arguments: "{}" }, context),
      /reserved collaboration identity/,
    );
    assert.throws(
      () => mapNativePlaintextSpawnJson({ type: "function_call", name: "send_message", namespace: "collaboration", arguments: "{}" }, context),
      /reserved collaboration identity/,
    );
    assert.throws(
      () => mapNativePlaintextSpawnJson({ type: "function_call", name: NATIVE_PLAINTEXT_SEND_ALIAS, namespace: "collaboration", arguments: "{}" }, context),
      /unexpected alias shape/,
    );
    assert.throws(
      () => mapNativePlaintextSpawnJson({ type: "function_call", name: NATIVE_PLAINTEXT_SEND_ALIAS, arguments: JSON.stringify({ target: "child" }) }, context),
      /arguments are invalid/,
    );
    assert.throws(
      () => mapNativePlaintextSpawnJson({ type: "function_call", name: NATIVE_PLAINTEXT_SEND_ALIAS, arguments: JSON.stringify({ message: "plain" }) }, context),
      /arguments are invalid/,
    );
    assert.throws(
      () => mapNativePlaintextSpawnJson({ type: "function_call", name: NATIVE_PLAINTEXT_SEND_ALIAS, arguments: JSON.stringify({ target: 7, message: "plain" }) }, context),
      /arguments are invalid/,
    );
    assert.throws(
      () => mapNativePlaintextSpawnJson({ type: "function_call", name: NATIVE_PLAINTEXT_FOLLOWUP_ALIAS, arguments: JSON.stringify({ message: "plain" }) }, context),
      /arguments are invalid/,
    );
    assert.throws(
      () => mapNativePlaintextSpawnJson({ type: "function_call", name: NATIVE_PLAINTEXT_FOLLOWUP_ALIAS, arguments: JSON.stringify({ target: 7, message: "plain" }) }, context),
      /arguments are invalid/,
    );
    assert.throws(
      () => mapNativePlaintextSpawnJson({ type: "function_call", name: NATIVE_PLAINTEXT_SPAWN_ALIAS, arguments: JSON.stringify({ message: "plain", cwd: "/tmp" }) }, context),
      /arguments are invalid/,
    );
    assert.throws(
      () => mapNativePlaintextSpawnJson({ type: "function_call", name: NATIVE_PLAINTEXT_SPAWN_ALIAS, arguments: JSON.stringify({ message: "plain", model: "gpt-5.6-sol" }) }, context),
      /arguments are invalid/,
    );
    assert.throws(
      () => mapNativePlaintextSpawnJson({ type: "function_call", name: NATIVE_PLAINTEXT_SEND_ALIAS, arguments: JSON.stringify({ target: "child", message: "plain", extra: true }) }, context),
      /arguments are invalid/,
    );
    const spawnWithOllama = mapNativePlaintextSpawnJson(
      {
        type: "function_call",
        name: NATIVE_PLAINTEXT_SPAWN_ALIAS,
        arguments: JSON.stringify({ message: "plain", model: "ollama/deepseek-v4-flash:0731-cloud" }),
      },
      context,
    ) as JsonObject;
    assert.equal(spawnWithOllama.name, "spawn_agent");

    const raw = [
      `data: {"type":"response.output_item.added","item":{"type":"function_call","name":"${NATIVE_PLAINTEXT_SPAWN_ALIAS}"}}\r\n`,
      `data: {"type":"response.output_item.done","item":{"type":"function_call","name":"${NATIVE_PLAINTEXT_SPAWN_ALIAS}","arguments":"{\\"message\\":\\"plain\\"}"}}\r\n`,
      `data: {"type":"response.output_item.added","item":{"type":"function_call","name":"${NATIVE_PLAINTEXT_SEND_ALIAS}"}}\r\n`,
      `data: {"type":"response.output_item.done","item":{"type":"function_call","name":"${NATIVE_PLAINTEXT_SEND_ALIAS}","arguments":"{\\"target\\":\\"child-0731\\",\\"message\\":\\"plain send\\"}"}}\r\n`,
      `data: {"type":"response.output_item.added","item":{"type":"function_call","name":"${NATIVE_PLAINTEXT_FOLLOWUP_ALIAS}"}}\r\n`,
      `data: {"type":"response.output_item.done","item":{"type":"function_call","name":"${NATIVE_PLAINTEXT_FOLLOWUP_ALIAS}","arguments":"{\\"target\\":\\"child-0731\\",\\"message\\":\\"plain followup\\"}"}}\r\n`,
      `data: {"type":"response.completed","response":{"output":[{"type":"function_call","name":"${NATIVE_PLAINTEXT_SPAWN_ALIAS}","arguments":"{\\"message\\":\\"plain\\"}"},{"type":"function_call","name":"${NATIVE_PLAINTEXT_SEND_ALIAS}","arguments":"{\\"target\\":\\"child-0731\\",\\"message\\":\\"plain send\\"}"},{"type":"function_call","name":"${NATIVE_PLAINTEXT_FOLLOWUP_ALIAS}","arguments":"{\\"target\\":\\"child-0731\\",\\"message\\":\\"plain followup\\"}"}]}}\r\n\r\n`,
    ].join("");
    const mapped = await collect(nativePlaintextSpawnSseTransform(context), raw);
    assert.equal((mapped.match(/cob_plaintext_spawn_agent/g) ?? []).length, 0);
    assert.equal((mapped.match(/cob_plaintext_send_message/g) ?? []).length, 0);
    assert.equal((mapped.match(/cob_plaintext_followup_task/g) ?? []).length, 0);
    assert.equal((mapped.match(/"name":"spawn_agent"/g) ?? []).length, 3);
    assert.equal((mapped.match(/"name":"send_message"/g) ?? []).length, 3);
    assert.equal((mapped.match(/"name":"followup_task"/g) ?? []).length, 3);
    assert.equal((mapped.match(/"namespace":"collaboration"/g) ?? []).length, 9);
    assert.equal((mapped.match(/"encrypted_function_args":\[\]/g) ?? []).length, 9);
    await assert.rejects(
      collect(
        nativePlaintextSpawnSseTransform(context),
        `data: {"type":"response.completed","response":{"output":[{"type":"function_call","name":"${NATIVE_PLAINTEXT_SPAWN_ALIAS}","arguments":"not-json"}]}}\n\n`,
      ),
      /arguments are invalid/,
    );
    await assert.rejects(
      collect(
        nativePlaintextSpawnSseTransform(context),
        `{"type":"function_call","name":"${NATIVE_PLAINTEXT_FOLLOWUP_ALIAS}","arguments":"{}"}`,
      ),
      /unsupported field/,
    );
  });

  it("classifies rejected responses with content-free structural diagnostics", () => {
    const invalid = observeNativePlaintextSpawnResponse(
      Buffer.from('{"output":[{"arguments":"SECRET_ARGUMENT"}]} trailing', "utf8"),
      200,
      "application/json; charset=utf-8",
    );
    assert.equal(invalid.diagnostic.json_classification, "invalid");
    assert.equal(invalid.diagnostic.upstream_status, 200);
    assert.equal(invalid.diagnostic.upstream_content_type, "application/json; charset=utf-8");
    assert.equal(invalid.diagnostic.raw_byte_length, Buffer.byteLength('{"output":[{"arguments":"SECRET_ARGUMENT"}]} trailing'));
    assert.equal("top_level_keys" in invalid.diagnostic, false);

    const array = observeNativePlaintextSpawnResponse(Buffer.from("[1,2,3]"), 200, "application/json");
    assert.equal(array.diagnostic.json_classification, "array");
    assert.deepEqual(array.value, [1, 2, 3]);

    const scalar = observeNativePlaintextSpawnResponse(Buffer.from("42"), 200, "application/json");
    assert.equal(scalar.diagnostic.json_classification, "scalar");
    assert.equal(scalar.value, 42);

    const object = observeNativePlaintextSpawnResponse(
      Buffer.from(JSON.stringify({ id: "resp_secret", type: "response", output: [], metadata: { secret: "do-not-log" } })),
      502,
      "application/json",
    );
    assert.equal(object.diagnostic.json_classification, "object");
    assert.equal(object.diagnostic.top_level_type, "response");
    assert.deepEqual(object.diagnostic.top_level_keys, ["id", "metadata", "output", "type"]);
    assert.equal(JSON.stringify(object.diagnostic).includes("resp_secret"), false);
    assert.equal(JSON.stringify(object.diagnostic).includes("do-not-log"), false);

    const failure = nativePlaintextSpawnError(
      new Error("SECRET_ARGUMENT must not escape"),
      {
        ...object.diagnostic,
        json_classification: "object",
      },
    );
    assert.equal(failure.status, 502);
    assert.equal(failure.body.error.code, "native_plaintext_spawn_response_invalid");
    assert.equal(failure.body.error.diagnostics?.mapper_error_class, "Error");
    assert.equal(failure.body.error.diagnostics?.mapper_error_code, "native_plaintext_spawn_response_invalid");
    assert.equal(JSON.stringify(failure).includes("SECRET_ARGUMENT"), false);
    const log = formatNativePlaintextSpawnResponseDiagnostic(failure.body.error.diagnostics!);
    assert.match(log, /upstream_status=502/);
    assert.match(log, /json_classification=object/);
    assert.match(log, /mapper_error_class="Error"/);
    assert.match(log, /mapper_error_code="native_plaintext_spawn_response_invalid"/);
    assert.equal(log.includes("SECRET_ARGUMENT"), false);
    assert.equal(log.includes("resp_secret"), false);
    assert.equal(log.includes("do-not-log"), false);
  });

  it("keeps invalid, array, and scalar response errors distinct", () => {
    const diagnostic = {
      upstream_status: 200,
      upstream_content_type: "application/json",
      raw_byte_length: 1,
      json_classification: "invalid" as const,
    };
    assert.deepEqual(
      [
        nativePlaintextSpawnError(
          new NativePlaintextSpawnError("native_plaintext_spawn_response_invalid_json", "invalid"),
          diagnostic,
        ).body.error.code,
        nativePlaintextSpawnError(
          new NativePlaintextSpawnError("native_plaintext_spawn_response_top_level_array", "array"),
          { ...diagnostic, json_classification: "array" },
        ).body.error.code,
        nativePlaintextSpawnError(
          new NativePlaintextSpawnError("native_plaintext_spawn_response_top_level_scalar", "scalar"),
          { ...diagnostic, json_classification: "scalar" },
        ).body.error.code,
      ],
      [
        "native_plaintext_spawn_response_invalid_json",
        "native_plaintext_spawn_response_top_level_array",
        "native_plaintext_spawn_response_top_level_scalar",
      ],
    );
  });
});

describe("Ollama plaintext child boundary", () => {
  it("projects agent_message text in order with exact Unicode and line endings", () => {
    const nonce = "first\r\nsecond " + '"quoted"' + " \\ 😀 e\u0301";
    const prepared = prepareOllamaPayload({
      model: "ollama/deepseek-v4-flash:0731-cloud",
      input: [
        { type: "agent_message", content: [{ type: "input_text", text: nonce }, { type: "input_text", text: "third" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "after" }] },
      ],
    });
    assert.equal("status" in prepared, false);
    if ("status" in prepared) return;
    assert.deepEqual((prepared.input as JsonObject[])[0], {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: nonce }, { type: "input_text", text: "third" }],
    });
    assert.equal(((prepared.input as JsonObject[])[1]!.content as JsonObject[])[0]!.text, "after");

    const unrelated = prepareOllamaPayload({
      model: "ollama/test",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ok" }] }],
      tools: [{ type: "function", name: "example", parameters: { agent_message: { type: "agent_message", message: "keep" } } }],
    });
    assert.equal("status" in unrelated, false);
    if (!("status" in unrelated)) {
      assert.deepEqual((unrelated.tools as JsonObject[])[0]!.parameters, {
        agent_message: { type: "agent_message", message: "keep" },
      });
    }
  });

  it("rejects mixed/unknown agent_message content and every non-empty encrypted_content", () => {
    const badMessages: JsonObject[] = [
      { type: "agent_message", content: [{ type: "input_text", text: "ok" }, { type: "image", url: "x" }] },
      { type: "agent_message", content: [{ type: "unknown", text: "no" }] },
      { type: "agent_message", content: "legacy string" },
      { type: "agent_message", message: "plain", content: "also" },
    ];
    for (const item of badMessages) {
      const result = prepareOllamaPayload({ model: "ollama/test", input: [item] });
      assert.equal(isOllamaReject(result), true);
      if (isOllamaReject(result)) assert.equal(result.body.error.code, "agent_message_unsupported");
    }
    for (const value of ["short", "   ", "A".repeat(96), { blob: "x" }, 7, false]) {
      const result = prepareOllamaPayload({ model: "ollama/test", input: [{ encrypted_content: value }] });
      assert.equal(isOllamaReject(result), true);
      if (isOllamaReject(result)) assert.equal(result.body.error.code, "encrypted_content_unsupported");
    }
    const empty = prepareOllamaPayload({ model: "ollama/test", input: [{ encrypted_content: "" }] });
    assert.equal("status" in empty, false);
    if (!("status" in empty)) assert.equal(JSON.stringify(empty).includes("encrypted_content"), false);
  });
});
