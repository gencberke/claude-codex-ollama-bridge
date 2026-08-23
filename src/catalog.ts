import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CodexBinaryRecord } from "./catalog-provenance.js";
import {
  FEATURED_NATIVE_SLUGS,
  GPT_IDENTITY_FIELDS,
  OLLAMA_BASE_INSTRUCTIONS,
  OLLAMA_CATALOG_CONTEXT_CAP,
  OLLAMA_CATALOG_FIELDS,
} from "./constants.js";
import { writeFileAtomic } from "./atomic.js";
import { CODEX_CATALOG_TIMEOUT_MS, OLLAMA_TAGS_TIMEOUT_MS } from "./limits.js";
import { DEFAULT_SPAWNABLE_OLLAMA_SLUGS } from "./cob-config.js";
import {
  evidenceFromOllamaTag,
  ollamaChildCatalogFields,
  OLLAMA_REASONING_EFFORTS,
  type OllamaCapabilityEvidence,
} from "./capabilities.js";
import { ollamaCatalogSlug } from "./route.js";
import type { CatalogFile, JsonObject, OllamaTag } from "./types.js";
import { asPriority, asSlug, asVisibility, isRecord } from "./types.js";

const IDENTITY_DROP = new Set<string>(
  GPT_IDENTITY_FIELDS.filter((field) => field !== "base_instructions"),
);

export type CatalogMergeOptions = {
  spawnableOllamaSlugs?: readonly string[];
  /** Advertise supports_search_tool on Ollama rows. Requires the cob tool_search shim. */
  supportsSearchTool?: boolean;
};

export type CatalogSafetyOptions = {
  allowSearchTool?: boolean;
};

export function parseCatalogJson(text: string): CatalogFile {
  const start = text.indexOf("{");
  if (start < 0) {
    throw new Error("catalog JSON not found");
  }
  const parsed: unknown = JSON.parse(text.slice(start));
  if (!isRecord(parsed) || !Array.isArray(parsed.models)) {
    throw new Error("catalog JSON must be { models: [] }");
  }
  return { models: parsed.models.filter(isRecord) };
}

type CatalogFileCache = {
  path: string;
  identity: string;
  catalog: CatalogFile;
};

let catalogFileCache: CatalogFileCache | undefined;

export function resetCatalogFileCache(): void {
  catalogFileCache = undefined;
}

export function catalogFileIdentityKey(path: string): string {
  const stat = statSync(path);
  return `${stat.dev}:${stat.ino}:${stat.size}:${Math.round(stat.mtimeMs)}`;
}

/** Process-local parsed catalog cache keyed by file identity. Not provenance. */
export function loadCatalogFile(path: string): CatalogFile {
  const identity = catalogFileIdentityKey(path);
  if (catalogFileCache && catalogFileCache.path === path && catalogFileCache.identity === identity) {
    return catalogFileCache.catalog;
  }
  const catalog = parseCatalogJson(readFileSync(path, "utf8"));
  catalogFileCache = { path, identity, catalog };
  return catalog;
}

