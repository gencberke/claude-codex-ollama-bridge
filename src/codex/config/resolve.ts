import type { CobPaths } from "../paths.js";
import {
  DEFAULT_CATALOG_POLICY,
  DEFAULT_EXPERIMENTAL_POLICY,
  DEFAULT_SPAWNABLE_OLLAMA_SLUGS,
  CobConfigError,
  catalogPolicy,
  compactionPolicy,
  experimentalPolicy,
  parseCompactionProvider,
  parseOllamaCompactEffort,
  parseOllamaCompactModel,
  parseOllamaThreadCompaction,
  parsePositiveInt,
  parseSchemaSha256,
  type CompactionPolicy,
  type CobFileConfig,
} from "./schema.js";
import { readCobToml } from "./toml.js";

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

function parseSubagentEnv(value: string | undefined): string[] | undefined {
  if (!value || value.trim().length === 0) return undefined;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseEnvBool(value: string | undefined, field = "COB_SUPPORTS_SEARCH_TOOL"): boolean | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "1" || trimmed === "true") return true;
  if (trimmed === "0" || trimmed === "false") return false;
  throw new CobConfigError("invalid_cob_toml", `${field} must be true or false`);
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}
