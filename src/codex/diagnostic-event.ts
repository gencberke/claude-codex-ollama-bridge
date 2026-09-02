import { createHash, createHmac, randomBytes } from "node:crypto";
import { extractOllamaUsage, type OllamaUsageMetrics } from "./request-metrics.js";
import type { ApplyPatchClassification } from "./experimental/apply-patch.js";
import { isRecord } from "../core/json.js";

/**
 * Versioned gateway diagnostic events. One discriminated event type per
 * consumed log site; the default human log line is formatted from the event,
 * and an explicit dev/eval JSONL mode emits one event object per line with
 * `schema_version: 1`. Content-free by contract: no prompt/response text,
 * tool names or definitions, arguments, outputs, patch bodies, ids, auth,
 * nonce, account, or raw error bodies ever enter these events.
 */

export const GATEWAY_DIAGNOSTIC_SCHEMA_VERSION = 1;

export interface GatewayDiagnosticSink {
  write(event: GatewayDiagnosticEventV1): void;
}

export type GatewayRequestRoute = "native" | "ollama" | "native-search" | "unknown";

export type GatewayRequestMetrics = {
  raw_bytes: number;
  decoded_bytes?: number;
  instructions_bytes?: number;
  tools_bytes?: number;
  input_bytes?: number;
  text_bytes?: number;
  reasoning_bytes?: number;
  metadata_bytes?: number;
  tools_n?: number;
  input_n?: number;
  previous_response_id?: boolean;
  effort?: string;
  tools_sha8?: string;
  instructions_sha8?: string;
};

export type GatewayRequestContext = {
  request_seq: number;
  request_fp8: string;
  started_at: string;
  started_ms: number;
  route: GatewayRequestRoute;
  model_sha8?: string;
  metrics?: GatewayRequestMetrics;
  headers_latency_ms?: number;
  first_event_latency_ms?: number;
  response_bytes?: number;
  upstream_status?: number;
  terminal?: string;
  usage?: CompactUsageEvent;
  provider_attempts?: number;
  gateway_retry_count?: number;
  retry_after_present?: boolean;
  outbound_stream?: boolean;
  response_content_type_class?: OllamaContentTypeClass;
  decoder_mode?: OllamaDecoderMode;
  hosted_tools_dropped_n?: number;
  start_emitted: boolean;
  end_emitted: boolean;
};

let nextRequestSequence = 0;
const requestFingerprintKey = randomBytes(32);

export function createGatewayRequestContext(path: string, raw?: Buffer): GatewayRequestContext {
  const startedMs = performance.now();
  const requestSeq = nextRequestSequence = (nextRequestSequence + 1) % Number.MAX_SAFE_INTEGER;
  const fingerprint = createHmac("sha256", requestFingerprintKey)
    .update(path, "utf8")
    .update("\0")
    .update(raw ?? Buffer.alloc(0))
    .digest("hex")
    .slice(0, 8);
  return {
    request_seq: requestSeq,
    request_fp8: fingerprint,
    started_at: new Date().toISOString(),
    started_ms: startedMs,
    route: "unknown",
    start_emitted: false,
    end_emitted: false,
  };
}

export function setGatewayRequestFingerprint(
  context: GatewayRequestContext,
  path: string,
  raw: Buffer,
): void {
  context.request_fp8 = createHmac("sha256", requestFingerprintKey)
    .update(path, "utf8")
    .update("\0")
    .update(raw)
    .digest("hex")
    .slice(0, 8);
}

export function modelSha8(model: string): string {
  return createHash("sha256").update(model, "utf8").digest("hex").slice(0, 8);
}

const DIAGNOSTIC_EFFORTS = new Set(["-", "none", "low", "medium", "high", "xhigh", "max", "ultra"]);

export function normalizeDiagnosticEffort(effort: string): string {
  return DIAGNOSTIC_EFFORTS.has(effort) ? effort : "other";
}

export function elapsedMs(startedMs: number): number {
  const elapsed = performance.now() - startedMs;
  return Number.isFinite(elapsed) && elapsed >= 0 ? Math.round(elapsed) : 0;
}

