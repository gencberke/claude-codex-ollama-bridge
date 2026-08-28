import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { NATIVE_RESPONSES_URL, NATIVE_SEARCH_URL } from "../constants.js";
import { DEFAULT_OLLAMA_URL } from "../../core/ollama/constants.js";
import { loadCatalogFile } from "../catalog/file.js";
import { ollamaReasoningLadderForModel } from "../capabilities.js";
import { decodeRequestBody, RequestDecodeError } from "../decode.js";
import { forwardNativeResponses, type HeaderMap, type UpstreamFetch } from "../native.js";
import {
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
  prepareOllamaPayload,
} from "../ollama.js";
import { COB_APPLY_PATCH_ALIAS } from "../experimental/apply-patch.js";
import { normalizeOllamaErrorBody } from "../ollama-boundary.js";
import { OLLAMA_DIALECT } from "../ollama-dialect.js";
import {
  formatOllamaGuardLog,
  guardOllamaJsonResponse,
  ollamaGuardHttpBody,
  ollamaGuardSseTerminal,
  type OllamaGuardFailure,
  type OllamaResponseGuardState,
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
  formatCompactSectionFlags,
  ollamaSummaryHandoffItem,
  projectOllamaSummarizerHistory,
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
import { sseDoneTerminal, sseErrorTerminal, sseRewriteTransform, type SseObserver } from "../sse.js";
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
  /** Isolated Gate 1-3; disabled by default and only applied to gpt-5.6-sol. */
  nativePlaintextSpawn?: NativePlaintextSpawnPolicy;
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
};

/**
 * At least one of stateDir / stateStore is required: the gateway never
 * guesses which codex home it persists checkpoints into.
 */
export type GatewayOptions =
  | (GatewayOptionsBase & { stateDir: string; stateStore?: ConversationStateStore })
  | (GatewayOptionsBase & { stateStore: ConversationStateStore; stateDir?: string });

