import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { DEFAULT_OLLAMA_URL, NATIVE_RESPONSES_URL } from "./constants.js";
import { parseCatalogJson } from "./catalog.js";
import { decodeRequestBody, RequestDecodeError } from "./decode.js";
import { forwardNativeResponses, type HeaderMap, type UpstreamFetch } from "./native.js";
import {
  forwardOllamaResponses,
  isOllamaReject,
  normalizeOllamaResponse,
  ollamaSseTransform,
  prepareOllamaPayload,
} from "./ollama.js";
import { assertLoopbackBindHost } from "./loopback.js";
import { nativeSlugsFromCatalog, routeModel, type RouteTarget } from "./route.js";
import type { CompactionPolicy } from "./cob-config.js";
import {
  classifyCompactionTrigger,
  compactionHeader,
  findCompactionInputItem,
  nativeCompactRequest,
  nativeCompactionResponseError,
  projectNativeCompactInput,
  projectOllamaInputValue,
  resolveCompactPlan,
  isResponseEnvelope,
  buildOllamaSummarizerPayload,
  extractOllamaCompactSummary,
  unsupportedOllamaCompactMediaError,
  ollamaSummaryHandoffItem,
  ollamaFollowUpInputError,
  projectOllamaSummarizerHistory,
} from "./compaction.js";
import {
  CobCompactEnvelopeError,
  encodeCobCompactEnvelope,
  newCobCompactIds,
} from "./compact-envelope.js";
import {
  BodyAbortedError,
  BodyLimitError,
  CONNECT_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  MAX_DECODED_BODY_BYTES,
  MAX_RAW_BODY_BYTES,
  MAX_UPSTREAM_BODY_BYTES,
  readLimitedBody,
  readLimitedResponse,
  UpstreamLimitError,
} from "./limits.js";
import {
  attachCancellation,
  relayPassthrough,
  relayTransformed,
  sseDoneTerminal,
  sseErrorTerminal,
} from "./relay.js";
import { ConnectTimeoutError, IdleTimeoutError } from "./timeouts.js";
import { sseRewriteTransform, type SseObserver } from "./sse.js";
import type { CatalogFile, JsonObject } from "./types.js";
import { isRecord } from "./types.js";
import {
  extractOllamaUsage,
  formatOllamaUsage,
  formatRequestMetrics,
  summarizeRequest,
} from "./request-metrics.js";
import type { ToolSearchBridge } from "./tool-search.js";
import {
  ConversationStateError,
  ConversationStateStore,
  createStateHistoryItems,
  mergeStateHistory,
  stateHistoryValues,
  type StateHistoryItem,
} from "./conversation-state.js";
import { resolvePaths } from "./paths.js";
import { ollamaUpstreamModel } from "./route.js";

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

export type GatewayOptions = {
  host?: string;
  port: number;
  ollamaUrl?: string;
  catalog?: CatalogFile;
  catalogPath?: string;
  nativeFetch?: UpstreamFetch;
  ollamaFetch?: UpstreamFetch;
  nonce?: string;
  compaction?: CompactionPolicy;
  connectMs?: number;
  idleMs?: number;
  stateDir?: string;
  stateStore?: ConversationStateStore;
  stateRetention?: {
    maxNodes?: number;
    maxHeads?: number;
    maxBytes?: number;
    maxAgeMs?: number;
  };
};

export function createGateway(options: GatewayOptions): Server {
  const gatewayOptions =
    options.stateStore === undefined
      ? {
          ...options,
          stateStore: new ConversationStateStore(
            options.stateDir ?? resolvePaths().stateDir,
            options.stateRetention,
          ),
        }
      : options;
  return createServer((req, res) => {
    void handleRequest(req, res, gatewayOptions).catch((error: unknown) => {
      if (isAbortLike(error) || error instanceof BodyAbortedError) {
        if (!res.writableEnded) res.end();
        return;
      }
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof BodyLimitError) {
        jsonError(res, error.status, error.code, error.message);
        return;
      }
      if (error instanceof UpstreamLimitError || error instanceof ConnectTimeoutError || error instanceof IdleTimeoutError) {
        jsonError(res, error.status, error.code, error.message);
        return;
      }
      if (error instanceof ConversationStateError) {
        jsonError(res, error.status, error.code, error.message, { requires_full_context: true });
        return;
      }
      jsonError(res, 500, "server_error", error instanceof Error ? error.message : String(error));
    });
  });
}