export type CompactUsageEvent = {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  total_tokens?: number;
  prompt_eval_count?: number;
  prompt_eval_duration_ms?: number;
  eval_duration_ms?: number;
};

export type OllamaContentTypeClass = "absent" | "json" | "sse" | "html" | "text" | "other";
export type OllamaDecoderMode = "sse_header" | "sse_sniff" | "json";
export type OllamaContentEncodingClass = "absent" | "identity" | "gzip" | "deflate" | "br" | "other";
export type OllamaContentLengthState = "absent" | "invalid" | "present";
export type OllamaInvalidJsonBodyClass =
  | "empty"
  | "possible_sse"
  | "possible_html"
  | "possible_json"
  | "text"
  | "binary";

export type OllamaInvalidJsonDiagnostic = {
  status: number;
  raw_bytes: number;
  raw_sha8: string;
  content_type_class: OllamaContentTypeClass;
  content_length_state: OllamaContentLengthState;
  /** Present only when the upstream header is a comparable decimal value. */
  content_length_match?: boolean;
  content_encoding_class: OllamaContentEncodingClass;
  /** Hex byte after a UTF-8 BOM and JSON whitespace, or `-` for empty. */
  first_significant_byte: string;
  body_class: OllamaInvalidJsonBodyClass;
  body_read_latency_ms: number;
};

export type GatewayDiagnosticEventV1 =
  | {
      schema_version: typeof GATEWAY_DIAGNOSTIC_SCHEMA_VERSION;
      kind: "request_route";
      route: "native" | "ollama" | "native-search";
      model: string;
    }
  | {
      schema_version: typeof GATEWAY_DIAGNOSTIC_SCHEMA_VERSION;
      kind: "request_start";
      timestamp: string;
      pid: number;
      request_seq: number;
      request_fp8: string;
      route: GatewayRequestRoute;
      model_sha8?: string;
      metrics?: GatewayRequestMetrics;
    }
  | {
      schema_version: typeof GATEWAY_DIAGNOSTIC_SCHEMA_VERSION;
      kind: "request_end";
      timestamp: string;
      pid: number;
      request_seq: number;
      request_fp8: string;
      route: GatewayRequestRoute;
      model_sha8?: string;
      status: number;
      total_latency_ms: number;
      headers_latency_ms?: number;
      first_event_latency_ms?: number;
      response_bytes?: number;
      upstream_status?: number;
      terminal?: string;
      provider_attempts: number;
      gateway_retry_count: number;
      retry_after_present?: boolean;
      outbound_stream?: boolean;
      response_content_type_class?: OllamaContentTypeClass;
      decoder_mode?: OllamaDecoderMode;
      hosted_tools_dropped_n?: number;
      usage?: CompactUsageEvent;
    }
  | {
      schema_version: typeof GATEWAY_DIAGNOSTIC_SCHEMA_VERSION;
      kind: "compact_start";
      provider: "native" | "ollama";
      thread_model: string;
      compact_model: string;
      group_sha8: string;
      attempt: number;
    }
  | {
      schema_version: typeof GATEWAY_DIAGNOSTIC_SCHEMA_VERSION;
      kind: "compact_success";
      transcript_format_version: number;
      latency_ms: number;
      summary_bytes: number;
      effort: string;
      sections: Record<string, number>;
      usage?: CompactUsageEvent;
      group_sha8: string;
      attempt: number;
    }
  | {
      schema_version: typeof GATEWAY_DIAGNOSTIC_SCHEMA_VERSION;
      kind: "compact_failure";
      code: string;
      group_sha8: string;
      attempt: number;
      transcript_format_version?: number;
      summary_bytes?: number;
      effort?: string;
      sections?: Record<string, number>;
      usage?: CompactUsageEvent;
    }
  | {
      schema_version: typeof GATEWAY_DIAGNOSTIC_SCHEMA_VERSION;
      kind: "upstream_terminal";
      terminal: "empty" | "eof" | "idle" | "error" | "client_abort";
      status: number;
      raw_bytes: number;
      completed: boolean;
      done: boolean;
      malformed: boolean;
      phase?: string;
      done_n?: number;
      contra_n?: number;
      held_malformed?: boolean;
    }
  | {
      schema_version: typeof GATEWAY_DIAGNOSTIC_SCHEMA_VERSION;
      kind: "guard_rejection";
      code: string;
      guard_kind: string;
      name_length: number;
      name_sha8: string;
      declared_count: number;
      declared_sha8: string;
    }
  | ({
      schema_version: typeof GATEWAY_DIAGNOSTIC_SCHEMA_VERSION;
      kind: "ollama_invalid_json";
    } & OllamaInvalidJsonDiagnostic)
  | {
      schema_version: typeof GATEWAY_DIAGNOSTIC_SCHEMA_VERSION;
      kind: "gate5_observation";
      classification: ApplyPatchClassification;
      declaration_present: boolean;
      outbound_alias_present: boolean;
      model_call_observed: boolean;
      restoration_observed: boolean;
      child_custom_call_observed?: boolean;
      child_custom_output_observed?: boolean;
      execution_effect_observed?: boolean;
    };

