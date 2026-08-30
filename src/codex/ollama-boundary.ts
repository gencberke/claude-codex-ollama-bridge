import {
  OLLAMA_ADVISORY_FIELDS,
  OLLAMA_REQUEST_ALLOWLIST,
} from "./ollama-dialect.js";
import { ollamaReasoningLadderForModel, type OllamaReasoningEffort } from "./capabilities.js";
import type { JsonError } from "./encrypted.js";
import type { JsonObject } from "../core/json.js";
import { isRecord } from "../core/json.js";

export type OllamaReject = { status: number; body: JsonError };

export {
  OLLAMA_0_32_15_RESPONSES_REQUEST_FIELDS,
  OLLAMA_ADVISORY_FIELDS,
  OLLAMA_REQUEST_ALLOWLIST,
} from "./ollama-dialect.js";

const ALLOWLIST = new Set<string>(OLLAMA_REQUEST_ALLOWLIST);
const ADVISORY = new Set<string>(OLLAMA_ADVISORY_FIELDS);

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
  if (Object.hasOwn(payload, "tool_choice")) {
    const toolChoiceError = unsupportedToolChoiceError(payload.tool_choice);
    if (toolChoiceError) return toolChoiceError;
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
    if (key === "tool_choice") {
      dropped.push(key);
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

function unsupportedToolChoiceError(toolChoice: unknown): OllamaReject | undefined {
  if (toolChoice === "auto") return undefined;
  if (toolChoice === "required" || toolChoice === "none") {
    return rejectBoundary(
      "ollama_tool_choice_unsupported",
      `Ollama does not implement tool_choice="${toolChoice}"; cob will not change tool invocation semantics. Only "auto" may be omitted.`,
    );
  }
  if (isRecord(toolChoice)) {
    return rejectBoundary(
      "ollama_tool_choice_unsupported",
      'Ollama does not implement named/object tool_choice; cob will not change tool selection semantics. Only "auto" may be omitted.',
    );
  }
  return rejectBoundary(
    "ollama_tool_choice_invalid",
    'Ollama tool_choice must be "auto" when present; cob will not drop another correctness-affecting value.',
  );
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
  const ladder = ollamaReasoningLadderForModel(typeof payload.model === "string" ? payload.model : undefined);
  const effort = mapOllamaReasoningEffort(incoming, payload.model) ?? ladder.defaultEffort;
  if (isRecord(payload.reasoning)) {
    payload.reasoning = { ...payload.reasoning, effort };
  } else {
    payload.reasoning = { effort };
  }
  delete payload.reasoning_effort;
}

export function mapOllamaReasoningEffort(effort: unknown, model?: unknown): string | undefined {
  if (typeof effort !== "string") return undefined;
  const ladder = ollamaReasoningLadderForModel(typeof model === "string" ? model : undefined);
  const incoming = effort.trim().toLowerCase();
  let mapped: OllamaReasoningEffort | undefined;
  if (incoming === "none" || incoming === "off") {
    mapped = ladder.efforts.includes("none") ? "none" : "low";
  } else if (incoming === "minimal") {
    mapped = ladder.id === "glm-5.3" ? "low" : "high";
  } else if (incoming === "medium") {
    mapped = "high";
  } else if (incoming === "xhigh") {
    mapped = ladder.id === "glm-5.3" ? "max" : "high";
  } else if (incoming === "low" || incoming === "high" || incoming === "max") {
    mapped = incoming;
  }
  if (!mapped) return undefined;
  return ladder.efforts.includes(mapped) ? mapped : ladder.defaultEffort;
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
        : sanitizeOllamaErrorDetail(upstreamMessage) ?? `Ollama returned HTTP ${status}`;
  const error: JsonObject = {
    type: status >= 500 ? "server_error" : "invalid_request_error",
    code: kind === "quota" ? "ollama_quota_exhausted" : kind === "rate" ? "ollama_rate_limited" : "ollama_upstream_error",
    message,
  };
  if (retryAfter) error.retry_after = retryAfter;
  return { error };
}

const OLLAMA_ERROR_DETAIL_CAP = 2048;

const OLLAMA_BEARER_CREDENTIAL_RE = /\b(?:Bearer|Basic)\s+\S+/gi;
const OLLAMA_POSIX_USER_PATH_RE = /\/(?:Users|home|root)\/[^\s"'`)}\]]+/g;
const OLLAMA_WINDOWS_USER_PATH_RE = /[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\s"'`)}\]]+/g;
const OLLAMA_RESIDUAL_RE = new RegExp(
  "\\b(?:Bearer|Basic)\\s+(?!\\[redacted-credential\\]\\b)\\S+|/(?:Users|home|root)/|[A-Za-z]:\\\\(?:Users|Documents and Settings)\\\\",
  "i",
);
const OLLAMA_CONTROL_CHAR_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u00ad\u2028\u2029\ufffe\uffff]/g;

/**
 * Bound the generic (non-quota, non-rate) upstream error detail before it
 * reaches the client. Credentials and user-absolute paths are redacted
 * content-free; anything empty, oversized, or still carrying a credential or
 * user-path shape after redaction falls back to the generic HTTP message.
 * The check regexes are stateless so a redacted result stays safe to re-test.
 * Quota and rate classifications keep their fixed cob text.
 */
export function sanitizeOllamaErrorDetail(text: string): string | undefined {
  const redacted = text
    .replace(OLLAMA_BEARER_CREDENTIAL_RE, "[redacted-credential]")
    .replace(OLLAMA_POSIX_USER_PATH_RE, "[redacted-path]")
    .replace(OLLAMA_WINDOWS_USER_PATH_RE, "[redacted-path]")
    .replace(OLLAMA_CONTROL_CHAR_RE, " ")
    .trim();
  if (
    redacted.length === 0 ||
    redacted.length > OLLAMA_ERROR_DETAIL_CAP ||
    OLLAMA_RESIDUAL_RE.test(redacted)
  ) {
    return undefined;
  }
  return redacted;
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
