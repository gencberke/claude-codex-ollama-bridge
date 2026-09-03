import { existsSync, readFileSync } from "node:fs";
import { readFileBufferOrNull, writeFileAtomic } from "../../core/atomic.js";
import { isRecord, type JsonObject } from "../../core/json.js";
import { withExclusiveLock } from "../../core/lock.js";
import { asPriority, asSlug, asVisibility } from "../types.js";
import { assessCatalogProvenance } from "../catalog/provenance.js";
import { discoverCodexBins } from "../catalog/source.js";
import { listVisibleSlugs, parseCatalogJson } from "../catalog/catalog.js";
import { isLiveCodexHome } from "../home.js";
import type { CobPaths } from "../paths.js";
import { assertRootConfigUnchanged, readRootConfig, restoreOverlays, snapshotOverlays, syncCatalog } from "../runtime/lifecycle.js";
import {
  DEFAULT_CATALOG_POLICY,
  DEFAULT_EXPERIMENTAL_POLICY,
  CobConfigError,
  parseNativeSlugList,
  parseOllamaCompactEffort,
  parseOllamaCompactModel,
  parseOllamaSlugList,
  parseOllamaThreadCompaction,
  parseCompactionProvider,
  type CobFileConfig,
} from "./schema.js";
import { readCobToml, writeCobToml } from "./toml.js";
import { resolveCobConfig, resolveSpawnableOllamaSlugs } from "./resolve.js";
import { sha256Hex } from "../catalog/source.js";

export const CONFIG_CONTROL_SCHEMA = 1;

export type ConfigValueSource = "default" | "file" | "environment";

export type ConfigField<T> = {
  value: T;
  source: ConfigValueSource;
};

export type ConfigModelSummary = {
  slug: string;
  kind: "native" | "ollama";
  visibility: string;
  priority: number;
};

export type ConfigShowJson = {
  schema_version: typeof CONFIG_CONTROL_SCHEMA;
  config_revision: string | null;
  effective: {
    compaction: {
      provider: "native";
      model: string | null;
      ollama_threads: "summarize" | "native";
      ollama_model: string | null;
      ollama_effort: "none" | "low" | "high" | "max" | null;
    };
    subagents: { models: string[] };
    catalog: {
      native_include: string[];
      native_exclude: string[];
      supports_search_tool: boolean;
    };
  };
  sources: {
    compaction: Record<string, ConfigValueSource>;
    subagents: Record<string, ConfigValueSource>;
    catalog: Record<string, ConfigValueSource>;
  };
  catalog: {
    freshness: "fresh" | "stale" | "unknown" | "missing";
    reason?: string;
    models: ConfigModelSummary[];
    picker_order: string[];
  };
};

export type ConfigApplyJson = ConfigShowJson & {
  config_changed: boolean;
  catalog_changed: boolean;
  desktop_restart_required: boolean;
};

export type ConfigApplyPatch = {
  schema_version: typeof CONFIG_CONTROL_SCHEMA;
  expected_revision: string | null;
  compaction?: {
    provider?: "native";
    model?: string | null;
    ollama_threads?: "summarize" | "native";
    ollama_model?: string | null;
    ollama_effort?: "none" | "low" | "high" | "max" | null;
  };
  subagents?: { models?: string[] };
  catalog?: {
    native_include?: string[];
    native_exclude?: string[];
    supports_search_tool?: boolean;
  };
};

const UI_FIELDS = new Set([
  "compaction.provider",
  "compaction.model",
  "compaction.ollama_threads",
  "compaction.ollama_model",
  "compaction.ollama_effort",
  "subagents.models",
  "catalog.native_include",
  "catalog.native_exclude",
  "catalog.supports_search_tool",
]);

/** Read-only, machine-readable panel state. It never starts a process. */
export function configShow(
  paths: CobPaths,
  env: NodeJS.ProcessEnv = process.env,
): ConfigShowJson {
  const raw = readFileBufferOrNull(paths.cobConfig);
  const file = raw === null ? undefined : readCobToml(paths.cobConfig);
  const effective = resolveCobConfig({ paths, env });
  return makeShowDocument(paths, effective, file, raw, env);
}

