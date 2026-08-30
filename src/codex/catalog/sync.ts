import { readFileBufferOrNull } from "../../core/atomic.js";
import { readFileSync } from "node:fs";
import { assertLoopbackHttpUrl } from "../../core/loopback.js";
import { loadOllamaTags } from "../../core/ollama/tags.js";
import { DEFAULT_PORT } from "../constants.js";
import { catalogSupportsApplyPatch, catalogSupportsSearchTool, resolveCobConfig, resolveSpawnableOllamaSlugs } from "../config/resolve.js";
import type { CobFileConfig } from "../config/schema.js";
import { isLiveCodexHome } from "../home.js";
import { writeCobProfile } from "../profile.js";
import type { CobPaths } from "../paths.js";
import type { CatalogFile } from "../types.js";
import { assertSpawnRowsCarryTools, mergeCatalogWithFallback, parseCatalogJson, serializeCatalog } from "./catalog.js";
import { writeCatalogIfChanged } from "./file.js";
import { writeCatalogProvenance, writeCatalogValidationFailure } from "./provenance.js";
import { discoverCodexBins, loadBundledCatalog, resolveCatalogSources, type CatalogDiscovery, type InspectCodexIo } from "./source.js";
import { assertConsumersAcceptCatalog, CatalogConsumerRejectedError } from "./validator.js";

/**
 * Catalog control-plane I/O orchestration: merge the bundled source with live
 * Ollama tags, fail closed on consumer rejection (retaining the last-good
 * catalog), then write catalog, provenance, and the profile under the caller's
 * lock. Lifecycle owns the lock, the start lease, and the runtime lookup.
 */
export async function syncCatalogControlPlane(opts: {
  paths: CobPaths;
  ollamaUrl: string;
  spawnableOllamaSlugs?: readonly string[];
  supportsSearchTool?: boolean;
  applyPatch?: boolean;
  cob?: CobFileConfig;
  discovery?: CatalogDiscovery;
  inspect?: InspectCodexIo;
  keepLastGoodOnReject?: boolean;
  /** Lifecycle-owned runtime lookup, injected to keep the control plane cycle-free. */
  resolveRuntimePort: () => number | undefined;
  /** Known listen port (start preparation); skips the runtime-file lookup. */
  profilePort?: number;
}): Promise<{ catalog: CatalogFile; wrote: boolean; ollamaCount: number; ollamaError?: string }> {
  assertLoopbackHttpUrl(opts.ollamaUrl, "Ollama URL");
  const cob = opts.cob ?? resolveCobConfig({ paths: opts.paths });
  const spawnable =
    opts.spawnableOllamaSlugs ?? resolveSpawnableOllamaSlugs(cob);
  const supportsSearchTool = opts.supportsSearchTool ?? catalogSupportsSearchTool(cob);
  // Gate 5 is an isolated development capability. A live ~/.codex home must
  // never receive the advertised alias even if a stale opt-in is present.
  const applyPatch =
    !isLiveCodexHome(opts.paths.codexHome) &&
    (opts.applyPatch ?? catalogSupportsApplyPatch(cob));
  const discovery =
    opts.discovery ??
    discoverCodexBins({
      paths: opts.paths,
      liveHome: isLiveCodexHome(opts.paths.codexHome),
    });
  const sources = resolveCatalogSources(discovery, opts.inspect);
  const bundled = loadBundledCatalog(sources.producer.path);
  let tags: Awaited<ReturnType<typeof loadOllamaTags>> = [];
  let ollamaError: string | undefined;
  try {
    tags = await loadOllamaTags(opts.ollamaUrl);
  } catch (error) {
    ollamaError = error instanceof Error ? error.message : String(error);
  }
  if (tags.length > 0) {
    assertSpawnRowsCarryTools(tags, spawnable);
  }
  const retainedCatalogBytes = readFileBufferOrNull(opts.paths.catalog);
  const retainedMetadataBytes = readFileBufferOrNull(opts.paths.catalogMeta);
  let previous: CatalogFile | null = null;
  try {
    previous = retainedCatalogBytes
      ? parseCatalogJson(retainedCatalogBytes.toString("utf8"))
      : null;
  } catch {
    previous = null;
  }
  const catalog = mergeCatalogWithFallback(bundled, tags, previous, Boolean(ollamaError), {
    spawnableOllamaSlugs: spawnable,
    supportsSearchTool,
    applyPatch,
    advertiseCloudMaxContext: cob.catalog?.advertiseCloudMaxContext === true,
    activeContextWindow: cob.catalog?.activeContextWindow,
    autoCompactTokenLimit: cob.catalog?.autoCompactTokenLimit,
  });
  try {
    assertConsumersAcceptCatalog(catalog, sources.validators);
  } catch (error) {
    if (error instanceof CatalogConsumerRejectedError) {
      writeCatalogValidationFailure({
        metaPath: opts.paths.catalogMeta,
        candidateBytes: serializeCatalog(catalog),
        retainedCatalogBytes,
        retainedMetadataBytes,
        sources,
        error,
      });
    }
    if (error instanceof CatalogConsumerRejectedError && opts.keepLastGoodOnReject && previous) {
      console.error(`[cob] ${error.message}`);
      console.error("[cob] keeping last known-good catalog; run cob sync after consumers agree");
      writeCobProfile(opts.paths, opts.profilePort ?? opts.resolveRuntimePort() ?? DEFAULT_PORT);
      const ollamaCount = previous.models.filter((model) => String(model.slug).startsWith("ollama/")).length;
      return { catalog: previous, wrote: false, ollamaCount, ollamaError: error.message };
    }
    throw error;
  }
  const wrote = writeCatalogIfChanged(opts.paths.catalog, catalog, {
    allowSearchTool: supportsSearchTool,
    allowApplyPatch: applyPatch,
    spawnableOllamaSlugs: spawnable,
  });
  writeCatalogProvenance({
    metaPath: opts.paths.catalogMeta,
    catalogBytes: readFileSync(opts.paths.catalog),
    sources,
  });
  writeCobProfile(opts.paths, opts.profilePort ?? opts.resolveRuntimePort() ?? DEFAULT_PORT);
  const ollamaCount = catalog.models.filter((model) => String(model.slug).startsWith("ollama/")).length;
  return { catalog, wrote, ollamaCount, ollamaError };
}
