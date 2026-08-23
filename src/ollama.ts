import type { Transform } from "node:stream";
import { DEFAULT_OLLAMA_URL } from "./constants.js";
import {
  encryptedOllamaRejection,
  findEncryptedContent,
  findFernetEncryptedContent,
  NON_STRING_ENCRYPTED_CONTENT,
  stripPlaintextEncryptedContent,
} from "./encrypted.js";
import { ollamaUpstreamModel } from "./route.js";
import { isResponseEnvelope } from "./compaction.js";
import { sseRewriteTransform, type SseObserver } from "./sse.js";
import { fetchWithHeadersTimeout } from "./timeouts.js";
import { OLLAMA_HEADERS_TIMEOUT_MS } from "./limits.js";
import type { JsonObject } from "./types.js";
import { isRecord } from "./types.js";
import type { UpstreamFetch } from "./native.js";
import {
  applyOllamaRequestBoundary,
  normalizeOllamaReasoning,
  type OllamaReject,
} from "./ollama-boundary.js";
import { formatOllamaWireMetrics, summarizeRequest } from "./request-metrics.js";
import {
  applyDeferredToolsToOllama,
  rewriteToolSearchFromOllama,
  type ToolSearchBridge,
} from "./tool-search.js";

export type { OllamaReject } from "./ollama-boundary.js";

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

export { mapOllamaReasoningEffort } from "./ollama-boundary.js";

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

export function prepareOllamaWire(
  payload: JsonObject,
  options: { supportsReasoning?: boolean } = {},
): OllamaWireRequest | OllamaReject {
  const next = structuredClone(payload);
  if (typeof next.model === "string") {
    next.model = ollamaUpstreamModel(next.model);
  }
  normalizeOllamaReasoning(next, options.supportsReasoning ?? true);
  const bridge = applyDeferredToolsToOllama(next);
  const bounded = applyOllamaRequestBoundary(next);
  if (isOllamaReject(bounded)) return bounded;
  return { payload: bounded.payload, bridge };
}

export function sanitizeOllamaPayload(
  payload: JsonObject,
  options: { supportsReasoning?: boolean } = {},
): JsonObject {
  const wire = prepareOllamaWire(payload, options);
  if (isOllamaReject(wire)) {
    throw new Error(wire.body.error.message);
  }
  return wire.payload;
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
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const rewritten = stripEncryptedContentDeep(item);
      if (rewritten !== item) changed = true;
      return rewritten;
    });
    return changed ? next : value;
  }
  if (!isRecord(value)) return value;
  let changed = false;
  const next: JsonObject = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "encrypted_content") {
      changed = true;
      continue;
    }
    const rewritten = stripEncryptedContentDeep(nested);
    if (rewritten !== nested) changed = true;
    next[key] = rewritten;
  }
  return changed ? next : value;
}

function rewriteEnvelopeModel(value: unknown, catalogModel: string): unknown {
  if (!isRecord(value)) return value;
  const response = isRecord(value.response) ? rewriteEnvelopeModel(value.response, catalogModel) : value.response;
  const modelNeedsRewrite =
    isResponseEnvelope(value) && typeof value.model === "string" && value.model !== catalogModel;
  if (!modelNeedsRewrite && response === value.response) return value;
  const next: JsonObject = { ...value };
  if (modelNeedsRewrite) next.model = catalogModel;
  if (response !== value.response) next.response = response;
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
  headersMs?: number;
  /** @deprecated one-release alias for headersMs */
  connectMs?: number;
  supportsReasoning?: boolean;
}): Promise<OllamaForwardResult | OllamaReject> {
  const base = (opts.ollamaUrl ?? DEFAULT_OLLAMA_URL).replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as UpstreamFetch);
  const wire = prepareOllamaWire(opts.payload, { supportsReasoning: opts.supportsReasoning });
  if (isOllamaReject(wire)) return wire;
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
      aliasSha: wire.bridge.aliasSha,
      aliasesAdded: wire.bridge.aliasesAdded,
      aliasesRemoved: wire.bridge.aliasesRemoved,
      aliasesReplaced: wire.bridge.aliasesReplaced,
      usedAliasMissing: wire.bridge.usedAliasMissing,
    })}`,
  );
  const response = await fetchWithHeadersTimeout(
    fetchImpl,
    `${base}/v1/responses`,
    {
      method: "POST",
      headers: ollamaHeaders(stream),
      body,
      signal: opts.signal,
    },
    opts.headersMs ?? opts.connectMs ?? OLLAMA_HEADERS_TIMEOUT_MS,
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