/**
 * Apply a versioned panel patch under the same lock used by lifecycle and
 * catalog publication. The old overlay is restored if any later publication
 * step fails, while ~/.codex/config.toml is checked before returning.
 */
export async function configApply(
  paths: CobPaths,
  patch: unknown,
  opts: {
    ollamaUrl: string;
    env?: NodeJS.ProcessEnv;
    sync?: typeof syncCatalog;
  },
): Promise<ConfigApplyJson> {
  const env = opts.env ?? process.env;
  const parsed = parseConfigApplyPatch(patch);
  return withExclusiveLock(paths.lock, async () => {
    const rootBefore = readRootConfig(paths);
    const rawBefore = readFileBufferOrNull(paths.cobConfig);
    const actualRevision = rawBefore === null ? null : sha256Hex(rawBefore);
    if (actualRevision !== parsed.expected_revision) {
      throw new CobConfigError(
        "config_conflict",
        "cob.toml changed since the panel loaded it; reload and try again",
      );
    }
    assertEnvironmentWritable(parsed, env);
    const snapshot = snapshotOverlays(paths);
    const previousFile = rawBefore === null ? undefined : readCobToml(paths.cobConfig);
    const candidate = applyPatchToFileConfig(previousFile, parsed);
    try {
      writeConfigPreservingUnmanaged(paths.cobConfig, rawBefore, candidate, parsed);
      const publish = opts.sync ?? syncCatalog;
      const synced = await publish({
        paths,
        ollamaUrl: opts.ollamaUrl,
        cob: candidate,
        locked: true,
      });
      assertRootConfigUnchanged(paths, rootBefore);
      const rawAfter = readFileBufferOrNull(paths.cobConfig);
      const document = makeShowDocument(
        paths,
        resolveCobConfig({ paths, env }),
        readCobToml(paths.cobConfig),
        rawAfter,
        env,
      );
      return {
        ...document,
        config_changed: rawBefore === null || rawAfter === null ? rawBefore !== rawAfter : !rawBefore.equals(rawAfter),
        catalog_changed: synced.wrote,
        desktop_restart_required: isLiveCodexHome(paths.codexHome) && synced.wrote,
      };
    } catch (error) {
      restoreOverlays(paths, snapshot, { preserveCatalogValidationFailure: true });
      assertRootConfigUnchanged(paths, rootBefore);
      throw error;
    }
  });
}

/**
 * Update only keys named by the panel patch. cob.toml is intentionally a
 * small format, so a line/range edit keeps comments, ordering, and the
 * experimental section byte-for-byte instead of round-tripping the document
 * through the canonical renderer.
 */
function writeConfigPreservingUnmanaged(
  path: string,
  previousBytes: Buffer | null,
  candidate: CobFileConfig,
  patch: ConfigApplyPatch,
): void {
  if (previousBytes === null) {
    writeCobToml(path, candidate);
    return;
  }
  const newline = previousBytes.toString("utf8").includes("\r\n") ? "\r\n" : "\n";
  let text = previousBytes.toString("utf8");
  const updates: Array<{ section: string; key: string; value?: string }> = [];
  if (patch.compaction) {
    if (patch.compaction.provider !== undefined) updates.push({ section: "compaction", key: "provider", value: JSON.stringify(candidate.compaction.provider) });
    if (patch.compaction.model !== undefined) updates.push({ section: "compaction", key: "model", value: candidate.compaction.model === undefined ? undefined : JSON.stringify(candidate.compaction.model) });
    if (patch.compaction.ollama_threads !== undefined) updates.push({ section: "compaction", key: "ollama_threads", value: JSON.stringify(candidate.compaction.ollamaThreads ?? "summarize") });
    if (patch.compaction.ollama_model !== undefined) updates.push({ section: "compaction", key: "ollama_model", value: candidate.compaction.ollamaModel === undefined ? undefined : JSON.stringify(candidate.compaction.ollamaModel) });
    if (patch.compaction.ollama_effort !== undefined) updates.push({ section: "compaction", key: "ollama_effort", value: candidate.compaction.ollamaEffort === undefined ? undefined : JSON.stringify(candidate.compaction.ollamaEffort) });
  }
  if (patch.subagents?.models !== undefined) {
    updates.push({ section: "subagents", key: "models", value: JSON.stringify(candidate.subagents.models ?? []) });
  }
  if (patch.catalog) {
    if (patch.catalog.native_include !== undefined) updates.push({ section: "catalog", key: "native_include", value: candidate.catalog?.nativeInclude?.length ? JSON.stringify(candidate.catalog.nativeInclude) : undefined });
    if (patch.catalog.native_exclude !== undefined) updates.push({ section: "catalog", key: "native_exclude", value: candidate.catalog?.nativeExclude?.length ? JSON.stringify(candidate.catalog.nativeExclude) : undefined });
    if (patch.catalog.supports_search_tool !== undefined) updates.push({ section: "catalog", key: "supports_search_tool", value: candidate.catalog?.supportsSearchTool === true ? "true" : "false" });
  }
  for (const update of updates) text = updateTomlKey(text, update.section, update.key, update.value, newline);
  writeFileAtomic(path, text, 0o600);
}

