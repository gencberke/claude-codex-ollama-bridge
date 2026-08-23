import type { JsonObject, OllamaTag, ReasoningLevel } from "./types.js";

export type OllamaCapabilityEvidence = {
  tools: boolean;
  thinking: boolean;
  vision: boolean;
};

export type OllamaChildProfile = {
  transport: "responses";
  subagentRole: "child-only";
  multiAgentVersion: "v1";
  supportsFunctionTools: boolean;
  supportsParallelToolCalls: false;
  supportsReasoning: boolean;
  supportsVision: boolean;
  supportsApplyPatch: false;
  supportsShell: false;
  supportsSearch: false;
  previousResponseState: "unsupported";
};

const OLLAMA_THINKING_LEVELS: readonly ReasoningLevel[] = [
  { effort: "none", description: "Thinking off. Fastest Ollama replies." },
  { effort: "low", description: "Light thinking for short coding turns." },
  { effort: "high", description: "Default DeepSeek thinking." },
  { effort: "max", description: "Maximum reasoning for architecture and hard analysis." },
];

export const OLLAMA_REASONING_EFFORTS = ["none", "low", "high", "max"] as const;

export const DEFAULT_OLLAMA_REASONING_EFFORT = "high" satisfies (typeof OLLAMA_REASONING_EFFORTS)[number];

export function evidenceFromOllamaTag(tag: OllamaTag): OllamaCapabilityEvidence {
  const capabilities = new Set(tag.capabilities ?? []);
  return {
    tools: capabilities.has("tools"),
    thinking: capabilities.has("thinking"),
    vision: capabilities.has("vision"),
  };
}

export function ollamaChildProfile(evidence: OllamaCapabilityEvidence): OllamaChildProfile {
  return {
    transport: "responses",
    subagentRole: "child-only",
    multiAgentVersion: "v1",
    supportsFunctionTools: evidence.tools,
    supportsParallelToolCalls: false,
    supportsReasoning: evidence.thinking,
    supportsVision: evidence.vision,
    supportsApplyPatch: false,
    supportsShell: false,
    supportsSearch: false,
    previousResponseState: "unsupported",
  };
}

/**
 * Catalog fields for an Ollama child row. Parser-required shapes may be filled
 * with cob-owned defaults; unsupported capabilities are not advertised.
 * `tools` does not imply parallel calls, apply_patch, shell, or native verbosity.
 */
export function nativeRowAdvertisesAutoCompactTokenLimit(skeleton: JsonObject): boolean {
  return typeof skeleton.auto_compact_token_limit === "number";
}

export function ollamaChildCatalogFields(opts: {
  evidence: OllamaCapabilityEvidence;
  skeleton: JsonObject;
  contextWindow: number;
  maxContextWindow?: number;
  supportsSearchTool?: boolean;
  autoCompactTokenLimit?: number;
}): JsonObject {
  const profile = ollamaChildProfile(opts.evidence);
  const levels = reasoningLevelsForEvidence(opts.skeleton, profile.supportsReasoning);
  const maxContextWindow = opts.maxContextWindow ?? opts.contextWindow;
  const fields: JsonObject = {
    supported_in_api: true,
    context_window: opts.contextWindow,
    max_context_window: maxContextWindow,
    effective_context_window_percent:
      typeof opts.skeleton.effective_context_window_percent === "number"
        ? opts.skeleton.effective_context_window_percent
        : 95,
    input_modalities: profile.supportsVision ? ["text", "image"] : ["text"],
    supported_reasoning_levels: levels,
    default_reasoning_summary: "none",
    support_verbosity: false,
    supports_parallel_tool_calls: false,
    supports_image_detail_original: profile.supportsVision,
    supports_search_tool: opts.supportsSearchTool === true,
    // Parser-required. `disabled` is the schema-safe value that does not advertise shell.
    shell_type: "disabled",
    // Parser-required shape. Not copied from a native GPT row.
    truncation_policy: { mode: "tokens", limit: 10000 },
    experimental_supported_tools: [],
    multi_agent_version: "v1",
  };
  if (levels.length > 0) {
    fields.default_reasoning_level =
      levels.find((level) => level.effort === DEFAULT_OLLAMA_REASONING_EFFORT)?.effort ??
      levels[0]!.effort;
  }
  if (
    typeof opts.autoCompactTokenLimit === "number" &&
    nativeRowAdvertisesAutoCompactTokenLimit(opts.skeleton)
  ) {
    fields.auto_compact_token_limit = opts.autoCompactTokenLimit;
  }
  return fields;
}

export function reasoningLevelsForEvidence(_skeleton: JsonObject, thinking: boolean): ReasoningLevel[] {
  if (!thinking) return [];
  return OLLAMA_THINKING_LEVELS.map((level) => ({ ...level }));
}
