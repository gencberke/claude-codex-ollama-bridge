import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { NATIVE_RESPONSES_URL, NATIVE_SEARCH_URL } from "../constants.js";
import { DEFAULT_OLLAMA_URL } from "../../core/ollama/constants.js";
import { loadCatalogFile } from "../catalog/file.js";
import { isVerifiedCloudOllamaRow } from "../catalog/catalog.js";
import { ollamaReasoningLadderForModel } from "../capabilities.js";
import { decodeRequestBody, RequestDecodeError } from "../decode.js";
import { forwardNativeResponses, type HeaderMap, type UpstreamFetch } from "../native.js";
import {
  formatNativePlaintextSpawnRequestDrift,
  formatNativePlaintextSpawnResponseDiagnostic,
  mapNativePlaintextSpawnJson,
  NativePlaintextSpawnError,
  nativePlaintextSpawnError,
  observeNativePlaintextSpawnResponse,
  prepareNativePlaintextSpawn,
  nativePlaintextSpawnSseTransform,
  type NativePlaintextSpawnContext,
} from "../experimental/native-plaintext-spawn.js";
import {
  forwardOllamaResponses,
  isOllamaReject,
  mapOllamaReasoningEffort,
  normalizeOllamaResponse,
  ollamaSseTransform,
  observeApplyPatchTurn,
  prepareOllamaPayload,
} from "../ollama.js";
import { APPLY_PATCH_OMIT, COB_APPLY_PATCH_ALIAS } from "../experimental/apply-patch.js";
import { normalizeOllamaErrorBody } from "../ollama-boundary.js";
import { OLLAMA_DIALECT } from "../ollama-dialect.js";
import {
  createOllamaTerminalTrack,
  guardOllamaJsonResponse,
  ollamaGuardHttpBody,
  ollamaGuardSseTerminal,
  ollamaNonSuccessCode,
  sanitizeOllamaNonSuccessTerminal,
  ollamaTerminalTrackObserver,
  strictOllamaCompletedEnvelope,
  type OllamaGuardFailure,
  type OllamaResponseGuardState,
  type OllamaTerminalTrack,
  type OllamaToolDeclaration,
} from "../ollama-response-boundary.js";
import { nativeSlugsFromCatalog, routeModel, type RouteTarget } from "../route.js";
import type { CompactionPolicy, NativePlaintextSpawnPolicy } from "../config/schema.js";
import { classifyCompactionTrigger, compactionHeader, resolveCompactPlan } from "../compaction/policy.js";
import {
  buildOllamaSummarizerPayload,
  compactHandoffSectionFlags,
  incompleteOllamaCompactHandoffError,
  extractOllamaCompactSummary,
  ollamaSummaryHandoffItem,
  projectOllamaSummarizerHistory,
  OLLAMA_COMPACT_TRANSCRIPT_VERSION,
} from "../compaction/summary.js";
import {
  findCompactionInputItem,
  isResponseEnvelope,
  nativeCompactRequest,
  nativeCompactionResponseError,
  projectNativeCompactInput,
  unsupportedOllamaCompactMediaError,
} from "../compaction/native.js";
import { ollamaFollowUpInputError, projectOllamaInputValue } from "../ollama/history.js";
import {
  CobCompactEnvelopeError,
  encodeCobCompactEnvelope,
  newCobCompactIds,
} from "../compact-envelope.js";
import {
  NATIVE_HEADERS_TIMEOUT_MS,
  OLLAMA_HEADERS_TIMEOUT_MS,
} from "../limits.js";
import {
  BodyAbortedError,
  BodyLimitError,
  IDLE_TIMEOUT_MS,
  MAX_DECODED_BODY_BYTES,
  MAX_RAW_BODY_BYTES,
  MAX_UPSTREAM_BODY_BYTES,
  readLimitedBody,
  readLimitedResponse,
  UpstreamLimitError,
} from "../../core/http/body.js";
import {
  isBenignAbort,
  relayPassthrough,
  relayTransformed,
  type StreamFailureWriter,
} from "../../core/http/relay.js";
import { attachCancellation } from "../../core/http/cancellation.js";
import { IdleTimeoutError } from "../../core/http/timeouts.js";
import { SseLimitError, sseDoneTerminal, sseErrorTerminal, sseRewriteTransform, type SseObserver } from "../sse.js";
import { formatOllamaJsonOverflowLog, OllamaJsonOverflowError } from "../bounded-json.js";
import {
  classifyOllamaContentType,
  compactUsageEventFromMetrics,
  compactUsageEventFromEnvelope,
  createGatewayRequestContext,
  elapsedMs,
  emitGatewayDiagnosticEventTo,
  diagnosticSha8,
  gatewayDevModeEnabled,
  gatewayDiagnosticJsonlEnabled,
  GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
  isDiagnosticErrorCode,
  modelSha8,
  normalizeDiagnosticEffort,
  observeOllamaInvalidJson,
  persistGatewayDiagnosticEvent,
  recordGatewayRequestEnd,
  setGatewayRequestFingerprint,
  type GatewayRequestContext,
  type GatewayRequestTerminal,
  type GatewayDiagnosticSink,
} from "../diagnostic-event.js";
import type { CatalogFile } from "../types.js";
import type { JsonObject } from "../../core/json.js";
import { isRecord } from "../../core/json.js";
import {
  extractOllamaUsage,
  formatOllamaUsage,
  formatRequestMetrics,
  summarizeRequest,
} from "../request-metrics.js";
import {
  formatCompactAttemptLog,
  noteCompactAttempt,
  type CompactAttemptNote,
} from "../compact-attempt-log.js";
import type { ToolSearchBridge } from "../tool-search.js";
import { ConversationStateError, type StateHistoryItem } from "../state/schema.js";
import {
  publishCompactCheckpoint,
  publishOllamaCheckpoint,
  publishOllamaSummaryCheckpoint,
} from "../state/store.js";
import { ConversationStateStore } from "../state/store.js";
import { createStateHistoryItems, mergeStateHistory, stateHistoryValues } from "../state/history.js";
import { ollamaUpstreamModel } from "../route.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
]);
const responseDiagnostics = new WeakMap<ServerResponse, GatewayRequestContext>();

export type NativePlaintextSpawnDriftRecord = {
  code: string;
  observedSchemaSha256?: string;
  count: number;
};

export type GatewayOptionsBase = {
  host?: string;
  port: number;
  ollamaUrl?: string;
  catalog?: CatalogFile;
  catalogPath?: string;
  nativeFetch?: UpstreamFetch;
  ollamaFetch?: UpstreamFetch;
  nonce?: string;
  compaction?: CompactionPolicy;
  /** Isolated Gate 5; disabled unless the dev catalog policy opts in. */
  applyPatch?: boolean;
  /** Disabled by default; applies to whichever model carries the namespace. */
  nativePlaintextSpawn?: NativePlaintextSpawnPolicy;
  /**
   * Process-local record of the last unrecognized collaboration schema. The
   * gateway writes it, `/healthz` publishes it, and `cob status` reads it back
   * so an operator can rotate the pinned digest after a Codex update. Never
   * persisted, and content-free: a cob-owned code and a schema digest.
   */
  nativePlaintextSpawnDrift?: NativePlaintextSpawnDriftRecord;
  /** Internal edge-triggered warning state for per-request catalog reloads. */
  catalogReloadFailed?: boolean;
  headersMs?: number;
  nativeHeadersMs?: number;
  ollamaHeadersMs?: number;
  /** @deprecated one-release alias for headersMs */
  connectMs?: number;
  idleMs?: number;
  stateRetention?: {
    maxNodes?: number;
    maxHeads?: number;
    maxBytes?: number;
    maxAgeMs?: number;
  };
  /** Explicit opt-in structured sidecar; active in JSONL or dev mode. */
  diagnosticSink?: GatewayDiagnosticSink;
  diagnosticPath?: string;
};

/**
 * At least one of stateDir / stateStore is required: the gateway never
 * guesses which codex home it persists checkpoints into.
 */
export type GatewayOptions =
  | (GatewayOptionsBase & { stateDir: string; stateStore?: ConversationStateStore })
  | (GatewayOptionsBase & { stateStore: ConversationStateStore; stateDir?: string });

/**
 * Collapse repeats of the same drift so a stale digest reports one fact with a
 * request count rather than growing state per turn.
 */
export function recordNativePlaintextSpawnDrift(
  options: GatewayOptions,
  error: { code: string; observed_schema_sha256?: string },
): void {
  const previous = options.nativePlaintextSpawnDrift;
  options.nativePlaintextSpawnDrift =
    previous && previous.code === error.code && previous.observedSchemaSha256 === error.observed_schema_sha256
      ? { ...previous, count: previous.count + 1 }
      : { code: error.code, observedSchemaSha256: error.observed_schema_sha256, count: 1 };
}

export async function handleNativeSearchPost(
  req: IncomingMessage,
  res: ServerResponse,
  options: GatewayOptions,
  path: string,
): Promise<void> {
  const abort = attachCancellation(req, res);
  const request = setupRequestDiagnostics(req, res, path, options);
  let inbound: { raw: Buffer; body: Buffer; decoded: boolean; encoding?: string };
  try {
    inbound = await readDecodedBody(req, abort.signal);
  } catch (error) {
    if (error instanceof BodyAbortedError || abort.signal.aborted) {
      markRequestStart(request, "native-search", undefined, Buffer.alloc(0), path, undefined, options.diagnosticSink);
      return;
    }
    if (error instanceof BodyLimitError) {
      markRequestStart(request, "native-search", undefined, Buffer.alloc(0), path, undefined, options.diagnosticSink);
      jsonError(res, error.status, error.code, error.message);
      req.destroy();
      return;
    }
    if (error instanceof RequestDecodeError) {
      markRequestStart(request, "native-search", undefined, Buffer.alloc(0), path, undefined, options.diagnosticSink);
      jsonError(res, 400, error.code, error.message);
      return;
    }
    markRequestStart(request, "native-search", undefined, Buffer.alloc(0), path, undefined, options.diagnosticSink);
    throw error;
  }

  markRequestStart(request, "native-search", undefined, inbound.raw, path, undefined, options.diagnosticSink, inbound.body.length);
  logNativeSearchRequest(req, path, inbound);
  const dispatchStarted = performance.now();
  if (request) request.provider_attempts = 1;
  const upstream = await forwardNativeResponses({
    body: inbound.body,
    headers: nativeHeaders(req, inbound.decoded),
    contentType: headerValue(req.headers["content-type"]) ?? "application/json",
    defaultAccept: "application/json",
    url: NATIVE_SEARCH_URL,
    fetchImpl: options.nativeFetch,
    signal: abort.signal,
    headersMs: resolveNativeHeadersMs(options),
  });
  markUpstreamHeaders(request, upstream.status, performance.now() - dispatchStarted, upstream.headers);
  await relay(upstream, res, abort, options);
}