export function recordGatewayRequestEnd(
  context: GatewayRequestContext,
  status: number,
  responseBytes?: number,
): Extract<GatewayDiagnosticEventV1, { kind: "request_end" }> {
  return {
    schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
    kind: "request_end",
    timestamp: new Date().toISOString(),
    pid: process.pid,
    request_seq: context.request_seq,
    request_fp8: context.request_fp8,
    route: context.route,
    ...(context.model_sha8 ? { model_sha8: context.model_sha8 } : {}),
    status,
    total_latency_ms: elapsedMs(context.started_ms),
    ...(context.headers_latency_ms === undefined ? {} : { headers_latency_ms: context.headers_latency_ms }),
    ...(context.first_event_latency_ms === undefined ? {} : { first_event_latency_ms: context.first_event_latency_ms }),
    ...(responseBytes === undefined ? {} : { response_bytes: responseBytes }),
    ...(context.upstream_status === undefined ? {} : { upstream_status: context.upstream_status }),
    ...(context.terminal === undefined ? {} : { terminal: context.terminal }),
    provider_attempts: context.provider_attempts ?? 0,
    gateway_retry_count: context.gateway_retry_count ?? 0,
    ...(context.retry_after_present === undefined ? {} : { retry_after_present: context.retry_after_present }),
    ...(context.outbound_stream === undefined ? {} : { outbound_stream: context.outbound_stream }),
    ...(context.response_content_type_class === undefined ? {} : { response_content_type_class: context.response_content_type_class }),
    ...(context.decoder_mode === undefined ? {} : { decoder_mode: context.decoder_mode }),
    ...(context.hosted_tools_dropped_n === undefined ? {} : { hosted_tools_dropped_n: context.hosted_tools_dropped_n }),
    ...(context.usage ? { usage: context.usage } : {}),
  };
}

/** Dev/eval-only JSONL mode; default live behavior remains human text. */
export function gatewayDiagnosticJsonlEnabled(): boolean {
  return process.env.COB_DIAGNOSTIC_JSONL === "1";
}

/**
 * Emit one diagnostic event. Human mode prints the byte-compatible log line
 * formatted from the event; JSONL mode prints one event object per line.
 */
export function emitGatewayDiagnosticEvent(event: GatewayDiagnosticEventV1): void {
  emitGatewayDiagnosticEventTo(event);
}

export function emitGatewayDiagnosticEventTo(
  event: GatewayDiagnosticEventV1,
  sink?: GatewayDiagnosticSink,
): void {
  if (gatewayDiagnosticJsonlEnabled()) {
    const redacted = redactPersistedEvent(event);
    safeWriteDiagnosticSink(sink, redacted);
    console.error(JSON.stringify(redacted));
    return;
  }
  console.error(formatGatewayDiagnosticEvent(event));
}

