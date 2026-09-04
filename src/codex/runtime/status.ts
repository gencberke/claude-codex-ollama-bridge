import { existsSync, readFileSync } from "node:fs";
import { fetchHealthz, healthNonceOk, healthPid, isCobHealth, readRuntime, runtimeStillServing } from "./runtime.js";
import { discoverCodexBins, type CatalogDiscovery, type InspectCodexIo } from "../catalog/source.js";
import { detectInstall, formatInstallLine } from "../../core/install-detection.js";
import { isLiveCodexHome } from "../home.js";
import { isRecord } from "../../core/json.js";
import { resolveCobConfig, resolveSpawnableOllamaSlugs } from "../config/resolve.js";
import { assessDesktopOverlay, loadRootTomlKeys, openaiPortFromToml, summarizeCobStatus, type CobStatusKind, type DesktopOverlayAssessment, type DesktopOverlayState } from "../root-config.js";
import { resolvePaths } from "../paths.js";
import { assessCatalogProvenance, type CatalogFreshness } from "../catalog/provenance.js";
import type { CobPaths } from "../paths.js";
import type { DiagnosticLogSnapshot } from "./diagnostic-log.js";

/**
 * Read-only codex status report: runtime health, overlay, and provenance.
 */

/** Stable machine-readable status document. Content-free by design. */
export type StatusReportJson = {
  schema_version: 1;
  kind: CobStatusKind;
  needs_action: boolean;
  install: { kind: string; version: string };
  home: { kind: "live" | "isolated" };
  gateway: {
    running: boolean;
    healthy: boolean;
    health?: string;
    port?: number;
    pid?: number;
    diagnostics?: DiagnosticLogSnapshot;
  };
  overlay: DesktopOverlayState;
  catalog: {
    present: boolean;
    meta_present: boolean;
    freshness: CatalogFreshness;
    reason?: string;
    producer?: { kind: string; version: string };
    validator_count?: number;
    ollama_discovery?: "success" | "degraded";
    ollama_discovery_code?: string;
  };
  action_codes: string[];
};

export type StatusReport = {
  /** Exit 0 when this Codex home needs no cob action. */
  ok: boolean;
  text: string;
  json: StatusReportJson;
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
      gatewayRunning: false,
      install,
      liveHome,
    });
  }
  let health = "unknown";
  let liveCompaction: string | undefined;
  let livePlaintextSpawn: string | undefined;
  let liveDevMode = false;
  let liveDiagnostics: DiagnosticLogSnapshot | undefined;
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
    livePlaintextSpawn = describePlaintextSpawn(fetched.body);
    liveDevMode = isRecord(fetched.body) && fetched.body.dev_mode === true;
    liveDiagnostics = readDiagnosticLogSnapshot(fetched.body);
  }
  const gatewayHealthy = health === "ok";
  // A runtime record alone is not evidence that the gateway runs: a stale
  // record with a dead or reused pid must not report running=true. Confirm a
  // live cob process/health without mutating anything.
  const gatewayRunning = gatewayHealthy || (await runtimeStillServing(runtime));
  const details = [
    `gateway pid: ${runtime.pid}`,
    `gateway port: ${runtime.port}`,
    `gateway health: ${health}`,
    `ollama url: ${runtime.ollamaUrl}`,
  ];
  if (!gatewayRunning) {
    details.push("gateway process: no live cob process for the recorded pid");
  }
  if (runtime.version) {
    details.push(`gateway release: ${runtime.version} (${runtime.installKind ?? "unknown"})`);
  }
  if (liveDevMode) {
    details.push(`dev mode: on (per-request diagnostics at ${paths.diagnostics})`);
  }
  if (liveDiagnostics) {
    details.push(describeDiagnosticLog(liveDiagnostics));
  }
  if (livePlaintextSpawn) {
    details.push(livePlaintextSpawn);
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
    gatewayRunning,
    gatewayPid: runtime.pid,
    gatewayHealth: health,
    gatewayDiagnostics: liveDiagnostics,
    install,
    liveHome,
  });
}

/**
 * Only reported while the wire is armed, so the default line-up is unchanged
 * for anyone not using it. A stale digest is the one fact an operator has to
 * act on, so it names the config key and the digest to paste.
 */
export function describePlaintextSpawn(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.native_plaintext_spawn)) return undefined;
  const wire = body.native_plaintext_spawn;
  if (wire.enabled !== true) return undefined;
  const drift = isRecord(wire.drift) ? wire.drift : undefined;
  if (!drift) {
    return `native plaintext spawn: armed${wire.pinned === true ? "" : " (no pinned digest)"}`;
  }
  const count = typeof drift.count === "number" ? drift.count : 0;
  const observed = typeof drift.observed_schema_sha256 === "string" && /^[a-f0-9]{64}$/.test(drift.observed_schema_sha256)
    ? drift.observed_schema_sha256
    : undefined;
  const prefix = `native plaintext spawn: schema drift after ${count} request${count === 1 ? "" : "s"}`;
  return observed
    ? `${prefix}; set experimental.native_plaintext_spawn_schema_sha256 = "${observed}" in cob.toml`
    : `${prefix}; no replacement digest was observed`;
}

