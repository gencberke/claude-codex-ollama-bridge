import type { JsonError } from "./encrypted.js";
import type { JsonObject } from "./types.js";
import { isRecord } from "./types.js";

export type OllamaReject = { status: number; body: JsonError };

/**
 * Top-level JSON keys on Ollama 0.32.15 `ResponsesRequest`
 * (`openai/responses.go`). `tool_choice` is documented as unsupported and is
 * not a struct field. `conversation` is present but not implemented.
 */
export const OLLAMA_0_32_15_RESPONSES_REQUEST_FIELDS = [
  "model",
  "background",
  "conversation",
  "include",
  "input",
  "instructions",
  "max_output_tokens",
  "reasoning",
  "temperature",
  "text",
  "top_p",
  "truncation",
  "tools",
  "stream",
] as const;

/** Reviewed Ollama 0.32.15 Responses request surface. */
export const OLLAMA_REQUEST_ALLOWLIST = [
  "model",
  "input",
  "instructions",
  "max_output_tokens",
  "reasoning",
  "temperature",
  "text",
  "top_p",
  "truncation",
  "tools",
  "stream",
] as const;

export const OLLAMA_ADVISORY_FIELDS = [
  "store",
  "background",
  "include",
  "metadata",
  "client_metadata",
  "stream_options",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning_effort",
  "prompt_cache_key",
  "prompt_cache_retention",
  "safety_identifier",
  "service_tier",
  "previous_response_id",
  "user",
  "max_tool_calls",
] as const;

const ALLOWLIST = new Set<string>(OLLAMA_REQUEST_ALLOWLIST);
const ADVISORY = new Set<string>(OLLAMA_ADVISORY_FIELDS);
const WIRE_EFFORTS = new Set(["none", "low", "high", "max"]);

export type OllamaBoundaryResult = {
  payload: JsonObject;
  dropped: string[];
};

export type OllamaBoundaryOptions = {
  supportsReasoning?: boolean;
  debug?: boolean;
};

export function applyOllamaRequestBoundary(
  payload: JsonObject,
  options: OllamaBoundaryOptions = {},
): OllamaBoundaryResult | OllamaReject {
  if (payload.conversation !== undefined) {
    return rejectBoundary(
      "conversation_unsupported",
      "Ollama does not implement conversation state; cob must resolve continuation locally.",
    );
  }
  const formatError = structuredTextFormatError(payload.text);
  if (formatError) return formatError;

  const next: JsonObject = {};
  const dropped: string[] = [];
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (ALLOWLIST.has(key)) {
      next[key] = value;
      continue;
    }
    if (ADVISORY.has(key) || key === "store") {
      dropped.push(key);
      continue;
    }
    unknown.push(key);
  }
  if (unknown.length > 0) {
    return rejectBoundary(
      "ollama_field_unsupported",
      `Ollama route rejected unreviewed field(s): ${unknown.sort().join(", ")}`,
    );
  }
  if ((options.debug ?? process.env.COB_DEBUG === "1") && dropped.length > 0) {
    console.error(`[cob] ollama dropped fields ${dropped.sort().join(",")}`);
  }
  return { payload: next, dropped };
}

export function normalizeOllamaReasoning(
  payload: JsonObject,
  supportsReasoning = true,
): void {
  const incoming = readIncomingEffort(payload);
  if (!supportsReasoning) {
    if (isRecord(payload.reasoning)) {
      const next = { ...payload.reasoning };
      delete next.effort;
      payload.reasoning = next;
      if (Object.keys(next).length === 0) delete payload.reasoning;
    }
    delete payload.reasoning_effort;
    return;
  }
  const effort = mapOllamaReasoningEffort(incoming) ?? "high";
  if (isRecord(payload.reasoning)) {
    payload.reasoning = { ...payload.reasoning, effort };
  } else {
    payload.reasoning = { effort };
  }
  delete payload.reasoning_effort;
}

export function mapOllamaReasoningEffort(effort: unknown): string | undefined {
  if (typeof effort !== "string") return undefined;
  if (effort === "none" || effort === "low" || effort === "high" || effort === "max") return effort;
  if (effort === "medium" || effort === "xhigh" || effort === "minimal") return "high";
  if (WIRE_EFFORTS.has(effort)) return effort;
  return undefined;
}

export function structuredTextFormatError(text: unknown): OllamaReject | undefined {
  if (text === undefined) return undefined;
  if (!isRecord(text)) {
    return rejectBoundary("ollama_text_unsupported", "Ollama text must be an object when present.");
  }
  if (text.format === undefined) return undefined;
  if (!isRecord(text.format) || typeof text.format.type !== "string") {
    return rejectBoundary("ollama_text_format_unsupported", "Ollama text.format is missing a type.");
  }
  if (text.format.type === "text" || text.format.type === "json_schema") return undefined;
  return rejectBoundary(
    "ollama_text_format_unsupported",
    `Ollama text.format type "${text.format.type}" is not implemented; cob will not downgrade structured output.`,
  );
}

export function normalizeOllamaErrorBody(
  status: number,
  raw: Buffer,
  retryAfter?: string,
): JsonObject {
  const parsed = parseJsonObject(raw);
  const upstreamMessage = readUpstreamErrorMessage(parsed, raw);
  const kind = classifyOllamaError(status, upstreamMessage);
  const message =
    kind === "quota"
      ? "Ollama quota is exhausted; replenish quota or retry later. cob start does not fix quota."
      : kind === "rate"
        ? "Ollama is rate limiting or at concurrency; retry later or reduce concurrency. cob start does not fix quota."
        : upstreamMessage || `Ollama returned HTTP ${status}`;
  const error: JsonObject = {
    type: status >= 500 ? "server_error" : "invalid_request_error",
    code: kind === "quota" ? "ollama_quota_exhausted" : kind === "rate" ? "ollama_rate_limited" : "ollama_upstream_error",
    message,
  };
  if (retryAfter) error.retry_after = retryAfter;
  return { error };
}

export function classifyOllamaError(status: number, message: string): "quota" | "rate" | "other" {
  const text = message.toLowerCase();
  if (/\bquota\b|\bbilling\b|\bpayment\b|\bcredit/.test(text)) return "quota";
  if (status === 429 || /\brate.?limit|\btoo many|\bconcurrency|\bcapacity/.test(text)) return "rate";
  return "other";
}

function readIncomingEffort(payload: JsonObject): unknown {
  if (isRecord(payload.reasoning) && "effort" in payload.reasoning) return payload.reasoning.effort;
  if ("reasoning_effort" in payload) return payload.reasoning_effort;
  return undefined;
}

function rejectBoundary(code: string, message: string): OllamaReject {
  return {
    status: 400,
    body: {
      error: {
        type: "invalid_request_error",
        code,
        message,
      },
    },
  };
}

function parseJsonObject(raw: Buffer): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readUpstreamErrorMessage(parsed: JsonObject | undefined, raw: Buffer): string {
  if (parsed && isRecord(parsed.error)) {
    if (typeof parsed.error.message === "string" && parsed.error.message.trim().length > 0) {
      return parsed.error.message.trim();
    }
    if (typeof parsed.error.code === "string") return parsed.error.code;
  }
  if (parsed && typeof parsed.error === "string" && parsed.error.trim().length > 0) {
    return parsed.error.trim();
  }
  if (parsed && typeof parsed.message === "string" && parsed.message.trim().length > 0) {
    return parsed.message.trim();
  }
  const text = raw.toString("utf8").trim();
  return text.length > 0 && text.length <= 240 ? text : "";
}
