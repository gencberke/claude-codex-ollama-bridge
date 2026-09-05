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
  limitsPolicy,
  parseNativeSlugList,
  parseOllamaCompactEffort,
  parseOllamaCompactModel,
  parseOllamaSlugList,
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

const KNOWN_COB_TOML_KEYS: Record<string, Set<string>> = {
  compaction: new Set(["provider", "model", "ollama_threads", "ollama_model", "ollama_effort"]),
  subagents: new Set(["models"]),
  catalog: new Set([
    "native_include",
    "native_exclude",
    "supports_search_tool",
    "advertise_cloud_max_context",
    "active_context_window",
    "auto_compact_token_limit",
    "apply_patch",
  ]),
  experimental: new Set(["native_plaintext_spawn", "native_plaintext_spawn_schema_sha256"]),
  limits: new Set(["ollama_max_response_bytes"]),
};

function assertKnownCobTomlKey(section: string, key: string): void {
  const allowed = KNOWN_COB_TOML_KEYS[section];
  if (allowed === undefined || !allowed.has(key)) {
    throw new CobConfigError("invalid_cob_toml", `unknown key "${key}" in [${section}] of cob.toml`);
  }
}

/** Token type each known scalar key demands; security booleans must never be quoted. */
const SCALAR_TOKEN_KINDS: Record<string, "string" | "boolean" | "integer"> = {
  "compaction.provider": "string",
  "compaction.model": "string",
  "compaction.ollama_threads": "string",
  "compaction.ollama_model": "string",
  "compaction.ollama_effort": "string",
  "catalog.supports_search_tool": "boolean",
  "catalog.advertise_cloud_max_context": "boolean",
  "catalog.active_context_window": "integer",
  "catalog.auto_compact_token_limit": "integer",
  "catalog.apply_patch": "boolean",
  "experimental.native_plaintext_spawn": "boolean",
  "experimental.native_plaintext_spawn_schema_sha256": "string",
  "limits.ollama_max_response_bytes": "integer",
};

function tomlScalarTokenKind(rawValue: string): "string" | "boolean" | "integer" | "invalid" {
  const quote = rawValue[0];
  if (quote === '"' || quote === "'") return "string";
  if (rawValue === "true" || rawValue === "false") return "boolean";
  if (/^[0-9]+$/.test(rawValue)) return "integer";
  return "invalid";
}