export async function handleNativeSearchPost(
  req: IncomingMessage,
  res: ServerResponse,
  options: GatewayOptions,
  path: string,
): Promise<void> {
  const abort = attachCancellation(req, res);
  let inbound: { raw: Buffer; body: Buffer; decoded: boolean; encoding?: string };
  try {
    inbound = await readDecodedBody(req, abort.signal);
  } catch (error) {
    if (error instanceof BodyAbortedError || abort.signal.aborted) return;
    if (error instanceof BodyLimitError) {
      jsonError(res, error.status, error.code, error.message);
      req.destroy();
      return;
    }
    if (error instanceof RequestDecodeError) {
      jsonError(res, 400, error.code, error.message);
      return;
    }
    throw error;
  }

  logNativeSearchRequest(req, path, inbound);
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

export async function handleResponsesPost(
  req: IncomingMessage,
  res: ServerResponse,
  options: GatewayOptions,
  path: string,
  kind: "responses" | "compact",
): Promise<void> {
  const abort = attachCancellation(req, res);
  // One catalog snapshot per request: route, capability, and dispatch
  // decisions must not straddle an atomic catalog replacement.
  const catalogSnapshot = resolveCatalog(options);
  const nativeSlugs = nativeSlugsFromCatalog(catalogSnapshot);
  let inbound: { raw: Buffer; body: Buffer; decoded: boolean; encoding?: string };
  try {
    inbound = await readDecodedBody(req, abort.signal);
  } catch (error) {
    if (error instanceof BodyAbortedError || abort.signal.aborted) return;
    if (error instanceof BodyLimitError) {
      jsonError(res, error.status, error.code, error.message);
      req.destroy();
      return;
    }
    if (error instanceof RequestDecodeError) {
      jsonError(res, 400, error.code, error.message);
      return;
    }
    throw error;
  }

  let payload: JsonObject;
  try {
    payload = parseResponsesJson(inbound.body);
  } catch (error) {
    if (error instanceof ResponsesParseError) {
      jsonError(res, error.status, error.code, error.message);
      return;
    }
    throw error;
  }

  const model = typeof payload.model === "string" ? payload.model.trim() : "";
  if (model.length === 0) {
    jsonError(res, 400, "missing_model", "Responses requests require a string model.");
    return;
  }

  const target = routeModel(model, nativeSlugs);
  logRequest(req, path, inbound, payload, target);

  if (target === "unknown") {
    jsonError(
      res,
      400,
      "unknown_model",
      `Unknown model ${model}; not in the native catalog and not an ollama/ slug.`,
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
      inbound,
      payload,
      trigger.inputWithoutTrigger,
      model,
      abort,
      catalogSnapshot,
    );
    return;
  }

  if (target === "ollama") {
    const expanded = await expandOllamaCompactionPayload(payload, stateStore(options), model);
    const prepared = prepareOllamaPayload(expanded, { applyPatch: options.applyPatch });
    if (isOllamaReject(prepared)) {
      json(res, prepared.status, prepared.body);
      return;
    }
    const continuation = await prepareOllamaContinuation(prepared, stateStore(options), expanded);
    const catalogModel = typeof continuation.payload.model === "string" ? continuation.payload.model : model;
    const forwarded = await forwardOllamaResponses({
      payload: continuation.payload,
      ollamaUrl: options.ollamaUrl ?? DEFAULT_OLLAMA_URL,
      fetchImpl: options.ollamaFetch,
      signal: abort.signal,
      headersMs: resolveOllamaHeadersMs(options),
      applyPatch: options.applyPatch,
      // Checkpoints currently retain the raw provider function-call alias.
      // The original client payload was validated before this replay is
      // assembled, so only a resolved previous_response_id may authorize the
      // stored alias history on the final Ollama wire.
      allowTrustedApplyPatchAliasHistory: continuation.parentResponseId !== undefined,
      supportsReasoning: catalogRowSupportsReasoning(catalogSnapshot, catalogModel),
    });
    if (isOllamaReject(forwarded)) {
      json(res, forwarded.status, forwarded.body);
      return;
    }
    await relayOllama(forwarded.response, res, catalogModel, abort, options, {
      state: stateStore(options),
      requestInput: continuation.requestInput,
      requestInputProjection: continuation.requestInputProjection,
      baseHistory: continuation.baseHistory,
      parentResponseId: continuation.parentResponseId,
      catalogModel,
    }, forwarded.bridge, forwarded.declaration);
    return;
  }

  const nativePrepared = prepareNativePlaintextSpawn(payload, options.nativePlaintextSpawn);
  if ("status" in nativePrepared && "body" in nativePrepared) {
    json(res, nativePrepared.status, nativePrepared.body);
    return;
  }
  const nativeBody = nativePrepared.context
    ? encodeNativePayload(inbound.body, nativePrepared.payload)
    : inbound.body;
  const upstream = await forwardNativeResponses({
    body: nativeBody,
    headers: nativeHeaders(req, inbound.decoded),
    contentType: headerValue(req.headers["content-type"]) ?? "application/json",
    fetchImpl: options.nativeFetch,
    signal: abort.signal,
    headersMs: resolveNativeHeadersMs(options),
  });
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
  inbound: { raw: Buffer; body: Buffer; decoded: boolean; encoding?: string },
  payload: JsonObject,
  inputWithoutTrigger: unknown[],
  threadModel: string,
  abort: AbortController,
  catalogSnapshot: CatalogFile | undefined,
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
  const prepared = prepareOllamaPayload(triggerlessPayload, { applyPatch: options.applyPatch });
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
  console.error(
    `[cob] compaction_trigger target=${sanitizeLogToken(threadModel)} compaction provider: ${sanitizeLogToken(compactionHeader("native", plan.compactModel))} ${formatCompactAttemptLog(compactNote)}`,
  );
  const rewritten = nativeCompactRequest(compactPayload, plan.compactModel);
  const body = Buffer.from(JSON.stringify(rewritten), "utf8");
  const upstream = await forwardNativeResponses({
    body,
    headers: nativeHeaders(req, true),
    contentType: "application/json",
    url: NATIVE_RESPONSES_URL,
    fetchImpl: options.nativeFetch,
    signal: abort.signal,
    headersMs: resolveNativeHeadersMs(options),
  });
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
    },
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
  const preparedSummarizer = prepareOllamaPayload(summarizerPayload, { applyPatch: options.applyPatch });
  if (isOllamaReject(preparedSummarizer)) {
    json(res, preparedSummarizer.status, preparedSummarizer.body);
    return;
  }
  const compactNote = noteCompactAttempt({
    parentResponseId: continuation.parentResponseId,
    threadModel,
    replayHistory: continuation.replayHistory,
  });
  console.error(
    `[cob] compaction_trigger target=${sanitizeLogToken(threadModel)} compaction provider: ${sanitizeLogToken(compactionHeader("ollama", compactModel))} ${formatCompactAttemptLog(compactNote)}`,
  );
  const compactStarted = Date.now();
  const supportsReasoning = catalogRowSupportsReasoning(catalogSnapshot, compactModel);
  const compactEffort = supportsReasoning
    ? mapOllamaReasoningEffort(options.compaction?.ollamaEffort, compactModel) ??
      ollamaReasoningLadderForModel(compactModel).defaultEffort
    : "omitted";
  const forwarded = await forwardOllamaResponses({
    payload: preparedSummarizer,
    ollamaUrl: options.ollamaUrl ?? DEFAULT_OLLAMA_URL,
    fetchImpl: options.ollamaFetch,
    signal: abort.signal,
    headersMs: resolveOllamaHeadersMs(options),
    applyPatch: options.applyPatch,
    supportsReasoning,
  });
  if (isOllamaReject(forwarded)) {
    json(res, forwarded.status, forwarded.body);
    return;
  }
  const { response: upstream } = forwarded;
  const extra: Record<string, string> = {
    "x-cob-compaction": compactionHeader("ollama", compactModel),
  };
  const raw = await readLimitedResponse(upstream, MAX_UPSTREAM_BODY_BYTES, {
    idleMs: options.idleMs ?? IDLE_TIMEOUT_MS,
    signal: abort.signal,
  });
  if (abort.signal.aborted) return;
  if (upstream.status < 200 || upstream.status >= 300) {
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
    summarizerResponse = await parseSummarizerResponse(upstream, raw);
  } catch (error) {
    jsonError(
      res,
      502,
      "ollama_compaction_failed",
      error instanceof Error ? error.message : "Ollama summarizer response is not valid JSON",
      { requires_full_context: true },
    );
    return;
  }
  const extracted = extractOllamaCompactSummary(summarizerResponse);
  if (extracted.kind === "error") {
    console.error(`[cob] ollama compact failed code=${extracted.code} ${formatCompactAttemptLog(compactNote)}`);
    jsonError(res, 400, extracted.code, extracted.message, { requires_full_context: true });
    return;
  }
  const incomplete = incompleteOllamaCompactHandoffError(extracted.text);
  if (incomplete) {
    console.error(`[cob] ollama compact failed code=${incomplete.code} ${formatCompactAttemptLog(compactNote)}`);
    jsonError(res, 400, incomplete.code, incomplete.message, { requires_full_context: true });
    return;
  }
  logOllamaCompactOk({
    latencyMs: Date.now() - compactStarted,
    summaryBytes: Buffer.byteLength(extracted.text, "utf8"),
    sections: compactHandoffSectionFlags(extracted.text),
    effort: compactEffort,
    usage: extractOllamaUsage(summarizerResponse),
    compactNote,
  });
  let envelope: string;
  try {
    envelope = encodeCobCompactEnvelope(extracted.text);
  } catch (error) {
    if (error instanceof CobCompactEnvelopeError) {
      jsonError(res, 400, error.code, error.message, { requires_full_context: true });
      return;
    }
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
      },
      response,
      rawBody,
      { model: threadModel, compactModel, upstreamModel: ollamaUpstreamModel(compactModel) },
      ollamaSummaryHandoffItem(extracted.text),
    );
  } catch {
    if (stream) {
      res.writeHead(502, { "content-type": "text/event-stream", ...extra });
      res.end(sseErrorTerminal("Ollama compact checkpoint publication failed; resend the full context"));
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
  if (abort.signal.aborted) return;
  if (stream) {
    res.writeHead(200, { "content-type": "text/event-stream", ...extra });
    res.end(rawBody);
    return;
  }
  json(res, 200, response, extra);
}

function logOllamaCompactOk(opts: {
  latencyMs: number;
  summaryBytes: number;
  sections: ReturnType<typeof compactHandoffSectionFlags>;
  effort: string;
  usage: ReturnType<typeof extractOllamaUsage>;
  compactNote: CompactAttemptNote;
}): void {
  const usage = opts.usage ? formatOllamaUsage(opts.usage) : "tokens=omitted";
  console.error(
    `[cob] ollama compact ok latency_ms=${opts.latencyMs} summary_bytes=${opts.summaryBytes} effort=${opts.effort} sections=${formatCompactSectionFlags(opts.sections)} ${usage} ${formatCompactAttemptLog(opts.compactNote)}`,
  );
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

async function parseSummarizerResponse(upstream: Response, raw: Buffer): Promise<JsonObject | undefined> {
  const contentType = upstream.headers.get("content-type") ?? "";
  const isSse = contentType.includes("text/event-stream") || looksLikeSse(raw);
  if (isSse) {
    const capture = createStreamCapture();
    await collectSseTransform(
      raw,
      sseRewriteTransform((value) => value, undefined, captureObserver(capture)),
    );
    if (capture.malformed) {
      throw new Error("Ollama summarizer SSE was malformed");
    }
    return capture.candidate ?? capture.completedResponse;
  }
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    return completedResponseEnvelope(parsed) ?? (isRecord(parsed) ? parsed : undefined);
  } catch {
    throw new Error("Ollama summarizer response is not valid JSON");
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
): void {
  console.error(
    `[cob] ollama stream incomplete terminal=${terminal} status=${status} raw_bytes=${capture.rawBytes} completed=${capture.sawCompletedEvent} done=${capture.sawDone} malformed=${capture.malformed}`,
  );
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

function captureObserver(capture: StreamCapture, suppressDone = false): SseObserver {
  return {
    suppressDone,
    onChunk(chunk) {
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

function isCompleteStreamCapture(capture: StreamCapture): boolean {
  // Ollama 0.32.15 cloud closes a valid stream after response.completed and
  // does not emit the OpenAI-style [DONE] sentinel. The completed envelope is
  // the success authority; cob publishes it durably and emits exactly one
  // client-facing [DONE]. Failed/incomplete terminals never set candidate.
  return capture.sawCompletedEvent && !capture.malformed && capture.candidate !== undefined;
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
): Promise<void> {
  const extra: Record<string, string> = {
    "x-cob-compaction": compactionHeader("native", context.compactModel),
  };
  const contentType = upstream.headers.get("content-type") ?? "";
  const raw = await readLimitedResponse(upstream, MAX_UPSTREAM_BODY_BYTES, {
    idleMs: options.idleMs ?? IDLE_TIMEOUT_MS,
    signal: abort.signal,
  });
  if (abort.signal.aborted) return;
  const isSse = contentType.includes("text/event-stream") || looksLikeSse(raw);
  if (upstream.status < 200 || upstream.status >= 300) {
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
    try {
      await collectSseTransform(
        raw,
        sseRewriteTransform((value) => value, undefined, captureObserver(capture)),
      );
    } catch (error) {
      validationError = error instanceof Error ? error.message : String(error);
    }
    if (!validationError && (!capture.sawCompletedEvent || capture.malformed)) {
      validationError = "native compaction SSE did not end with response.completed";
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
    const message = `native compaction validation failed: ${validationError ?? "missing response"}`;
    if (isSse) {
      res.writeHead(502, { "content-type": "text/event-stream", ...extra });
      res.end(sseErrorTerminal(message));
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
    // The native body is still buffered and headers are not sent. Keep the
    // failure provider-safe and deterministic; never echo opaque ciphertext
    // or an implementation error into the client-facing stream.
    if (isSse) {
      res.writeHead(502, { "content-type": "text/event-stream", ...extra });
      res.end(sseErrorTerminal("native compaction checkpoint publication failed; resend the full context"));
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

function logOllamaUsage(envelope: JsonObject | undefined): void {
  const usage = extractOllamaUsage(envelope);
  if (!usage) {
    console.error("[cob] ollama usage omitted (upstream did not supply exact token counts)");
    return;
  }
  console.error(`[cob] ollama usage ${formatOllamaUsage(usage)}`);
}

export function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
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
    if (!res.writableEnded) res.end();
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (res.writableEnded) return;
  try {
    res.write(sseErrorTerminal(message));
    res.end();
  } catch {
    res.destroy();
  }
};

async function relay(
  upstream: Response,
  res: ServerResponse,
  abort: AbortController,
  options: GatewayOptions,
  extraHeaders?: Record<string, string>,
): Promise<void> {
  res.writeHead(upstream.status, { ...copyUpstreamHeaders(upstream), ...extraHeaders });
  if (!upstream.body) {
    res.end();
    return;
  }
  const nodeStream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
  abort.signal.addEventListener("abort", () => nodeStream.destroy(), { once: true });
  await relayPassthrough(nodeStream, res, {
    idleMs: options.idleMs ?? IDLE_TIMEOUT_MS,
    abort,
    onUpstreamFailure: codexStreamFailure,
  });
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
      res.write(sseErrorTerminal("native plaintext spawn stream was empty"));
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
): Promise<void> {
  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    res.writeHead(upstream.status, copyUpstreamHeaders(upstream));
    if (!upstream.body) {
      if (upstream.status >= 200 && upstream.status < 300) {
        logOllamaStreamIncomplete(upstream.status, "empty", createStreamCapture());
        endOllamaStream(res);
        return;
      }
      res.end();
      return;
    }
    const nodeStream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
    abort.signal.addEventListener("abort", () => nodeStream.destroy(), { once: true });
    const capture = createStreamCapture();
    const guard: OllamaResponseGuardState = {};
    const suppressDone = upstream.status >= 200 && upstream.status < 300;
    // Gate 5 has its own explicit response.failed terminal contract for
    // transform/guard rejection. Keep that path on the regular response;
    // ordinary Ollama streams must not get relayTransformed's generic
    // error+[DONE] terminal after a partial prefix.
    const failClosedSse = suppressDone && declaration.applyPatch?.enabled !== true;
    let relayed: boolean;
    try {
      relayed = await relayTransformed(
        nodeStream,
        ollamaSseTransform(catalogModel, captureObserver(capture, suppressDone), bridge, declaration, guard),
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
      if (failClosedSse) {
        if (abort.signal.aborted) {
          logOllamaStreamIncomplete(upstream.status, "client_abort", capture);
          return;
        }
        logOllamaStreamIncomplete(
          upstream.status,
          error instanceof IdleTimeoutError ? "idle" : "error",
          capture,
        );
        endOllamaStream(res);
        return;
      }
      throw error;
    }
    if (!relayed && failClosedSse) {
      if (abort.signal.aborted) {
        logOllamaStreamIncomplete(upstream.status, "client_abort", capture);
        return;
      }
      logOllamaStreamIncomplete(upstream.status, "error", capture);
      endOllamaStream(res);
      return;
    }
    if (!relayed) return;
    if (abort.signal.aborted) {
      logOllamaStreamIncomplete(upstream.status, "client_abort", capture);
      return;
    }
    if (guard.failure) {
      console.error(formatOllamaGuardLog(guard.failure, declaration));
      if (!res.writableEnded && !res.destroyed) res.write(ollamaGuardSseTerminal(guard.failure));
      if (!res.writableEnded && !res.destroyed) res.end();
      return;
    }
    if (upstream.status >= 200 && upstream.status < 300 && isCompleteStreamCapture(capture)) {
      try {
        logOllamaUsage(capture.candidate);
        await publishOllamaCheckpoint(context, capture.candidate!, {
          model: context.catalogModel,
          upstreamModel: ollamaUpstreamModel(context.catalogModel),
        });
        if (!res.writableEnded && !res.destroyed) res.write(sseDoneTerminal());
      } catch (error) {
        if (!res.writableEnded && !res.destroyed) {
          res.write(sseErrorTerminal(error instanceof Error ? error.message : String(error)));
        }
      }
    } else if (!res.writableEnded && !res.destroyed && upstream.status >= 200 && upstream.status < 300) {
      logOllamaStreamIncomplete(upstream.status, "eof", capture);
      endOllamaStream(res);
      return;
    }
    if (!res.writableEnded && !res.destroyed) res.end();
    return;
  }
  const raw = await readLimitedResponse(upstream, MAX_UPSTREAM_BODY_BYTES, {
    idleMs: options.idleMs ?? IDLE_TIMEOUT_MS,
    signal: abort.signal,
  });
  if (upstream.status < 200 || upstream.status >= 300) {
    const retryAfter = upstream.headers.get("retry-after") ?? undefined;
    const body = normalizeOllamaErrorBody(upstream.status, raw, retryAfter);
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
    jsonError(
      res,
      502,
      "ollama_response_invalid_json",
      "Ollama returned an invalid JSON response; resend the full context.",
    );
    return;
  }
  const failure = guardOllamaJsonResponse(parsed, declaration);
  if (failure) {
    rejectOllamaJsonGuard(res, failure, declaration);
    return;
  }
  let publicBody: Buffer;
  try {
    const normalized = normalizeOllamaResponse(parsed, catalogModel, bridge, declaration.applyPatch);
    publicBody = Buffer.from(JSON.stringify(normalized), "utf8");
  } catch (error) {
    if (error instanceof UpstreamLimitError) throw error;
    if (error instanceof ConversationStateError) throw error;
    rejectOllamaJsonNormalize(res, declaration);
    return;
  }
  if (declaration.applyPatch && publicBody.includes(COB_APPLY_PATCH_ALIAS)) {
    rejectOllamaJsonNormalize(res, declaration);
    return;
  }
  try {
    const candidate = completedResponseEnvelope(parsed);
    logOllamaUsage(candidate ?? (isRecord(parsed) ? parsed : undefined));
    if (candidate) {
      await publishOllamaCheckpoint(context, candidate, {
        model: context.catalogModel,
        upstreamModel: ollamaUpstreamModel(context.catalogModel),
      });
    }
  } catch (error) {
    if (error instanceof UpstreamLimitError) throw error;
    if (error instanceof ConversationStateError) throw error;
    rejectOllamaJsonNormalize(res, declaration);
    return;
  }
  const headers = copyUpstreamHeaders(upstream);
  headers["content-type"] = "application/json";
  res.writeHead(upstream.status, headers);
  res.end(publicBody);
}

function rejectOllamaJsonGuard(
  res: ServerResponse,
  failure: OllamaGuardFailure,
  declaration: OllamaToolDeclaration,
): void {
  console.error(formatOllamaGuardLog(failure, declaration));
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

export function resolveCatalog(options: GatewayOptions): CatalogFile | undefined {
  if (options.catalogPath) {
    try {
      return loadCatalogFile(options.catalogPath);
    } catch {
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
