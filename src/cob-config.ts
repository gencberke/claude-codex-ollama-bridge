import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import type { CobPaths } from "./paths.js";

export type CompactionProvider = "native";

export type OllamaThreadCompaction = "summarize" | "native";

export type CompactionPolicy = {
  provider: CompactionProvider;
  /** Native ChatGPT slug for GPT-thread compact and the optional Ollama native-replay fallback. */
  model?: string;
  /** Ollama threads: summarize (default) or native full-replay compact. */
  ollamaThreads?: OllamaThreadCompaction;
  /** Optional dedicated Ollama summarizer slug. Default is the thread model. */
  ollamaModel?: string;
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
};

export type CobFileConfig = {
  compaction: CompactionPolicy;
  subagents: SubagentPolicy;
  catalog?: CatalogPolicy;
};

export const DEFAULT_CATALOG_POLICY: CatalogPolicy = { supportsSearchTool: true };

export const DEFAULT_SPAWNABLE_OLLAMA_SLUGS = ["ollama/deepseek-v4-flash:0731-cloud"] as const;

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

export function parseCobToml(text: string): CobFileConfig {
  let section = "";
  let provider: CompactionProvider | undefined;
  let model: string | undefined;
  let ollamaThreads: OllamaThreadCompaction | undefined;
  let ollamaModel: string | undefined;
  let subagentModels: string[] | undefined;
  let supportsSearchTool: boolean | undefined;
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
    if (section === "subagents" && key === "models") subagentModels = [value];
    if (section === "catalog" && key === "supports_search_tool") {
      supportsSearchTool = parseTomlBool(value, "catalog.supports_search_tool");
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
    }),
    subagents: subagentModels ? { models: subagentModels } : {},
    catalog: { supportsSearchTool: supportsSearchTool ?? DEFAULT_CATALOG_POLICY.supportsSearchTool },
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
    "",
  );
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
  subagentModels?: string[];
  supportsSearchTool?: boolean;
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
  const subagentModels =
    opts.subagentModels ?? parseSubagentEnv(env.COB_SUBAGENT_MODELS) ?? file?.subagents.models;
  const supportsSearchTool =
    opts.supportsSearchTool ??
    parseEnvBool(env.COB_SUPPORTS_SEARCH_TOOL) ??
    file?.catalog?.supportsSearchTool ??
    DEFAULT_CATALOG_POLICY.supportsSearchTool;
  return {
    compaction: compactionPolicy({ provider, model, ollamaThreads, ollamaModel }),
    subagents: subagentModels ? { models: subagentModels } : {},
    catalog: { supportsSearchTool },
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
}): CompactionPolicy {
  return {
    provider: opts.provider,
    ollamaThreads: opts.ollamaThreads,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.ollamaModel ? { ollamaModel: opts.ollamaModel } : {}),
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

function parseEnvBool(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "1" || trimmed === "true") return true;
  if (trimmed === "0" || trimmed === "false") return false;
  throw new CobConfigError("invalid_cob_toml", `COB_SUPPORTS_SEARCH_TOOL must be true or false`);
}