/** Persist an event without adding a new human log line. */
export function persistGatewayDiagnosticEvent(
  event: GatewayDiagnosticEventV1,
  sink?: GatewayDiagnosticSink,
): void {
  if (gatewayDiagnosticJsonlEnabled()) safeWriteDiagnosticSink(sink, redactPersistedEvent(event));
}

function safeWriteDiagnosticSink(
  sink: GatewayDiagnosticSink | undefined,
  event: GatewayDiagnosticEventV1,
): void {
  if (!sink) return;
  try {
    sink.write(event);
  } catch {
    // Structured diagnostics are best-effort and must never fail a request.
  }
}

function redactPersistedEvent(event: GatewayDiagnosticEventV1): GatewayDiagnosticEventV1 {
  switch (event.kind) {
    case "request_route":
      return { ...event, model: modelSha8(event.model) };
    case "compact_start":
      return {
        ...event,
        thread_model: modelSha8(event.thread_model),
        compact_model: modelSha8(event.compact_model),
      };
    default:
      return event;
  }
}

export function compactUsageEventFromMetrics(
  metrics: OllamaUsageMetrics | undefined,
): CompactUsageEvent | undefined {
  if (!metrics) return undefined;
  const event: CompactUsageEvent = {};
  if (metrics.inputTokens !== undefined) event.input_tokens = metrics.inputTokens;
  if (metrics.outputTokens !== undefined) event.output_tokens = metrics.outputTokens;
  if (metrics.cachedInputTokens !== undefined) event.cached_input_tokens = metrics.cachedInputTokens;
  if (metrics.totalTokens !== undefined) event.total_tokens = metrics.totalTokens;
  if (metrics.promptEvalCount !== undefined) event.prompt_eval_count = metrics.promptEvalCount;
  if (metrics.promptEvalDurationMs !== undefined) event.prompt_eval_duration_ms = metrics.promptEvalDurationMs;
  if (metrics.evalDurationMs !== undefined) event.eval_duration_ms = metrics.evalDurationMs;
  return event;
}

/** Map only provider-supplied usage fields for request terminal events. */
export function compactUsageEventFromEnvelope(envelope: unknown): CompactUsageEvent | undefined {
  const event = compactUsageEventFromMetrics(extractOllamaUsage(envelope));
  if (!event || !isRecord(envelope)) return event;
  const usage = isRecord(envelope.usage) ? envelope.usage : undefined;
  if (event.total_tokens !== undefined && !Number.isFinite(usage?.total_tokens)) {
    delete event.total_tokens;
  }
  return event;
}

