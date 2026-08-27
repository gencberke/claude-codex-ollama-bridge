import type { Transform } from "node:stream";
import { DEFAULT_OLLAMA_URL } from "./ollama-constants.js";
import {
  APPLY_PATCH_OMIT,
  prepareApplyPatchToOllama,
  validateApplyPatchPayload,
  rewriteApplyPatchFromOllama,
  type ApplyPatchBridge,
  type ApplyPatchPrepareOptions,
  type ApplyPatchPolicyInput,
} from "./apply-patch.js";
import {
  encryptedOllamaRejection,
  findEncryptedContent,
  isEncryptedFieldName,
  stripPlaintextEncryptedContent,
} from "./encrypted.js";
import { ollamaUpstreamModel } from "./route.js";
import { isResponseEnvelope } from "./compaction.js";
import { SSE_OMIT_LINE, sseRewriteTransform, type SseObserver } from "./sse.js";
import { fetchWithHeadersTimeout } from "./timeouts.js";
import { OLLAMA_HEADERS_TIMEOUT_MS } from "./limits.js";
import type { JsonObject } from "./json.js";
import { isRecord } from "./json.js";
import type { UpstreamFetch } from "./native.js";
import {
  applyOllamaRequestBoundary,
  normalizeOllamaReasoning,
  type OllamaReject,
} from "./ollama-boundary.js";
import {
  declareOllamaWireTools,
  inspectOllamaSseEvent,
  type OllamaResponseGuardState,
  type OllamaToolDeclaration,
} from "./ollama-response-boundary.js";
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

export function isOllamaReject(value: unknown): value is OllamaReject {
  return (
    isRecord(value) &&
    "status" in value &&
    "body" in value &&
    isRecord(value.body) &&
    isRecord(value.body.error) &&
    typeof value.body.error.message === "string"
  );
}