function logRequest(
  req: IncomingMessage,
  path: string,
  inbound: { raw: Buffer; body: Buffer; decoded: boolean; encoding?: string },
  payload: JsonObject | undefined,
  target: RouteTarget,
): void {
  const model = typeof payload?.model === "string" ? payload.model : undefined;
  const prefix = inbound.raw.subarray(0, 8).toString("hex");
  const metrics = payload ? ` ${formatRequestMetrics(summarizeRequest(payload, inbound.body.length))}` : "";
  console.error(
    `[cob] ${req.method ?? "?"} ${path} encoding=${inbound.encoding ?? "identity"} raw=${inbound.raw.length} decoded=${inbound.decoded} json=${payload ? "ok" : "no"} model=${model ?? "-"} target=${target} magic=${prefix}${metrics}`,
  );
}

function setupRequestDiagnostics(
  _req: IncomingMessage,
  res: ServerResponse,
  path: string,
  options: GatewayOptions,
): GatewayRequestContext | undefined {
  if (!gatewayDiagnosticJsonlEnabled() || !options.diagnosticSink) return undefined;
  const context = createGatewayRequestContext(path);
  responseDiagnostics.set(res, context);
  if (gatewayDevModeEnabled()) {
    const thread = headerValue(_req.headers["thread-id"]) ?? headerValue(_req.headers["session_id"]);
    const parent = headerValue(_req.headers["x-codex-parent-thread-id"]);
    if (thread) context.thread_sha8 = diagnosticSha8(thread);
    if (parent) context.parent_thread_sha8 = diagnosticSha8(parent);
    const cpu = process.cpuUsage();
    context.cpu_started_us = cpu.user + cpu.system;
  }
  const finish = () => finishRequestDiagnostics(context, res, options.diagnosticSink);
  res.once("finish", finish);
  res.once("close", () => {
    if (!res.writableFinished && context.terminal === undefined) {
      context.terminal = "client_abort";
    }
    if (!res.writableFinished) finish();
  });
  return context;
}

function markRequestStart(
  context: GatewayRequestContext | undefined,
  route: GatewayRequestContext["route"],
  model: string | undefined,
  raw: Buffer,
  path: string,
  payload: JsonObject | undefined,
  sink?: GatewayDiagnosticSink,
  decodedBytes?: number,
): void {
  if (!context || context.start_emitted) return;
  setGatewayRequestFingerprint(context, path, raw);
  context.route = route;
  context.model_sha8 = model === undefined ? undefined : modelSha8(model);
  if (payload) {
    const metrics = summarizeRequest(payload, raw.length);
    context.metrics = {
      raw_bytes: raw.length,
      decoded_bytes: decodedBytes ?? metrics.decodedBytes,
      instructions_bytes: metrics.instructionsBytes,
      tools_bytes: metrics.toolsBytes,
      input_bytes: metrics.inputBytes,
      text_bytes: metrics.textBytes,
      reasoning_bytes: metrics.reasoningBytes,
      metadata_bytes: metrics.metadataBytes,
      tools_n: metrics.toolsCount,
      input_n: metrics.inputCount,
      previous_response_id: metrics.previousResponseId,
      effort: normalizeDiagnosticEffort(metrics.reasoningEffort),
      tools_sha8: metrics.toolsSha,
      instructions_sha8: metrics.instructionsSha,
    };
  } else {
    context.metrics = {
      raw_bytes: raw.length,
      ...(decodedBytes === undefined ? {} : { decoded_bytes: decodedBytes }),
    };
  }
  context.start_emitted = true;
  persistGatewayDiagnosticEvent(
    {
      schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
      kind: "request_start",
      timestamp: context.started_at,
      pid: process.pid,
      run_sha8: context.run_sha8,
      request_seq: context.request_seq,
      request_fp8: context.request_fp8,
      route: context.route,
      ...(context.model_sha8 ? { model_sha8: context.model_sha8 } : {}),
      metrics: context.metrics,
    },
    sink,
  );
}

function markUpstreamHeaders(
  context: GatewayRequestContext | undefined,
  status: number,
  latencyMs: number,
  headers: Pick<Headers, "get">,
): void {
  if (!context) return;
  context.upstream_status = status;
  context.headers_latency_ms = Number.isFinite(latencyMs) && latencyMs >= 0 ? Math.round(latencyMs) : 0;
  context.retry_after_present = headers.get("retry-after") !== null;
}

function finishRequestDiagnostics(
  context: GatewayRequestContext,
  res: ServerResponse,
  sink?: GatewayDiagnosticSink,
): void {
  if (context.end_emitted) return;
  if (context.cpu_started_us !== undefined) {
    const cpu = process.cpuUsage();
    context.cpu_ms = Math.round((cpu.user + cpu.system - context.cpu_started_us) / 1000);
    context.rss_mb = Math.round(process.memoryUsage.rss() / 1048576);
  }
  if (!context.start_emitted) {
    context.start_emitted = true;
    context.metrics = { raw_bytes: 0 };
    persistGatewayDiagnosticEvent(
      {
        schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
        kind: "request_start",
        timestamp: context.started_at,
        pid: process.pid,
        run_sha8: context.run_sha8,
        request_seq: context.request_seq,
        request_fp8: context.request_fp8,
        route: context.route,
        metrics: context.metrics,
      },
      sink,
    );
  }
  if (context.terminal === undefined) {
    context.terminal = res.statusCode >= 400 ? "http_error" : "completed";
  }
  context.end_emitted = true;
  const contentLength = Number(res.getHeader("content-length"));
  const responseBytes = Number.isSafeInteger(contentLength) && contentLength >= 0 ? contentLength : context.response_bytes;
  const event = recordGatewayRequestEnd(context, res.statusCode, responseBytes);
  responseDiagnostics.delete(res);
  if (event.terminal === "completed") persistGatewayDiagnosticEvent(event, sink);
  else emitGatewayDiagnosticEventTo(event, sink);
}

export async function handleResponsesPost(
  req: IncomingMessage,
  res: ServerResponse,
  options: GatewayOptions,
  path: string,
  kind: "responses" | "compact",
): Promise<void> {
  const abort = attachCancellation(req, res);
  const request = setupRequestDiagnostics(req, res, path, options);
  // One catalog snapshot per request: route, capability, and dispatch
  // decisions must not straddle an atomic catalog replacement.
  const catalogSnapshot = resolveCatalog(options, request);
  const nativeSlugs = nativeSlugsFromCatalog(catalogSnapshot);
  let inbound: { raw: Buffer; body: Buffer; decoded: boolean; encoding?: string };
  try {
    inbound = await readDecodedBody(req, abort.signal);
  } catch (error) {
    if (error instanceof BodyAbortedError || abort.signal.aborted) {
      markRequestStart(request, "unknown", undefined, Buffer.alloc(0), path, undefined, options.diagnosticSink);
      return;
    }
    if (error instanceof BodyLimitError) {
      markRequestStart(request, "unknown", undefined, Buffer.alloc(0), path, undefined, options.diagnosticSink);
      jsonError(res, error.status, error.code, error.message);
      req.destroy();
      return;
    }
    if (error instanceof RequestDecodeError) {
      markRequestStart(request, "unknown", undefined, Buffer.alloc(0), path, undefined, options.diagnosticSink);
      jsonError(res, 400, error.code, error.message);
      return;
    }
    markRequestStart(request, "unknown", undefined, Buffer.alloc(0), path, undefined, options.diagnosticSink);
    throw error;
  }

  if (request) setGatewayRequestFingerprint(request, path, inbound.raw);
  let payload: JsonObject;
  try {
    payload = parseResponsesJson(inbound.body);
  } catch (error) {
    if (error instanceof ResponsesParseError) {
      markRequestStart(request, "unknown", undefined, inbound.raw, path, undefined, options.diagnosticSink, inbound.body.length);
      jsonError(res, error.status, error.code, error.message);
      return;
    }
    markRequestStart(request, "unknown", undefined, inbound.raw, path, undefined, options.diagnosticSink, inbound.body.length);
    throw error;
  }

  const model = typeof payload.model === "string" ? payload.model.trim() : "";
  if (model.length === 0) {
    markRequestStart(request, "unknown", undefined, inbound.raw, path, payload, options.diagnosticSink, inbound.body.length);
    jsonError(res, 400, "missing_model", "Responses requests require a string model.");
    return;
  }

  const target = routeModel(model, nativeSlugs);
  markRequestStart(request, target, model, inbound.raw, path, payload, options.diagnosticSink, inbound.body.length);
  logRequest(req, path, inbound, payload, target);
  if (gatewayDiagnosticJsonlEnabled() && target !== "unknown") {
    emitGatewayDiagnosticEventTo({
      schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
      kind: "request_route",
      route: target,
      model: sanitizeLogToken(model),
    }, options.diagnosticSink);
  }

  if (target === "unknown") {
    jsonError(
      res,
      400,
      "unknown_model",
      "Requested model is not available in the native catalog or Ollama routes.",
    );
    return;
  }

  const trigger = classifyCompactionTrigger(payload);
  if (trigger.kind === "error") {
    jsonError(res, trigger.status, trigger.code, trigger.message);
    return;
  }

  if (kind === "compact") {
    await handleLegacyCompact(res);
    return;
  }

  if (trigger.kind === "trigger" && target === "ollama") {
    await handleOllamaCompactionTrigger(
      req,
      res,
      options,
      payload,
      trigger.inputWithoutTrigger,
      model,
      abort,
      catalogSnapshot,
      request,
    );
    return;
  }

  if (target === "ollama") {
    const expanded = await expandOllamaCompactionPayload(payload, stateStore(options), model);
    const applyPatch = options.applyPatch === true && catalogRowSupportsApplyPatch(catalogSnapshot, model);
    const prepared = prepareOllamaPayload(expanded, { applyPatch });
    if (isOllamaReject(prepared)) {
      json(res, prepared.status, prepared.body);
      return;
    }
    const continuation = await prepareOllamaContinuation(prepared, stateStore(options), expanded);
    const catalogModel = typeof continuation.payload.model === "string" ? continuation.payload.model : model;
    // Reuse the one verified cloud classification over the routed catalog row:
    // a remote_host tag without a cloud suffix must reject json_schema exactly
    // like other verified cloud routes.
    const cloudRoute = isVerifiedCloudOllamaRow(
      catalogModel,
      catalogSnapshot?.models.find((item) => String(item.slug) === catalogModel),
    );
    const dispatchStarted = performance.now();
    if (request) request.provider_attempts = 1;
    const forwarded = await forwardOllamaResponses({
      payload: continuation.payload,
      ollamaUrl: options.ollamaUrl ?? DEFAULT_OLLAMA_URL,
      fetchImpl: options.ollamaFetch,
      signal: abort.signal,
      headersMs: resolveOllamaHeadersMs(options),
      applyPatch,
      cloudRoute,
      // Checkpoints currently retain the raw provider function-call alias.
      // The original client payload was validated before this replay is
      // assembled, so only a resolved previous_response_id may authorize the
      // stored alias history on the final Ollama wire.
      allowTrustedApplyPatchAliasHistory: continuation.parentResponseId !== undefined,
      supportsReasoning: catalogRowSupportsReasoning(catalogSnapshot, catalogModel),
      onWirePrepared: ({ bridge, stream }) => {
        if (!request) return;
        request.outbound_stream = stream;
        request.hosted_tools_dropped_n = bridge.hostedToolsDroppedN;
      },
    });
    if (isOllamaReject(forwarded)) {
      if (request) request.provider_attempts = 0;
      json(res, forwarded.status, forwarded.body);
      return;
    }
    if (request) {
      request.response_content_type_class = classifyOllamaContentType(forwarded.response.headers.get("content-type"));
    }
    markUpstreamHeaders(request, forwarded.response.status, performance.now() - dispatchStarted, forwarded.response.headers);
    await relayOllama(forwarded.response, res, catalogModel, abort, options, {
      state: stateStore(options),
      requestInput: continuation.requestInput,
      requestInputProjection: continuation.requestInputProjection,
      baseHistory: continuation.baseHistory,
      parentResponseId: continuation.parentResponseId,
      catalogModel,
      signal: abort.signal,
    }, forwarded.bridge, forwarded.declaration, request);
    return;
  }

  const nativePrepared = prepareNativePlaintextSpawn(payload, options.nativePlaintextSpawn);
  if ("status" in nativePrepared && "body" in nativePrepared) {
    recordNativePlaintextSpawnDrift(options, nativePrepared.body.error);
    console.error(formatNativePlaintextSpawnRequestDrift(nativePrepared.body.error, "rejected"));
    json(res, nativePrepared.status, nativePrepared.body);
    return;
  }
  if (nativePrepared.drift) {
    recordNativePlaintextSpawnDrift(options, nativePrepared.drift);
    console.error(formatNativePlaintextSpawnRequestDrift(nativePrepared.drift, "passed_through"));
  }
  const nativeBody = nativePrepared.context
    ? encodeNativePayload(inbound.body, nativePrepared.payload)
    : inbound.body;
  const dispatchStarted = performance.now();
  if (request) request.provider_attempts = 1;
  const upstream = await forwardNativeResponses({
    body: nativeBody,
    headers: nativeHeaders(req, inbound.decoded),
    contentType: headerValue(req.headers["content-type"]) ?? "application/json",
    fetchImpl: options.nativeFetch,
    signal: abort.signal,
    headersMs: resolveNativeHeadersMs(options),
  });
  markUpstreamHeaders(request, upstream.status, performance.now() - dispatchStarted, upstream.headers);
  if (nativePrepared.context) {
    await relayNativePlaintextSpawn(upstream, res, abort, options, nativePrepared.context);
  } else {
    await relay(upstream, res, abort, options);
  }
}

