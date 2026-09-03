import { DEFAULT_OLLAMA_SPAWN_MODEL } from "../../core/ollama/default-model.js";

export type CompactionProvider = "native";

export type OllamaThreadCompaction = "summarize" | "native";

export type OllamaCompactEffort = "none" | "low" | "high" | "max";

export type CompactionPolicy = {
  provider: CompactionProvider;
  /** Native ChatGPT slug for GPT-thread compact and the optional Ollama native-replay fallback. */
  model?: string;
  /** Ollama threads: summarize (default) or native full-replay compact. */
  ollamaThreads?: OllamaThreadCompaction;
  /** Optional dedicated Ollama summarizer slug. Default is the thread model. */
  ollamaModel?: string;
  /**
   * Opt-in summarizer effort. Omit to use the selected model's reviewed ladder
   * default (DeepSeek `high`, GLM-5.3 Flash `max`).
   */
  ollamaEffort?: OllamaCompactEffort;
};

export type SubagentPolicy = {
  /** Present once `[subagents].models` was parsed, including an explicit empty list. */
  models?: string[];
};

export type CatalogPolicy = {
  /** Native slugs forced visible in addition to the bundled Codex visibility. */
  nativeInclude?: string[];
  /** Native slugs hidden even when the bundled Codex catalog lists them. */
  nativeExclude?: string[];
  /**
   * When true, Ollama catalog rows advertise `supports_search_tool` so Desktop
   * defers MCP behind `tool_search`. cob translates the wire shape. Default true.
   * An explicit false in cob.toml remains the escape hatch.
   */
  supportsSearchTool: boolean;
  /**
   * Isolated Gate 5 opt-in. When true, cob may advertise its freeform
   * apply_patch alias on configured Ollama spawn rows. Default false.
   */
  applyPatch: boolean;
  /**
   * When true, verified cloud tags advertise their tag `context_length` as
   * `max_context_window` without raising the active `context_window`. Default false.
   */
  advertiseCloudMaxContext?: boolean;
  /**
   * Active catalog cap. Default 256000. Opt-in raise; never inferred from max.
   */
  activeContextWindow?: number;
  /**
   * Isolated compact-threshold experiment. Omitted from rows unless set and
   * the native skeleton already advertises `auto_compact_token_limit`.
   */
  autoCompactTokenLimit?: number;
};

/**
 * Isolated Gate 1 experiment. This is deliberately not a catalog capability:
 * it changes the native Sol request/response wire and is therefore disabled
 * unless a caller supplies the exact schema fingerprint observed in its
 * isolated Codex home.
 */
export type NativePlaintextSpawnPolicy = {
  enabled: boolean;
  schemaSha256?: string;
};

export type ExperimentalPolicy = {
  nativePlaintextSpawn: NativePlaintextSpawnPolicy;
};

export type CobFileConfig = {
  compaction: CompactionPolicy;
  subagents: SubagentPolicy;
  catalog?: CatalogPolicy;
  experimental?: ExperimentalPolicy;
};

export const DEFAULT_CATALOG_POLICY: CatalogPolicy = { supportsSearchTool: true, applyPatch: false };
export const DEFAULT_EXPERIMENTAL_POLICY: ExperimentalPolicy = {
  nativePlaintextSpawn: { enabled: false },
};

/** Catalog slug(s) that cob exposes as the default spawnable Ollama row. */
export const DEFAULT_SPAWNABLE_OLLAMA_SLUGS = [`ollama/${DEFAULT_OLLAMA_SPAWN_MODEL}`] as const;

export class CobConfigError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CobConfigError";
  }
}

export function parseCompactionProvider(value: string | undefined): CompactionProvider | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed === "native") return "native";
  if (trimmed === "ollama" || trimmed === "disabled") {
    throw new CobConfigError(
      "compaction_provider_unsupported",
      `compaction.provider = "${trimmed}" is no longer valid. That setting meant "call Ollama /compact", which cob never does. Keep provider = "native" for GPT-thread ChatGPT compact. Ollama threads use compaction.ollama_threads = "summarize" (default) or "native".`,
    );
  }
  throw new CobConfigError(
    "invalid_compaction_provider",
    `invalid compaction.provider "${trimmed}" (only native is accepted)`,
  );
}

export function parseOllamaThreadCompaction(value: string | undefined): OllamaThreadCompaction | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed === "summarize" || trimmed === "native") return trimmed;
  throw new CobConfigError(
    "invalid_compaction_ollama_threads",
    `invalid compaction.ollama_threads "${trimmed}" (summarize or native)`,
  );
}

export function parseOllamaCompactModel(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  try {
    return validateOllamaSlug(value, "compaction.ollama_model");
  } catch (error) {
    if (error instanceof CobConfigError) {
      throw new CobConfigError("invalid_compaction_ollama_model", error.message);
    }
    throw error;
  }
}

