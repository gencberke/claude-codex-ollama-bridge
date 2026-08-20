import type { Transform } from "node:stream";
import { DEFAULT_OLLAMA_URL } from "./constants.js";
import {
  encryptedOllamaRejection,
  findEncryptedContent,
  findFernetEncryptedContent,
  NON_STRING_ENCRYPTED_CONTENT,
  stripPlaintextEncryptedContent,
} from "./encrypted.js";
import type { JsonError } from "./encrypted.js";
import { ollamaUpstreamModel } from "./route.js";
import { isResponseEnvelope } from "./compaction.js";
import { sseRewriteTransform, type SseObserver } from "./sse.js";
import { fetchWithConnectTimeout } from "./timeouts.js";
import { CONNECT_TIMEOUT_MS } from "./limits.js";
import type { JsonObject } from "./types.js";
import { isRecord } from "./types.js";
import type { UpstreamFetch } from "./native.js";
import { formatOllamaWireMetrics, summarizeRequest } from "./request-metrics.js";
import {
  applyDeferredToolsToOllama,
  rewriteToolSearchFromOllama,
  type ToolSearchBridge,
} from "./tool-search.js";

const CHATGPT_HEADER_PREFIXES = ["chatgpt-", "x-codex-", "x-openai-", "x-oai-"];
const CHATGPT_HEADER_NAMES = new Set([
  "authorization",
  "originator",
  "openai-beta",
  "session_id",
  "session-id",
  "thread-id",
  "x-client-request-id",
  "x-responsesapi-include-timing-metrics",
]);

const DROP_OLLAMA_FIELDS = [
  "previous_response_id",
  "prompt_cache_key",
  "prompt_cache_retention",
  "safety_identifier",
  "service_tier",
] as const;

const DEEPSEEK_WIRE_EFFORTS = new Set(["none", "low", "high", "max"]);

/** Map Codex/Desktop leftovers onto DeepSeek V4 / Ollama Responses efforts. */
export function mapOllamaReasoningEffort(effort: unknown): string | undefined {
  if (typeof effort !== "string") return undefined;
  if (effort === "medium" || effort === "xhigh") return "high";
  if (DEEPSEEK_WIRE_EFFORTS.has(effort)) return effort;
  return undefined;
}

export type OllamaReject = { status: number; body: JsonError };

export function isOllamaReject(value: JsonObject | OllamaReject): value is OllamaReject {
  return (
    "status" in value &&
    "body" in value &&
    isRecord(value.body) &&
    isRecord(value.body.error) &&
    typeof value.body.error.message === "string"
  );
}

export function prepareOllamaPayload(payload: JsonObject): JsonObject | OllamaReject {
  // Compaction items are resolved from cob's durable transcript before this
  // function runs. Never turn opaque native state into a developer note.
  const rejection = rejectOllamaRequest(payload);
  if (rejection) return rejection;
  const cleaned = stripPlaintextEncryptedContent(payload);
  if (!isRecord(cleaned)) {
    return {
      status: 400,
      body: {
        error: {
          type: "invalid_request_error",
          code: "invalid_json",
          message: "Ollama path requires a JSON Responses body.",
        },
      },
    };
  }
  return cleaned;
}

export function rejectOllamaRequest(payload: unknown): OllamaReject | undefined {
  if (!isRecord(payload)) {
    return {
      status: 400,
      body: {
        error: {
          type: "invalid_request_error",
          code: "invalid_json",
          message: "Ollama path requires a JSON Responses body.",
        },
      },
    };
  }
  if (Array.isArray(payload.messages) && payload.input === undefined) {
    return {
      status: 400,
      body: {
        error: {
          type: "invalid_request_error",
          code: "chat_completions_unsupported",
          message:
            "cob v1 is Responses-only. Ollama Chat Completions is not translated; send POST /v1/responses.",
        },
      },
    };
  }
  const inputItems = Array.isArray(payload.input) ? payload.input : [];
  if (
    inputItems.some(
      (item) => isRecord(item) && (item.type === "compaction" || item.type === "compaction_trigger"),
    )
  ) {
    return {
      status: 400,
      body: {
        error: {
          type: "invalid_request_error",
          code: "compaction_context_required",
          message:
            "Native compaction state cannot be sent to Ollama without a cob checkpoint; resend the full context.",
        },
      },
    };
  }
  const fernet = findFernetEncryptedContent(payload);
  if (fernet !== undefined) {
    return encryptedOllamaRejection(fernet);
  }
  const encrypted = findEncryptedContent(payload);
  if (encrypted === NON_STRING_ENCRYPTED_CONTENT) {
    return encryptedOllamaRejection(encrypted);
  }
  if ("previous_response_id" in payload) {
    const previous = payload.previous_response_id;
    if (typeof previous !== "string" || previous.trim().length === 0) {
      return {
        status: 400,
        body: {
          error: {
            type: "invalid_request_error",
            code: "previous_response_id_invalid",
            message:
              "previous_response_id must be a non-empty response id. If the id is unavailable, resend the full context without previous_response_id.",
          },
        },
      };
    }
  }
  return undefined;
}