async function expandOllamaCompactionPayload(
  payload: JsonObject,
  store: ConversationStateStore,
  model: string,
): Promise<JsonObject> {
  if (!Array.isArray(payload.input)) return payload;
  const compactionIndexes = payload.input.flatMap((item, index) =>
    isRecord(item) && item.type === "compaction" ? [index] : [],
  );
  if (compactionIndexes.length === 0) return payload;
  if (compactionIndexes.length !== 1) {
    throw new ConversationStateError(
      "state_checkpoint_conflict",
      "multiple compaction items are ambiguous; resend the full context",
    );
  }
  const item = findCompactionInputItem(payload);
  if (!item) return payload;
  const remainder = payload.input.filter((_value, index) => index !== compactionIndexes[0]);
  const previousId =
    typeof payload.previous_response_id === "string" ? payload.previous_response_id.trim() : "";
  // Prefer previous_response_id when both continuation hints are present.
  // Inline from the opaque item only when there is no local response id.
  if (previousId.length > 0) {
    const byId = await store.resolve(previousId);
    const byItem = await store.resolveCompactionItem(item, model);
    if (!(await store.lineageContains(byId.responseId, byItem.responseId))) {
      throw new ConversationStateError(
        "state_checkpoint_conflict",
        "previous_response_id and compaction item refer to different conversation state; resend the full context",
      );
    }
    return { ...payload, input: remainder };
  }
  const resolved = await store.resolveCompactionItem(item, model);
  return {
    ...payload,
    input: [...stateHistoryValues(resolved.history), ...remainder],
  };
}

export async function handleLegacyCompact(res: ServerResponse): Promise<void> {
  jsonError(
    res,
    400,
    "legacy_compaction_unavailable",
    "The legacy /v1/responses/compact endpoint is unavailable; send a normal /v1/responses request with one terminal compaction_trigger item.",
  );
}

async function handleOllamaCompactionTrigger(
  req: IncomingMessage,
  res: ServerResponse,
  options: GatewayOptions,
  payload: JsonObject,
  inputWithoutTrigger: unknown[],
  threadModel: string,
  abort: AbortController,
  catalogSnapshot: CatalogFile | undefined,
  request?: GatewayRequestContext,
): Promise<void> {
  const policy = options.compaction ?? { provider: "native" };
  const nativeSlugs = nativeSlugsFromCatalog(catalogSnapshot);
  const plan = resolveCompactPlan({
    threadModel,
    target: "ollama",
    policy,
    nativeSlugs,
  });

  if (plan.kind === "error") {
    jsonError(res, plan.status, plan.code, plan.message);
    return;
  }

  const triggerlessPayload = await expandOllamaCompactionPayload(
    { ...payload, input: inputWithoutTrigger },
    stateStore(options),
    threadModel,
  );
  // Compaction authorization follows the conversation's own thread row, never
  // the summarizer or compaction model.
  const threadApplyPatch =
    options.applyPatch === true && catalogRowSupportsApplyPatch(catalogSnapshot, threadModel);
  const prepared = prepareOllamaPayload(triggerlessPayload, { applyPatch: threadApplyPatch });
  if (isOllamaReject(prepared)) {
    json(res, prepared.status, prepared.body);
    return;
  }
  const continuation = await prepareOllamaContinuation(prepared, stateStore(options), triggerlessPayload);

  if (plan.kind === "summarize-ollama") {
    await handleOllamaSummaryCompact(
      res,
      options,
      continuation,
      threadModel,
      plan.compactModel,
      abort,
      payload.stream === true,
      catalogSnapshot,
      request,
    );
    return;
  }

  if (plan.kind !== "native-for-ollama") {
    jsonError(res, 400, "compaction_model_unavailable", "No compaction model is available.");
    return;
  }
  const nativeHistory = projectNativeCompactInput(stateHistoryValues(continuation.replayHistory));
  if (!Array.isArray(nativeHistory)) {
    throw new Error("internal error: native compact history projection must be an array");
  }
  const compactPayload = {
    ...continuation.payload,
    input: [...nativeHistory, { type: "compaction_trigger" }],
  };
  const compactNote = noteCompactAttempt({
    parentResponseId: continuation.parentResponseId,
    threadModel,
    replayHistory: continuation.replayHistory,
  });
  emitGatewayDiagnosticEventTo({
    schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
    kind: "compact_start",
    ...compactRequestFields(request),
    provider: "native",
    thread_model: sanitizeLogToken(threadModel),
    compact_model: sanitizeLogToken(plan.compactModel),
    group_sha8: compactNote.groupSha8,
    attempt: compactNote.attempt,
  }, options.diagnosticSink);
  const rewritten = nativeCompactRequest(compactPayload, plan.compactModel);
  const body = Buffer.from(JSON.stringify(rewritten), "utf8");
  const dispatchStarted = performance.now();
  if (request) request.provider_attempts = 1;
  let upstream: Response;
  try {
    upstream = await forwardNativeResponses({
      body,
      headers: nativeHeaders(req, true),
      contentType: "application/json",
      url: NATIVE_RESPONSES_URL,
      fetchImpl: options.nativeFetch,
      signal: abort.signal,
      headersMs: resolveNativeHeadersMs(options),
    });
  } catch (error) {
    emitCompactFailure(
      options,
      compactNote,
      abort.signal.aborted ? "native_compaction_aborted" : "native_compaction_dispatch_failed",
      request,
    );
    throw error;
  }
  markUpstreamHeaders(request, upstream.status, performance.now() - dispatchStarted, upstream.headers);
  await relayNativeOllamaCompaction(
    upstream,
    res,
    abort,
    options,
    {
      state: stateStore(options),
      requestInput: continuation.requestInput,
      requestInputProjection: continuation.requestInputProjection,
      baseHistory: continuation.baseHistory,
      parentResponseId: continuation.parentResponseId,
      catalogModel: threadModel,
      compactModel: plan.compactModel,
      signal: abort.signal,
    },
    compactNote,
    request,
  );
}

