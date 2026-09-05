import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyOllamaContentType,
  compactUsageEventFromMetrics,
  compactUsageEventFromEnvelope,
  createGatewayRequestContext,
  recordRequestOutcome,
  emitGatewayDiagnosticEvent,
  emitGatewayDiagnosticEventTo,
  formatGatewayDiagnosticEvent,
  GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
  modelSha8,
  normalizeDiagnosticEffort,
  observeOllamaInvalidJson,
  persistGatewayDiagnosticEvent,
  recordGatewayRequestEnd,
  type GatewayDiagnosticEventV1,
} from "./codex/diagnostic-event.js";
import {
  DiagnosticLog,
  DIAGNOSTIC_LOG_MAX_BYTES,
} from "./codex/runtime/diagnostic-log.js";
import { summarizeRequest } from "./codex/request-metrics.js";

const SENSITIVE = [
  "SECRET_PROMPT_TEXT",
  "SECRET_OUTPUT_TEXT",
  "apply_patch",
  "exec_command",
  "gAAAAA-fernet",
  "resp_abc123",
  "sk-credential",
  "account-42",
];

function captureStderr(fn: () => void): string {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines.join("\n");
}

describe("request outcome recording", () => {
  it("keeps the first classification and never records a sourceless failure", () => {
    const context = createGatewayRequestContext("/v1/responses");
    // The precise terminal is recorded where the failure is detected...
    recordRequestOutcome(context, {
      terminal: "invalid_json",
      source: "cob_limit",
      code: "ollama_response_invalid_json",
    });
    // ...and the generic one a shared response writer produces further out
    // must not replace it. This exact overwrite made every counter reading
    // `terminal` undercount the invalid-JSON class.
    recordRequestOutcome(context, { terminal: "http_error", source: "provider", code: "http_502" });
    assert.equal(context.terminal, "invalid_json");
    assert.equal(context.termination_source, "cob_limit");
    assert.equal(context.error_code, "ollama_response_invalid_json");

    // Every failure carries whose decision it was. The type makes a
    // sourceless failure unrepresentable; this asserts the runtime agrees.
    const fresh = createGatewayRequestContext("/v1/responses");
    recordRequestOutcome(fresh, { terminal: "stream_error", source: "transport" });
    assert.equal(fresh.termination_source, "transport");

    // A completed request has no source: nobody "decided" to end it.
    const ok = createGatewayRequestContext("/v1/responses");
    recordRequestOutcome(ok, { terminal: "completed" });
    assert.equal(ok.terminal, "completed");
    assert.equal(ok.termination_source, undefined);
  });
});

