import { CLAUDE_DIALECT_VERSION } from "./dialect.js";
import { CLAUDE_OLLAMA_CONTEXT_CAP } from "./constants.js";
import type { OllamaTag } from "../core/ollama/tags.js";

export type ClaudeCapabilitySupport = { supported: boolean };

export type ClaudeModelCapabilities = {
  batch: ClaudeCapabilitySupport;
  citations: ClaudeCapabilitySupport;
  code_execution: ClaudeCapabilitySupport;
  context_management: {
    supported: boolean;
    clear_thinking_20251015: null;
    clear_tool_uses_20250919: null;
    compact_20260112: null;
  };
  effort: {
    supported: boolean;
    low: ClaudeCapabilitySupport;
    medium: ClaudeCapabilitySupport;
    high: ClaudeCapabilitySupport;
    max: ClaudeCapabilitySupport;
    xhigh: ClaudeCapabilitySupport | null;
  };
  image_input: ClaudeCapabilitySupport;
  pdf_input: ClaudeCapabilitySupport;
  structured_outputs: ClaudeCapabilitySupport;
  thinking: {
    supported: boolean;
    types: {
      adaptive: ClaudeCapabilitySupport;
      enabled: ClaudeCapabilitySupport;
    };
  };
};

export type ClaudeModelListEntry = {
  type: "model";
  id: string;
  display_name: string;
  created_at: string;
  capabilities: ClaudeModelCapabilities;
  max_input_tokens: number | null;
  max_tokens: null;
};

const CATALOG_CREATED_AT = "2026-01-01T00:00:00Z";

const NATIVE_EFFORT_RUNGS = ["low", "medium", "high", "max"] as const;
const OLLAMA_THINKING_EFFORT_RUNGS = ["low", "high", "max"] as const;

/** Current Claude family only. 4.6 ids bloated the 3P picker; do not relist them. */
export const CLAUDE_DESKTOP_NATIVE_MODELS: readonly ClaudeModelListEntry[] = [
  desktopModel("claude-opus-5", "Opus 5"),
  desktopModel("claude-sonnet-5", "Sonnet 5"),
  desktopModel("claude-haiku-4-5", "Haiku 4.5"),
  desktopModel("claude-fable-5", "Fable 5"),
];

/** Pins Claude Desktop 3P picker. Discovery is XOR; this list is the picker. */
export function claudeDesktopInferenceModels(): Array<{ name: string; labelOverride: string }> {
  return CLAUDE_DESKTOP_NATIVE_MODELS.map((entry) => ({
    name: entry.id,
    labelOverride: entry.display_name,
  }));
}

export function buildClaudeModelsResponse(tags: readonly OllamaTag[] = []): {
  data: ClaudeModelListEntry[];
  has_more: false;
  cob: { surface: "claude"; dialect: typeof CLAUDE_DIALECT_VERSION };
} {
  const seen = new Set<string>();
  const data: ClaudeModelListEntry[] = [];
  for (const entry of CLAUDE_DESKTOP_NATIVE_MODELS) {
    seen.add(entry.id);
    data.push(entry);
  }
  for (const tag of tags) {
    const id = tag.name.trim();
    if (id.length === 0 || seen.has(id) || id.toLowerCase().startsWith("claude")) continue;
    seen.add(id);
    data.push(ollamaModel(tag));
  }
  return {
    data,
    has_more: false,
    cob: { surface: "claude", dialect: CLAUDE_DIALECT_VERSION },
  };
}

function desktopModel(id: string, displayName: string): ClaudeModelListEntry {
  return {
    type: "model",
    id,
    display_name: displayName,
    created_at: CATALOG_CREATED_AT,
    capabilities: modelCapabilities(NATIVE_EFFORT_RUNGS, true),
    max_input_tokens: null,
    max_tokens: null,
  };
}

function ollamaModel(tag: OllamaTag): ClaudeModelListEntry {
  const thinking = (tag.capabilities ?? []).includes("thinking");
  const vision = (tag.capabilities ?? []).includes("vision");
  const context = tag.details?.context_length;
  const maxInput =
    typeof context === "number" && context > 0 ? Math.min(context, CLAUDE_OLLAMA_CONTEXT_CAP) : null;
  return {
    type: "model",
    id: tag.name.trim(),
    display_name: tag.name.trim(),
    created_at: CATALOG_CREATED_AT,
    capabilities: modelCapabilities(thinking ? OLLAMA_THINKING_EFFORT_RUNGS : [], vision),
    max_input_tokens: maxInput,
    max_tokens: null,
  };
}

function cap(supported: boolean): ClaudeCapabilitySupport {
  return { supported };
}

function modelCapabilities(ladder: readonly string[], imageInput: boolean): ClaudeModelCapabilities {
  const rungs = new Set(ladder);
  const supported = rungs.size > 0;
  return {
    batch: cap(false),
    citations: cap(false),
    code_execution: cap(false),
    context_management: {
      supported: false,
      clear_thinking_20251015: null,
      clear_tool_uses_20250919: null,
      compact_20260112: null,
    },
    effort: {
      supported,
      low: cap(rungs.has("low")),
      medium: cap(rungs.has("medium")),
      high: cap(rungs.has("high")),
      max: cap(rungs.has("max")),
      xhigh: supported ? cap(rungs.has("xhigh")) : null,
    },
    image_input: cap(imageInput),
    pdf_input: cap(false),
    structured_outputs: cap(false),
    thinking: supported
      ? { supported: true, types: { adaptive: cap(true), enabled: cap(true) } }
      : { supported: false, types: { adaptive: cap(false), enabled: cap(false) } },
  };
}