export function listenGateway(options: GatewayOptions): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  assertLoopbackBindHost(host);
  const server = createGateway(options);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: GatewayOptions,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && (path === "/healthz" || path === "/health")) {
    const compaction = options.compaction ?? { provider: "native", ollamaThreads: "summarize" };
    const presented = headerValue(req.headers["x-cob-nonce"]) ?? "";
    json(res, 200, {
      ok: true,
      service: "cob",
      pid: process.pid,
      nonce_ok: Boolean(options.nonce && presented === options.nonce),
      compaction: {
        provider: compaction.provider,
        model: compaction.model ?? null,
        ollama_threads: compaction.ollamaThreads ?? "summarize",
        ollama_model: compaction.ollamaModel ?? null,
      },
    });
    return;
  }

  if (req.method === "POST" && path === "/cob/shutdown") {
    await handleShutdown(req, res, options);
    return;
  }

  if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
    const models = (resolveCatalog(options)?.models ?? []).map((model) => ({
      id: model.slug,
      object: "model",
      owned_by: typeof model.slug === "string" && model.slug.startsWith("ollama/") ? "ollama" : "openai",
    }));
    json(res, 200, { object: "list", data: models });
    return;
  }

  if (isResponsesPath(path) && req.method !== "POST" && (isWebSocketUpgrade(req) || req.method === "GET")) {
    req.resume();
    jsonError(
      res,
      426,
      "upgrade_required",
      "Responses WebSocket transport is disabled; use HTTP.",
    );
    return;
  }

  if (req.method === "POST" && isCompactPath(path)) {
    await handleResponsesPost(req, res, options, path, "compact");
    return;
  }

  if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
    jsonError(
      res,
      400,
      "chat_completions_unsupported",
      "cob v1 is Responses-only. Use POST /v1/responses.",
    );
    return;
  }

  if (req.method === "POST" && isResponsesPath(path)) {
    await handleResponsesPost(req, res, options, path, "responses");
    return;
  }

  jsonError(res, 404, "not_found", `Unsupported path ${path}`);
}

async function handleResponsesPost(
  req: IncomingMessage,
  res: ServerResponse,
  options: GatewayOptions,
  path: string,
  kind: "responses" | "compact",
): Promise<void> {
  const abort = attachCancellation(req, res);
  const nativeSlugs = nativeSlugsFromCatalog(resolveCatalog(options));
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
    );
    return;
  }

  if (target === "ollama") {
    const expanded = await expandOllamaCompactionPayload(payload, stateStore(options), model);
    const prepared = prepareOllamaPayload(expanded);
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
      connectMs: options.connectMs ?? CONNECT_TIMEOUT_MS,
    });
    await relayOllama(forwarded.response, res, catalogModel, abort, options, {
      state: stateStore(options),
      originalPayload: payload,
      preparedPayload: continuation.payload,
      requestInput: continuation.requestInput,
      requestInputProjection: continuation.requestInputProjection,
      baseHistory: continuation.baseHistory,
      parentResponseId: continuation.parentResponseId,
      catalogModel,
    }, forwarded.bridge);
    return;
  }

  const upstream = await forwardNativeResponses({
    body: inbound.body,
    headers: nativeHeaders(req, inbound.decoded),
    contentType: headerValue(req.headers["content-type"]) ?? "application/json",
    fetchImpl: options.nativeFetch,
    signal: abort.signal,
    connectMs: options.connectMs ?? CONNECT_TIMEOUT_MS,
  });
  await relay(upstream, res, abort, options);
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

