import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { OLLAMA_CATALOG_CONTEXT_CAP } from "./constants.js";
import type { CobPaths } from "./paths.js";

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

/** Unprefixed model id sent to Ollama for the default V1 child on both surfaces. */
export const DEFAULT_OLLAMA_SPAWN_MODEL = "deepseek-v4-flash:0731-cloud" as const;

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
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (!trimmed.startsWith("ollama/")) {
    throw new CobConfigError(
      "invalid_compaction_ollama_model",
      `compaction.ollama_model must be an ollama/ slug, not "${trimmed}". Do not reuse compaction.model (that is the native ChatGPT slug).`,
    );
  }
  return trimmed;
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

export function parseCobToml(text: string): CobFileConfig {
  let section = "";
  let provider: CompactionProvider | undefined;
  let model: string | undefined;
  let ollamaThreads: OllamaThreadCompaction | undefined;
  let ollamaModel: string | undefined;
  let ollamaEffort: OllamaCompactEffort | undefined;
  let subagentModels: string[] | undefined;
  let supportsSearchTool: boolean | undefined;
  let advertiseCloudMaxContext: boolean | undefined;
  let activeContextWindow: number | undefined;
  let autoCompactTokenLimit: number | undefined;
  let applyPatch: boolean | undefined;
  let nativePlaintextSpawn: boolean | undefined;
  let nativePlaintextSpawnSchemaSha256: string | undefined;
  let arrayKey: string | undefined;
  let arrayItems: string[] = [];

  const flushArray = (): void => {
    if (arrayKey === "models" && section === "subagents") {
      subagentModels = arrayItems.slice();
    }
    arrayKey = undefined;
    arrayItems = [];
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line.length === 0) continue;
    if (arrayKey) {
      if (line.startsWith("]")) {
        flushArray();
        continue;
      }
      const item = unquoteToml(line.replace(/,$/, "").trim());
      if (item.length > 0) arrayItems.push(item);
      continue;
    }
    if (line.startsWith("[")) {
      section = line.replace(/^\[/, "").replace(/\]$/, "").trim();
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const rawValue = line.slice(eq + 1).trim();
    if (rawValue === "[" || rawValue.startsWith("[") && !rawValue.endsWith("]")) {
      arrayKey = key;
      arrayItems = [];
      if (rawValue.length > 1) {
        const rest = rawValue.slice(1).trim();
        if (rest.length > 0) arrayItems.push(unquoteToml(rest.replace(/,$/, "").trim()));
      }
      continue;
    }
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      const inner = rawValue.slice(1, -1).trim();
      const items = inner.length === 0 ? [] : splitTomlList(inner);
      if (key === "models" && section === "subagents") subagentModels = items;
      continue;
    }
    const value = unquoteToml(rawValue);
    if (section === "compaction" && key === "provider") provider = parseCompactionProvider(value);
    if (section === "compaction" && key === "model" && value.length > 0) model = value;
    if (section === "compaction" && key === "ollama_threads") ollamaThreads = parseOllamaThreadCompaction(value);
    if (section === "compaction" && key === "ollama_model") ollamaModel = parseOllamaCompactModel(value);
    if (section === "compaction" && key === "ollama_effort") ollamaEffort = parseOllamaCompactEffort(value);
    if (section === "subagents" && key === "models") subagentModels = [value];
    if (section === "catalog" && key === "supports_search_tool") {
      supportsSearchTool = parseTomlBool(value, "catalog.supports_search_tool");
    }
    if (section === "catalog" && key === "advertise_cloud_max_context") {
      advertiseCloudMaxContext = parseTomlBool(value, "catalog.advertise_cloud_max_context");
    }
    if (section === "catalog" && key === "active_context_window") {
      activeContextWindow = parsePositiveInt(value, "catalog.active_context_window");
    }
    if (section === "catalog" && key === "auto_compact_token_limit") {
      autoCompactTokenLimit = parsePositiveInt(value, "catalog.auto_compact_token_limit");
    }
    if (section === "catalog" && key === "apply_patch") {
      applyPatch = parseTomlBool(value, "catalog.apply_patch");
    }
    if (section === "experimental" && key === "native_plaintext_spawn") {
      nativePlaintextSpawn = parseTomlBool(value, "experimental.native_plaintext_spawn");
    }
    if (section === "experimental" && key === "native_plaintext_spawn_schema_sha256") {
      nativePlaintextSpawnSchemaSha256 = parseSchemaSha256(value, "experimental.native_plaintext_spawn_schema_sha256");
    }
  }
  if (arrayKey) {
    throw new CobConfigError("invalid_cob_toml", "unterminated array in cob.toml");
  }

  return {
    compaction: compactionPolicy({
      provider: provider ?? "native",
      model,
      ollamaThreads: ollamaThreads ?? "summarize",
      ollamaModel,
      ollamaEffort,
    }),
    subagents: subagentModels ? { models: subagentModels } : {},
    catalog: catalogPolicy({
      supportsSearchTool: supportsSearchTool ?? DEFAULT_CATALOG_POLICY.supportsSearchTool,
      advertiseCloudMaxContext,
      activeContextWindow,
      autoCompactTokenLimit,
      applyPatch: applyPatch ?? DEFAULT_CATALOG_POLICY.applyPatch,
    }),
    experimental: experimentalPolicy({
      nativePlaintextSpawn: nativePlaintextSpawn ?? DEFAULT_EXPERIMENTAL_POLICY.nativePlaintextSpawn.enabled,
      schemaSha256: nativePlaintextSpawnSchemaSha256,
    }),
  };
}

