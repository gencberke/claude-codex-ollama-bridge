import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../../core/atomic.js";
import { OLLAMA_CATALOG_CONTEXT_CAP } from "../constants.js";
import {
  DEFAULT_CATALOG_POLICY,
  DEFAULT_EXPERIMENTAL_POLICY,
  DEFAULT_SPAWNABLE_OLLAMA_SLUGS,
  CobConfigError,
  catalogPolicy,
  compactionPolicy,
  experimentalPolicy,
  parseOllamaCompactEffort,
  parseOllamaCompactModel,
  parseOllamaThreadCompaction,
  parsePositiveInt,
  parseCompactionProvider,
  parseSchemaSha256,
  parseTomlBool,
  type CompactionProvider,
  type CobFileConfig,
  type OllamaCompactEffort,
  type OllamaThreadCompaction,
} from "./schema.js";

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
