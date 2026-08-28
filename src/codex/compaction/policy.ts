import { PREFERRED_NATIVE_COMPACT_SLUGS } from "../constants.js";
import { OLLAMA_PREFIX } from "../../core/ollama/constants.js";
import type { CompactionPolicy } from "../config/schema.js";
import { isRecord, type JsonObject } from "../../core/json.js";

/** Compaction plan, model, and trigger classification. Pure; no I/O. */

export type CompactPlan =
  | { kind: "passthrough-native" }
  | { kind: "summarize-ollama"; compactModel: string }
  | { kind: "native-for-ollama"; compactModel: string }
  | { kind: "error"; status: number; code: string; message: string };

export function compactionHeader(provider: string, model: string): string {
  const rest = model.startsWith(OLLAMA_PREFIX) ? model.slice(OLLAMA_PREFIX.length) : model;
  return `${provider}/${rest}`;
}

export function resolveCompactPlan(opts: {
  threadModel: string;
  target: "native" | "ollama" | "unknown";
  policy: CompactionPolicy;
  nativeSlugs: ReadonlySet<string>;
}): CompactPlan {
  if (opts.target === "native") return { kind: "passthrough-native" };
  if (opts.target !== "ollama") {
    return {
      kind: "error",
      status: 400,
      code: "unknown_model",
      message: `Unknown model ${opts.threadModel}; not in the native catalog and not an ollama/ slug.`,
    };
  }
  if (opts.policy.provider !== "native") {
    return {
      kind: "error",
      status: 400,
      code: "compaction_provider_unsupported",
      message:
        "cob compaction.provider must stay native. Ollama /compact is never called. Set compaction.ollama_threads to summarize or native.",
    };
  }
  const ollamaThreads = opts.policy.ollamaThreads ?? "summarize";
  if (ollamaThreads === "summarize") {
    const compactModel = opts.policy.ollamaModel ?? opts.threadModel;
    if (!compactModel.startsWith(OLLAMA_PREFIX)) {
      return {
        kind: "error",
        status: 400,
        code: "compaction_model_unavailable",
        message:
          "Ollama-thread summarize compact requires an ollama/ slug (the thread model, or compaction.ollama_model). Do not reuse compaction.model, which is the native ChatGPT slug.",
      };
    }
    return { kind: "summarize-ollama", compactModel };
  }
  const compactModel = resolveNativeCompactModel(opts.policy.model, opts.nativeSlugs);
  if (!compactModel) {
    return {
      kind: "error",
      status: 400,
      code: "compaction_model_unavailable",
      message:
        "Native compaction requires a catalogued native model. Set compaction.model to a loaded native slug or add one to the cob catalog.",
    };
  }
  return { kind: "native-for-ollama", compactModel };
}

export const OLLAMA_COMPACT_EFFORTS = ["none", "low", "high", "max"] as const;
export type OllamaCompactEffort = (typeof OLLAMA_COMPACT_EFFORTS)[number];

/** Legacy DeepSeek-compatible effort constant; omitted effort is model-specific on the wire. */
export const DEFAULT_OLLAMA_COMPACT_EFFORT = "high" satisfies OllamaCompactEffort;

export function resolveNativeCompactModel(
  configured: string | undefined,
  nativeSlugs: ReadonlySet<string>,
): string | undefined {
  if (configured && configured.trim().length > 0) {
    const model = configured.trim();
    return nativeSlugs.has(model) ? model : undefined;
  }
  for (const slug of PREFERRED_NATIVE_COMPACT_SLUGS) {
    if (nativeSlugs.has(slug)) return slug;
  }
  return nativeSlugs.values().next().value;
}

export type CompactionTriggerResult =
  | { kind: "none" }
  | { kind: "trigger"; inputWithoutTrigger: unknown[] }
  | { kind: "error"; status: number; code: string; message: string };

/**
 * Classify the v2 compaction trigger before any provider-specific rewriting.
 * The trigger is transient and must never enter the Ollama transcript or a
 * durable checkpoint history.
 */
export function classifyCompactionTrigger(payload: JsonObject): CompactionTriggerResult {
  if (!Array.isArray(payload.input)) return { kind: "none" };
  const triggerIndexes = payload.input.flatMap((item, index) =>
    isRecord(item) && item.type === "compaction_trigger" ? [index] : [],
  );
  if (triggerIndexes.length === 0) return { kind: "none" };
  if (triggerIndexes.length !== 1 || triggerIndexes[0] !== payload.input.length - 1) {
    return {
      kind: "error",
      status: 400,
      code: "invalid_compaction_trigger",
      message: "Responses compaction requires exactly one terminal compaction_trigger input item.",
    };
  }
  return { kind: "trigger", inputWithoutTrigger: payload.input.slice(0, -1) };
}