export function renderCobToml(config: CobFileConfig): string {
  const models = config.subagents.models ?? [...DEFAULT_SPAWNABLE_OLLAMA_SLUGS];
  const lines = [
    "# Owned by cob. This is not a Codex profile; cob restore deletes it.",
    "[compaction]",
    `provider = ${tomlString(config.compaction.provider)}`,
    `ollama_threads = ${tomlString(config.compaction.ollamaThreads ?? "summarize")}`,
  ];
  if (config.compaction.model && config.compaction.model.length > 0) {
    lines.push(`model = ${tomlString(config.compaction.model)}`);
  }
  if (config.compaction.ollamaModel && config.compaction.ollamaModel.length > 0) {
    lines.push(`ollama_model = ${tomlString(config.compaction.ollamaModel)}`);
  }
  if (config.compaction.ollamaEffort) {
    lines.push(`ollama_effort = ${tomlString(config.compaction.ollamaEffort)}`);
  }
  lines.push("", "[subagents]", "models = [");
  for (const slug of models) {
    lines.push(`  ${tomlString(slug)},`);
  }
  lines.push(
    "]",
    "",
    "[catalog]",
    "# Default true. Set false to send the full tool list on every Ollama turn.",
    `supports_search_tool = ${config.catalog?.supportsSearchTool !== false ? "true" : "false"}`,
    "# Gate 5: isolated --dev only; default false. Enables freeform apply_patch on configured Ollama spawn rows.",
    `apply_patch = ${config.catalog?.applyPatch === true ? "true" : "false"}`,
  );
  if (config.catalog?.advertiseCloudMaxContext === true) {
    lines.push("advertise_cloud_max_context = true");
  }
  if (
    typeof config.catalog?.activeContextWindow === "number" &&
    config.catalog.activeContextWindow !== OLLAMA_CATALOG_CONTEXT_CAP
  ) {
    lines.push(`active_context_window = ${config.catalog.activeContextWindow}`);
  }
  if (typeof config.catalog?.autoCompactTokenLimit === "number") {
    lines.push(`auto_compact_token_limit = ${config.catalog.autoCompactTokenLimit}`);
  }
  const nativePlaintextSpawn = config.experimental?.nativePlaintextSpawn ?? DEFAULT_EXPERIMENTAL_POLICY.nativePlaintextSpawn;
  lines.push(
    "",
    "[experimental]",
    `native_plaintext_spawn = ${nativePlaintextSpawn.enabled ? "true" : "false"}`,
  );
  if (nativePlaintextSpawn.schemaSha256) {
    lines.push(`native_plaintext_spawn_schema_sha256 = ${tomlString(nativePlaintextSpawn.schemaSha256)}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function readCobToml(path: string): CobFileConfig | undefined {
  try {
    return parseCobToml(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof CobConfigError) throw error;
    return undefined;
  }
}

export function writeCobToml(path: string, config: CobFileConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, renderCobToml(config), 0o600);
}

export function resolveCobConfig(opts: {
  paths?: Pick<CobPaths, "cobConfig">;
  provider?: string;
  model?: string;
  ollamaThreads?: string;
  ollamaModel?: string;
  ollamaEffort?: string;
  subagentModels?: string[];
  supportsSearchTool?: boolean;
  advertiseCloudMaxContext?: boolean;
  activeContextWindow?: number;
  autoCompactTokenLimit?: number;
  applyPatch?: boolean;
  nativePlaintextSpawn?: boolean;
  nativePlaintextSpawnSchemaSha256?: string;
  env?: NodeJS.ProcessEnv;
}): CobFileConfig {
  const env = opts.env ?? process.env;
  const file = opts.paths ? readCobToml(opts.paths.cobConfig) : undefined;
  const provider =
    parseCompactionProvider(opts.provider) ??
    parseCompactionProvider(env.COB_COMPACTION_PROVIDER) ??
    file?.compaction.provider ??
    "native";
  const model = firstNonEmpty(opts.model, env.COB_COMPACTION_MODEL, file?.compaction.model);
  const ollamaThreads =
    parseOllamaThreadCompaction(opts.ollamaThreads) ??
    parseOllamaThreadCompaction(env.COB_COMPACTION_OLLAMA_THREADS) ??
    file?.compaction.ollamaThreads ??
    "summarize";
  const ollamaModel = parseOllamaCompactModel(
    firstNonEmpty(opts.ollamaModel, env.COB_COMPACTION_OLLAMA_MODEL, file?.compaction.ollamaModel),
  );
  const ollamaEffort =
    parseOllamaCompactEffort(opts.ollamaEffort) ??
    parseOllamaCompactEffort(env.COB_COMPACTION_OLLAMA_EFFORT) ??
    file?.compaction.ollamaEffort;
  const subagentModels =
    opts.subagentModels ?? parseSubagentEnv(env.COB_SUBAGENT_MODELS) ?? file?.subagents.models;
  const supportsSearchTool =
    opts.supportsSearchTool ??
    parseEnvBool(env.COB_SUPPORTS_SEARCH_TOOL) ??
    file?.catalog?.supportsSearchTool ??
    DEFAULT_CATALOG_POLICY.supportsSearchTool;
  const advertiseCloudMaxContext =
    opts.advertiseCloudMaxContext ??
    parseEnvBool(env.COB_ADVERTISE_CLOUD_MAX_CONTEXT) ??
    file?.catalog?.advertiseCloudMaxContext ??
    false;
  const activeContextWindow =
    opts.activeContextWindow ??
    parsePositiveInt(env.COB_ACTIVE_CONTEXT_WINDOW, "COB_ACTIVE_CONTEXT_WINDOW") ??
    file?.catalog?.activeContextWindow;
  const autoCompactTokenLimit =
    opts.autoCompactTokenLimit ??
    parsePositiveInt(env.COB_AUTO_COMPACT_TOKEN_LIMIT, "COB_AUTO_COMPACT_TOKEN_LIMIT") ??
    file?.catalog?.autoCompactTokenLimit;
  const applyPatch =
    opts.applyPatch ??
    file?.catalog?.applyPatch ??
    DEFAULT_CATALOG_POLICY.applyPatch ??
    false;
  const nativePlaintextSpawn =
    opts.nativePlaintextSpawn ??
    parseEnvBool(env.COB_NATIVE_PLAINTEXT_SPAWN, "COB_NATIVE_PLAINTEXT_SPAWN") ??
    file?.experimental?.nativePlaintextSpawn.enabled ??
    DEFAULT_EXPERIMENTAL_POLICY.nativePlaintextSpawn.enabled;
  const nativePlaintextSpawnSchemaSha256 = parseSchemaSha256(
    firstNonEmpty(
      opts.nativePlaintextSpawnSchemaSha256,
      env.COB_NATIVE_PLAINTEXT_SPAWN_SCHEMA_SHA256,
      file?.experimental?.nativePlaintextSpawn.schemaSha256,
    ),
    "experimental.native_plaintext_spawn_schema_sha256",
  );
  return {
    compaction: compactionPolicy({ provider, model, ollamaThreads, ollamaModel, ollamaEffort }),
    subagents: subagentModels ? { models: subagentModels } : {},
    catalog: catalogPolicy({
      supportsSearchTool,
      advertiseCloudMaxContext,
      activeContextWindow,
      autoCompactTokenLimit,
      applyPatch,
    }),
    experimental: experimentalPolicy({
      nativePlaintextSpawn,
      schemaSha256: nativePlaintextSpawnSchemaSha256,
    }),
  };
}

export function resolveCompactionPolicy(opts: {
  paths?: Pick<CobPaths, "cobConfig">;
  provider?: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
}): CompactionPolicy {
  return resolveCobConfig(opts).compaction;
}

export function resolveSpawnableOllamaSlugs(config: CobFileConfig): string[] {
  if (config.subagents.models) return config.subagents.models;
  return [...DEFAULT_SPAWNABLE_OLLAMA_SLUGS];
}

export function catalogSupportsSearchTool(config: CobFileConfig): boolean {
  return config.catalog?.supportsSearchTool === true;
}

export function catalogSupportsApplyPatch(config: CobFileConfig): boolean {
  return config.catalog?.applyPatch === true;
}

export function cobTomlExists(path: string): boolean {
  return existsSync(path);
}

function parseSubagentEnv(value: string | undefined): string[] | undefined {
  if (!value || value.trim().length === 0) return undefined;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function splitTomlList(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const char of inner) {
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ",") {
      const item = unquoteToml(current.trim());
      if (item.length > 0) items.push(item);
      current = "";
      continue;
    }
    current += char;
  }
  const last = unquoteToml(current.trim());
  if (last.length > 0) items.push(last);
  return items;
}

function compactionPolicy(opts: {
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

function catalogPolicy(opts: {
  supportsSearchTool: boolean;
  advertiseCloudMaxContext?: boolean;
  activeContextWindow?: number;
  autoCompactTokenLimit?: number;
  applyPatch?: boolean;
}): CatalogPolicy {
  return {
    supportsSearchTool: opts.supportsSearchTool,
    applyPatch: opts.applyPatch === true,
    ...(opts.advertiseCloudMaxContext === true ? { advertiseCloudMaxContext: true } : {}),
    ...(typeof opts.activeContextWindow === "number" ? { activeContextWindow: opts.activeContextWindow } : {}),
    ...(typeof opts.autoCompactTokenLimit === "number" ? { autoCompactTokenLimit: opts.autoCompactTokenLimit } : {}),
  };
}

function experimentalPolicy(opts: {
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

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function unquoteToml(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function parseTomlBool(value: string, field: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new CobConfigError("invalid_cob_toml", `${field} must be true or false`);
}

function parseEnvBool(value: string | undefined, field = "COB_SUPPORTS_SEARCH_TOOL"): boolean | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "1" || trimmed === "true") return true;
  if (trimmed === "0" || trimmed === "false") return false;
  throw new CobConfigError("invalid_cob_toml", `${field} must be true or false`);
}

function parseSchemaSha256(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;
  if (!/^[0-9a-f]{64}$/.test(trimmed)) {
    throw new CobConfigError("invalid_cob_toml", `${field} must be a 64-character SHA-256 hex digest`);
  }
  return trimmed;
}