function updateTomlKey(
  text: string,
  section: string,
  key: string,
  value: string | undefined,
  newline: string,
): string {
  const lines = text.split(/\r?\n/);
  let active = "";
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    const sectionMatch = /^\[([A-Za-z0-9_-]+)\]$/.exec(trimmed);
    if (sectionMatch) {
      active = sectionMatch[1]!;
      continue;
    }
    if (active !== section || trimmed.startsWith("#")) continue;
    const match = new RegExp(`^(\\s*)${escapeRegExp(key)}\\s*=`).exec(lines[index]!);
    if (!match) continue;
    let end = index;
    const rhs = lines[index]!.slice(match[0].length).trim();
    if (rhs.startsWith("[") && !rhs.endsWith("]")) {
      while (end + 1 < lines.length && !lines[end]!.includes("]")) end += 1;
    }
    if (value === undefined) lines.splice(index, end - index + 1);
    else lines.splice(index, end - index + 1, `${match[1] ?? ""}${key} = ${value}`);
    return lines.join(newline);
  }
  if (value === undefined) return text;
  const sectionHeader = `[${section}]`;
  const addition = `${sectionHeader}${newline}${key} = ${value}`;
  if (text.length === 0) return `${addition}${newline}`;
  const sectionIndex = lines.findIndex((line) => line.trim() === sectionHeader);
  if (sectionIndex >= 0) {
    let insertAt = lines.length;
    for (let index = sectionIndex + 1; index < lines.length; index += 1) {
      if (/^\[[A-Za-z0-9_-]+\]$/.test(lines[index]!.trim())) {
        insertAt = index;
        break;
      }
    }
    lines.splice(insertAt, 0, `${key} = ${value}`);
    return lines.join(newline);
  }
  return `${text.replace(/[\r\n]+$/, "")}${newline}${addition}${newline}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeShowDocument(
  paths: CobPaths,
  effective: CobFileConfig,
  file: CobFileConfig | undefined,
  raw: Buffer | null,
  env: NodeJS.ProcessEnv,
): ConfigShowJson {
  const catalog = readCatalogSummaries(paths.catalog);
  const freshness = readCatalogFreshness(paths, effective);
  const models = effective.subagents.models ?? resolveSpawnableOllamaSlugs(effective);
  return {
    schema_version: CONFIG_CONTROL_SCHEMA,
    config_revision: raw === null ? null : sha256Hex(raw),
    effective: {
      compaction: {
        provider: "native",
        model: effective.compaction.model ?? null,
        ollama_threads: effective.compaction.ollamaThreads ?? "summarize",
        ollama_model: effective.compaction.ollamaModel ?? null,
        ollama_effort: effective.compaction.ollamaEffort ?? null,
      },
      subagents: { models: models.slice() },
      catalog: {
        native_include: effective.catalog?.nativeInclude?.slice() ?? [],
        native_exclude: effective.catalog?.nativeExclude?.slice() ?? [],
        supports_search_tool: effective.catalog?.supportsSearchTool ?? DEFAULT_CATALOG_POLICY.supportsSearchTool,
      },
    },
    sources: {
      compaction: {
        provider: sourceFor(env.COB_COMPACTION_PROVIDER, file?.compaction.provider),
        model: sourceFor(env.COB_COMPACTION_MODEL, file?.compaction.model),
        ollama_threads: sourceFor(env.COB_COMPACTION_OLLAMA_THREADS, file?.compaction.ollamaThreads),
        ollama_model: sourceFor(env.COB_COMPACTION_OLLAMA_MODEL, file?.compaction.ollamaModel),
        ollama_effort: sourceFor(env.COB_COMPACTION_OLLAMA_EFFORT, file?.compaction.ollamaEffort),
      },
      subagents: {
        models: sourceFor(env.COB_SUBAGENT_MODELS, file?.subagents.models),
      },
      catalog: {
        native_include: sourceFor(env.COB_NATIVE_MODEL_INCLUDE, file?.catalog?.nativeInclude),
        native_exclude: sourceFor(env.COB_NATIVE_MODEL_EXCLUDE, file?.catalog?.nativeExclude),
        supports_search_tool: sourceFor(env.COB_SUPPORTS_SEARCH_TOOL, file?.catalog?.supportsSearchTool),
      },
    },
    catalog: {
      freshness: freshness.freshness,
      ...(freshness.reason ? { reason: freshness.reason } : {}),
      models: catalog.models,
      picker_order: catalog.picker_order,
    },
  };
}

function sourceFor(environmentValue: string | undefined, fileValue: unknown): ConfigValueSource {
  if (environmentValue !== undefined && environmentValue.trim().length > 0) return "environment";
  if (fileValue !== undefined) return "file";
  return "default";
}

function readCatalogSummaries(path: string): { models: ConfigModelSummary[]; picker_order: string[] } {
  try {
    const parsed = parseCatalogJson(readFileSync(path, "utf8"));
    const models = parsed.models.map((model) => {
      const slug = asSlug(model);
      return {
        slug,
        kind: slug.startsWith("ollama/") ? "ollama" : "native",
        visibility: asVisibility(model),
        priority: asPriority(model),
      } as ConfigModelSummary;
    });
    return { models, picker_order: listVisibleSlugs(parsed.models) };
  } catch {
    return { models: [], picker_order: [] };
  }
}

function readCatalogFreshness(
  paths: CobPaths,
  effective: CobFileConfig,
): Pick<ConfigShowJson["catalog"], "freshness" | "reason"> {
  try {
    const result = assessCatalogProvenance({
      catalogPath: paths.catalog,
      metaPath: paths.catalogMeta,
      discovery: discoverCodexBins({ paths, liveHome: isLiveCodexHome(paths.codexHome) }),
      spawnableOllamaSlugs: resolveSpawnableOllamaSlugs(effective),
    });
    return { freshness: result.freshness, ...(result.reason ? { reason: result.reason } : {}) };
  } catch {
    return { freshness: existsSync(paths.catalog) ? "unknown" : "missing", reason: "catalog provenance unavailable" };
  }
}

function parseConfigApplyPatch(value: unknown): ConfigApplyPatch {
  if (!isRecord(value)) throw new CobConfigError("invalid_config_patch", "config patch must be a JSON object");
  assertKeys(value, ["schema_version", "expected_revision", "compaction", "subagents", "catalog"]);
  if (value.schema_version !== CONFIG_CONTROL_SCHEMA) {
    throw new CobConfigError("invalid_config_patch", "unsupported config patch schema_version");
  }
  if (value.expected_revision !== null &&
      (typeof value.expected_revision !== "string" || !/^[0-9a-f]{64}$/.test(value.expected_revision))) {
    throw new CobConfigError("invalid_config_patch", "expected_revision must be a SHA-256 hex digest or null");
  }
  const out: ConfigApplyPatch = {
    schema_version: CONFIG_CONTROL_SCHEMA,
    expected_revision: value.expected_revision as string | null,
  };
  if (value.compaction !== undefined) out.compaction = parseCompactionPatch(value.compaction);
  if (value.subagents !== undefined) {
    if (!isRecord(value.subagents)) throw new CobConfigError("invalid_config_patch", "subagents must be an object");
    assertKeys(value.subagents, ["models"]);
    out.subagents = {};
    if (value.subagents.models !== undefined) {
      if (!Array.isArray(value.subagents.models) || !value.subagents.models.every((item) => typeof item === "string")) {
        throw new CobConfigError("invalid_config_patch", "subagents.models must be an array of strings");
      }
      out.subagents.models = parseOllamaSlugList(value.subagents.models, "subagents.models");
    }
  }
  if (value.catalog !== undefined) {
    if (!isRecord(value.catalog)) throw new CobConfigError("invalid_config_patch", "catalog must be an object");
    assertKeys(value.catalog, ["native_include", "native_exclude", "supports_search_tool"]);
    out.catalog = {};
    for (const key of ["native_include", "native_exclude"] as const) {
      const item = value.catalog[key];
      if (item !== undefined) {
        if (!Array.isArray(item) || !item.every((entry) => typeof entry === "string")) {
          throw new CobConfigError("invalid_config_patch", `catalog.${key} must be an array of strings`);
        }
        out.catalog[key] = parseNativeSlugList(item, `catalog.${key}`);
      }
    }
    if (value.catalog.supports_search_tool !== undefined) {
      if (typeof value.catalog.supports_search_tool !== "boolean") {
        throw new CobConfigError("invalid_config_patch", "catalog.supports_search_tool must be boolean");
      }
      out.catalog.supports_search_tool = value.catalog.supports_search_tool;
    }
  }
  return out;
}

function parseCompactionPatch(value: unknown): NonNullable<ConfigApplyPatch["compaction"]> {
  if (!isRecord(value)) throw new CobConfigError("invalid_config_patch", "compaction must be an object");
  assertKeys(value, ["provider", "model", "ollama_threads", "ollama_model", "ollama_effort"]);
  const out: NonNullable<ConfigApplyPatch["compaction"]> = {};
  if (value.provider !== undefined) {
    if (typeof value.provider !== "string") throw new CobConfigError("invalid_config_patch", "compaction.provider must be native");
    out.provider = parseCompactionProvider(value.provider);
  }
  if (value.model !== undefined) {
    if (value.model !== null && (typeof value.model !== "string" || value.model.length === 0)) {
      throw new CobConfigError("invalid_config_patch", "compaction.model must be a non-empty string or null");
    }
    out.model = value.model as string | null;
  }
  if (value.ollama_threads !== undefined) {
    if (typeof value.ollama_threads !== "string") throw new CobConfigError("invalid_config_patch", "compaction.ollama_threads is invalid");
    out.ollama_threads = parseOllamaThreadCompaction(value.ollama_threads)!;
  }
  if (value.ollama_model !== undefined) {
    if (value.ollama_model !== null && typeof value.ollama_model !== "string") throw new CobConfigError("invalid_config_patch", "compaction.ollama_model is invalid");
    out.ollama_model = value.ollama_model === null ? null : parseOllamaCompactModel(value.ollama_model);
  }
  if (value.ollama_effort !== undefined) {
    if (value.ollama_effort !== null && typeof value.ollama_effort !== "string") throw new CobConfigError("invalid_config_patch", "compaction.ollama_effort is invalid");
    out.ollama_effort = value.ollama_effort === null ? null : parseOllamaCompactEffort(value.ollama_effort);
  }
  return out;
}

function assertKeys(value: JsonObject, keys: readonly string[]): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new CobConfigError("invalid_config_patch", `unknown config patch field: ${key}`);
  }
}

function assertEnvironmentWritable(patch: ConfigApplyPatch, env: NodeJS.ProcessEnv): void {
  const attempted = new Set<string>();
  if (patch.compaction) {
    if (patch.compaction.provider !== undefined) attempted.add("compaction.provider");
    if (patch.compaction.model !== undefined) attempted.add("compaction.model");
    if (patch.compaction.ollama_threads !== undefined) attempted.add("compaction.ollama_threads");
    if (patch.compaction.ollama_model !== undefined) attempted.add("compaction.ollama_model");
    if (patch.compaction.ollama_effort !== undefined) attempted.add("compaction.ollama_effort");
  }
  if (patch.subagents?.models !== undefined) attempted.add("subagents.models");
  if (patch.catalog?.native_include !== undefined) attempted.add("catalog.native_include");
  if (patch.catalog?.native_exclude !== undefined) attempted.add("catalog.native_exclude");
  if (patch.catalog?.supports_search_tool !== undefined) attempted.add("catalog.supports_search_tool");
  const envNames: Record<string, string> = {
    "compaction.provider": "COB_COMPACTION_PROVIDER",
    "compaction.model": "COB_COMPACTION_MODEL",
    "compaction.ollama_threads": "COB_COMPACTION_OLLAMA_THREADS",
    "compaction.ollama_model": "COB_COMPACTION_OLLAMA_MODEL",
    "compaction.ollama_effort": "COB_COMPACTION_OLLAMA_EFFORT",
    "subagents.models": "COB_SUBAGENT_MODELS",
    "catalog.native_include": "COB_NATIVE_MODEL_INCLUDE",
    "catalog.native_exclude": "COB_NATIVE_MODEL_EXCLUDE",
    "catalog.supports_search_tool": "COB_SUPPORTS_SEARCH_TOOL",
  };
  for (const field of attempted) {
    const name = envNames[field];
    if (name && env[name] !== undefined && env[name]!.trim().length > 0) {
      throw new CobConfigError("config_field_environment_locked", `${field} is controlled by environment`);
    }
  }
}

function applyPatchToFileConfig(file: CobFileConfig | undefined, patch: ConfigApplyPatch): CobFileConfig {
  // Do not resolve defaults through any process/home state here. In
  // particular, an absent temporary-home cob.toml must never consult the
  // caller's live ~/.codex configuration.
  const base = file ?? defaultFileConfig();
  const candidate: CobFileConfig = {
    compaction: { ...base.compaction },
    subagents: { ...(base.subagents.models === undefined ? {} : { models: base.subagents.models.slice() }) },
    catalog: {
      ...(base.catalog ?? DEFAULT_CATALOG_POLICY),
      ...(base.catalog?.nativeInclude ? { nativeInclude: base.catalog.nativeInclude.slice() } : {}),
      ...(base.catalog?.nativeExclude ? { nativeExclude: base.catalog.nativeExclude.slice() } : {}),
    },
    experimental: base.experimental
      ? { nativePlaintextSpawn: { ...base.experimental.nativePlaintextSpawn } }
      : { nativePlaintextSpawn: { ...DEFAULT_EXPERIMENTAL_POLICY.nativePlaintextSpawn } },
  };
  if (patch.compaction) {
    if (patch.compaction.provider !== undefined) candidate.compaction.provider = patch.compaction.provider;
    if (patch.compaction.model !== undefined) {
      if (patch.compaction.model === null) delete candidate.compaction.model;
      else candidate.compaction.model = patch.compaction.model;
    }
    if (patch.compaction.ollama_threads !== undefined) candidate.compaction.ollamaThreads = patch.compaction.ollama_threads;
    if (patch.compaction.ollama_model !== undefined) {
      if (patch.compaction.ollama_model === null) delete candidate.compaction.ollamaModel;
      else candidate.compaction.ollamaModel = patch.compaction.ollama_model;
    }
    if (patch.compaction.ollama_effort !== undefined) {
      if (patch.compaction.ollama_effort === null) delete candidate.compaction.ollamaEffort;
      else candidate.compaction.ollamaEffort = patch.compaction.ollama_effort;
    }
  }
  if (patch.subagents?.models !== undefined) candidate.subagents.models = patch.subagents.models.slice();
  if (patch.catalog) {
    if (patch.catalog.native_include !== undefined) candidate.catalog!.nativeInclude = patch.catalog.native_include.slice();
    if (patch.catalog.native_exclude !== undefined) candidate.catalog!.nativeExclude = patch.catalog.native_exclude.slice();
    if (patch.catalog.supports_search_tool !== undefined) candidate.catalog!.supportsSearchTool = patch.catalog.supports_search_tool;
  }
  return candidate;
}

function defaultFileConfig(): CobFileConfig {
  return {
    compaction: { provider: "native", ollamaThreads: "summarize" },
    subagents: {},
    catalog: { ...DEFAULT_CATALOG_POLICY },
    experimental: { nativePlaintextSpawn: { ...DEFAULT_EXPERIMENTAL_POLICY.nativePlaintextSpawn } },
  };
}

// Retained as a small public guard for callers that want to audit a patch
// before taking the lifecycle lock.
export function isUiConfigField(field: string): boolean {
  return UI_FIELDS.has(field);
}