/**
 * The one Ollama slug validator: an exact `ollama/<non-empty-id>` form, no
 * surrounding whitespace, no interior whitespace or control characters, and
 * never a native (non-`ollama/`) model slug. Shared by the cob.toml file
 * config, the COB_SUBAGENT_MODELS env spawn list, and the compact Ollama
 * model so every entry point fails closed the same way.
 */
export function validateOllamaSlug(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed !== value) {
    throw new CobConfigError("invalid_ollama_slug", `${field} has surrounding whitespace: ${JSON.stringify(value)}`);
  }
  if (!trimmed.startsWith("ollama/")) {
    throw new CobConfigError(
      "invalid_ollama_slug",
      `${field} must be an ollama/ slug, not the native slug "${trimmed}"`,
    );
  }
  const id = trimmed.slice("ollama/".length);
  if (id.length === 0) {
    throw new CobConfigError("invalid_ollama_slug", `${field} must include a model id after ollama/`);
  }
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new CobConfigError("invalid_ollama_slug", `${field} must not contain whitespace or control characters`);
  }
  return trimmed;
}

export function parseOllamaSlugList(values: readonly string[], field: string): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const slug = validateOllamaSlug(value, field);
    if (seen.has(slug)) {
      throw new CobConfigError("invalid_ollama_slug", `${field} lists a duplicate spawn model: ${slug}`);
    }
    seen.add(slug);
  }
  return values.slice();
}

export function parseNativeSlugList(values: readonly string[], field: string): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (
      trimmed !== value ||
      trimmed.length === 0 ||
      trimmed.startsWith("ollama/") ||
      /[\s\u0000-\u001f\u007f]/.test(trimmed)
    ) {
      throw new CobConfigError(
        "invalid_native_slug",
        `${field} must contain exact native model slugs without whitespace: ${JSON.stringify(value)}`,
      );
    }
    if (seen.has(trimmed)) {
      throw new CobConfigError("invalid_native_slug", `${field} lists a duplicate native model: ${trimmed}`);
    }
    seen.add(trimmed);
  }
  return values.slice();
}

export function parseOllamaCompactEffort(value: string | undefined): OllamaCompactEffort | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed === "none" || trimmed === "low" || trimmed === "high" || trimmed === "max") return trimmed;
  throw new CobConfigError(
    "invalid_compaction_ollama_effort",
    `invalid compaction.ollama_effort "${trimmed}" (none, low, high, or max). medium/xhigh are not compact experiments.`,
  );
}

export function parsePositiveInt(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new CobConfigError("invalid_cob_toml", `${field} must be a positive integer`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CobConfigError("invalid_cob_toml", `${field} must be a positive integer`);
  }
  return parsed;
}

export function parseTomlBool(value: string, field: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new CobConfigError("invalid_cob_toml", `${field} must be true or false`);
}

export function parseSchemaSha256(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;
  if (!/^[0-9a-f]{64}$/.test(trimmed)) {
    throw new CobConfigError("invalid_cob_toml", `${field} must be a 64-character SHA-256 hex digest`);
  }
  return trimmed;
}

export function compactionPolicy(opts: {
  provider: CompactionProvider;
  model?: string;
  ollamaThreads: OllamaThreadCompaction;
  ollamaModel?: string;
  ollamaEffort?: OllamaCompactEffort;
}): CompactionPolicy {
  return {
    provider: opts.provider,
    ollamaThreads: opts.ollamaThreads,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.ollamaModel ? { ollamaModel: opts.ollamaModel } : {}),
    ...(opts.ollamaEffort ? { ollamaEffort: opts.ollamaEffort } : {}),
  };
}

export function catalogPolicy(opts: {
  supportsSearchTool: boolean;
  nativeInclude?: string[];
  nativeExclude?: string[];
  advertiseCloudMaxContext?: boolean;
  activeContextWindow?: number;
  autoCompactTokenLimit?: number;
  applyPatch?: boolean;
}): CatalogPolicy {
  return {
    supportsSearchTool: opts.supportsSearchTool,
    applyPatch: opts.applyPatch === true,
    ...(opts.nativeInclude !== undefined ? { nativeInclude: opts.nativeInclude.slice() } : {}),
    ...(opts.nativeExclude !== undefined ? { nativeExclude: opts.nativeExclude.slice() } : {}),
    ...(opts.advertiseCloudMaxContext === true ? { advertiseCloudMaxContext: true } : {}),
    ...(typeof opts.activeContextWindow === "number" ? { activeContextWindow: opts.activeContextWindow } : {}),
    ...(typeof opts.autoCompactTokenLimit === "number" ? { autoCompactTokenLimit: opts.autoCompactTokenLimit } : {}),
  };
}

export function experimentalPolicy(opts: {
  nativePlaintextSpawn: boolean;
  schemaSha256?: string;
}): ExperimentalPolicy {
  return {
    nativePlaintextSpawn: {
      enabled: opts.nativePlaintextSpawn,
      ...(opts.schemaSha256 ? { schemaSha256: opts.schemaSha256 } : {}),
    },
  };
}