function assertScalarTokenKind(rawValue: string, field: string): void {
  const expected = SCALAR_TOKEN_KINDS[field];
  if (expected === undefined) return;
  const kind = tomlScalarTokenKind(rawValue);
  if (kind === "invalid") return; // parseTomlScalar reports the malformed token
  if (kind !== expected) {
    const want =
      expected === "boolean"
        ? "a bare true or false"
        : expected === "integer"
          ? "a bare positive integer"
          : "a quoted string";
    throw new CobConfigError("invalid_cob_toml", `${field} must be ${want}`);
  }
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
  let nativeInclude: string[] | undefined;
  let nativeExclude: string[] | undefined;
  let advertiseCloudMaxContext: boolean | undefined;
  let activeContextWindow: number | undefined;
  let autoCompactTokenLimit: number | undefined;
  let applyPatch: boolean | undefined;
  let nativePlaintextSpawn: boolean | undefined;
  let nativePlaintextSpawnSchemaSha256: string | undefined;
  let ollamaMaxResponseBytes: number | undefined;
  let arrayKey: string | undefined;
  let arrayItems: string[] = [];
  const seenSections = new Set<string>();
  const seenKeys = new Map<string, Set<string>>();

  const flushArray = (): void => {
    if (arrayKey === "models" && section === "subagents") {
      subagentModels = arrayItems.slice();
    }
    if (arrayKey === "native_include" && section === "catalog") {
      nativeInclude = arrayItems.slice();
    }
    if (arrayKey === "native_exclude" && section === "catalog") {
      nativeExclude = arrayItems.slice();
    }
    arrayKey = undefined;
    arrayItems = [];
  };
  const assignScalar = (key: string, value: string): void => {
    if (section === "compaction") {
      if (key === "provider") provider = parseCompactionProvider(value);
      if (key === "model" && value.length > 0) model = value;
      if (key === "ollama_threads") ollamaThreads = parseOllamaThreadCompaction(value);
      if (key === "ollama_model") ollamaModel = parseOllamaCompactModel(value);
      if (key === "ollama_effort") ollamaEffort = parseOllamaCompactEffort(value);
    }
    if (section === "subagents" && key === "models") {
      throw new CobConfigError("invalid_cob_toml", "subagents.models must be an array of quoted strings");
    }
    if (section === "catalog" && (key === "native_include" || key === "native_exclude")) {
      throw new CobConfigError("invalid_cob_toml", `catalog.${key} must be an array of quoted strings`);
    }
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
    if (section === "limits" && key === "ollama_max_response_bytes") {
      ollamaMaxResponseBytes = parsePositiveInt(value, "limits.ollama_max_response_bytes");
    }
  };
  const assignList = (key: string, items: string[]): void => {
    if (section === "subagents" && key === "models") {
      subagentModels = items;
      return;
    }
    if (section === "catalog" && key === "native_include") {
      nativeInclude = items;
      return;
    }
    if (section === "catalog" && key === "native_exclude") {
      nativeExclude = items;
      return;
    }
    throw new CobConfigError("invalid_cob_toml", `key "${section}.${key}" must not be an array`);
  };
  const trackKey = (key: string): void => {
    const seen = seenKeys.get(section);
    if (seen === undefined) {
      throw new CobConfigError("invalid_cob_toml", `key "${key}" appears before any table header in cob.toml`);
    }
    assertKnownCobTomlKey(section, key);
    if (seen.has(key)) {
      throw new CobConfigError("invalid_cob_toml", `duplicate key "${key}" in [${section}] of cob.toml`);
    }
    seen.add(key);
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (line.length === 0) continue;
    if (arrayKey !== undefined) {
      if (line === "]") {
        flushArray();
        continue;
      }
      arrayItems.push(parseTomlArrayItem(line));
      continue;
    }
    const sectionMatch = /^\[([A-Za-z0-9_-]+)\]$/.exec(line);
    if (sectionMatch) {
      const name = sectionMatch[1]!;
      if (!KNOWN_COB_TOML_KEYS[name]) {
        throw new CobConfigError("invalid_cob_toml", `unknown section [${name}] in cob.toml`);
      }
      if (seenSections.has(name)) {
        throw new CobConfigError("invalid_cob_toml", `duplicate section [${name}] in cob.toml`);
      }
      seenSections.add(name);
      seenKeys.set(name, new Set());
      section = name;
      continue;
    }
    if (line.startsWith("[")) {
      throw new CobConfigError("invalid_cob_toml", `malformed table header in cob.toml: ${line}`);
    }
    const eq = line.indexOf("=");
    if (eq < 0) {
      throw new CobConfigError("invalid_cob_toml", `expected key = value in cob.toml, got: ${line}`);
    }
    const key = line.slice(0, eq).trim();
    const rawValue = line.slice(eq + 1).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) {
      throw new CobConfigError("invalid_cob_toml", `invalid key "${key}" in cob.toml`);
    }
    trackKey(key);
    if (!rawValue.startsWith("[")) {
      assertScalarTokenKind(rawValue, `${section}.${key}`);
    }
    if (rawValue === "[" || (rawValue.startsWith("[") && !rawValue.endsWith("]"))) {
      if (
        !(
          (section === "subagents" && key === "models") ||
          (section === "catalog" && (key === "native_include" || key === "native_exclude"))
        )
      ) {
        throw new CobConfigError("invalid_cob_toml", `key "${section}.${key}" must not be an array`);
      }
      arrayKey = key;
      arrayItems = [];
      if (rawValue.length > 1) {
        arrayItems.push(parseTomlArrayItem(rawValue.slice(1).trim()));
      }
      continue;
    }
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      const inner = rawValue.slice(1, -1).trim();
      assignList(key, inner.length === 0 ? [] : splitTomlList(inner));
      continue;
    }
    assignScalar(key, parseTomlScalar(rawValue, `${section}.${key}`));
  }
  if (arrayKey !== undefined) {
    throw new CobConfigError("invalid_cob_toml", "unterminated array in cob.toml");
  }
  if (subagentModels !== undefined) {
    parseOllamaSlugList(subagentModels, "subagents.models");
  }
  if (nativeInclude !== undefined) {
    parseNativeSlugList(nativeInclude, "catalog.native_include");
  }
  if (nativeExclude !== undefined) {
    parseNativeSlugList(nativeExclude, "catalog.native_exclude");
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
      nativeInclude,
      nativeExclude,
      advertiseCloudMaxContext,
      activeContextWindow,
      autoCompactTokenLimit,
      applyPatch: applyPatch ?? DEFAULT_CATALOG_POLICY.applyPatch,
    }),
    experimental: experimentalPolicy({
      nativePlaintextSpawn: nativePlaintextSpawn ?? DEFAULT_EXPERIMENTAL_POLICY.nativePlaintextSpawn.enabled,
      schemaSha256: nativePlaintextSpawnSchemaSha256,
    }),
    limits: limitsPolicy({ ollamaMaxResponseBytes }),
  };
}

/**
 * `#` starts a comment only outside a quoted value; the quote state is tracked
 * with escape awareness so quoted `#` characters survive.
 */
function stripTomlComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote !== undefined) {
      if (ch === "\\" && quote === '"') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function parseTomlScalar(rawValue: string, field: string): string {
  if (rawValue.length === 0) {
    throw new CobConfigError("invalid_cob_toml", `${field} has an empty value`);
  }
  const quote = rawValue[0]!;
  if (quote === '"') {
    const close = findBasicStringEnd(rawValue);
    if (close === undefined) {
      throw new CobConfigError("invalid_cob_toml", `${field} has an unterminated quoted string`);
    }
    if (rawValue.slice(close + 1).trim().length > 0) {
      throw new CobConfigError("invalid_cob_toml", `${field} has trailing content after the closing quote`);
    }
    return unescapeBasicString(rawValue.slice(1, close), field);
  }
  if (quote === "'") {
    const close = rawValue.indexOf("'", 1);
    if (close < 0) {
      throw new CobConfigError("invalid_cob_toml", `${field} has an unterminated quoted string`);
    }
    if (rawValue.slice(close + 1).trim().length > 0) {
      throw new CobConfigError("invalid_cob_toml", `${field} has trailing content after the closing quote`);
    }
    return rawValue.slice(1, close);
  }
  if (rawValue === "true" || rawValue === "false" || /^[0-9]+$/.test(rawValue)) {
    return rawValue;
  }
  throw new CobConfigError("invalid_cob_toml", `${field} must be a quoted string, boolean, or integer`);
}

function findBasicStringEnd(value: string): number | undefined {
  for (let i = 1; i < value.length; i += 1) {
    const ch = value[i]!;
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === '"') return i;
  }
  return undefined;
}

function unescapeBasicString(raw: string, field: string): string {
  return raw.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_match, escape: string) => {
    if (escape.startsWith("u")) return String.fromCharCode(parseInt(escape.slice(1), 16));
    switch (escape) {
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      default:
        throw new CobConfigError("invalid_cob_toml", `${field} uses unsupported escape sequence \\${escape}`);
    }
  });
}

function parseTomlArrayItem(line: string): string {
  if (!line.endsWith(",")) {
    throw new CobConfigError("invalid_cob_toml", "array items in cob.toml must end with a comma");
  }
  const inner = line.slice(0, -1).trim();
  if (inner.length === 0) {
    throw new CobConfigError("invalid_cob_toml", "empty item in a cob.toml array");
  }
  const quote = inner[0]!;
  if (quote !== '"' && quote !== "'") {
    throw new CobConfigError("invalid_cob_toml", `array items in cob.toml must be quoted strings, got: ${inner}`);
  }
  return parseTomlScalar(inner, "cob.toml array item");
}

export function renderCobToml(config: CobFileConfig): string {
  const models = config.subagents.models ?? [...DEFAULT_SPAWNABLE_OLLAMA_SLUGS];
  const nativeInclude = config.catalog?.nativeInclude ?? [];
  const nativeExclude = config.catalog?.nativeExclude ?? [];
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
    "# Native rows follow the bundled Codex catalog. These exact-slug lists are optional overrides.",
  );
  if (nativeInclude.length > 0) {
    lines.push(`native_include = [${nativeInclude.map(tomlString).join(", ")}]`);
  }
  if (nativeExclude.length > 0) {
    lines.push(`native_exclude = [${nativeExclude.map(tomlString).join(", ")}]`);
  }
  lines.push(
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
  if (typeof config.limits?.ollamaMaxResponseBytes === "number") {
    lines.push(
      "",
      "[limits]",
      "# Cumulative ceiling on one Ollama SSE response. Omit for the built-in default.",
      `ollama_max_response_bytes = ${config.limits.ollamaMaxResponseBytes}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function readCobToml(path: string): CobFileConfig | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isFsError(error) && error.code === "ENOENT") return undefined;
    // A missing cob.toml is the default-config case, but any other I/O error
    // means the configured file exists and cannot be honored. Fail closed
    // instead of silently starting with defaults. Never echo file content.
    const code = isFsError(error) ? error.code : "unknown_error";
    throw new CobConfigError("cob_config_read_failed", `cannot read ${path}: ${code}`);
  }
  return parseCobToml(text);
}

function isFsError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string";
}

export function writeCobToml(path: string, config: CobFileConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, renderCobToml(config), 0o600);
}
function splitTomlList(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i]!;
    if (quote) {
      current += char;
      if (quote === '"' && char === "\\") {
        current += inner[i + 1] ?? "";
        i += 1;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ",") {
      const item = current.trim();
      if (item.length === 0) {
        throw new CobConfigError("invalid_cob_toml", "empty item in a cob.toml array");
      }
      items.push(parseTomlScalar(item, "cob.toml array item"));
      current = "";
      continue;
    }
    current += char;
  }
  const last = current.trim();
  if (last.length > 0) items.push(parseTomlScalar(last, "cob.toml array item"));
  return items;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