export function loadBundledCatalog(codexBin = process.env.COB_CODEX_BIN ?? "codex"): CatalogFile {
  const result = spawnSync(codexBin, ["debug", "models", "--bundled"], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: CODEX_CATALOG_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === "ETIMEDOUT") {
        throw new Error(`codex debug models --bundled timed out after ${CODEX_CATALOG_TIMEOUT_MS}ms`);
      }
      throw result.error;
    }
  if (result.status !== 0) {
    throw new Error(
      `codex debug models --bundled failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return parseCatalogJson(result.stdout);
}

export async function loadOllamaTags(
  ollamaUrl: string,
  timeoutMs = OLLAMA_TAGS_TIMEOUT_MS,
): Promise<OllamaTag[]> {
  const url = `${ollamaUrl.replace(/\/$/, "")}/api/tags`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error(`Ollama /api/tags timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
  if (!response.ok) {
    throw new Error(`Ollama /api/tags failed: ${response.status} ${response.statusText}`);
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    throw new Error("Ollama /api/tags returned an unexpected payload");
  }
  return payload.models.filter(isRecord).map((model) => ({
    name: typeof model.name === "string" ? model.name : "",
    model: typeof model.model === "string" ? model.model : undefined,
    details: isRecord(model.details)
      ? {
          context_length:
            typeof model.details.context_length === "number"
              ? model.details.context_length
              : undefined,
          family: typeof model.details.family === "string" ? model.details.family : undefined,
          parameter_size:
            typeof model.details.parameter_size === "string"
              ? model.details.parameter_size
              : undefined,
        }
      : undefined,
    capabilities: Array.isArray(model.capabilities)
      ? model.capabilities.filter((item): item is string => typeof item === "string")
      : [],
    remote_host: typeof model.remote_host === "string" ? model.remote_host : undefined,
  })).filter((tag) => tag.name.length > 0);
}

export function listVisibleTopSlugs(models: JsonObject[], limit = 5): string[] {
  return models
    .filter((model) => asVisibility(model) === "list")
    .slice()
    .sort((a, b) => asPriority(a) - asPriority(b) || asSlug(a).localeCompare(asSlug(b)))
    .slice(0, limit)
    .map(asSlug);
}

function pickSkeleton(native: JsonObject[]): JsonObject {
  const luna = native.find((model) => asSlug(model) === "gpt-5.6-luna");
  if (luna) return luna;
  const withReasoning = native.find((model) => Array.isArray(model.supported_reasoning_levels));
  if (withReasoning) return withReasoning;
  const first = native[0];
  if (!first) {
    throw new Error("bundled catalog has no native models to use as schema fixture");
  }
  return first;
}

export function buildOllamaEntry(
  tag: OllamaTag,
  skeleton: JsonObject,
  priority: number,
  options?: CatalogMergeOptions,
): JsonObject {
  const evidence = evidenceFromOllamaTag(tag);
  const context = ollamaCatalogContextWindow(tag.details?.context_length);
  const size = tag.details?.parameter_size ? ` (${tag.details.parameter_size})` : "";
  const where = tag.remote_host
    ? `via the local Ollama daemon to ${tag.remote_host}`
    : "via the local Ollama daemon";
  const fields = ollamaChildCatalogFields({
    evidence,
    skeleton,
    contextWindow: context,
    supportsSearchTool: options?.supportsSearchTool === true,
  });
  const slug = ollamaCatalogSlug(tag.name);
  const entry: JsonObject = {
    slug,
    display_name: slug,
    description: `Ollama model${size} ${where}. Routed by cob; not a ChatGPT model.`,
    base_instructions: OLLAMA_BASE_INSTRUCTIONS,
    visibility: "list",
    priority,
    ...fields,
  };

  for (const key of Object.keys(entry)) {
    if (!OLLAMA_CATALOG_FIELDS.includes(key as (typeof OLLAMA_CATALOG_FIELDS)[number])) {
      delete entry[key];
    }
  }
  for (const leaked of IDENTITY_DROP) {
    delete entry[leaked];
  }
  assertOllamaRowMatchesEvidence(entry, evidence);
  return entry;
}

export function ollamaCatalogContextWindow(tagLength: number | undefined): number {
  const raw = typeof tagLength === "number" && tagLength > 0 ? tagLength : 32768;
  return Math.min(raw, OLLAMA_CATALOG_CONTEXT_CAP);
}

export function assignFeaturedPriorities(
  native: JsonObject[],
  ollamaIds: string[],
  spawnableOllamaSlugs: readonly string[] = DEFAULT_SPAWNABLE_OLLAMA_SLUGS,
): Map<string, number> {
  const nativeSlugs = new Set(native.map(asSlug));
  const spawnableIds = matchingSpawnableIds(ollamaIds, spawnableOllamaSlugs);
  const used = new Set<string>();
  const window: string[] = [];

  for (const slug of FEATURED_NATIVE_SLUGS) {
    if (nativeSlugs.has(slug) && !used.has(slug)) {
      window.push(slug);
      used.add(slug);
    }
  }

  const primarySpawn = spawnableIds[0];
  if (primarySpawn) {
    const slug = ollamaCatalogSlug(primarySpawn);
    if (!used.has(slug)) {
      window.push(slug);
      used.add(slug);
    }
  }

  const priorities = new Map<string, number>();
  window.forEach((slug, index) => {
    priorities.set(slug, index);
  });

  for (const model of native) {
    const slug = asSlug(model);
    if (!priorities.has(slug)) {
      priorities.set(slug, 10 + asPriority(model));
    }
  }
  let extra = 20;
  for (const id of ollamaIds) {
    const slug = ollamaCatalogSlug(id);
    if (!priorities.has(slug)) {
      priorities.set(slug, extra);
      extra += 1;
    }
  }
  return priorities;
}

function applyPickerVisibility(models: JsonObject[], spawnableOllamaSlugs: readonly string[]): void {
  const featured = new Set<string>(FEATURED_NATIVE_SLUGS);
  for (const model of models) {
    const slug = asSlug(model);
    if (slug.startsWith("ollama/")) {
      model.visibility = spawnableOllamaSlugs.some((wanted) => isSpawnableMatch(slug, wanted))
        ? "list"
        : "hide";
    } else {
      model.visibility = featured.has(slug) ? "list" : "hide";
    }
  }
}

function matchingSpawnableIds(ollamaIds: string[], spawnableSlugs: readonly string[]): string[] {
  const matched: string[] = [];
  for (const wanted of spawnableSlugs) {
    const id = ollamaIds.find((candidate) => isSpawnableMatch(candidate, wanted));
    if (id && !matched.includes(id)) matched.push(id);
  }
  return matched;
}

export function isSpawnableMatch(tagNameOrSlug: string, spawnable: string): boolean {
  const candidateSlug = tagNameOrSlug.startsWith("ollama/")
    ? tagNameOrSlug
    : ollamaCatalogSlug(tagNameOrSlug);
  const wantedSlug = spawnable.startsWith("ollama/") ? spawnable : ollamaCatalogSlug(spawnable);
  return candidateSlug === wantedSlug;
}

export function mergeCatalogWithFallback(
  bundled: CatalogFile,
  tags: OllamaTag[],
  previous: CatalogFile | null,
  discoveryFailed: boolean,
  options?: CatalogMergeOptions,
): CatalogFile {
  if (!discoveryFailed || tags.length > 0) {
    return mergeCatalog(bundled, tags, options);
  }
  const previousOllama = (previous?.models ?? []).filter((model) => asSlug(model).startsWith("ollama/"));
  if (previousOllama.length === 0) {
    return mergeCatalog(bundled, [], options);
  }
  const nativeOnly = mergeCatalog(bundled, [], options).models.filter(
    (model) => !asSlug(model).startsWith("ollama/"),
  );
  const ids = previousOllama.map((model) => asSlug(model).slice("ollama/".length));
  const spawnable = options?.spawnableOllamaSlugs ?? DEFAULT_SPAWNABLE_OLLAMA_SLUGS;
  const priorities = assignFeaturedPriorities(nativeOnly, ids, spawnable);
  for (const model of nativeOnly) {
    model.priority = priorities.get(asSlug(model)) ?? asPriority(model);
  }
  const skeleton = pickSkeleton(nativeOnly);
  const ollama: JsonObject[] = [];
  for (const model of previousOllama) {
    const rebuilt = rebuildOllamaRowFromPrevious(
      model,
      skeleton,
      priorities.get(asSlug(model)) ?? asPriority(model),
      options,
    );
    if (rebuilt) ollama.push(rebuilt);
  }
  const catalog = { models: [...nativeOnly, ...ollama] };
  applyPickerVisibility(catalog.models, spawnable);
  assertOllamaRowsSafe(catalog, { allowSearchTool: options?.supportsSearchTool === true });
  return catalog;
}

function rebuildOllamaRowFromPrevious(
  model: JsonObject,
  skeleton: JsonObject,
  priority: number,
  options?: CatalogMergeOptions,
): JsonObject | null {
  const slug = asSlug(model);
  if (!slug.startsWith("ollama/")) return null;
  const efforts = advertisedReasoningEfforts(model);
  const evidence: OllamaCapabilityEvidence = {
    tools: false,
    thinking: efforts.some(
      (effort) => effort === "low" || effort === "high" || effort === "max" || effort === "medium",
    ),
    vision: Array.isArray(model.input_modalities) && model.input_modalities.includes("image"),
  };
  const context = ollamaCatalogContextWindow(
    typeof model.context_window === "number" ? model.context_window : undefined,
  );
  const fields = ollamaChildCatalogFields({
    evidence,
    skeleton,
    contextWindow: context,
    supportsSearchTool: options?.supportsSearchTool === true,
  });
  const entry: JsonObject = {
    slug,
    display_name: slug,
    description: typeof model.description === "string" ? model.description : "Ollama model via cob.",
    base_instructions: OLLAMA_BASE_INSTRUCTIONS,
    visibility: "list",
    priority,
    ...fields,
  };
  for (const key of Object.keys(entry)) {
    if (!OLLAMA_CATALOG_FIELDS.includes(key as (typeof OLLAMA_CATALOG_FIELDS)[number])) {
      delete entry[key];
    }
  }
  for (const leaked of IDENTITY_DROP) {
    delete entry[leaked];
  }
  try {
    assertOllamaRowMatchesEvidence(entry, evidence);
    return entry;
  } catch {
    return null;
  }
}

export function mergeCatalog(
  nativeCatalog: CatalogFile,
  tags: OllamaTag[],
  options?: CatalogMergeOptions,
): CatalogFile {
  const native = nativeCatalog.models.map((model) => structuredClone(model));
  if (native.length === 0) {
    throw new Error("bundled catalog contains no models");
  }
  const skeleton = pickSkeleton(native);
  const ollamaModels: JsonObject[] = [];
  const ollamaIds: string[] = [];
  for (const tag of tags) {
    try {
      ollamaModels.push(buildOllamaEntry(tag, skeleton, 20, options));
      ollamaIds.push(tag.name);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[cob] skipping Ollama tag ${tag.name}: ${detail}`);
    }
  }
  const spawnable = options?.spawnableOllamaSlugs ?? DEFAULT_SPAWNABLE_OLLAMA_SLUGS;
  const priorities = assignFeaturedPriorities(native, ollamaIds, spawnable);

  for (const model of native) {
    model.priority = priorities.get(asSlug(model)) ?? asPriority(model);
  }
  for (const model of ollamaModels) {
    model.priority = priorities.get(asSlug(model)) ?? asPriority(model);
  }

  const catalog = { models: [...native, ...ollamaModels] };
  applyPickerVisibility(catalog.models, spawnable);
  return catalog;
}

export function assertOllamaRowsSafe(catalog: CatalogFile, options?: CatalogSafetyOptions): void {
  const allowSearchTool = options?.allowSearchTool === true;
  for (const model of catalog.models) {
    const slug = asSlug(model);
    if (!slug.startsWith("ollama/")) continue;
    if (model.base_instructions !== OLLAMA_BASE_INSTRUCTIONS) {
      throw new Error(`Ollama row ${slug} must use cob-owned base_instructions, not GPT text`);
    }
    if (!("base_instructions" in model) && !hasInstructionsTemplate(model)) {
      throw new Error(`Ollama row ${slug} is missing instructions required by Codex`);
    }
    for (const field of IDENTITY_DROP) {
      if (field in model) {
        throw new Error(`Ollama row ${slug} leaked GPT identity field ${field}`);
      }
    }
    if (model.supports_parallel_tool_calls === true) {
      throw new Error(`Ollama row ${slug} must not advertise parallel tool calls`);
    }
    if (model.supports_search_tool === true && !allowSearchTool) {
      throw new Error(`Ollama row ${slug} must not advertise search`);
    }
    if (allowSearchTool && model.supports_search_tool !== true) {
      throw new Error(`Ollama row ${slug} must advertise search when cob.toml catalog.supports_search_tool is true`);
    }
    if (model.multi_agent_version !== "v1") {
      throw new Error(`Ollama row ${slug} must stay on multi_agent_version v1`);
    }
    if (model.shell_type !== "disabled") {
      throw new Error(`Ollama row ${slug} must set shell_type to disabled`);
    }
    if ("apply_patch_tool_type" in model || "tool_mode" in model) {
      throw new Error(`Ollama row ${slug} advertised an unproven tool capability field`);
    }
    const efforts = advertisedReasoningEfforts(model);
    if (efforts.some((effort) => !(OLLAMA_REASONING_EFFORTS as readonly string[]).includes(effort))) {
      throw new Error(`Ollama row ${slug} advertised unsupported reasoning effort`);
    }
    if (typeof model.default_reasoning_level === "string") {
      if (efforts.length === 0) {
        throw new Error(`Ollama row ${slug} advertised default_reasoning_level without supported_reasoning_levels`);
      }
      if (!efforts.includes(model.default_reasoning_level)) {
        throw new Error(`Ollama row ${slug} default_reasoning_level is not in supported_reasoning_levels`);
      }
    }
  }
}

function advertisedReasoningEfforts(model: JsonObject): string[] {
  const raw = model.supported_reasoning_levels;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .map((level) => level.effort)
    .filter((effort): effort is string => typeof effort === "string");
}

function assertOllamaRowMatchesEvidence(model: JsonObject, evidence: OllamaCapabilityEvidence): void {
  const slug = asSlug(model);
  const efforts = advertisedReasoningEfforts(model);
  if (!evidence.thinking) {
    if (efforts.some((effort) => effort !== "none")) {
      throw new Error(`Ollama row ${slug} advertised reasoning without thinking evidence`);
    }
    if (typeof model.default_reasoning_level === "string" && model.default_reasoning_level !== "none") {
      throw new Error(`Ollama row ${slug} advertised default_reasoning_level without thinking evidence`);
    }
  }
}

function hasInstructionsTemplate(model: JsonObject): boolean {
  return isRecord(model.model_messages) && typeof model.model_messages.instructions_template === "string";
}

export function serializeCatalog(catalog: CatalogFile): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

export function writeCatalogIfChanged(
  path: string,
  catalog: CatalogFile,
  options?: CatalogSafetyOptions,
): boolean {
  assertOllamaRowsSafe(catalog, options);
  const next = serializeCatalog(catalog);
  try {
    const previous = readFileSync(path, "utf8");
    if (previous === next) return false;
  } catch {
    // first write
  }
  writeFileAtomic(path, next, 0o600);
  return true;
}

export class CatalogConsumerRejectedError extends Error {
  readonly code = "catalog_consumer_rejected";
  constructor(message: string) {
    super(message);
    this.name = "CatalogConsumerRejectedError";
  }
}

export function assertConsumersAcceptCatalog(
  catalog: CatalogFile,
  consumers: readonly CodexBinaryRecord[],
): void {
  for (const consumer of consumers) {
    try {
      assertCodexAcceptsCatalog(catalog, consumer.path);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new CatalogConsumerRejectedError(
        `Codex rejected cob catalog (${consumer.kind} ${consumer.path} ${consumer.version}): ${detail}`,
      );
    }
  }
}

export function assertCodexAcceptsCatalog(
  catalog: CatalogFile,
  codexBin = process.env.COB_CODEX_BIN ?? "codex",
): void {
  const dir = mkdtempSync(join(tmpdir(), "cob-catalog-check-"));
  const home = join(dir, "codex-home");
  try {
    mkdirSync(home, { recursive: true });
    const path = join(dir, "catalog.json");
    writeFileSync(path, serializeCatalog(catalog), { encoding: "utf8" });
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };
    delete env.COB_CODEX_HOME;
    const result = spawnSync(codexBin, ["debug", "models", "-c", `model_catalog_json=${JSON.stringify(path)}`], {
      encoding: "utf8",
      env,
      cwd: home,
      maxBuffer: 20 * 1024 * 1024,
      timeout: CODEX_CATALOG_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
      throw new Error(`codex catalog check timed out after ${CODEX_CATALOG_TIMEOUT_MS}ms`);
    }
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(
        `Codex rejected cob catalog: ${(result.stderr || result.stdout || "").trim() || `exit ${result.status}`}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