export type OllamaWireRequest = {
  payload: JsonObject;
  bridge: ToolSearchBridge;
};

export function prepareOllamaWire(payload: JsonObject): OllamaWireRequest {
  const next = structuredClone(payload);
  if (typeof next.model === "string") {
    next.model = ollamaUpstreamModel(next.model);
  }
  next.store = false;
  for (const field of DROP_OLLAMA_FIELDS) {
    delete next[field];
  }
  applyOllamaReasoningEffortMap(next);
  const bridge = applyDeferredToolsToOllama(next);
  return { payload: next, bridge };
}

export function sanitizeOllamaPayload(payload: JsonObject): JsonObject {
  return prepareOllamaWire(payload).payload;
}

function applyOllamaReasoningEffortMap(payload: JsonObject): void {
  if (isRecord(payload.reasoning) && "effort" in payload.reasoning) {
    const mapped = mapOllamaReasoningEffort(payload.reasoning.effort);
    if (mapped !== undefined) {
      payload.reasoning = { ...payload.reasoning, effort: mapped };
    }
  }
  if ("reasoning_effort" in payload) {
    const mapped = mapOllamaReasoningEffort(payload.reasoning_effort);
    if (mapped !== undefined) {
      payload.reasoning_effort = mapped;
    }
  }
}

export function normalizeOllamaResponse(
  value: unknown,
  catalogModel: string,
  bridge?: ToolSearchBridge,
): unknown {
  return rewriteEnvelopeModel(
    rewriteToolSearchFromOllama(stripEncryptedContentDeep(value), bridge),
    catalogModel,
  );
}

function stripEncryptedContentDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripEncryptedContentDeep);
  if (!isRecord(value)) return value;
  const next: JsonObject = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "encrypted_content") continue;
    next[key] = stripEncryptedContentDeep(nested);
  }
  return next;
}

function rewriteEnvelopeModel(value: unknown, catalogModel: string): unknown {
  if (!isRecord(value)) return value;
  const next: JsonObject = { ...value };
  if (isResponseEnvelope(next) && typeof next.model === "string") {
    next.model = catalogModel;
  }
  if (isRecord(next.response)) {
    next.response = rewriteEnvelopeModel(next.response, catalogModel);
  }
  return next;
}

export function ollamaSseTransform(
  catalogModel: string,
  observer?: SseObserver,
  bridge?: ToolSearchBridge,
): Transform {
  return sseRewriteTransform(
    (value) => normalizeOllamaResponse(value, catalogModel, bridge),
    undefined,
    observer,
  );
}

export type OllamaForwardResult = {
  response: Response;
  bridge: ToolSearchBridge;
};

export async function forwardOllamaResponses(opts: {
  payload: JsonObject;
  ollamaUrl?: string;
  fetchImpl?: UpstreamFetch;
  signal?: AbortSignal;
  connectMs?: number;
}): Promise<OllamaForwardResult> {
  const base = (opts.ollamaUrl ?? DEFAULT_OLLAMA_URL).replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as UpstreamFetch);
  const wire = prepareOllamaWire(opts.payload);
  const stream = wire.payload.stream === true;
  const body = Buffer.from(JSON.stringify(wire.payload), "utf8");
  const tools = summarizeRequest(wire.payload, body.length);
  console.error(
    `[cob] ollama wire ${formatOllamaWireMetrics({
      wireBytes: body.length,
      toolsCount: tools.toolsCount,
      toolsBytes: tools.toolsBytes,
      toolsSha: tools.toolsSha,
      toolBytesByName: tools.toolBytesByName,
      promotedN: wire.bridge.promotedN,
      promotedBytes: wire.bridge.promotedBytes,
      skippedCap: wire.bridge.skippedCap,
      skippedInvalid: wire.bridge.skippedInvalid,
      skippedUnsupported: wire.bridge.skippedUnsupported,
      collisions: wire.bridge.collisions,
    })}`,
  );
  const response = await fetchWithConnectTimeout(
    fetchImpl,
    `${base}/v1/responses`,
    {
      method: "POST",
      headers: ollamaHeaders(stream),
      body,
      signal: opts.signal,
    },
    opts.connectMs ?? CONNECT_TIMEOUT_MS,
  );
  return { response, bridge: wire.bridge };
}

export function ollamaHeaders(stream = false): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: stream ? "text/event-stream" : "application/json",
  };
}

export function isForbiddenOllamaHeader(name: string): boolean {
  const key = name.toLowerCase();
  if (CHATGPT_HEADER_NAMES.has(key)) return true;
  return CHATGPT_HEADER_PREFIXES.some((prefix) => key.startsWith(prefix));
}