export function sanitizeDiagnosticToken(value: string): string {
  const cleaned = value.replace(/[\r\n\u0000]+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : "-";
}

/** Byte-compatible human log lines, formatted from the typed event. */
export function formatGatewayDiagnosticEvent(event: GatewayDiagnosticEventV1): string {
  switch (event.kind) {
    case "request_start":
    case "request_end":
      return `[cob] ${event.kind} request_seq=${event.request_seq} route=${event.route}`;
    case "request_route":
      // JSONL-only event: no default human line exists for pure routing.
      return `[cob] request route=${sanitizeDiagnosticToken(event.route)} model=${sanitizeDiagnosticToken(event.model)}`;
    case "compact_start":
      return `[cob] compaction_trigger target=${sanitizeDiagnosticToken(event.thread_model)} compaction provider: ${sanitizeDiagnosticToken(`${event.provider}/${stripOllamaPrefix(event.compact_model)}`)} compact_group=${event.group_sha8} compact_attempt=${event.attempt}`;
    case "compact_success":
      return (
        `[cob] ollama compact ok transcript_v=${event.transcript_format_version}` +
        ` latency_ms=${event.latency_ms} summary_bytes=${event.summary_bytes} effort=${event.effort}` +
        ` sections=${formatSectionFlags(event.sections)}` +
        ` ${event.usage ? formatUsageTokens(event.usage) : "tokens=omitted"}` +
        ` compact_group=${event.group_sha8} compact_attempt=${event.attempt}`
      );
    case "compact_failure": {
      let line = `[cob] ollama compact failed code=${event.code}`;
      if (event.transcript_format_version !== undefined) {
        line += ` transcript_v=${event.transcript_format_version}`;
      }
      if (event.summary_bytes !== undefined) line += ` summary_bytes=${event.summary_bytes}`;
      if (event.effort !== undefined) line += ` effort=${event.effort}`;
      if (event.sections !== undefined) line += ` sections=${formatSectionFlags(event.sections)}`;
      if (event.summary_bytes !== undefined || event.sections !== undefined) {
        line += ` ${event.usage ? formatUsageTokens(event.usage) : "tokens=omitted"}`;
      }
      return `${line} compact_group=${event.group_sha8} compact_attempt=${event.attempt}`;
    }
    case "upstream_terminal": {
      let line =
        `[cob] ollama stream incomplete terminal=${event.terminal} status=${event.status}` +
        ` raw_bytes=${event.raw_bytes} completed=${event.completed} done=${event.done} malformed=${event.malformed}`;
      if (event.phase !== undefined) {
        line += ` phase=${event.phase} done_n=${event.done_n ?? 0} contra_n=${event.contra_n ?? 0} held_malformed=${event.held_malformed ?? false}`;
      }
      return line;
    }
    case "guard_rejection":
      return (
        `[cob] ollama guard rejected code=${event.code} kind=${event.guard_kind}` +
        ` name_len=${event.name_length} name_sha=${event.name_sha8}` +
        ` declared_n=${event.declared_count} declared_sha=${event.declared_sha8}`
      );
    case "ollama_invalid_json": {
      const lengthMatch = event.content_length_match === undefined
        ? ""
        : ` content_length_match=${event.content_length_match}`;
      return [
        "[cob] ollama response invalid_json",
        `status=${event.status}`,
        `raw_bytes=${event.raw_bytes}`,
        `raw_sha8=${event.raw_sha8}`,
        `content_type_class=${event.content_type_class}`,
        `content_length_state=${event.content_length_state}${lengthMatch}`,
        `content_encoding_class=${event.content_encoding_class}`,
        `first_significant_byte=${event.first_significant_byte}`,
        `body_class=${event.body_class}`,
        `body_read_latency_ms=${event.body_read_latency_ms}`,
      ].join(" ");
    }
    case "gate5_observation":
      return [
        "[cob] gate5 observation",
        `classification=${event.classification}`,
        `declaration_present=${event.declaration_present}`,
        `outbound_alias_present=${event.outbound_alias_present}`,
        `model_call_observed=${event.model_call_observed}`,
        `restoration_observed=${event.restoration_observed}`,
        ...(event.child_custom_call_observed === undefined
          ? []
          : [`child_custom_call_observed=${event.child_custom_call_observed}`]),
        ...(event.child_custom_output_observed === undefined
          ? []
          : [`child_custom_output_observed=${event.child_custom_output_observed}`]),
        ...(event.execution_effect_observed === undefined
          ? []
          : [`execution_effect_observed=${event.execution_effect_observed}`]),
      ].join(" ");
  }
}

/**
 * Classify one buffered, invalid Ollama 2xx body without retaining or
 * returning its contents. The optional content-length match is omitted when
 * the provider header is absent or not a strict decimal byte count.
 */
export function observeOllamaInvalidJson(
  raw: Buffer,
  headers: Pick<Headers, "get">,
  bodyReadLatencyMs: number,
  status = 200,
): OllamaInvalidJsonDiagnostic {
  const contentType = classifyOllamaContentType(headers.get("content-type"));
  const contentEncoding = classifyOllamaContentEncoding(headers.get("content-encoding"));
  const contentLength = classifyOllamaContentLength(
    headers.get("content-length"),
    raw.length,
    contentEncoding === "absent" || contentEncoding === "identity",
  );
  const significant = firstSignificantByteOffset(raw);
  const firstByte = significant === undefined ? "-" : raw[significant]!.toString(16).padStart(2, "0");
  return {
    status,
    raw_bytes: raw.length,
    raw_sha8: createHash("sha256").update(raw).digest("hex").slice(0, 8),
    content_type_class: contentType,
    content_length_state: contentLength.state,
    ...(contentLength.match === undefined ? {} : { content_length_match: contentLength.match }),
    content_encoding_class: contentEncoding,
    first_significant_byte: firstByte,
    body_class: classifyOllamaInvalidJsonBody(raw, significant, contentType),
    body_read_latency_ms: Number.isFinite(bodyReadLatencyMs) && bodyReadLatencyMs >= 0
      ? Math.round(bodyReadLatencyMs)
      : 0,
  };
}

export function classifyOllamaContentType(value: string | null): OllamaContentTypeClass {
  if (value === null || value.trim().length === 0) return "absent";
  const mediaType = value.split(";", 1)[0]!.trim().toLowerCase();
  if (mediaType === "text/event-stream") return "sse";
  if (mediaType === "text/html") return "html";
  if (mediaType === "application/json" || mediaType.endsWith("+json")) return "json";
  if (mediaType.startsWith("text/")) return "text";
  return "other";
}

function classifyOllamaContentEncoding(value: string | null): OllamaContentEncodingClass {
  if (value === null || value.trim().length === 0) return "absent";
  const encoding = value.trim().toLowerCase();
  if (encoding.includes(",")) return "other";
  if (encoding === "identity") return "identity";
  if (encoding === "gzip") return "gzip";
  if (encoding === "deflate") return "deflate";
  if (encoding === "br") return "br";
  return "other";
}

function classifyOllamaContentLength(value: string | null, actual: number, comparable: boolean): {
  state: OllamaContentLengthState;
  match?: boolean;
} {
  if (value === null || value.trim().length === 0) return { state: "absent" };
  if (!/^\d+$/.test(value.trim())) return { state: "invalid" };
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed)) return { state: "invalid" };
  return { state: "present", ...(comparable ? { match: parsed === actual } : {}) };
}