async function handleOllamaSummaryCompact(
  res: ServerResponse,
  options: GatewayOptions,
  continuation: OllamaContinuation,
  threadModel: string,
  compactModel: string,
  abort: AbortController,
  stream: boolean,
  catalogSnapshot: CatalogFile | undefined,
  request?: GatewayRequestContext,
): Promise<void> {
  const history = projectOllamaSummarizerHistory(stateHistoryValues(continuation.replayHistory));
  if (!Array.isArray(history) || history.length === 0) {
    jsonError(
      res,
      400,
      "compaction_empty_history",
      "Ollama compact requires conversation history to summarize; resend the full context without compacting",
      { requires_full_context: true },
    );
    return;
  }
  const mediaError = unsupportedOllamaCompactMediaError(history);
  if (mediaError) {
    jsonError(res, 400, "compaction_unsupported_input", mediaError, { requires_full_context: true });
    return;
  }
  const followUpError = ollamaFollowUpInputError(history);
  if (followUpError) {
    jsonError(res, 400, "compaction_context_required", followUpError, { requires_full_context: true });
    return;
  }
  const summarizerPayload = buildOllamaSummarizerPayload({
    compactModel,
    history,
    effort: options.compaction?.ollamaEffort,
  });
  // The summarizer's own tools-less request keeps the patch bridge closed;
  // the thread row's capability never elevates the compact model.
  const preparedSummarizer = prepareOllamaPayload(summarizerPayload);
  if (isOllamaReject(preparedSummarizer)) {
    json(res, preparedSummarizer.status, preparedSummarizer.body);
    return;
  }
  const compactNote = noteCompactAttempt({
    parentResponseId: continuation.parentResponseId,
    threadModel,
    replayHistory: continuation.replayHistory,
  });
  emitGatewayDiagnosticEventTo({
    schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
    kind: "compact_start",
    ...compactRequestFields(request),
    provider: "ollama",
    thread_model: sanitizeLogToken(threadModel),
    compact_model: sanitizeLogToken(compactModel),
    group_sha8: compactNote.groupSha8,
    attempt: compactNote.attempt,
  }, options.diagnosticSink);
  const compactStarted = Date.now();
  const supportsReasoning = catalogRowSupportsReasoning(catalogSnapshot, compactModel);
  const compactEffort = supportsReasoning
    ? mapOllamaReasoningEffort(options.compaction?.ollamaEffort, compactModel) ??
      ollamaReasoningLadderForModel(compactModel).defaultEffort
    : "omitted";
  const dispatchStarted = performance.now();
  if (request) request.provider_attempts = 1;
  let forwarded: Awaited<ReturnType<typeof forwardOllamaResponses>>;
  try {
    forwarded = await forwardOllamaResponses({
      payload: preparedSummarizer,
      ollamaUrl: options.ollamaUrl ?? DEFAULT_OLLAMA_URL,
      fetchImpl: options.ollamaFetch,
      signal: abort.signal,
      headersMs: resolveOllamaHeadersMs(options),
      supportsReasoning,
      onWirePrepared: ({ bridge, stream }) => {
        if (!request) return;
        request.outbound_stream = stream;
        request.hosted_tools_dropped_n = bridge.hostedToolsDroppedN;
      },
    });
  } catch (error) {
    emitCompactFailure(
      options,
      compactNote,
      abort.signal.aborted ? "ollama_compaction_aborted" : "ollama_compaction_dispatch_failed",
      request,
    );
    throw error;
  }
  if (isOllamaReject(forwarded)) {
    if (request) request.provider_attempts = 0;
    emitCompactFailure(options, compactNote, "ollama_compaction_prepare_failed", request);
    json(res, forwarded.status, forwarded.body);
    return;
  }
  if (request) {
    request.response_content_type_class = classifyOllamaContentType(forwarded.response.headers.get("content-type"));
  }
  const { response: upstream } = forwarded;
  markUpstreamHeaders(request, upstream.status, performance.now() - dispatchStarted, upstream.headers);
  const extra: Record<string, string> = {
    "x-cob-compaction": compactionHeader("ollama", compactModel),
  };
  let raw: Buffer;
  try {
    raw = await readLimitedResponse(upstream, MAX_UPSTREAM_BODY_BYTES, {
      idleMs: options.idleMs ?? IDLE_TIMEOUT_MS,
      signal: abort.signal,
    });
  } catch (error) {
    emitCompactFailure(options, compactNote, abort.signal.aborted ? "ollama_compaction_aborted" : "ollama_compaction_read_failed", request);
    throw error;
  }
  if (abort.signal.aborted) {
    emitCompactFailure(options, compactNote, "ollama_compaction_aborted", request);
    if (request) request.terminal = "client_abort";
    return;
  }
  if (upstream.status < 200 || upstream.status >= 300) {
    emitCompactFailure(options, compactNote, "ollama_compaction_http_failed", request);
    console.error(formatOllamaSummarizerHttpError(upstream.status, raw, Date.now() - compactStarted, compactNote));
    jsonError(
      res,
      502,
      "ollama_compaction_failed",
      "Ollama summarizer request failed; resend the full context.",
      { requires_full_context: true },
    );
    return;
  }
  let summarizerResponse: JsonObject | undefined;
  try {
    summarizerResponse = await parseSummarizerResponse(upstream, raw, request);
  } catch {
    emitCompactFailure(options, compactNote, "ollama_compaction_parse_failed", request);
    jsonError(
      res,
      502,
      "ollama_compaction_failed",
      "Ollama summarizer returned an invalid response; resend the full context.",
      { requires_full_context: true },
    );
    return;
  }
  const extracted = extractOllamaCompactSummary(summarizerResponse);
  if (extracted.kind === "error") {
    emitGatewayDiagnosticEventTo({
      schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
      kind: "compact_failure",
      ...compactRequestFields(request),
      code: extracted.code,
      group_sha8: compactNote.groupSha8,
      attempt: compactNote.attempt,
    }, options.diagnosticSink);
    jsonError(res, 400, extracted.code, extracted.message, { requires_full_context: true });
    return;
  }
  const incomplete = incompleteOllamaCompactHandoffError(extracted.text);
  if (incomplete) {
    const usage = extractOllamaUsage(summarizerResponse);
    emitGatewayDiagnosticEventTo({
      schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
      kind: "compact_failure",
      ...compactRequestFields(request),
      code: incomplete.code,
      group_sha8: compactNote.groupSha8,
      attempt: compactNote.attempt,
      transcript_format_version: OLLAMA_COMPACT_TRANSCRIPT_VERSION,
      summary_bytes: Buffer.byteLength(extracted.text, "utf8"),
      effort: compactEffort,
      sections: sectionEventFlags(extracted.text),
      usage: compactUsageEventFromMetrics(usage),
    }, options.diagnosticSink);
    jsonError(res, 400, incomplete.code, incomplete.message, { requires_full_context: true });
    return;
  }
  let envelope: string;
  try {
    envelope = encodeCobCompactEnvelope(extracted.text);
  } catch (error) {
    if (error instanceof CobCompactEnvelopeError) {
      emitCompactFailure(options, compactNote, error.code, request);
      jsonError(res, 400, error.code, error.message, { requires_full_context: true });
      return;
    }
    emitCompactFailure(options, compactNote, "ollama_compaction_envelope_failed", request);
    throw error;
  }
  const ids = newCobCompactIds();
  const compactionItem: JsonObject = {
    type: "compaction",
    id: ids.itemId,
    encrypted_content: envelope,
  };
  const response: JsonObject = {
    id: ids.responseId,
    object: "response",
    status: "completed",
    model: threadModel,
    output: [compactionItem],
  };
  const rawBody = stream ? cobCompactionSse(response, compactionItem) : Buffer.from(JSON.stringify(response), "utf8");
  try {
    await publishOllamaSummaryCheckpoint(
      {
        state: stateStore(options),
        requestInput: continuation.requestInput,
        requestInputProjection: [],
        baseHistory: continuation.baseHistory,
        parentResponseId: continuation.parentResponseId,
        signal: abort.signal,
      },
      response,
      rawBody,
      { model: threadModel, compactModel, upstreamModel: ollamaUpstreamModel(compactModel) },
      ollamaSummaryHandoffItem(extracted.text),
    );
  } catch {
    emitCompactFailure(options, compactNote, "ollama_compaction_checkpoint_failed", request);
    if (stream) {
      markGatewayResponseOutcome(res, "checkpoint_failed", "ollama_compaction_checkpoint_failed");
      res.writeHead(502, { "content-type": "text/event-stream", ...extra });
      res.end(sseErrorTerminal(
        "Ollama compact checkpoint publication failed; resend the full context.",
        "ollama_compaction_checkpoint_failed",
      ));
    } else {
      jsonError(
        res,
        502,
        "ollama_compaction_checkpoint_failed",
        "Ollama compact checkpoint publication failed; resend the full context",
        { requires_full_context: true },
      );
    }
    return;
  }
  logOllamaCompactOk({
    latencyMs: Date.now() - compactStarted,
    summaryBytes: Buffer.byteLength(extracted.text, "utf8"),
    sections: compactHandoffSectionFlags(extracted.text),
    effort: compactEffort,
    usage: extractOllamaUsage(summarizerResponse),
    compactNote,
    request,
    sink: options.diagnosticSink,
  });
  if (abort.signal.aborted) {
    emitCompactFailure(options, compactNote, "ollama_compaction_aborted", request);
    if (request) request.terminal = "client_abort";
    return;
  }
  if (request) {
    request.terminal = "completed";
    request.response_bytes = rawBody.length;
  }
  if (stream) {
    res.writeHead(200, { "content-type": "text/event-stream", ...extra });
    res.end(rawBody);
    return;
  }
  json(res, 200, response, extra);
}

/** Section-presence flags as a content-free 0/1 event record. */
function sectionEventFlags(text: string): Record<string, number> {
  return sectionEventFlagsFromFlags(compactHandoffSectionFlags(text));
}

function sectionEventFlagsFromFlags(flags: ReturnType<typeof compactHandoffSectionFlags>): Record<string, number> {
  return Object.fromEntries(Object.entries(flags).map(([name, present]) => [name, present ? 1 : 0]));
}

function logOllamaCompactOk(opts: {
  latencyMs: number;
  summaryBytes: number;
  sections: ReturnType<typeof compactHandoffSectionFlags>;
  effort: string;
  usage: ReturnType<typeof extractOllamaUsage>;
  compactNote: CompactAttemptNote;
  request?: GatewayRequestContext;
  sink?: GatewayDiagnosticSink;
}): void {
  emitGatewayDiagnosticEventTo({
    schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
    kind: "compact_success",
    ...compactRequestFields(opts.request),
    transcript_format_version: OLLAMA_COMPACT_TRANSCRIPT_VERSION,
    latency_ms: opts.latencyMs,
    summary_bytes: opts.summaryBytes,
    effort: opts.effort,
    sections: sectionEventFlagsFromFlags(opts.sections),
    usage: compactUsageEventFromMetrics(opts.usage),
    group_sha8: opts.compactNote.groupSha8,
    attempt: opts.compactNote.attempt,
  }, opts.sink);
}

function emitCompactFailure(
  options: GatewayOptions,
  compactNote: CompactAttemptNote,
  code: string,
  request?: GatewayRequestContext,
): void {
  emitGatewayDiagnosticEventTo(
    {
      schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
      kind: "compact_failure",
      ...compactRequestFields(request),
      code,
      group_sha8: compactNote.groupSha8,
      attempt: compactNote.attempt,
    },
    options.diagnosticSink,
  );
}

function compactRequestFields(request?: GatewayRequestContext): { run_sha8?: string; request_seq?: number } {
  return request ? { run_sha8: request.run_sha8, request_seq: request.request_seq } : {};
}

function formatOllamaSummarizerHttpError(
  status: number,
  raw: Buffer,
  latencyMs: number,
  compactNote: CompactAttemptNote,
): string {
  return [
    "[cob] ollama compact failed",
    "code=ollama_compaction_failed",
    `status=${status}`,
    `body_bytes=${raw.length}`,
    `body_sha=${createHash("sha256").update(raw).digest("hex").slice(0, 8)}`,
    `latency_ms=${latencyMs}`,
    formatCompactAttemptLog(compactNote),
  ].join(" ");
}

function sanitizeLogToken(value: string): string {
  const cleaned = value.replace(/[\r\n\u0000]+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : "-";
}

async function parseSummarizerResponse(
  upstream: Response,
  raw: Buffer,
  request?: GatewayRequestContext,
): Promise<JsonObject | undefined> {
  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    if (request) request.decoder_mode = "sse_header";
  } else if (looksLikeSse(raw)) {
    if (request) request.decoder_mode = "sse_sniff";
  } else {
    if (request) request.decoder_mode = "json";
  }
  const isSse = contentType.includes("text/event-stream") || looksLikeSse(raw);
  if (isSse) {
    const track = createOllamaTerminalTrack();
    // The observer is the tracker's single feeding point: onData runs before
    // the rewrite callback, so feeding the frame decisions from both would
    // taint the first held terminal as a post-terminal contradiction.
    await collectSseTransform(
      raw,
      sseRewriteTransform((value) => value, undefined, ollamaTerminalTrackObserver(track)),
    );
    if (track.phase !== "held-completed" || track.completedCandidate === undefined) {
      throw new Error("Ollama summarizer SSE did not end with a completed response");
    }
    return track.completedCandidate;
  }
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    const envelope = strictOllamaCompletedEnvelope(parsed);
    if (!envelope) {
      throw new Error("Ollama summarizer response is not a completed response");
    }
    return envelope;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Ollama summarizer response is not valid JSON");
    }
    throw error;
  }
}