describe("gateway diagnostic events", () => {
  it("redacts persisted model names and ignores sink failures", () => {
    const previous = process.env.COB_DIAGNOSTIC_JSONL;
    process.env.COB_DIAGNOSTIC_JSONL = "1";
    const model = "ollama/secret-model";
    const route: GatewayDiagnosticEventV1 = {
      schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
      kind: "request_route",
      route: "ollama",
      model,
    };
    const compact: GatewayDiagnosticEventV1 = {
      schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
      kind: "compact_start",
      provider: "ollama",
      thread_model: model,
      compact_model: model,
      group_sha8: "abcd1234",
      attempt: 1,
    };
    const persisted: GatewayDiagnosticEventV1[] = [];
    const sink = { write: (event: GatewayDiagnosticEventV1) => persisted.push(event) };
    const throwingSink = { write: () => { throw new Error("diagnostic sink unavailable"); } };
    try {
      const stderr = captureStderr(() => {
        assert.doesNotThrow(() => emitGatewayDiagnosticEventTo(route, throwingSink));
        emitGatewayDiagnosticEventTo(route, sink);
        emitGatewayDiagnosticEventTo(compact, sink);
      });
      assert.doesNotThrow(() => persistGatewayDiagnosticEvent(route, throwingSink));
      assert.equal(persisted[0]?.kind, "request_route");
      assert.equal((persisted[0] as Extract<GatewayDiagnosticEventV1, { kind: "request_route" }>).model, modelSha8(model));
      assert.equal((persisted[1] as Extract<GatewayDiagnosticEventV1, { kind: "compact_start" }>).thread_model, modelSha8(model));
      assert.equal(JSON.stringify(persisted).includes(model), false);
      assert.equal(stderr.includes(model), false);
    } finally {
      if (previous === undefined) delete process.env.COB_DIAGNOSTIC_JSONL;
      else process.env.COB_DIAGNOSTIC_JSONL = previous;
    }
  });

  it("disables the sidecar when its active path is a symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-diagnostic-bind-"));
    const target = join(dir, "target");
    const path = join(dir, "cob-diagnostics.jsonl");
    try {
      writeFileSync(target, "untouched\n");
      symlinkSync(target, path);
      const log = new DiagnosticLog(path);
      log.write({
        schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
        kind: "request_end",
        timestamp: new Date().toISOString(),
        pid: process.pid,
        request_seq: 1,
        request_fp8: "0123abcd",
        route: "native",
        status: 200,
        total_latency_ms: 1,
        provider_attempts: 1,
        gateway_retry_count: 0,
      });
      const snapshot = log.snapshot();
      log.close();
      assert.equal(readFileSync(target, "utf8"), "untouched\n");
      assert.equal(snapshot.state, "failed");
      assert.equal(snapshot.dropped_event_count, 1);
      assert.equal(snapshot.write_failure_count, 1);
      assert.equal(snapshot.last_failure_code, "open_failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps persisted request metrics content-free and bounds the sidecar", () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-diagnostic-log-"));
    const path = join(dir, "cob-diagnostics.jsonl");
    try {
      const hostile = "SECRET_ROLE_and_type_and_effort";
      const requestMetrics = summarizeRequest(
        {
          input: [{ type: hostile, role: hostile, content: hostile }],
          reasoning: { effort: hostile },
        },
        100,
      );
      const event: GatewayDiagnosticEventV1 = {
        schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
        kind: "request_start",
        timestamp: new Date().toISOString(),
        pid: process.pid,
        request_seq: 1,
        request_fp8: "0123abcd",
        route: "native",
        model_sha8: modelSha8(hostile),
        metrics: {
          raw_bytes: 100,
          input_n: requestMetrics.inputCount,
          effort: normalizeDiagnosticEffort(requestMetrics.reasoningEffort),
        },
      };
      writeFileSync(path, Buffer.alloc(DIAGNOSTIC_LOG_MAX_BYTES + 1, 0x20), { mode: 0o600 });
      const external = join(dir, "external");
      writeFileSync(external, "must-survive\n");
      symlinkSync(external, `${path}.1`);
      const log = new DiagnosticLog(path);
      log.write(event);
      const snapshot = log.snapshot();
      log.close();
      const persisted = readFileSync(path, "utf8");
      assert.equal(persisted.includes(hostile), false);
      assert.equal(JSON.parse(persisted).metrics.effort, "other");
      assert.equal(statSync(path).size <= DIAGNOSTIC_LOG_MAX_BYTES, true);
      assert.equal(statSync(`${path}.1`).size <= DIAGNOSTIC_LOG_MAX_BYTES, true);
      assert.equal(readFileSync(external, "utf8"), "must-survive\n");
      assert.equal(snapshot.rotation_count, 1);
      assert.equal(snapshot.discarded_backup_count, 1);
      assert.equal(snapshot.state, "degraded");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an oversized diagnostic event instead of dropping it silently", () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-diagnostic-oversize-"));
    const path = join(dir, "cob-diagnostics.jsonl");
    try {
      const log = new DiagnosticLog(path);
      log.write({
        schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
        kind: "compact_success",
        transcript_format_version: 2,
        latency_ms: 1,
        summary_bytes: 1,
        effort: "high",
        sections: Object.fromEntries(
          Array.from({ length: 2_000 }, (_value, index) => [`section_${index}`, index]),
        ),
        group_sha8: "abcd1234",
        attempt: 1,
      });
      const snapshot = log.snapshot();
      log.close();
      assert.equal(readFileSync(path, "utf8"), "");
      assert.equal(snapshot.state, "degraded");
      assert.equal(snapshot.dropped_event_count, 1);
      assert.equal(snapshot.oversize_drop_count, 1);
      assert.equal(snapshot.write_failure_count, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not pad a normally rotated backup with non-JSON bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-diagnostic-rotate-"));
    const path = join(dir, "cob-diagnostics.jsonl");
    const existingBytes = DIAGNOSTIC_LOG_MAX_BYTES - 10;
    try {
      writeFileSync(path, Buffer.alloc(existingBytes, 0x20), { mode: 0o600 });
      const log = new DiagnosticLog(path);
      log.write({
        schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
        kind: "request_end",
        timestamp: new Date().toISOString(),
        pid: process.pid,
        request_seq: 1,
        request_fp8: "0123abcd",
        route: "native",
        status: 200,
        total_latency_ms: 1,
        provider_attempts: 1,
        gateway_retry_count: 0,
      });
      log.close();
      assert.equal(statSync(`${path}.1`).size, existingBytes);
      assert.doesNotMatch(readFileSync(`${path}.1`, "utf8"), /\u0000/);
      assert.equal(JSON.parse(readFileSync(path, "utf8")).kind, "request_end");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not synthesize missing provider usage fields in request diagnostics", () => {
    assert.deepEqual(
      compactUsageEventFromEnvelope({ usage: { input_tokens: 4, output_tokens: 2 } }),
      { input_tokens: 4, output_tokens: 2 },
    );
  });

  it("uses one content-free run digest across request events", () => {
    const first = createGatewayRequestContext("/v1/responses");
    const second = createGatewayRequestContext("/v1/responses");
    assert.match(first.run_sha8, /^[a-f0-9]{8}$/);
    assert.equal(first.run_sha8, second.run_sha8);
    assert.equal(recordGatewayRequestEnd(first, 200).run_sha8, first.run_sha8);
  });

  it("classifies invalid Ollama bodies without retaining content", () => {
    const secret = Buffer.from("  <html>SECRET_BODY</html>", "utf8");
    const diagnostic = observeOllamaInvalidJson(
      secret,
      new Headers({
        "content-type": "application/json; charset=utf-8",
        "content-length": String(secret.length),
        "content-encoding": "identity",
      }),
      3.6,
      200,
    );
    assert.equal(diagnostic.raw_bytes, secret.length);
    assert.equal(diagnostic.raw_sha8.length, 8);
    assert.equal(diagnostic.content_type_class, "json");
    assert.equal(diagnostic.content_length_state, "present");
    assert.equal(diagnostic.content_length_match, true);
    assert.equal(diagnostic.content_encoding_class, "identity");
    assert.equal(diagnostic.first_significant_byte, "3c");
    assert.equal(diagnostic.body_class, "possible_html");
    assert.equal(diagnostic.body_read_latency_ms, 4);
    assert.equal(JSON.stringify(diagnostic).includes("SECRET_BODY"), false);
  });

  it("omits a content-length match when the header is not comparable", () => {
    const cases = [
      { body: Buffer.from("data: SECRET\n\n"), contentType: "text/event-stream", length: "not-a-length", expected: "possible_sse" },
      { body: Buffer.alloc(0), contentType: "text/html", length: undefined, expected: "empty" },
      { body: Buffer.from([0xff, 0x00, 0x01]), contentType: "application/octet-stream", length: "999999999999999999999", expected: "binary" },
    ] as const;
    for (const entry of cases) {
      const headers = new Headers({ "content-type": entry.contentType });
      if (entry.length !== undefined) headers.set("content-length", entry.length);
      const diagnostic = observeOllamaInvalidJson(entry.body, headers, 0);
      assert.equal(diagnostic.body_class, entry.expected);
      assert.equal("content_length_match" in diagnostic, false);
      assert.equal(JSON.stringify(diagnostic).includes("SECRET"), false);
    }
  });

  it("does not compare encoded content length with decoded bytes", () => {
    const body = Buffer.from("not-json", "utf8");
    const diagnostic = observeOllamaInvalidJson(
      body,
      new Headers({
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": String(body.length),
      }),
      1,
    );
    assert.equal(diagnostic.content_length_state, "present");
    assert.equal("content_length_match" in diagnostic, false);
    assert.equal(diagnostic.content_encoding_class, "gzip");
  });

  const events: GatewayDiagnosticEventV1[] = [
    {
      schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
      kind: "request_route",
      route: "ollama",
      model: "ollama/deepseek-v4-flash:0731-cloud",
    },
    {
      schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
      kind: "compact_start",
      provider: "ollama",
      thread_model: "ollama/deepseek-v4-flash:0731-cloud",
      compact_model: "ollama/deepseek-v4-flash:0731-cloud",
      group_sha8: "abcd1234",
      attempt: 2,
    },
    {
      schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
      kind: "compact_success",
      transcript_format_version: 2,
      latency_ms: 3297,
      summary_bytes: 830,
      effort: "high",
      sections: { Goal: 1, Constraints: 1 },
      usage: compactUsageEventFromMetrics({ inputTokens: 13896, outputTokens: 561 }),
      group_sha8: "abcd1234",
      attempt: 2,
    },
    {
      schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
      kind: "compact_failure",
      code: "compaction_summary_incomplete",
      group_sha8: "abcd1234",
      attempt: 3,
      transcript_format_version: 2,
      summary_bytes: 347,
      effort: "omitted",
      sections: { Goal: 0, Constraints: 0 },
    },
    {
      schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
      kind: "upstream_terminal",
      terminal: "eof",
      status: 200,
      raw_bytes: 512,
      completed: false,
      done: false,
      malformed: true,
      phase: "tainted",
      done_n: 1,
      contra_n: 2,
      held_malformed: true,
    },
    {
      schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
      kind: "guard_rejection",
      code: "ollama_undeclared_tool_call",
      guard_kind: "undeclared",
      name_length: 11,
      name_sha8: "aa11bb22",
      declared_count: 10,
      declared_sha8: "cc33dd44",
    },
    {
      schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
      kind: "gate5_observation",
      classification: "model_declined",
      declaration_present: true,
      outbound_alias_present: true,
      model_call_observed: false,
      restoration_observed: false,
    },
    {
      schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
      kind: "request_end",
      timestamp: new Date().toISOString(),
      pid: process.pid,
      request_seq: 42,
      request_fp8: "abcd1234",
      route: "ollama",
      status: 200,
      total_latency_ms: 123,
      provider_attempts: 1,
      gateway_retry_count: 0,
      outbound_stream: true,
      response_content_type_class: "sse",
      decoder_mode: "sse_header",
      hosted_tools_dropped_n: 1,
    },
  ];

  it("formats byte-compatible human lines from the typed events", () => {
    assert.equal(
      formatGatewayDiagnosticEvent(events[0]!),
      "[cob] request route=ollama model=ollama/deepseek-v4-flash:0731-cloud",
    );
    assert.equal(
      formatGatewayDiagnosticEvent(events[1]!),
      "[cob] compaction_trigger target=ollama/deepseek-v4-flash:0731-cloud compaction provider: ollama/deepseek-v4-flash:0731-cloud compact_group=abcd1234 compact_attempt=2",
    );
    assert.equal(
      formatGatewayDiagnosticEvent(events[2]!),
      "[cob] ollama compact ok transcript_v=2 latency_ms=3297 summary_bytes=830 effort=high sections=Goal:1,Constraints:1 in=13896 out=561 cache=- total=- prompt_eval_n=- prompt_eval_ms=- eval_ms=- compact_group=abcd1234 compact_attempt=2",
    );
    assert.equal(
      formatGatewayDiagnosticEvent(events[3]!),
      "[cob] ollama compact failed code=compaction_summary_incomplete transcript_v=2 summary_bytes=347 effort=omitted sections=Goal:0,Constraints:0 tokens=omitted compact_group=abcd1234 compact_attempt=3",
    );
    assert.equal(
      formatGatewayDiagnosticEvent(events[4]!),
      "[cob] ollama stream incomplete terminal=eof status=200 raw_bytes=512 completed=false done=false malformed=true phase=tainted done_n=1 contra_n=2 held_malformed=true",
    );
    assert.equal(
      formatGatewayDiagnosticEvent(events[5]!),
      "[cob] ollama guard rejected code=ollama_undeclared_tool_call kind=undeclared name_len=11 name_sha=aa11bb22 declared_n=10 declared_sha=cc33dd44",
    );
    assert.equal(
      formatGatewayDiagnosticEvent(events[7]!),
      "[cob] request_end request_seq=42 route=ollama",
    );
  });

  it("classifies Ollama content-type headers into structural classes", () => {
    assert.equal(classifyOllamaContentType("text/event-stream"), "sse");
    assert.equal(classifyOllamaContentType("text/event-stream; charset=utf-8"), "sse");
    assert.equal(classifyOllamaContentType("application/json"), "json");
    assert.equal(classifyOllamaContentType("application/problem+json; charset=utf-8"), "json");
    assert.equal(classifyOllamaContentType("text/html"), "html");
    assert.equal(classifyOllamaContentType("text/html; charset=iso-8859-1"), "html");
    assert.equal(classifyOllamaContentType("text/plain"), "text");
    assert.equal(classifyOllamaContentType("application/octet-stream"), "other");
    assert.equal(classifyOllamaContentType("image/png"), "other");
    assert.equal(classifyOllamaContentType(null), "absent");
    assert.equal(classifyOllamaContentType(""), "absent");
    assert.equal(classifyOllamaContentType("   "), "absent");
  });

  it("records outbound diagnostic evidence in request_end while preserving schema_version 1", () => {
    const context = createGatewayRequestContext("/v1/responses");
    context.route = "ollama";
    context.provider_attempts = 1;
    context.outbound_stream = true;
    context.response_content_type_class = "sse";
    context.decoder_mode = "sse_header";
    context.hosted_tools_dropped_n = 2;

    const event = recordGatewayRequestEnd(context, 200, 1024);
    assert.equal(event.schema_version, 1);
    assert.equal(event.kind, "request_end");
    assert.equal(event.route, "ollama");
    assert.equal(event.status, 200);
    assert.equal(event.response_bytes, 1024);
    assert.equal(event.provider_attempts, 1);
    assert.equal(event.outbound_stream, true);
    assert.equal(event.response_content_type_class, "sse");
    assert.equal(event.decoder_mode, "sse_header");
    assert.equal(event.hosted_tools_dropped_n, 2);

    const nativeContext = createGatewayRequestContext("/v1/responses");
    nativeContext.route = "native";
    nativeContext.provider_attempts = 1;
    const nativeEvent = recordGatewayRequestEnd(nativeContext, 200, 512);
    assert.equal("outbound_stream" in nativeEvent, false);
    assert.equal("response_content_type_class" in nativeEvent, false);
    assert.equal("decoder_mode" in nativeEvent, false);
    assert.equal("hosted_tools_dropped_n" in nativeEvent, false);
  });

  it("emits one JSONL event object per line with schema_version 1", () => {
    const previous = process.env.COB_DIAGNOSTIC_JSONL;
    process.env.COB_DIAGNOSTIC_JSONL = "1";
    try {
      for (const event of events) {
        const line = captureStderr(() => emitGatewayDiagnosticEvent(event));
        const parsed = JSON.parse(line) as { schema_version: number; kind: string };
        assert.equal(parsed.schema_version, 1);
        assert.equal(parsed.kind, event.kind);
      }
    } finally {
      if (previous === undefined) delete process.env.COB_DIAGNOSTIC_JSONL;
      else process.env.COB_DIAGNOSTIC_JSONL = previous;
    }
  });

  it("keeps default live output human text, never JSONL", () => {
    const previous = process.env.COB_DIAGNOSTIC_JSONL;
    delete process.env.COB_DIAGNOSTIC_JSONL;
    try {
      const output = captureStderr(() => emitGatewayDiagnosticEvent(events[1]!));
      assert.match(output, /^\[cob\] compaction_trigger /);
      assert.equal(output.startsWith("{"), false);
    } finally {
      if (previous !== undefined) process.env.COB_DIAGNOSTIC_JSONL = previous;
    }
  });

  it("never carries prompt/response text, tool names, ids, auth, nonce, or account fields", () => {
    for (const event of events) {
      const serialized = JSON.stringify(event);
      for (const forbidden of SENSITIVE) {
        assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
      }
      const keys = Object.keys(event);
      for (const prohibited of ["prompt", "output_text", "tool_name", "schema", "arguments", "auth", "nonce", "account", "error_body"]) {
        assert.equal(
          keys.some((key) => key === prohibited),
          false,
          `prohibited key ${prohibited}`,
        );
      }
    }
  });
});