async function handleLegacyCompact(res: ServerResponse): Promise<void> {
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
): Promise<void> {
  const policy = options.compaction ?? { provider: "native" };
  const nativeSlugs = nativeSlugsFromCatalog(resolveCatalog(options));
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
  const prepared = prepareOllamaPayload(triggerlessPayload);
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
  console.error(
    `[cob] compaction_trigger target=${threadModel} compaction provider: ${compactionHeader("native", plan.compactModel)}`,
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
    connectMs: options.connectMs ?? CONNECT_TIMEOUT_MS,
  });
  await relayNativeOllamaCompaction(
    upstream,
    res,
    abort,
    options,
    {
      state: stateStore(options),
      originalPayload: triggerlessPayload,
      preparedPayload: compactPayload,
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
  const summarizerPayload = buildOllamaSummarizerPayload({ compactModel, history });
  const preparedSummarizer = prepareOllamaPayload(summarizerPayload);
  if (isOllamaReject(preparedSummarizer)) {
    json(res, preparedSummarizer.status, preparedSummarizer.body);
    return;
  }
  console.error(
    `[cob] compaction_trigger target=${threadModel} compaction provider: ${compactionHeader("ollama", compactModel)}`,
  );
  const { response: upstream } = await forwardOllamaResponses({
    payload: preparedSummarizer,
    ollamaUrl: options.ollamaUrl ?? DEFAULT_OLLAMA_URL,
    fetchImpl: options.ollamaFetch,
    signal: abort.signal,
    connectMs: options.connectMs ?? CONNECT_TIMEOUT_MS,
  });
  const extra: Record<string, string> = {
    "x-cob-compaction": compactionHeader("ollama", compactModel),
  };
  const raw = await readLimitedResponse(upstream, MAX_UPSTREAM_BODY_BYTES, {
    idleMs: options.idleMs ?? IDLE_TIMEOUT_MS,
    signal: abort.signal,
  });
  if (abort.signal.aborted) return;
  if (upstream.status < 200 || upstream.status >= 300) {
    const message = ollamaSummarizerHttpError(upstream.status, raw);
    console.error(`[cob] ${message}`);
    jsonError(res, 502, "ollama_compaction_failed", message, { requires_full_context: true });
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
    jsonError(res, 400, extracted.code, extracted.message, { requires_full_context: true });
    return;
  }
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
        originalPayload: continuation.payload,
        preparedPayload: preparedSummarizer,
        requestInput: continuation.requestInput,
        requestInputProjection: [],
        baseHistory: continuation.baseHistory,
        parentResponseId: continuation.parentResponseId,
        catalogModel: threadModel,
        compactModel,
      },
      response,
      rawBody,
      extracted.text,
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

function ollamaSummarizerHttpError(status: number, raw: Buffer): string {
  const prefix = `Ollama summarizer returned HTTP ${status}`;
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    const message =
      isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string"
        ? parsed.error.message.trim()
        : "";
    if (message.length === 0) return prefix;
    return `${prefix}: ${message.length > 400 ? `${message.slice(0, 400)}…` : message}`;
  } catch {
    return prefix;
  }
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
  originalPayload: JsonObject;
  preparedPayload: JsonObject;
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
  const requestInputProjection = projectOllamaInputValue(requestInput);
  const pending = createStateHistoryItems(requestInputProjection, "cob-pending-request", "request");
  const replayHistory = mergeStateHistory(baseHistory, pending);
  const next: JsonObject = { ...payload };
  if ("previous_response_id" in payload) {
    next.input = stateHistoryValues(replayHistory);
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

function stateStore(options: GatewayOptions): ConversationStateStore {
  if (!options.stateStore) {
    throw new Error("internal error: gateway state store was not initialized");
  }
  return options.stateStore;
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
  return capture.sawDone && !capture.malformed && capture.candidate !== undefined;
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

async function publishOllamaCheckpoint(
  context: OllamaStateContext,
  response: JsonObject,
): Promise<void> {
  const responseId = typeof response.id === "string" ? response.id : "";
  if (responseId.length === 0 || !Array.isArray(response.output)) return;
  const providerInput = createStateHistoryItems(
    context.requestInputProjection,
    responseId,
    "request",
  );
  const providerOutput = createStateHistoryItems(response.output, responseId, "response");
  const history = mergeStateHistory(
    mergeStateHistory(context.baseHistory, providerInput),
    providerOutput,
  );
  await context.state.publish({
    responseId,
    parentResponseId: context.parentResponseId,
    requestInput: context.requestInput,
    output: response.output,
    providerInput,
    providerOutput,
    history,
    responseBody: response,
    model: context.catalogModel,
    provenance: {
      source: "ollama-response",
      gateway: "cob",
      upstreamModel: ollamaUpstreamModel(context.catalogModel),
    },
    isCompactionReplacement: false,
  });
}

async function publishCompactCheckpoint(
  context: OllamaStateContext & { compactModel: string },
  response: JsonObject,
  rawBody: Buffer,
): Promise<void> {
  const responseId = typeof response.id === "string" ? response.id : "";
  if (responseId.length === 0 || !Array.isArray(response.output)) {
    throw new ConversationStateError(
      "state_checkpoint_incompatible",
      "native compaction response cannot be checkpointed; resend the full context",
    );
  }
  const providerInput = createStateHistoryItems(
    context.requestInputProjection,
    responseId,
    "request",
  );
  const preCompactionHistory = mergeStateHistory(context.baseHistory, providerInput);
  // Native encrypted state remains in responseBody/output inside private cob
  // state, while Ollama receives only this provider-safe replay history.
  const replacementHistory = preCompactionHistory;
  await context.state.publish({
    responseId,
    parentResponseId: context.parentResponseId,
    requestInput: context.requestInput,
    output: response.output,
    providerInput,
    providerOutput: [],
    replacementHistory,
    history: replacementHistory,
    responseBody: response,
    model: context.catalogModel,
    provenance: {
      source: "native-compact",
      gateway: "cob",
      compactModel: context.compactModel,
    },
    isCompactionReplacement: true,
    rawCompactBody: rawBody,
  });
}

async function publishOllamaSummaryCheckpoint(
  context: OllamaStateContext & { compactModel: string },
  response: JsonObject,
  rawBody: Buffer,
  summary: string,
): Promise<void> {
  const responseId = typeof response.id === "string" ? response.id : "";
  if (responseId.length === 0 || !Array.isArray(response.output)) {
    throw new ConversationStateError(
      "state_checkpoint_incompatible",
      "Ollama compact response cannot be checkpointed; resend the full context",
    );
  }
  const replacementHistory = createStateHistoryItems(
    ollamaSummaryHandoffItem(summary),
    responseId,
    "replacement",
  );
  await context.state.publish({
    responseId,
    parentResponseId: context.parentResponseId,
    requestInput: context.requestInput,
    output: response.output,
    providerInput: [],
    providerOutput: [],
    replacementHistory,
    history: replacementHistory,
    responseBody: response,
    model: context.catalogModel,
    provenance: {
      source: "ollama-summary",
      gateway: "cob",
      compactModel: context.compactModel,
      upstreamModel: ollamaUpstreamModel(context.compactModel),
    },
    isCompactionReplacement: true,
    rawCompactBody: rawBody,
  });
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
    await publishCompactCheckpoint(context, candidate, raw);
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

async function handleShutdown(
  req: IncomingMessage,
  res: ServerResponse,
  options: GatewayOptions,
): Promise<void> {
  const abort = attachCancellation(req, res);
  const raw = await readLimitedBody(req, { signal: abort.signal });
  let nonce = headerValue(req.headers["x-cob-nonce"]) ?? "";
  if (!nonce) {
    try {
      const parsed: unknown = JSON.parse(raw.toString("utf8") || "{}");
      if (isRecord(parsed) && typeof parsed.nonce === "string") {
        nonce = parsed.nonce;
      }
    } catch {
      nonce = "";
    }
  }
  if (!options.nonce || nonce !== options.nonce) {
    jsonError(res, 403, "forbidden", "invalid cob shutdown nonce");
    return;
  }
  json(res, 200, { ok: true, stopping: true });
  setImmediate(() => process.kill(process.pid, "SIGTERM"));
}

function isResponsesPath(path: string): boolean {
  return path === "/v1/responses" || path === "/responses";
}

function isCompactPath(path: string): boolean {
  return path === "/v1/responses/compact" || path === "/responses/compact";
}

function isWebSocketUpgrade(req: IncomingMessage): boolean {
  const upgrade = headerValue(req.headers.upgrade)?.toLowerCase();
  if (upgrade === "websocket") return true;
  const connection = headerValue(req.headers.connection)?.toLowerCase() ?? "";
  return connection.split(",").some((part) => part.trim() === "upgrade") && upgrade === "websocket";
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

function headerValue(value: string | string[] | undefined): string | undefined {
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

function logOllamaUsage(envelope: JsonObject | undefined): void {
  const usage = extractOllamaUsage(envelope);
  if (!usage) return;
  console.error(`[cob] ollama usage ${formatOllamaUsage(usage)}`);
}

function json(
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

function jsonError(
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
  });
}

async function relayOllama(
  upstream: Response,
  res: ServerResponse,
  catalogModel: string,
  abort: AbortController,
  options: GatewayOptions,
  context: OllamaStateContext,
  bridge: ToolSearchBridge,
): Promise<void> {
  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    res.writeHead(upstream.status, copyUpstreamHeaders(upstream));
    if (!upstream.body) {
      if (upstream.status >= 200 && upstream.status < 300) {
        res.write(
          sseErrorTerminal(
            "Ollama stream ended without a complete response; resend the full context without previous_response_id",
          ),
        );
      }
      res.end();
      return;
    }
    const nodeStream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
    abort.signal.addEventListener("abort", () => nodeStream.destroy(), { once: true });
    const capture = createStreamCapture();
    const suppressDone = upstream.status >= 200 && upstream.status < 300;
    const relayed = await relayTransformed(
      nodeStream,
      ollamaSseTransform(catalogModel, captureObserver(capture, suppressDone), bridge),
      res,
      {
        idleMs: options.idleMs ?? IDLE_TIMEOUT_MS,
        abort,
        endResponse: false,
      },
    );
    if (!relayed) return;
    if (abort.signal.aborted) return;
    if (upstream.status >= 200 && upstream.status < 300 && isCompleteStreamCapture(capture)) {
      try {
        logOllamaUsage(capture.candidate);
        await publishOllamaCheckpoint(context, capture.candidate!);
        if (!res.writableEnded && !res.destroyed) res.write(sseDoneTerminal());
      } catch (error) {
        if (!res.writableEnded && !res.destroyed) {
          res.write(sseErrorTerminal(error instanceof Error ? error.message : String(error)));
        }
      }
    } else if (!res.writableEnded && !res.destroyed && upstream.status >= 200 && upstream.status < 300) {
      res.write(
        sseErrorTerminal(
          "Ollama stream did not produce a complete response; resend the full context without previous_response_id",
        ),
      );
    }
    if (!res.writableEnded && !res.destroyed) res.end();
    return;
  }
  const raw = await readLimitedResponse(upstream, MAX_UPSTREAM_BODY_BYTES, {
    idleMs: options.idleMs ?? IDLE_TIMEOUT_MS,
    signal: abort.signal,
  });
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    const candidate = completedResponseEnvelope(parsed);
    if (upstream.status >= 200 && upstream.status < 300) {
      logOllamaUsage(candidate ?? (isRecord(parsed) ? parsed : undefined));
      if (candidate) {
        await publishOllamaCheckpoint(context, candidate);
      }
    }
    const normalized = normalizeOllamaResponse(parsed, catalogModel, bridge);
    const body = Buffer.from(JSON.stringify(normalized), "utf8");
    const headers = copyUpstreamHeaders(upstream);
    headers["content-type"] = "application/json";
    res.writeHead(upstream.status, headers);
    res.end(body);
  } catch (error) {
    if (error instanceof UpstreamLimitError) throw error;
    if (error instanceof ConversationStateError) throw error;
    res.writeHead(upstream.status, copyUpstreamHeaders(upstream));
    res.end(raw);
  }
}

function resolveCatalog(options: GatewayOptions): CatalogFile | undefined {
  if (options.catalogPath) {
    try {
      return parseCatalogJson(readFileSync(options.catalogPath, "utf8"));
    } catch {
      return options.catalog;
    }
  }
  return options.catalog;
}

function isAbortLike(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: string; code?: string };
  return record.name === "AbortError" || record.code === "ABORT_ERR";
}