function cobCompactionSse(response: JsonObject, item: JsonObject): Buffer {
  const created = {
    type: "response.created",
    response: {
      id: response.id,
      object: "response",
      model: response.model,
      status: "in_progress",
      output: [],
    },
  };
  const events = [
    created,
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  return Buffer.from(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
    "utf8",
  );
}

type OllamaContinuation = {
  payload: JsonObject;
  parentResponseId?: string;
  baseHistory: StateHistoryItem[];
  replayHistory: StateHistoryItem[];
  requestInput: unknown;
  requestInputProjection: unknown;
};

type OllamaStateContext = {
  state: ConversationStateStore;
  requestInput: unknown;
  requestInputProjection: unknown;
  baseHistory: StateHistoryItem[];
  parentResponseId?: string;
  catalogModel: string;
  compactModel?: string;
  /** Client cancellation; re-checked inside the checkpoint publish lock. */
  signal?: AbortSignal;
};

type StreamCapture = {
  rawBytes: number;
  sawDone: boolean;
  malformed: boolean;
  sawCompletedEvent: boolean;
  completedResponse?: JsonObject;
  compactionItem?: JsonObject;
  compactionItemDone: boolean;
  candidate?: JsonObject;
};

async function prepareOllamaContinuation(
  payload: JsonObject,
  store: ConversationStateStore,
  originalPayload: JsonObject = payload,
): Promise<OllamaContinuation> {
  let baseHistory: StateHistoryItem[] = [];
  let parentResponseId: string | undefined;
  if ("previous_response_id" in payload) {
    if (typeof payload.previous_response_id !== "string" || payload.previous_response_id.trim().length === 0) {
      throw new ConversationStateError(
        "state_checkpoint_unsafe",
        "previous_response_id is invalid; resend the full context without previous_response_id",
      );
    }
    parentResponseId = payload.previous_response_id;
    const resolved = await store.resolve(parentResponseId);
    baseHistory = resolved.history;
  }
  const requestInput = originalPayload.input;
  // `payload` is the provider-bound form produced by prepareOllamaPayload.
  // Keep originalPayload for checkpoint/audit metadata, but derive the
  // provider projection from the already-sanitized input. Otherwise a
  // provider rewrite (for example Gate 1-3's agent_message -> user message)
  // is silently discarded here when the continuation is assembled.
  const sourceInput = payload.input !== undefined ? payload.input : requestInput;
  const requestInputProjection = projectOllamaInputValue(sourceInput);
  const pending = createStateHistoryItems(requestInputProjection, "cob-pending-request", "request");
  const replayHistory = mergeStateHistory(baseHistory, pending);
  const next: JsonObject = { ...payload };
  if ("previous_response_id" in payload) {
    next.input = ollamaReplayInputValues(replayHistory);
  } else if (payload.input !== undefined) {
    next.input = requestInputProjection;
  }
  return {
    payload: next,
    parentResponseId,
    baseHistory,
    replayHistory,
    requestInput,
    requestInputProjection,
  };
}

/**
 * Ollama accepts a string as the entire Responses `input`, but every entry in
 * an `input[]` replay must be a typed item. Promote only archived top-level
 * strings at the continuation boundary; the initial request stays byte-shape
 * compatible with Ollama's string shorthand.
 */
function ollamaReplayInputValues(history: readonly StateHistoryItem[]): unknown[] {
  return stateHistoryValues(history).map((value) =>
    typeof value === "string"
      ? {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: value }],
        }
      : value,
  );
}

function stateStore(options: GatewayOptions): ConversationStateStore {
  if (!options.stateStore) {
    throw new Error("internal error: gateway state store was not initialized");
  }
  return options.stateStore;
}

function endOllamaStream(res: ServerResponse): void {
  // An incomplete SSE must end without [DONE]. This leaves the client with
  // the already-streamed prefix for diagnostics, but no valid completion
  // terminal that Codex could accept.
  if (!res.writableEnded && !res.destroyed) res.end();
}

function logOllamaStreamIncomplete(
  status: number,
  terminal: "empty" | "eof" | "idle" | "error" | "client_abort",
  capture: StreamCapture,
  track?: OllamaTerminalTrack,
  request?: GatewayRequestContext,
  sink?: GatewayDiagnosticSink,
): void {
  if (request) {
    request.terminal = terminal;
    request.response_bytes = capture.rawBytes;
    if (terminal !== "client_abort") {
      request.error_code = terminal === "idle" ? "idle_timeout" : "upstream_stream_error";
    }
  }
  emitGatewayDiagnosticEventTo({
    schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
    kind: "upstream_terminal",
    terminal,
    status,
    raw_bytes: capture.rawBytes,
    completed: capture.sawCompletedEvent,
    done: capture.sawDone,
    malformed: capture.malformed,
    ...(track
      ? {
          phase: track.phase,
          done_n: track.doneTrailers,
          contra_n: track.contradictoryFrames,
          held_malformed: track.malformed,
        }
      : {}),
  }, sink);
}

function createStreamCapture(): StreamCapture {
  return {
    rawBytes: 0,
    sawDone: false,
    malformed: false,
    sawCompletedEvent: false,
    compactionItemDone: false,
  };
}

/**
 * Compose two passive SSE observers over the same parsed events. The tracker
 * observer must be the stream's only terminal-feeding point; the capture
 * observer never feeds it.
 */
function composedSseObserver(primary: SseObserver, secondary: SseObserver): SseObserver {
  return {
    suppressDone: primary.suppressDone === true,
    onChunk(chunk) {
      primary.onChunk?.(chunk);
      secondary.onChunk?.(chunk);
    },
    onData(event) {
      secondary.onData?.(event);
      primary.onData?.(event);
    },
  };
}

function captureObserver(
  capture: StreamCapture,
  suppressDone = false,
  request?: GatewayRequestContext,
): SseObserver {
  return {
    suppressDone,
    onChunk(chunk) {
      if (request && request.first_event_latency_ms === undefined) {
        request.first_event_latency_ms = elapsedMs(request.started_ms);
      }
      capture.rawBytes += chunk.length;
      if (capture.rawBytes > MAX_UPSTREAM_BODY_BYTES) {
        throw new UpstreamLimitError();
      }
    },
    onData(event) {
      if (event.done) {
        capture.sawDone = true;
        return;
      }
      if (event.malformed) {
        capture.malformed = true;
        return;
      }
      if (!event.value || !isRecord(event.value)) return;
      if (event.value.type === "response.completed" && isRecord(event.value.response)) {
        capture.sawCompletedEvent = true;
        const completed = completedResponseEnvelope(event.value.response);
        if (completed) {
          capture.completedResponse = completed;
          capture.candidate = completed;
          if (capture.compactionItemDone && capture.compactionItem) {
            capture.candidate = { ...completed, output: [capture.compactionItem] };
          }
        }
        return;
      }
      if (
        (event.value.type === "response.output_item.added" ||
          event.value.type === "response.output_item.done") &&
        isRecord(event.value.item) &&
        event.value.item.type === "compaction"
      ) {
        capture.compactionItem = event.value.item;
        capture.compactionItemDone = event.value.type === "response.output_item.done";
        if (capture.completedResponse && capture.compactionItemDone) {
          capture.candidate = { ...capture.completedResponse, output: [capture.compactionItem] };
        }
        return;
      }
      if (!("type" in event.value)) {
        const completed = completedResponseEnvelope(event.value);
        if (completed) capture.candidate = completed;
      }
    },
  };
}

function collectSseTransform(raw: Buffer, transform: import("node:stream").Transform): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    transform.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    transform.once("error", reject);
    transform.once("end", () => resolve(Buffer.concat(chunks)));
    Readable.from([raw]).pipe(transform);
  });
}

function completedResponseEnvelope(value: unknown): JsonObject | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id === "string" && value.id.length > 0 && Array.isArray(value.output)) {
    if (typeof value.status === "string" && value.status !== "completed") return undefined;
    if (isResponseEnvelope(value)) return value;
  }
  if (isRecord(value.response)) return completedResponseEnvelope(value.response);
  return undefined;
}

function looksLikeSse(raw: Buffer): boolean {
  const text = raw.toString("utf8").replace(/^\uFEFF/, "").trimStart();
  return text.startsWith("data:") || text.startsWith("event:");
}