export function prepareOllamaPayload(
  payload: JsonObject,
  options: { applyPatch?: ApplyPatchPolicyInput } = {},
): JsonObject | OllamaReject {
  // Compaction items are resolved from cob's durable transcript before this
  // function runs. Never turn opaque native state into a developer note.
  const rejection = rejectOllamaRequest(payload);
  if (rejection) return rejection;
  const patchRejection = validateApplyPatchPayload(payload, options.applyPatch);
  if (patchRejection) return patchRejection;
  const projected = projectAgentMessages(payload);
  if (isOllamaReject(projected)) return projected;
  const cleaned = stripPlaintextEncryptedContent(projected);
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

/**
 * Ollama does not implement Codex's agent_message item. Gate 1's plaintext
 * child boundary admits only text content and renders it as an ordinary user
 * message. Ciphertext is checked before this projection by rejectOllamaRequest
 * and is never converted into an empty placeholder.
 */
export function projectAgentMessages(payload: JsonObject): JsonObject | OllamaReject {
  if (!Array.isArray(payload.input)) return payload;
  let changed = false;
  const input: unknown[] = [];
  for (let index = 0; index < payload.input.length; index += 1) {
    const item = payload.input[index];
    if (!isRecord(item) || item.type !== "agent_message") {
      input.push(item);
      continue;
    }
    const projected = projectOneAgentMessage(item, `body.input[${index}]`);
    if (isOllamaReject(projected)) return projected;
    input.push(projected);
    changed = true;
  }
  return changed ? { ...payload, input } : payload;
}

function projectOneAgentMessage(value: JsonObject, path: string): JsonObject | OllamaReject {
  if (!Array.isArray(value.content)) {
    return rejectAgentMessage(path, "agent_message requires a plaintext content array");
  }
  if (value.content.length === 0) {
    return rejectAgentMessage(`${path}.content`, "agent_message content must contain input_text parts");
  }
  let hasNonEmptyText = false;
  for (let index = 0; index < value.content.length; index += 1) {
    const part = value.content[index];
    if (!isRecord(part) || !isPlaintextAgentPart(part)) {
      return rejectAgentMessage(
        `${path}.content[${index}]`,
        "agent_message content contains mixed or unknown parts",
      );
    }
    if ((part.text as string).length > 0) hasNonEmptyText = true;
  }
  if (!hasNonEmptyText) {
    return rejectAgentMessage(`${path}.content`, "agent_message content has no readable plaintext");
  }
  return {
    type: "message",
    role: "user",
    content: value.content,
  };
}

function isPlaintextAgentPart(value: JsonObject): boolean {
  return (
    value.type === "input_text" &&
    typeof value.text === "string" &&
    Object.keys(value).every((key) => key === "type" || key === "text")
  );
}

function rejectAgentMessage(path: string, message: string): OllamaReject {
  return {
    status: 400,
    body: {
      error: {
        type: "invalid_request_error",
        code: "agent_message_unsupported",
        message: `${path}: ${message}; Ollama accepts only plaintext user/input_text projection.`,
      },
    },
  };
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
  const encrypted = findEncryptedContent(payload);
  if (encrypted !== undefined) {
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
  declaration: OllamaToolDeclaration;
};

export function prepareOllamaWire(
  payload: JsonObject,
  options: {
    supportsReasoning?: boolean;
    applyPatch?: ApplyPatchPolicyInput;
    allowTrustedApplyPatchAliasHistory?: boolean;
  } = {},
): OllamaWireRequest | OllamaReject {
  const next = structuredClone(payload);
  if (typeof next.model === "string") {
    next.model = ollamaUpstreamModel(next.model);
  }
  normalizeOllamaReasoning(next, options.supportsReasoning ?? true);
  const bridge = applyDeferredToolsToOllama(next);
  const patchOptions: ApplyPatchPrepareOptions = {
    allowTrustedAliasHistory: options.allowTrustedApplyPatchAliasHistory,
  };
  const patch = prepareApplyPatchToOllama(next, options.applyPatch, patchOptions);
  if (isOllamaReject(patch)) return patch;
  const bounded = applyOllamaRequestBoundary(next);
  if (isOllamaReject(bounded)) return bounded;
  return {
    payload: bounded.payload,
    bridge,
    declaration: declareOllamaWireTools(bounded.payload, patch.bridge),
  };
}

export function sanitizeOllamaPayload(
  payload: JsonObject,
  options: { supportsReasoning?: boolean; applyPatch?: ApplyPatchPolicyInput } = {},
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
  applyPatch?: ApplyPatchBridge,
): unknown {
  const patchRewritten = applyPatch ? rewriteApplyPatchFromOllama(value, applyPatch) : value;
  if (patchRewritten === APPLY_PATCH_OMIT) return patchRewritten;
  return rewriteEnvelopeModel(
    rewriteToolSearchFromOllama(stripEncryptedContentDeep(patchRewritten), bridge),
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
    if (isEncryptedFieldName(key)) {
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
  declaration?: OllamaToolDeclaration,
  guard?: OllamaResponseGuardState,
): Transform {
  return sseRewriteTransform(
    (value) => {
      if (guard?.failure) return SSE_OMIT_LINE;
      if (declaration && guard) {
        const failure = inspectOllamaSseEvent(value, declaration);
        if (failure) {
          guard.failure = failure;
          return SSE_OMIT_LINE;
        }
      }
      const normalized = normalizeOllamaResponse(value, catalogModel, bridge, declaration?.applyPatch);
      return normalized === APPLY_PATCH_OMIT ? SSE_OMIT_LINE : normalized;
    },
    undefined,
    {
      onChunk: observer?.onChunk,
      onData: observer?.onData,
      // Gate 5 has a Codex-facing custom tool contract.  A malformed data
      // line cannot be relayed as an opaque provider line on that path: the
      // caller must see a stream error before it can interpret any tool
      // result.  Keep the legacy permissive behavior for the ordinary and
      // tool-search-only Ollama dialects.
      failOnError: Boolean(declaration?.applyPatch),
      suppressDone: observer?.suppressDone,
      omitData: () => Boolean(guard?.failure),
    },
  );
}

export type OllamaForwardResult = {
  response: Response;
  bridge: ToolSearchBridge;
  declaration: OllamaToolDeclaration;
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
  applyPatch?: ApplyPatchPolicyInput;
  allowTrustedApplyPatchAliasHistory?: boolean;
}): Promise<OllamaForwardResult | OllamaReject> {
  const base = (opts.ollamaUrl ?? DEFAULT_OLLAMA_URL).replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as UpstreamFetch);
  const wire = prepareOllamaWire(opts.payload, {
    supportsReasoning: opts.supportsReasoning,
    applyPatch: opts.applyPatch,
    allowTrustedApplyPatchAliasHistory: opts.allowTrustedApplyPatchAliasHistory,
  });
  if (isOllamaReject(wire)) return wire;
  const stream = wire.payload.stream === true;
  const body = Buffer.from(JSON.stringify(wire.payload), "utf8");
  const tools = summarizeRequest(wire.payload, body.length);
  console.error(
    `[cob] ollama wire ${formatOllamaWireMetrics({
      wireBytes: body.length,
      instructionsBytes: tools.instructionsBytes,
      inputBytes: tools.inputBytes,
      inputCount: tools.inputCount,
      inputByType: tools.inputByType,
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
    })} declared_n=${wire.declaration.count} declared_sha=${wire.declaration.sha8}`,
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
  return { response, bridge: wire.bridge, declaration: wire.declaration };
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