export function describeDiagnosticLog(snapshot: DiagnosticLogSnapshot): string {
  return (
    `diagnostics: ${snapshot.state}` +
    ` dropped=${snapshot.dropped_event_count}` +
    ` oversize=${snapshot.oversize_drop_count}` +
    ` failures=${snapshot.write_failure_count}` +
    ` rotations=${snapshot.rotation_count}` +
    ` discarded_backups=${snapshot.discarded_backup_count}` +
    (snapshot.last_failure_code ? ` last_failure=${snapshot.last_failure_code}` : "")
  );
}

function readDiagnosticLogSnapshot(body: unknown): DiagnosticLogSnapshot | undefined {
  if (!isRecord(body) || !isRecord(body.diagnostics)) return undefined;
  const value = body.diagnostics;
  if (
    (value.state !== "active" && value.state !== "degraded" && value.state !== "failed") ||
    typeof value.fd_open !== "boolean" ||
    !isNonNegativeInteger(value.dropped_event_count) ||
    !isNonNegativeInteger(value.oversize_drop_count) ||
    !isNonNegativeInteger(value.write_failure_count) ||
    !isNonNegativeInteger(value.rotation_count) ||
    !isNonNegativeInteger(value.discarded_backup_count)
  ) {
    return undefined;
  }
  const lastFailure = value.last_failure_code;
  if (
    lastFailure !== undefined &&
    lastFailure !== "open_failed" &&
    lastFailure !== "rotation_failed" &&
    lastFailure !== "write_failed"
  ) {
    return undefined;
  }
  return {
    state: value.state,
    fd_open: value.fd_open,
    dropped_event_count: value.dropped_event_count,
    oversize_drop_count: value.oversize_drop_count,
    write_failure_count: value.write_failure_count,
    rotation_count: value.rotation_count,
    discarded_backup_count: value.discarded_backup_count,
    ...(lastFailure === undefined ? {} : { last_failure_code: lastFailure }),
  };
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
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
    gatewayRunning: boolean;
    gatewayPid?: number;
    gatewayHealth?: string;
    gatewayDiagnostics?: DiagnosticLogSnapshot;
    install: ReturnType<typeof detectInstall>;
    liveHome: boolean;
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
  const catalogPresent = existsSync(paths.catalog);
  const metaPresent = existsSync(paths.catalogMeta);
  // Discovery evidence must stay in parity with the human lines across stale
  // and validation-failure states, not only when provenance is fresh.
  const discoveryEvidence = provenance.discovery_evidence;
  const actionCodes = buildStatusActionCodes({
    gatewayRunning: opts.gatewayRunning,
    gatewayHealthy: opts.gatewayHealthy,
    overlay: overlay.state,
    freshness: provenance.freshness,
    liveHome,
  });
  const json: StatusReportJson = {
    schema_version: 1,
    kind: summary.kind,
    needs_action: !summary.ok,
    install: { kind: opts.install.kind, version: opts.install.version },
    home: { kind: liveHome ? "live" : "isolated" },
    gateway: {
      running: opts.gatewayRunning,
      healthy: opts.gatewayHealthy,
      ...(opts.gatewayHealth !== undefined ? { health: opts.gatewayHealth } : {}),
      ...(opts.runtimePort !== undefined ? { port: opts.runtimePort } : {}),
      ...(opts.gatewayPid !== undefined ? { pid: opts.gatewayPid } : {}),
      ...(opts.gatewayDiagnostics !== undefined ? { diagnostics: opts.gatewayDiagnostics } : {}),
    },
    overlay: overlay.state,
    catalog: {
      present: catalogPresent,
      meta_present: metaPresent,
      freshness: provenance.freshness,
      ...(provenance.reason !== undefined ? { reason: provenance.reason } : {}),
      ...(provenance.provenance
        ? {
            producer: {
              kind: provenance.provenance.producer.kind,
              version: provenance.provenance.producer.version,
            },
            validator_count: provenance.provenance.validators.length,
          }
        : {}),
      ...(discoveryEvidence
        ? {
            ollama_discovery: discoveryEvidence.state,
            ...(discoveryEvidence.diagnostic?.code
              ? { ollama_discovery_code: discoveryEvidence.diagnostic.code }
              : {}),
          }
        : {}),
    },
    action_codes: actionCodes,
  };
  return {
    ok: summary.ok,
    text: [`cob: ${summary.kind}`, ...heading, ...details, ...overlay.lines, ...provenance.lines].join("\n"),
    json,
  };
}

/**
 * Stable, content-free suggested action codes derived from the same
 * assessment as the human output. Ordered by the standard recovery ladder.
 */
function buildStatusActionCodes(input: {
  gatewayRunning: boolean;
  gatewayHealthy: boolean;
  overlay: DesktopOverlayState;
  freshness: CatalogFreshness;
  liveHome: boolean;
}): string[] {
  const codes: string[] = [];
  if (!input.gatewayRunning || !input.gatewayHealthy) codes.push("cob_start");
  if (input.overlay === "broken" || input.overlay === "unreadable") {
    codes.push("repair_desktop_overlay");
  }
  if (input.freshness === "stale" || input.freshness === "unknown" || input.freshness === "missing") {
    codes.push("cob_sync");
  }
  return codes;
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