async function relayNativeOllamaCompaction(
  upstream: Response,
  res: ServerResponse,
  abort: AbortController,
  options: GatewayOptions,
  context: OllamaStateContext & { compactModel: string },
  compactNote: CompactAttemptNote,
  request?: GatewayRequestContext,
): Promise<void> {
  const extra: Record<string, string> = {
    "x-cob-compaction": compactionHeader("native", context.compactModel),
  };
  const contentType = upstream.headers.get("content-type") ?? "";
  let raw: Buffer;
  try {
    raw = await readLimitedResponse(upstream, MAX_UPSTREAM_BODY_BYTES, {
      idleMs: options.idleMs ?? IDLE_TIMEOUT_MS,
      signal: abort.signal,
    });
  } catch (error) {
    emitCompactFailure(
      options,
      compactNote,
      abort.signal.aborted ? "native_compaction_aborted" : "native_compaction_read_failed",
      request,
    );
    throw error;
  }
  if (request) request.response_bytes = raw.length;
  if (abort.signal.aborted) {
    emitCompactFailure(options, compactNote, "native_compaction_aborted", request);
    if (request) request.terminal = "client_abort";
    return;
  }
  const isSse = contentType.includes("text/event-stream") || looksLikeSse(raw);
  if (upstream.status < 200 || upstream.status >= 300) {
    emitCompactFailure(options, compactNote, "native_compaction_http_failed", request);
    if (request) request.terminal = "http_error";
    const headers = { ...copyUpstreamHeaders(upstream), ...extra };
    if (isSse && !headers["content-type"]?.includes("text/event-stream")) {
      headers["content-type"] = "text/event-stream";
    }
    res.writeHead(upstream.status, headers);
    res.end(raw);
    return;
  }

  let candidate: JsonObject | undefined;
  let validationError: string | undefined;
  if (isSse) {
    const capture = createStreamCapture();
    // The native compaction SSE path honors the same terminal-order
    // transaction as the normal Ollama relay: exactly one terminal is fed
    // into the tracker, a contradictory/later frame taints success, and a
    // [DONE] is optional but never early and never doubled. Separated
    // compaction-envelope validation still gates the candidate.
    const track = createOllamaTerminalTrack();
    const observer = composedSseObserver(captureObserver(capture), ollamaTerminalTrackObserver(track));
    try {
      await collectSseTransform(raw, sseRewriteTransform((value) => value, undefined, observer));
    } catch (error) {
      validationError = error instanceof Error ? error.message : String(error);
    }
    if (!validationError && (track.phase !== "held-completed" || track.completedCandidate === undefined)) {
      validationError = "native compaction SSE did not end with a single valid response.completed terminal";
    }
    candidate = capture.candidate;
  } else {
    try {
      candidate = completedResponseEnvelope(JSON.parse(raw.toString("utf8")));
    } catch {
      validationError = "native compaction response is not valid JSON";
    }
  }
  if (!validationError) {
    validationError = nativeCompactionResponseError(candidate);
  }
  if (validationError || !candidate) {
    emitCompactFailure(options, compactNote, "native_compaction_invalid", request);
    if (request) request.terminal = "invalid_response";
    const message = "Native compaction response was invalid; resend the full context.";
    if (isSse) {
      markGatewayResponseOutcome(res, "invalid_response", "native_compaction_invalid");
      res.writeHead(502, { "content-type": "text/event-stream", ...extra });
      res.end(sseErrorTerminal(message, "native_compaction_invalid"));
    } else {
      jsonError(res, 502, "native_compaction_invalid", message);
    }
    return;
  }

  try {
    await publishCompactCheckpoint(context, candidate, raw, {
      model: context.catalogModel,
      compactModel: context.compactModel,
    });
  } catch {
    emitCompactFailure(options, compactNote, "native_compaction_checkpoint_failed", request);
    if (request) request.terminal = "checkpoint_failed";
    // The native body is still buffered and headers are not sent. Keep the
    // failure provider-safe and deterministic; never echo opaque ciphertext
    // or an implementation error into the client-facing stream.
    if (isSse) {
      markGatewayResponseOutcome(res, "checkpoint_failed", "native_compaction_checkpoint_failed");
      res.writeHead(502, { "content-type": "text/event-stream", ...extra });
      res.end(sseErrorTerminal(
        "Native compaction checkpoint publication failed; resend the full context.",
        "native_compaction_checkpoint_failed",
      ));
    } else {
      jsonError(
        res,
        502,
        "native_compaction_checkpoint_failed",
        "native compaction checkpoint publication failed; resend the full context",
      );
    }
    return;
  }
  const headers = { ...copyUpstreamHeaders(upstream), ...extra };
  if (isSse && !headers["content-type"]?.includes("text/event-stream")) {
    headers["content-type"] = "text/event-stream";
  }
  if (request) request.terminal = "completed";
  res.writeHead(upstream.status, headers);
  res.end(raw);
}

class ResponsesParseError extends Error {
  readonly status = 400;
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ResponsesParseError";
  }
}

function parseResponsesJson(body: Buffer): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new ResponsesParseError("invalid_json", "Responses body must be JSON.");
  }
  const payload = unwrapResponsesPayload(parsed);
  if (!payload) {
    throw new ResponsesParseError("invalid_json", "Responses body must be a JSON object.");
  }
  return payload;
}

function unwrapResponsesPayload(parsed: unknown): JsonObject | undefined {
  if (!isRecord(parsed)) return undefined;
  if (parsed.type === "response.create") {
    const rest = { ...parsed };
    delete rest.type;
    return rest;
  }
  return parsed;
}

export function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function readDecodedBody(
  req: IncomingMessage,
  signal: AbortSignal,
): Promise<{
  raw: Buffer;
  body: Buffer;
  decoded: boolean;
  encoding?: string;
}> {
  const raw = await readLimitedBody(req, { maxBytes: MAX_RAW_BODY_BYTES, signal });
  const encoding = headerValue(req.headers["content-encoding"]);
  const { body, decoded } = decodeRequestBody(raw, encoding);
  if (body.length > MAX_DECODED_BODY_BYTES) {
    throw new BodyLimitError(`Decoded body exceeds ${MAX_DECODED_BODY_BYTES} bytes`);
  }
  return { raw, body, decoded, encoding };
}

function nativeHeaders(req: IncomingMessage, decoded: boolean): HeaderMap {
  const headers: HeaderMap = { ...(req.headers as HeaderMap) };
  if (decoded) {
    delete headers["content-encoding"];
  }
  return headers;
}

function logNativeSearchRequest(
  req: IncomingMessage,
  path: string,
  inbound: { raw: Buffer; body: Buffer; decoded: boolean; encoding?: string },
): void {
  console.error(
    `[cob] ${req.method ?? "?"} ${path} encoding=${inbound.encoding ?? "identity"} raw=${inbound.raw.length} decoded=${inbound.decoded} target=native-search`,
  );
}

function logOllamaUsage(envelope: JsonObject | undefined): ReturnType<typeof extractOllamaUsage> {
  const usage = extractOllamaUsage(envelope);
  if (!usage) {
    console.error("[cob] ollama usage omitted (upstream did not supply exact token counts)");
    return undefined;
  }
  console.error(`[cob] ollama usage ${formatOllamaUsage(usage)}`);
  return usage;
}

export function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  if (status >= 400) {
    const code = structuredErrorCode(body);
    markGatewayResponseOutcome(res, "http_error", code);
  }
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": payload.length,
    ...extraHeaders,
  });
  res.end(payload);
}

export function jsonError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: JsonObject,
): void {
  json(res, status, {
    error: {
      type: status >= 500 ? "server_error" : "invalid_request_error",
      code,
      message,
      ...(details ?? {}),
    },
  });
}

export function markGatewayResponseOutcome(
  res: ServerResponse,
  terminal: GatewayRequestTerminal,
  code?: string,
): void {
  const request = responseDiagnostics.get(res);
  if (!request) return;
  request.terminal = terminal;
  if (isDiagnosticErrorCode(code)) request.error_code = code;
}

function structuredErrorCode(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.error) || typeof body.error.code !== "string") {
    return undefined;
  }
  return isDiagnosticErrorCode(body.error.code) ? body.error.code : undefined;
}

function copyUpstreamHeaders(upstream: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key.toLowerCase())) return;
    headers[key] = value;
  });
  return headers;
}

/**
 * Codex-owned failure writer: after headers are sent, upstream stream failures
 * end with the OpenAI Responses error terminal. Claude and raw relays never use it.
 */
const codexStreamFailure: StreamFailureWriter = async (res, error) => {
  if (isBenignAbort(error)) {
    markGatewayResponseOutcome(res, "client_abort");
    if (!res.writableEnded) res.end();
    return;
  }
  const failure = publicStreamFailure(error);
  markGatewayResponseOutcome(res, "stream_error", failure.code);
  if (res.writableEnded) return;
  try {
    res.write(sseErrorTerminal(failure.message, failure.code));
    res.end();
  } catch {
    res.destroy();
  }
};

function publicStreamFailure(error: unknown): { code: string; message: string } {
  if (error instanceof SseLimitError) {
    return {
      code: error.code,
      message: "Upstream SSE frame exceeded the safety limit; retry with a shorter response.",
    };
  }
  if (error instanceof UpstreamLimitError) {
    return {
      code: error.code,
      message: "Upstream response exceeded the safety limit; retry with a shorter response.",
    };
  }
  if (error instanceof IdleTimeoutError) {
    return { code: error.code, message: "Upstream response stream timed out." };
  }
  if (error instanceof ConversationStateError) {
    return {
      code: error.code,
      message: publicConversationStateMessage(error),
    };
  }
  return { code: "upstream_stream_error", message: "Upstream response stream failed." };
}

/** Never expose checkpoint ids, paths, or stored-state detail to a client. */
export function publicConversationStateMessage(error: ConversationStateError): string {
  switch (error.code) {
    case "state_checkpoint_conflict":
      return "Conversation checkpoint conflicts with the requested state; resend the full context.";
    case "state_checkpoint_too_large":
    case "state_archive_too_large":
    case "state_retention_exhausted":
      return "Conversation checkpoint exceeds cob's bounded state limits; resend the full context.";
    case "state_publish_aborted":
      return "Conversation checkpoint publication was aborted; resend the full context.";
    default:
      return "Conversation checkpoint is unavailable or invalid; resend the full context.";
  }
}

async function relay(
  upstream: Response,
  res: ServerResponse,
  abort: AbortController,
  options: GatewayOptions,
  extraHeaders?: Record<string, string>,
): Promise<void> {
  if (upstream.status >= 400) {
    markGatewayResponseOutcome(res, "http_error", "native_upstream_error");
  }
  res.writeHead(upstream.status, { ...copyUpstreamHeaders(upstream), ...extraHeaders });
  if (!upstream.body) {
    res.end();
    return;
  }
  const nodeStream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
  abort.signal.addEventListener("abort", () => nodeStream.destroy(), { once: true });
  const relayed = await relayPassthrough(nodeStream, res, {
    idleMs: options.idleMs ?? IDLE_TIMEOUT_MS,
    abort,
    onUpstreamFailure: codexStreamFailure,
  });
  if (relayed && upstream.status < 400) markGatewayResponseOutcome(res, "completed");
}

/**
 * Gate 1-3's response boundary. The normal native path above remains a raw
 * relay; this function is only reachable after the request-side alias shim
 * has been accepted for the exact Sol schema fingerprint.
 */