function firstSignificantByteOffset(raw: Buffer): number | undefined {
  let index = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? 3 : 0;
  while (index < raw.length) {
    const byte = raw[index]!;
    if (byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x20) return index;
    index += 1;
  }
  return undefined;
}

function classifyOllamaInvalidJsonBody(
  raw: Buffer,
  significant: number | undefined,
  contentType: OllamaContentTypeClass,
): OllamaInvalidJsonBodyClass {
  if (significant === undefined) return "empty";
  const first = raw[significant]!;
  const prefix = raw.subarray(significant, Math.min(raw.length, significant + 6)).toString("ascii").toLowerCase();
  if (contentType === "sse" || prefix.startsWith("data:") || prefix.startsWith("event:")) return "possible_sse";
  if (first === 0x3c) return "possible_html";
  if (
    first === 0x7b || first === 0x5b || first === 0x22 || first === 0x2d ||
    (first >= 0x30 && first <= 0x39) || first === 0x74 || first === 0x66 || first === 0x6e
  ) return "possible_json";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(raw);
    return "text";
  } catch {
    return "binary";
  }
}

function formatSectionFlags(sections: Record<string, number>): string {
  return Object.entries(sections)
    .map(([name, flag]) => `${name.replaceAll(" ", "_").replaceAll("/", "_")}:${flag}`)
    .join(",");
}

function formatUsageTokens(usage: CompactUsageEvent): string {
  const fmt = (value: number | undefined): string => (value === undefined ? "-" : String(value));
  return [
    `in=${fmt(usage.input_tokens)}`,
    `out=${fmt(usage.output_tokens)}`,
    `cache=${fmt(usage.cached_input_tokens)}`,
    `total=${fmt(usage.total_tokens)}`,
    `prompt_eval_n=${fmt(usage.prompt_eval_count)}`,
    `prompt_eval_ms=${fmt(usage.prompt_eval_duration_ms)}`,
    `eval_ms=${fmt(usage.eval_duration_ms)}`,
  ].join(" ");
}

function stripOllamaPrefix(model: string): string {
  return model.startsWith("ollama/") ? model.slice("ollama/".length) : model;
}
