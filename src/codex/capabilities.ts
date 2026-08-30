import type { JsonObject } from "../core/json.js";
import type { OllamaTag } from "../core/ollama/tags.js";
import type { ReasoningLevel } from "./types.js";

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
  supportsApplyPatch: boolean;
  supportsShell: boolean;
  supportsSearch: false;
  previousResponseState: "unsupported";
};

export const OLLAMA_REASONING_EFFORTS = ["none", "low", "high", "max"] as const;

export type OllamaReasoningEffort = (typeof OLLAMA_REASONING_EFFORTS)[number];

export type OllamaReasoningLadder = {
  id: "deepseek" | "glm-5.3";
  efforts: readonly OllamaReasoningEffort[];
  defaultEffort: OllamaReasoningEffort;
  levels: readonly ReasoningLevel[];
};

const DEEPSEEK_THINKING_LEVELS: readonly ReasoningLevel[] = [
  { effort: "none", description: "Thinking off. Fastest Ollama replies." },
  { effort: "low", description: "Light thinking for short coding turns." },
  { effort: "high", description: "Default DeepSeek thinking." },
  { effort: "max", description: "Maximum reasoning for architecture and hard analysis." },
];

const GLM53_THINKING_LEVELS: readonly ReasoningLevel[] = [
  { effort: "low", description: "Light thinking. GLM-5.3 cannot turn thinking off." },
  { effort: "high", description: "Enhanced thinking for typical coding turns." },
  { effort: "max", description: "Default GLM-5.3 thinking. Deepest analysis." },
];

export const DEEPSEEK_REASONING_LADDER: OllamaReasoningLadder = {
  id: "deepseek",
  efforts: ["none", "low", "high", "max"],
  defaultEffort: "high",
  levels: DEEPSEEK_THINKING_LEVELS,
};

export const GLM53_REASONING_LADDER: OllamaReasoningLadder = {
  id: "glm-5.3",
  efforts: ["low", "high", "max"],
  defaultEffort: "max",
  levels: GLM53_THINKING_LEVELS,
};


export function ollamaReasoningLadderForModel(model: string | undefined): OllamaReasoningLadder {
  const id = (model ?? "").toLowerCase().replace(/^ollama\//, "");
  if (/^glm-5[.-]3-flash(?::|$)/.test(id)) return GLM53_REASONING_LADDER;
  return DEEPSEEK_REASONING_LADDER;
}

export function evidenceFromOllamaTag(tag: OllamaTag): OllamaCapabilityEvidence {
  const capabilities = new Set(tag.capabilities ?? []);
  return {
    tools: capabilities.has("tools"),
    thinking: capabilities.has("thinking"),
    vision: capabilities.has("vision"),
  };
}

export function ollamaChildProfile(
  evidence: OllamaCapabilityEvidence,
  opts: boolean | { supportsApplyPatch?: boolean } = false,
): OllamaChildProfile {
  const supportsApplyPatch = typeof opts === "boolean" ? opts : opts.supportsApplyPatch === true;
  return {
    transport: "responses",
    subagentRole: "child-only",
    multiAgentVersion: "v1",
    supportsFunctionTools: evidence.tools,
    supportsParallelToolCalls: false,
    supportsReasoning: evidence.thinking,
    supportsVision: evidence.vision,
    supportsApplyPatch,
    supportsShell: evidence.tools,
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
  /** Explicit Gate 5 opt-in for this configured Ollama spawn row. */
  applyPatch?: boolean;
  autoCompactTokenLimit?: number;
  /** Catalog slug or Ollama tag. Selects the advertised thinking ladder. */
  model?: string;
}): JsonObject {
  const profile = ollamaChildProfile(opts.evidence, { supportsApplyPatch: opts.applyPatch === true });
  const levels = reasoningLevelsForEvidence(opts.skeleton, profile.supportsReasoning, opts.model);
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
    ...(profile.supportsApplyPatch ? { apply_patch_tool_type: "freeform" } : {}),
    // Only the exact fresh lowercase `tools` capability advertises unified_exec
    // shell; no-tools, unknown, or fallback evidence stays disabled.
    shell_type: profile.supportsShell ? "unified_exec" : "disabled",
    // Parser-required shape. Not copied from a native GPT row.
    truncation_policy: { mode: "tokens", limit: 10000 },
    experimental_supported_tools: [],
    multi_agent_version: "v1",
  };
  if (levels.length > 0) {
    const ladder = ollamaReasoningLadderForModel(opts.model);
    fields.default_reasoning_level =
      levels.find((level) => level.effort === ladder.defaultEffort)?.effort ?? levels[0]!.effort;
  }
  if (
    typeof opts.autoCompactTokenLimit === "number" &&
    nativeRowAdvertisesAutoCompactTokenLimit(opts.skeleton)
  ) {
    fields.auto_compact_token_limit = opts.autoCompactTokenLimit;
  }
  return fields;
}

export function reasoningLevelsForEvidence(
  _skeleton: JsonObject,
  thinking: boolean,
  model?: string,
): ReasoningLevel[] {
  if (!thinking) return [];
  return ollamaReasoningLadderForModel(model).levels.map((level) => ({ ...level }));
}