async function relayNativePlaintextSpawn(
  upstream: Response,
  res: ServerResponse,
  abort: AbortController,
  options: GatewayOptions,
  context: NativePlaintextSpawnContext,
): Promise<void> {
  const contentType = upstream.headers.get("content-type") ?? "";
  if (upstream.status >= 200 && upstream.status < 300 && contentType.includes("text/event-stream")) {
    res.writeHead(upstream.status, copyUpstreamHeaders(upstream));
    if (!upstream.body) {
      markGatewayResponseOutcome(res, "stream_error", "native_plaintext_spawn_stream_empty");
      res.write(sseErrorTerminal(
        "Native plaintext spawn stream was empty.",
        "native_plaintext_spawn_stream_empty",
      ));
      res.end();
      return;
    }
    const nodeStream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
    abort.signal.addEventListener("abort", () => nodeStream.destroy(), { once: true });
    await relayTransformed(
      nodeStream,
      nativePlaintextSpawnSseTransform(context),
      res,
      {
        idleMs: options.idleMs ?? IDLE_TIMEOUT_MS,
        abort,
        endResponse: true,
        onUpstreamFailure: codexStreamFailure,
      },
    );
    return;
  }

  const raw = await readLimitedResponse(upstream, MAX_UPSTREAM_BODY_BYTES, {
    idleMs: options.idleMs ?? IDLE_TIMEOUT_MS,
    signal: abort.signal,
  });
  if (upstream.status < 200 || upstream.status >= 300) {
    markGatewayResponseOutcome(res, "http_error", "native_upstream_error");
    res.writeHead(upstream.status, copyUpstreamHeaders(upstream));
    res.end(raw);
    return;
  }

  // Some native Responses deployments return SSE framing without a
  // content-type header. Keep this recognition deliberately narrower than a
  // generic "not JSON" fallback: only the existing data:/event: framing is
  // eligible for the Gate 1-3 response mapper. Invalid JSON without that
  // framing must continue through the JSON diagnostic path below.
  if (looksLikeSse(raw)) {
    const observation = observeNativePlaintextSpawnResponse(
      raw,
      upstream.status,
      contentType,
    );
    let mapped: Buffer;
    try {
      mapped = await collectSseTransform(raw, nativePlaintextSpawnSseTransform(context));
    } catch (error) {
      const failure = nativePlaintextSpawnError(error, observation.diagnostic);
      console.error(formatNativePlaintextSpawnResponseDiagnostic(failure.body.error.diagnostics!));
      json(res, failure.status, failure.body);
      return;
    }
    const headers = copyUpstreamHeaders(upstream);
    headers["content-type"] = "text/event-stream";
    headers["content-length"] = String(mapped.length);
    res.writeHead(upstream.status, headers);
    res.end(mapped);
    return;
  }

  const observation = observeNativePlaintextSpawnResponse(
    raw,
    upstream.status,
    contentType,
  );
  if (!("value" in observation)) {
    const failure = nativePlaintextSpawnError(
      new NativePlaintextSpawnError(
        "native_plaintext_spawn_response_invalid_json",
        "native plaintext spawn response was not valid JSON",
      ),
      observation.diagnostic,
    );
    console.error(formatNativePlaintextSpawnResponseDiagnostic(failure.body.error.diagnostics!));
    json(res, failure.status, failure.body);
    return;
  }
  const parsed = observation.value;
  if (!isRecord(parsed)) {
    const failure = nativePlaintextSpawnError(
      new NativePlaintextSpawnError(
        Array.isArray(parsed)
          ? "native_plaintext_spawn_response_top_level_array"
          : "native_plaintext_spawn_response_top_level_scalar",
        "native plaintext spawn response was not an object",
      ),
      observation.diagnostic,
    );
    console.error(formatNativePlaintextSpawnResponseDiagnostic(failure.body.error.diagnostics!));
    json(res, failure.status, failure.body);
    return;
  }
  let mapped: unknown;
  try {
    mapped = mapNativePlaintextSpawnJson(parsed, context);
  } catch (error) {
    const failure = nativePlaintextSpawnError(error, observation.diagnostic);
    console.error(formatNativePlaintextSpawnResponseDiagnostic(failure.body.error.diagnostics!));
    json(res, failure.status, failure.body);
    return;
  }
  const body = Buffer.from(JSON.stringify(mapped), "utf8");
  const headers = copyUpstreamHeaders(upstream);
  headers["content-type"] = "application/json";
  headers["content-length"] = String(body.length);
  res.writeHead(upstream.status, headers);
  res.end(body);
}

function encodeNativePayload(originalBody: Buffer, payload: JsonObject): Buffer {
  try {
    const original: unknown = JSON.parse(originalBody.toString("utf8"));
    if (isRecord(original) && original.type === "response.create") {
      return Buffer.from(JSON.stringify({ type: "response.create", ...payload }), "utf8");
    }
  } catch {
    // parseResponsesJson already validated this body; retain a deterministic
    // fallback for direct callers that use a custom decoded body.
  }
  return Buffer.from(JSON.stringify(payload), "utf8");
}

async function relayOllama(
  upstream: Response,
  res: ServerResponse,
  catalogModel: string,
  abort: AbortController,
  options: GatewayOptions,
  context: OllamaStateContext,
  bridge: ToolSearchBridge,
  declaration: OllamaToolDeclaration,
  request?: GatewayRequestContext,
): Promise<void> {
  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    if (request) request.decoder_mode = "sse_header";
    res.writeHead(upstream.status, copyUpstreamHeaders(upstream));
    const capture = createStreamCapture();
    const guard: OllamaResponseGuardState = { terminal: createOllamaTerminalTrack() };
    if (!upstream.body) {
      if (upstream.status >= 200 && upstream.status < 300) {
        logOllamaStreamIncomplete(upstream.status, "empty", capture, guard.terminal, request, options.diagnosticSink);
        endOllamaStream(res);
        return;
      }
      if (request) request.terminal = "http_error";
      res.end();
      return;
    }
    const nodeStream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
    abort.signal.addEventListener("abort", () => nodeStream.destroy(), { once: true });
    // A 2xx upstream opens cob's terminal transaction: the transform absorbs
    // the upstream [DONE] trailer and holds the one terminal frame; the
    // client terminal plus exactly one cob-owned [DONE] are emitted only
    // after the checkpoint publishes successfully.
    const okStream = upstream.status >= 200 && upstream.status < 300;
    // Gate 5 has its own explicit response.failed terminal contract for
    // transform/guard rejection. Keep that path on the regular response;
    // ordinary Ollama streams must not get relayTransformed's generic
    // error+[DONE] terminal after a partial prefix.
    const failClosedSse = okStream && declaration.applyPatch?.enabled !== true;
    let relayed: boolean;
    try {
      relayed = await relayTransformed(
        nodeStream,
        ollamaSseTransform(catalogModel, captureObserver(capture, false, request), bridge, declaration, guard),
        res,
        {
          idleMs: options.idleMs ?? IDLE_TIMEOUT_MS,
          abort,
          endResponse: false,
          appendErrorTerminal: !failClosedSse,
          onUpstreamFailure: codexStreamFailure,
        },
      );
    } catch (error) {
      if (error instanceof OllamaJsonOverflowError) {
        if (request) {
          request.terminal = "overflow";
          request.error_code = error.overflow.code;
          request.response_bytes = capture.rawBytes;
        }
        console.error(formatOllamaJsonOverflowLog(error.overflow));
        if (!res.writableEnded && !res.destroyed) {
          res.write(ollamaJsonOverflowSseTerminal(error.overflow));
          res.end();
        }
        return;
      }
      if (failClosedSse) {
        if (abort.signal.aborted) {
          logOllamaStreamIncomplete(upstream.status, "client_abort", capture, guard.terminal, request, options.diagnosticSink);
          return;
        }
        logOllamaStreamIncomplete(
          upstream.status,
          error instanceof IdleTimeoutError ? "idle" : "error",
          capture,
          guard.terminal,
          request,
          options.diagnosticSink,
        );
        endOllamaStream(res);
        return;
      }
      throw error;
    }
    if (!relayed && failClosedSse) {
      if (abort.signal.aborted) {
        logOllamaStreamIncomplete(upstream.status, "client_abort", capture, guard.terminal, request, options.diagnosticSink);
        return;
      }
      logOllamaStreamIncomplete(upstream.status, "error", capture, guard.terminal, request, options.diagnosticSink);
      endOllamaStream(res);
      return;
    }
    if (!relayed) return;
    if (abort.signal.aborted) {
      logOllamaStreamIncomplete(upstream.status, "client_abort", capture, guard.terminal, request, options.diagnosticSink);
      return;
    }
    if (guard.failure) {
      if (request) {
        request.terminal = "guard_rejection";
        request.error_code = guard.failure.code;
        request.response_bytes = 0;
      }
      logApplyPatchObservation(declaration, true, options.diagnosticSink);
      emitGatewayDiagnosticEventTo({
        schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
        kind: "guard_rejection",
        code: guard.failure.code,
        guard_kind: guard.failure.kind,
        name_length: guard.failure.nameLength,
        name_sha8: guard.failure.nameSha8,
        declared_count: declaration.count,
        declared_sha8: declaration.sha8,
      }, options.diagnosticSink);
      if (!res.writableEnded && !res.destroyed) res.write(ollamaGuardSseTerminal(guard.failure));
      if (!res.writableEnded && !res.destroyed) res.end();
      return;
    }
    // A traversal overflow taints the whole response: frames were already
    // omitted, so success is off the table regardless of the terminal phase.
    // Always end with exactly one overflow response.failed plus one [DONE].
    if (guard.overflow) {
      if (request) {
        request.terminal = "overflow";
        request.error_code = guard.overflow.code;
        request.response_bytes = capture.rawBytes;
      }
      console.error(formatOllamaJsonOverflowLog(guard.overflow));
      if (!res.writableEnded && !res.destroyed) {
        res.write(ollamaJsonOverflowSseTerminal(guard.overflow));
        res.end();
      }
      return;
    }
    const track = guard.terminal ?? createOllamaTerminalTrack();
    if (okStream && track.phase === "held-completed" && track.completedCandidate) {
      await writeOllamaCompletedTerminal(
        res,
        context,
        track,
        catalogModel,
        bridge,
        declaration,
        request,
        capture.rawBytes,
        options.diagnosticSink,
      );
      if (!res.writableEnded && !res.destroyed) res.end();
      return;
    }
    if (track.phase === "held-non-success") {
      // A single failed/incomplete/error terminal is relayed verbatim once;
      // cob never appends a success [DONE] to it.
      if (request) {
        request.terminal = "non_success";
        request.non_success_kind = track.nonSuccessKind ?? "error";
        request.error_code = ollamaNonSuccessCode(request.non_success_kind);
        request.response_bytes = capture.rawBytes;
      }
      writeOllamaHeldNonSuccessTerminal(res, track, catalogModel, bridge, declaration);
    } else if (okStream) {
      logOllamaStreamIncomplete(upstream.status, "eof", capture, track, request, options.diagnosticSink);
    }
    if (!res.writableEnded && !res.destroyed) res.end();
    return;
  }
  if (request) request.decoder_mode = "json";
  const bodyReadStarted = performance.now();
  const raw = await readLimitedResponse(upstream, MAX_UPSTREAM_BODY_BYTES, {
    idleMs: options.idleMs ?? IDLE_TIMEOUT_MS,
    signal: abort.signal,
  });
  if (request) request.response_bytes = raw.length;
  if (upstream.status < 200 || upstream.status >= 300) {
    if (request) request.terminal = "http_error";
    const retryAfter = upstream.headers.get("retry-after") ?? undefined;
    const body = normalizeOllamaErrorBody(upstream.status, raw, retryAfter);
    const errorCode = structuredErrorCode(body);
    if (request && errorCode) request.error_code = errorCode;
    const headers = copyUpstreamHeaders(upstream);
    headers["content-type"] = "application/json";
    res.writeHead(upstream.status, headers);
    res.end(JSON.stringify(body));
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    // A successful Ollama response is still an API response that cob must
    // validate before relaying.  Never forward an opaque 2xx body: it could
    // be provider text, an HTML error page, or an untrusted tool dialect.
    if (request) request.terminal = "invalid_json";
    emitGatewayDiagnosticEventTo({
      schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
      kind: "ollama_invalid_json",
      ...observeOllamaInvalidJson(
        raw,
        upstream.headers,
        performance.now() - bodyReadStarted,
        upstream.status,
      ),
    }, options.diagnosticSink);
    jsonError(
      res,
      502,
      "ollama_response_invalid_json",
      "Ollama returned an invalid JSON response; resend the full context.",
    );
    return;
  }
  // Only the exact normal completed envelope is a success authority on this
  // route. Compaction shells, status-less bodies, and provider-private
  // objects fail closed here instead of publishing state.
  const candidate = strictOllamaCompletedEnvelope(parsed);
  if (!candidate) {
    if (request) request.terminal = "invalid_response";
    rejectOllamaJsonNormalize(res, declaration);
    return;
  }
  const failure = guardOllamaJsonResponse(candidate, declaration);
  if (failure) {
    if (request) {
      request.terminal = "guard_rejection";
      request.error_code = failure.code;
    }
    logApplyPatchObservation(declaration, true, options.diagnosticSink);
    rejectOllamaJsonGuard(res, failure, declaration, options.diagnosticSink);
    return;
  }
  let publicBody: Buffer;
  try {
    const normalized = normalizeOllamaResponse(parsed, catalogModel, bridge, declaration.applyPatch);
    publicBody = Buffer.from(JSON.stringify(normalized), "utf8");
  } catch (error) {
    logApplyPatchObservation(declaration, true, options.diagnosticSink);
    if (error instanceof UpstreamLimitError) throw error;
    if (error instanceof ConversationStateError) throw error;
    if (error instanceof OllamaJsonOverflowError) {
      if (request) {
        request.terminal = "overflow";
        request.error_code = error.overflow.code;
      }
      console.error(formatOllamaJsonOverflowLog(error.overflow));
      jsonError(
        res,
        502,
        error.overflow.code,
        "Ollama response JSON exceeded the traversal safety budget; resend the full context.",
      );
      return;
    }
    if (request) request.terminal = "invalid_response";
    rejectOllamaJsonNormalize(res, declaration);
    return;
  }
  if (declaration.applyPatch && publicBody.includes(COB_APPLY_PATCH_ALIAS)) {
    if (request) request.terminal = "invalid_response";
    logApplyPatchObservation(declaration, true, options.diagnosticSink);
    rejectOllamaJsonNormalize(res, declaration);
    return;
  }
  logApplyPatchObservation(declaration, false, options.diagnosticSink);
  try {
    logOllamaUsage(candidate);
    if (request) request.usage = compactUsageEventFromEnvelope(candidate);
    await publishOllamaCheckpoint(context, candidate, {
      model: context.catalogModel,
      upstreamModel: ollamaUpstreamModel(context.catalogModel),
    });
  } catch (error) {
    if (error instanceof UpstreamLimitError) throw error;
    if (error instanceof ConversationStateError) throw error;
    if (request) request.terminal = "checkpoint_error";
    rejectOllamaJsonNormalize(res, declaration);
    return;
  }
  if (request) request.terminal = "completed";
  const headers = copyUpstreamHeaders(upstream);
  headers["content-type"] = "application/json";
  res.writeHead(upstream.status, headers);
  res.end(publicBody);
}

