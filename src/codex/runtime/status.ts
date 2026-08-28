import { existsSync, readFileSync } from "node:fs";
import { fetchHealthz, healthNonceOk, healthPid, isCobHealth, readRuntime } from "./runtime.js";
import { discoverCodexBins, type CatalogDiscovery, type InspectCodexIo } from "../catalog/source.js";
import { detectInstall, formatInstallLine } from "../../core/install-detection.js";
import { isLiveCodexHome } from "../home.js";
import { isRecord } from "../../core/json.js";
import { resolveCobConfig, resolveSpawnableOllamaSlugs } from "../config/resolve.js";
import { assessDesktopOverlay, loadRootTomlKeys, openaiPortFromToml, summarizeCobStatus, type DesktopOverlayAssessment } from "../root-config.js";
import { resolvePaths } from "../paths.js";
import { assessCatalogProvenance } from "../catalog/provenance.js";
import type { CobPaths } from "../paths.js";

/**
 * Read-only codex status report: runtime health, overlay, and provenance.
 */

export type StatusReport = {
  /** Exit 0 when this Codex home needs no cob action. */
  ok: boolean;
  text: string;
};

export async function statusReport(
  paths: CobPaths = resolvePaths(),
  opts?: { discovery?: CatalogDiscovery; inspect?: InspectCodexIo },
): Promise<StatusReport> {
  const liveHome = isLiveCodexHome(paths.codexHome);
  const runtime = readRuntime(paths);
  const root = existsSync(paths.rootConfig);
  const install = detectInstall();
  const discovery = opts?.discovery ?? discoverCodexBins({ paths, liveHome });
  const heading = [
    formatInstallLine(install),
    `cli: ${install.cliPath || "-"}`,
    `codex home: ${paths.codexHome}`,
    `root config present: ${root} (read-only for cob)`,
    `profile: ${existsSync(paths.profile) ? paths.profile : "missing"}`,
    `catalog: ${existsSync(paths.catalog) ? paths.catalog : "missing"}`,
    `catalog meta: ${existsSync(paths.catalogMeta) ? paths.catalogMeta : "missing"}`,
    `state: ${existsSync(paths.stateDir) ? paths.stateDir : "missing"}`,
  ];
  if (!liveHome) {
    heading.push("isolated Codex home: ChatGPT Desktop still reads ~/.codex");
  }
  if (!runtime) {
    return finishStatusReport(liveHome, heading, ["gateway: stopped"], paths, {
      gatewayHealthy: false,
      discovery,
      inspect: opts?.inspect,
    });
  }
  let health = "unknown";
  let liveCompaction: string | undefined;
  const fetched = await fetchHealthz(runtime.port, runtime.nonce);
  if (!fetched) {
    health = "unreachable";
  } else {
    const cob = isCobHealth(fetched.body);
    const nonceOk = !runtime.nonce || healthNonceOk(fetched.body);
    const pidOk = healthPid(fetched.body) === undefined || healthPid(fetched.body) === runtime.pid;
    health = fetched.ok && cob && nonceOk && pidOk ? "ok" : `http ${fetched.status}`;
    if (isRecord(fetched.body) && "compaction" in fetched.body) {
      const compaction = (fetched.body as {
        compaction?: { provider?: string; model?: string | null; ollama_threads?: string };
      }).compaction;
      if (compaction?.provider) {
        liveCompaction = `${compaction.provider}${compaction.model ? `/${compaction.model}` : ""}${
          compaction.ollama_threads ? ` ollama_threads=${compaction.ollama_threads}` : ""
        }`;
      }
    }
  }
  const gatewayHealthy = health === "ok";
  const details = [
    `gateway pid: ${runtime.pid}`,
    `gateway port: ${runtime.port}`,
    `gateway health: ${health}`,
    `ollama url: ${runtime.ollamaUrl}`,
  ];
  if (runtime.version) {
    details.push(`gateway release: ${runtime.version} (${runtime.installKind ?? "unknown"})`);
  }
  if (liveCompaction) {
    details.push(`compaction: ${liveCompaction}`);
  } else if (runtime.compaction) {
    details.push(
      `compaction: ${runtime.compaction.provider}${runtime.compaction.model ? `/${runtime.compaction.model}` : ""} ollama_threads=${runtime.compaction.ollamaThreads ?? "summarize"}`,
    );
  }
  return finishStatusReport(liveHome, heading, details, paths, {
    runtimePort: runtime.port,
    gatewayHealthy,
    discovery,
    inspect: opts?.inspect,
  });
}

function finishStatusReport(
  liveHome: boolean,
  heading: string[],
  details: string[],
  paths: CobPaths,
  opts: {
    runtimePort?: number;
    gatewayHealthy: boolean;
    discovery: CatalogDiscovery;
    inspect?: InspectCodexIo;
  },
): StatusReport {
  const overlay = assessPathsOverlay(paths, opts);
  const cob = resolveCobConfig({ paths });
  const provenance = assessCatalogProvenance({
    catalogPath: paths.catalog,
    metaPath: paths.catalogMeta,
    discovery: opts.discovery,
    spawnableOllamaSlugs: resolveSpawnableOllamaSlugs(cob),
    io: opts.inspect,
  });
  const summary = summarizeCobStatus({
    liveHome,
    overlay: overlay.state,
    gatewayHealthy: opts.gatewayHealthy,
    catalogFreshness: provenance.freshness,
  });
  return {
    ok: summary.ok,
    text: [`cob: ${summary.kind}`, ...heading, ...details, ...overlay.lines, ...provenance.lines].join("\n"),
  };
}

function assessPathsOverlay(
  paths: CobPaths,
  opts: { runtimePort?: number; gatewayHealthy: boolean },
): DesktopOverlayAssessment {
  const loaded = loadRootTomlKeys(paths.rootConfig);
  let profilePort: number | undefined;
  try {
    profilePort = openaiPortFromToml(readFileSync(paths.profile, "utf8"));
  } catch {
    profilePort = undefined;
  }
  return assessDesktopOverlay({
    keys: loaded.keys,
    readError: loaded.readError,
    cobCatalogPath: paths.catalog,
    cobCatalogExists: existsSync(paths.catalog),
    codexHome: paths.codexHome,
    profilePort,
    runtimePort: opts.runtimePort,
    gatewayHealthy: opts.gatewayHealthy,
  });
}