/**
 * Publish the held completed envelope, then emit the normalized terminal
 * frame followed by exactly one cob-owned client [DONE]. Any failure before
 * the client terminal degrades to the single upstream_stream_error terminal,
 * still carrying exactly one [DONE].
 */
async function writeOllamaCompletedTerminal(
  res: ServerResponse,
  context: OllamaStateContext,
  track: OllamaTerminalTrack,
  catalogModel: string,
  bridge: ToolSearchBridge,
  declaration: OllamaToolDeclaration,
  request?: GatewayRequestContext,
  responseBytes?: number,
  sink?: GatewayDiagnosticSink,
): Promise<void> {
  try {
    const candidate = track.completedCandidate;
    const held = track.heldTerminal;
    if (!candidate || !held) {
      throw new Error("Ollama terminal is missing its completed envelope");
    }
    const normalized = normalizeOllamaResponse(held, catalogModel, bridge, declaration.applyPatch);
    if (normalized === APPLY_PATCH_OMIT) {
      throw new Error("Ollama terminal was rejected by the apply-patch rewrite");
    }
    if (request) {
      request.terminal = "completed";
      request.response_bytes = responseBytes;
    }
    logApplyPatchObservation(declaration, false, sink);
    logOllamaUsage(candidate);
    if (request) request.usage = compactUsageEventFromEnvelope(candidate);
    await publishOllamaCheckpoint(context, candidate, {
      model: context.catalogModel,
      upstreamModel: ollamaUpstreamModel(context.catalogModel),
    });
    if (!res.writableEnded && !res.destroyed) {
      res.write(`data: ${JSON.stringify(normalized)}\n\n`);
      res.write(sseDoneTerminal());
    }
  } catch (error) {
    logApplyPatchObservation(declaration, true, sink);
    if (error instanceof OllamaJsonOverflowError) {
      if (request) request.terminal = "overflow";
      console.error(formatOllamaJsonOverflowLog(error.overflow));
      if (!res.writableEnded && !res.destroyed) {
        res.write(ollamaJsonOverflowSseTerminal(error.overflow));
      }
      return;
    }
    const failure = publicStreamFailure(error);
    if (request) {
      request.terminal = "stream_error";
      request.error_code = failure.code;
    }
    if (!res.writableEnded && !res.destroyed) {
      res.write(sseErrorTerminal(failure.message, failure.code));
    }
  }
}

/**
 * Relay the single held failed/incomplete/error frame once, with the same
 * normalization the inline path used. Never append a success [DONE].
 */
function writeOllamaHeldNonSuccessTerminal(
  res: ServerResponse,
  track: OllamaTerminalTrack,
  catalogModel: string,
  bridge: ToolSearchBridge,
  declaration: OllamaToolDeclaration,
): void {
  const held = track.heldTerminal;
  if (!held || res.writableEnded || res.destroyed) return;
  try {
    const normalized = normalizeOllamaResponse(held, catalogModel, bridge, declaration.applyPatch);
    if (normalized !== APPLY_PATCH_OMIT) {
      const kind = track.nonSuccessKind ?? "error";
      const terminal = isRecord(normalized)
        ? sanitizeOllamaNonSuccessTerminal(normalized, kind)
        : sanitizeOllamaNonSuccessTerminal(held, kind);
      res.write(`data: ${JSON.stringify(terminal)}\n\n`);
    }
  } catch (error) {
    if (error instanceof UpstreamLimitError) throw error;
    if (error instanceof OllamaJsonOverflowError) {
      console.error(formatOllamaJsonOverflowLog(error.overflow));
      if (!res.writableEnded && !res.destroyed) {
        res.write(ollamaJsonOverflowSseTerminal(error.overflow));
      }
      return;
    }
    // A non-success terminal that cannot be safely rewritten simply ends the
    // stream without a client terminal; cob never invents one.
  }
}

function rejectOllamaJsonGuard(
  res: ServerResponse,
  failure: OllamaGuardFailure,
  declaration: OllamaToolDeclaration,
  sink?: GatewayDiagnosticSink,
): void {
  emitGatewayDiagnosticEventTo({
    schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
    kind: "guard_rejection",
    code: failure.code,
    guard_kind: failure.kind,
    name_length: failure.nameLength,
    name_sha8: failure.nameSha8,
    declared_count: declaration.count,
    declared_sha8: declaration.sha8,
  }, sink);
  const body = Buffer.from(JSON.stringify(ollamaGuardHttpBody(failure)), "utf8");
  res.writeHead(502, {
    "content-type": "application/json",
    "content-length": body.length,
  });
  res.end(body);
}

function rejectOllamaJsonNormalize(res: ServerResponse, declaration: OllamaToolDeclaration): void {
  console.error(
    `[cob] ollama json rejected code=${OLLAMA_DIALECT.response.invalidResponse} declared_n=${declaration.count} declared_sha=${declaration.sha8}`,
  );
  jsonError(
    res,
    502,
    OLLAMA_DIALECT.response.invalidResponse,
    "Ollama returned an invalid response; resend the full context.",
  );
}

/** Emit Gate 5's boolean-only turn facts after response normalization. */
function logApplyPatchObservation(
  declaration: OllamaToolDeclaration,
  requireModelCall = false,
  sink?: GatewayDiagnosticSink,
): void {
  if (!declaration.applyPatch?.enabled) return;
  const bridge = declaration.applyPatch;
  if (requireModelCall && !bridge.observation.modelCallObserved) return;
  const observed = observeApplyPatchTurn(
    bridge,
    declaration.names.has(declaration.applyPatch.alias),
  );
  emitGatewayDiagnosticEventTo({
    schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
    kind: "gate5_observation",
    classification: observed.classification,
    declaration_present: observed.declarationPresent,
    outbound_alias_present: observed.outboundAliasPresent,
    model_call_observed: observed.modelCallObserved,
    restoration_observed: observed.restorationObserved,
  }, sink);
}

/**
 * One response.failed terminal plus exactly one client [DONE] for an
 * upstream-response traversal overflow. Content-free: no path, key, or value
 * from the offending body.
 */
function ollamaJsonOverflowSseTerminal(overflow: { code: string }): string {
  const failed = {
    type: "response.failed",
    response: {
      status: "failed",
      error: {
        type: "upstream_error",
        code: overflow.code,
        message:
          "Ollama response JSON exceeded the traversal safety budget; resend the full context.",
      },
    },
  };
  return `data: ${JSON.stringify(failed)}\n\n${sseDoneTerminal()}`;
}

function resolveNativeHeadersMs(options: GatewayOptions): number {
  return options.nativeHeadersMs ?? options.headersMs ?? options.connectMs ?? NATIVE_HEADERS_TIMEOUT_MS;
}

function resolveOllamaHeadersMs(options: GatewayOptions): number {
  return options.ollamaHeadersMs ?? options.headersMs ?? options.connectMs ?? OLLAMA_HEADERS_TIMEOUT_MS;
}

function catalogRowSupportsReasoning(catalog: CatalogFile | undefined, model: string): boolean {
  const row = catalog?.models.find((item) => String(item.slug) === model);
  return Array.isArray(row?.supported_reasoning_levels) && row.supported_reasoning_levels.length > 0;
}

/**
 * Gate 5 authorization is the exact catalog row capability, not the global
 * boolean: a missing catalog, a missing row, or any capability other than
 * `freeform` leaves the patch bridge fail-closed for that request.
 */
function catalogRowSupportsApplyPatch(catalog: CatalogFile | undefined, model: string): boolean {
  const row = catalog?.models.find((item) => String(item.slug) === model);
  return Boolean(row) && row?.apply_patch_tool_type === "freeform";
}

export function resolveCatalog(
  options: GatewayOptions,
  request?: GatewayRequestContext,
): CatalogFile | undefined {
  if (options.catalogPath) {
    try {
      const catalog = loadCatalogFile(options.catalogPath);
      options.catalogReloadFailed = false;
      return catalog;
    } catch {
      if (request) request.catalog_reload_fallback = true;
      if (options.catalogReloadFailed !== true) {
        console.error("[cob] catalog reload failed; using startup snapshot");
      }
      options.catalogReloadFailed = true;
      return options.catalog;
    }
  }
  return options.catalog;
}

export function isAbortLike(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: string; code?: string };
  return record.name === "AbortError" || record.code === "ABORT_ERR";
}
