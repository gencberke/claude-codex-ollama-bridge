import type { ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { DEFAULT_PORT } from "./constants.js";
import { DEFAULT_OLLAMA_URL } from "../core/ollama/constants.js";
import {
  mergeCatalogWithFallback,
  parseCatalogJson,
  serializeCatalog,
  writeCatalogIfChanged,
} from "./catalog/catalog.js";
import { loadBundledCatalog } from "./catalog/source.js";
import { syncCatalogControlPlane } from "./catalog/sync.js";
import { assertConsumersAcceptCatalog, CatalogConsumerRejectedError } from "./catalog/validator.js";
import { loadOllamaTags } from "../core/ollama/tags.js";
import {
  LIVE_DESKTOP_RESTART_HINT,
  assessCatalogProvenance,
  parseCatalogMetadata,
  shouldPrintDesktopRestartHint,
  writeCatalogProvenance,
  writeCatalogValidationFailure,
} from "./catalog/provenance.js";
import {
  discoverCodexBins,
  resolveCatalogSources,
  sha256Hex,
  type CatalogDiscovery,
  type InspectCodexIo,
} from "./catalog/source.js";
import { listenGateway } from "./gateway.js";
import { HEALTH_FETCH_TIMEOUT_MS, START_HEALTH_DEADLINE_MS } from "./limits.js";
import { assertLoopbackHttpUrl } from "../core/loopback.js";
import { writeCobProfile } from "./profile.js";
import {
  assessDesktopOverlay,
  loadRootTomlKeys,
  openaiPortFromToml,
  summarizeCobStatus,
  type DesktopOverlayAssessment,
} from "./root-config.js";
import { resolvePaths, type CobPaths } from "./paths.js";
import { detectInstall, formatInstallLine } from "../core/install-detection.js";
import { isLiveCodexHome } from "./home.js";
import {
  DEFAULT_CATALOG_POLICY,
  type CobFileConfig,
  type CompactionPolicy,
} from "./config/schema.js";
import { writeCobToml } from "./config/toml.js";
import {
  catalogSupportsApplyPatch,
  catalogSupportsSearchTool,
  resolveCobConfig,
  resolveSpawnableOllamaSlugs,
} from "./config/resolve.js";
import { readFileBufferOrNull, writeFileAtomic } from "../core/atomic.js";
import {
  acquireLock,
  adoptLock,
  heldLockToken,
  peekLockRecord,
  releaseLock,
  waitForLockAdopted,
  withExclusiveLock,
} from "../core/lock.js";
import { clearConversationState } from "./state/store.js";
import {
  cobProcessIdentity,
  isCobGatewayProcess,
  isPidAlive,
  isSameProcess,
  ownStartKey,
  processStartKey,
  reapChild,
} from "../core/process-info.js";
import type { CatalogFile } from "./types.js";
import { isRecord } from "../core/json.js";

export { isCobProcess } from "../core/process-info.js";
export { adoptLock, heldLockToken } from "../core/lock.js";

export type OverlaySnapshot = Record<string, Buffer | null>;

export type StartLease = {
  pid: number;
  nonce: string;
  startKey?: string;
  launcherPid?: number;
  launcherStartKey?: string;
  createdAt: string;
};

export type DetachedStartSpawn = (env: { token: string; nonce: string }) => ChildProcess;

export type StartOptions = {
  port?: number;
  ollamaUrl?: string;
  paths?: CobPaths;
  compaction?: CompactionPolicy;
  cob?: CobFileConfig;
  locked?: boolean;
  discovery?: CatalogDiscovery;
  inspect?: InspectCodexIo;
};

export type RuntimeState = {
  pid: number;
  port: number;
  ollamaUrl: string;
  startedAt: string;
  nonce?: string;
  startKey?: string;
  compaction?: CompactionPolicy;
  version?: string;
  installKind?: string;
  cliPath?: string;
};

export type HealthWait = {
  attempts?: number;
  deadlineMs?: number;
  nonce?: string;
  pid?: number;
};

export function overlayStateFiles(paths: CobPaths): string[] {
  return [paths.profile, paths.catalog, paths.catalogMeta, paths.cobConfig, paths.runtime, paths.pid];
}

export function snapshotOverlays(paths: CobPaths): OverlaySnapshot {
  const snapshot: OverlaySnapshot = {};
  for (const file of overlayStateFiles(paths)) {
    snapshot[file] = readFileBufferOrNull(file);
  }
  return snapshot;
}

export function restoreOverlays(
  paths: CobPaths,
  snapshot: OverlaySnapshot,
  opts: { preserveCatalogValidationFailure?: boolean } = {},
): void {
  const failedValidationMetadata = opts.preserveCatalogValidationFailure
    ? retainableCatalogValidationFailure(paths, snapshot)
    : null;
  for (const file of overlayStateFiles(paths)) {
    // The retained failure sidecar was already written atomically with mode
    // 0600. Leave it in place so rollback has no delete/rewrite crash window.
    if (file === paths.catalogMeta && failedValidationMetadata) continue;
    const bytes = snapshot[file];
    if (bytes === null || bytes === undefined) unlinkIfExists(file);
    else writeFileAtomic(file, bytes, 0o600);
  }
}

function retainableCatalogValidationFailure(
  paths: CobPaths,
  snapshot: OverlaySnapshot,
): Buffer | null {
  const metadataBytes = readFileBufferOrNull(paths.catalogMeta);
  const previousMetadataBytes = snapshot[paths.catalogMeta] ?? null;
  if (
    metadataBytes === null ||
    (previousMetadataBytes !== null && metadataBytes.equals(previousMetadataBytes))
  ) {
    return null;
  }

  for (const file of overlayStateFiles(paths)) {
    if (file === paths.catalogMeta) continue;
    const snapshotBytes = snapshot[file] ?? null;
    const currentBytes = readFileBufferOrNull(file);
    if (
      (snapshotBytes === null) !== (currentBytes === null) ||
      (snapshotBytes !== null && currentBytes !== null && !snapshotBytes.equals(currentBytes))
    ) {
      return null;
    }
  }

  const retainedCatalogBytes = snapshot[paths.catalog] ?? null;
  try {
    const metadata = parseCatalogMetadata(metadataBytes.toString("utf8"));
    if (metadata.schema_version !== 2 || metadata.last_failure === undefined) return null;
    if (retainedCatalogBytes === null) {
      return metadata.catalog_sha256 === null ? metadataBytes : null;
    }
    return metadata.catalog_sha256 === sha256Hex(retainedCatalogBytes) ? metadataBytes : null;
  } catch {
    return null;
  }
}

export function writeStartLease(paths: CobPaths, lease: StartLease): void {
  writeFileAtomic(paths.startLease, `${JSON.stringify(lease)}\n`, 0o600);
}

export function readStartLease(paths: CobPaths): StartLease | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(paths.startLease, "utf8"));
    if (!isRecord(parsed) || typeof parsed.pid !== "number" || typeof parsed.nonce !== "string") {
      return null;
    }
    if (!Number.isInteger(parsed.pid) || parsed.pid <= 0 || parsed.nonce.length === 0) return null;
    return {
      pid: parsed.pid,
      nonce: parsed.nonce,
      startKey: typeof parsed.startKey === "string" && parsed.startKey.length > 0 ? parsed.startKey : undefined,
      launcherPid:
        typeof parsed.launcherPid === "number" && Number.isInteger(parsed.launcherPid) && parsed.launcherPid > 0
          ? parsed.launcherPid
          : undefined,
      launcherStartKey:
        typeof parsed.launcherStartKey === "string" && parsed.launcherStartKey.length > 0
          ? parsed.launcherStartKey
          : undefined,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    };
  } catch {
    return null;
  }
}

export function clearStartLease(paths: CobPaths): void {
  unlinkIfExists(paths.startLease);
}

export function isStartLeaseActive(lease: StartLease): boolean {
  if (lease.launcherPid !== undefined && isLeaseProcessActive(lease.launcherPid, lease.launcherStartKey)) {
    return true;
  }
  return isLeaseProcessActive(lease.pid, lease.startKey);
}

function isLeaseProcessActive(pid: number, startKey: string | undefined): boolean {
  if (!isPidAlive(pid)) return false;
  if (!startKey) return true;
  const live = processStartKey(pid);
  if (live === undefined) return true;
  return live === startKey;
}

export async function withCobLock<T>(paths: CobPaths, fn: () => Promise<T>): Promise<T> {
  return withExclusiveLock(paths.lock, fn);
}

export function readRootConfig(paths: CobPaths): Buffer | null {
  try {
    return readFileSync(paths.rootConfig);
  } catch {
    return null;
  }
}

export function assertRootConfigUnchanged(paths: CobPaths, before: Buffer | null): void {
  const after = readRootConfig(paths);
  if (before === null && after === null) return;
  if (before === null || after === null || !before.equals(after)) {
    throw new Error("refusing to continue: ~/.codex/config.toml changed; cob must never write it");
  }
}

export async function syncCatalog(opts: {
  paths: CobPaths;
  ollamaUrl: string;
  spawnableOllamaSlugs?: readonly string[];
  applyPatch?: boolean;
  cob?: CobFileConfig;
  locked?: boolean;
  discovery?: CatalogDiscovery;
  inspect?: InspectCodexIo;
}): Promise<{ catalog: CatalogFile; wrote: boolean; ollamaCount: number; ollamaError?: string }> {
  const run = () =>
    syncCatalogControlPlane({
      ...opts,
      resolveRuntimePort: () => readRuntime(opts.paths)?.port,
    });
  if (opts.locked) return run();
  return withCobLock(opts.paths, async () => {
    const lease = readStartLease(opts.paths);
    if (lease && isStartLeaseActive(lease)) {
      throw new Error("cob sync refused: cob start in progress");
    }
    return run();
  });
}

export async function prepareProfileAndCatalog(opts: StartOptions = {}): Promise<{
  paths: CobPaths;
  port: number;
  ollamaUrl: string;
  catalog: CatalogFile;
  wrote: boolean;
  ollamaError?: string;
  compaction: CompactionPolicy;
  cob: CobFileConfig;
}> {
  const run = () => prepareUnlocked(opts);
  const paths = opts.paths ?? resolvePaths();
  if (opts.locked) return run();
  return withCobLock(paths, run);
}

async function prepareUnlocked(opts: StartOptions): Promise<{
  paths: CobPaths;
  port: number;
  ollamaUrl: string;
  catalog: CatalogFile;
  wrote: boolean;
  ollamaError?: string;
  compaction: CompactionPolicy;
  cob: CobFileConfig;
}> {
  const paths = opts.paths ?? resolvePaths();
  const port = opts.port ?? DEFAULT_PORT;
  const ollamaUrl = opts.ollamaUrl ?? DEFAULT_OLLAMA_URL;
  const resolvedCob =
    opts.cob ??
    resolveCobConfig({
      paths,
      provider: opts.compaction?.provider,
      model: opts.compaction?.model,
      ollamaThreads: opts.compaction?.ollamaThreads,
      ollamaModel: opts.compaction?.ollamaModel,
      ollamaEffort: opts.compaction?.ollamaEffort,
    });
  const cob = restrictExperimentalToIsolatedHome(resolvedCob, isLiveCodexHome(paths.codexHome));
  const spawnable = resolveSpawnableOllamaSlugs(cob);
  const before = readRootConfig(paths);
  const synced = await syncCatalogControlPlane({
    paths,
    ollamaUrl,
    spawnableOllamaSlugs: spawnable,
    supportsSearchTool: catalogSupportsSearchTool(cob),
    applyPatch: catalogSupportsApplyPatch(cob),
    cob,
    discovery: opts.discovery,
    inspect: opts.inspect,
    keepLastGoodOnReject: true,
    resolveRuntimePort: () => readRuntime(paths)?.port,
  });
  writeCobProfile(paths, port);
  writeCobToml(paths.cobConfig, {
    compaction: cob.compaction,
    subagents: { models: spawnable },
    catalog: cob.catalog ?? DEFAULT_CATALOG_POLICY,
    experimental: cob.experimental,
  });
  assertRootConfigUnchanged(paths, before);
  return {
    paths,
    port,
    ollamaUrl,
    catalog: synced.catalog,
    wrote: synced.wrote,
    ollamaError: synced.ollamaError,
    compaction: cob.compaction,
    cob,
  };
}

/** Isolated-only experiments are never persisted or armed in the live Desktop home. */
export function restrictExperimentalToIsolatedHome(cob: CobFileConfig, liveHome: boolean): CobFileConfig {
  if (!liveHome) return cob;
  const applyPatchOn = cob.catalog?.applyPatch === true;
  const spawn = cob.experimental?.nativePlaintextSpawn;
  const spawnOn = spawn?.enabled === true;
  const spawnDigest = typeof spawn?.schemaSha256 === "string" && spawn.schemaSha256.length > 0;
  if (!applyPatchOn && !spawnOn && !spawnDigest) return cob;
  return {
    ...cob,
    catalog: applyPatchOn
      ? {
          ...(cob.catalog ?? DEFAULT_CATALOG_POLICY),
          applyPatch: false,
        }
      : cob.catalog,
    experimental:
      spawnOn || spawnDigest
        ? {
            nativePlaintextSpawn: { enabled: false },
          }
        : cob.experimental,
  };
}

export async function serveForeground(opts: StartOptions = {}): Promise<void> {
  const paths = opts.paths ?? resolvePaths();
  const handoffToken = process.env.COB_LOCK_TOKEN;
  const boot = async () => {
    const existing = readRuntime(paths);
    if (existing && existing.pid !== process.pid && (await isHealthyRuntime(existing))) {
      throw new Error(`cob already running on 127.0.0.1:${existing.port} (pid ${existing.pid})`);
    }
    if (existing && !isPidAlive(existing.pid)) {
      unlinkIfExists(paths.pid);
      unlinkIfExists(paths.runtime);
    }
    const snapshot = snapshotOverlays(paths);
    let server: Awaited<ReturnType<typeof listenGateway>> | undefined;
    try {
      const next = await prepareUnlocked({ ...opts, paths });
      if (shouldPrintDesktopRestartHint(isLiveCodexHome(next.paths.codexHome), next.wrote)) {
        console.log(LIVE_DESKTOP_RESTART_HINT);
      }
      const nonce = process.env.COB_RUNTIME_NONCE || randomBytes(16).toString("hex");
      server = await listenGateway({
        port: next.port,
        ollamaUrl: next.ollamaUrl,
        catalog: next.catalog,
        catalogPath: next.paths.catalog,
        nonce,
        compaction: next.compaction,
        nativePlaintextSpawn: next.cob.experimental?.nativePlaintextSpawn,
        // The gateway owns the wire translator; lifecycle only threads the
        // isolated catalog decision into the implemented Gate 5 bridge.
        ...(catalogSupportsApplyPatch(next.cob) && !isLiveCodexHome(next.paths.codexHome)
          ? { applyPatch: true }
          : {}),
        stateDir: next.paths.stateDir,
      });
      const install = detectInstall();
      writeRuntime(next.paths, {
        pid: process.pid,
        port: next.port,
        ollamaUrl: next.ollamaUrl,
        startedAt: new Date().toISOString(),
        nonce,
        startKey: processStartKey(process.pid),
        compaction: next.compaction,
        version: install.version,
        installKind: install.kind,
        cliPath: install.cliPath,
      });
      return { ...next, server };
    } catch (error) {
      if (server) {
        const listeningServer = server;
        server = undefined;
        try {
          await new Promise<void>((resolve) => {
            listeningServer.close(() => resolve());
          });
        } catch {
          // Preserve the boot error; there is no safe recovery if close itself fails.
        }
      }
      restoreOverlays(paths, snapshot, {
        preserveCatalogValidationFailure: error instanceof CatalogConsumerRejectedError,
      });
      throw error;
    }
  };

  let prepared: Awaited<ReturnType<typeof boot>>;
  if (handoffToken) {
    adoptLock(paths.lock, handoffToken);
    try {
      prepared = await boot();
    } finally {
      releaseLock(paths.lock);
    }
  } else if (opts.locked) {
    prepared = await boot();
  } else {
    prepared = await withCobLock(paths, boot);
  }

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      prepared.server.close(() => resolve());
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  });
}

export function writeRuntime(paths: CobPaths, runtime: RuntimeState): void {
  writeFileAtomic(paths.runtime, `${JSON.stringify(runtime, null, 2)}\n`, 0o600);
  writeFileAtomic(paths.pid, `${runtime.pid}\n`, 0o600);
}

export function readRuntime(paths: CobPaths): RuntimeState | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(paths.runtime, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      "pid" in parsed &&
      "port" in parsed &&
      typeof (parsed as RuntimeState).pid === "number"
    ) {
      return parsed as RuntimeState;
    }
  } catch {
    // fall through to pid file
  }
  try {
    const pid = Number(readFileSync(paths.pid, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) {
      return {
        pid,
        port: DEFAULT_PORT,
        ollamaUrl: DEFAULT_OLLAMA_URL,
        startedAt: "",
      };
    }
  } catch {
    return null;
  }
  return null;
}

export async function isHealthyRuntime(runtime: RuntimeState): Promise<boolean> {
  if (!isPidAlive(runtime.pid)) return false;
  const health = await fetchHealthz(runtime.port, runtime.nonce);
  if (!health) return false;
  if (!isCobHealth(health.body) || !health.ok) return false;
  const bodyPid = healthPid(health.body);
  if (bodyPid !== undefined && bodyPid !== runtime.pid) return false;
  if (runtime.nonce && !healthNonceOk(health.body)) return false;
  return true;
}

export async function stopGateway(paths: CobPaths = resolvePaths(), opts?: { locked?: boolean }): Promise<boolean> {
  const run = () => stopGatewayUnlocked(paths);
  if (opts?.locked) return run();
  return withCobLock(paths, run);
}

async function stopGatewayUnlocked(paths: CobPaths): Promise<boolean> {
  const runtime = readRuntime(paths);
  if (!runtime) return false;
  let stopped = false;
  if (runtime.nonce) {
    try {
      const response = await fetch(`http://127.0.0.1:${runtime.port}/cob/shutdown`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-cob-nonce": runtime.nonce },
        body: JSON.stringify({ nonce: runtime.nonce }),
        signal: AbortSignal.timeout(HEALTH_FETCH_TIMEOUT_MS),
      });
      stopped = response.ok;
    } catch {
      stopped = false;
    }
  }
  if (!stopped && isOurGatewayPid(runtime)) {
    try {
      process.kill(runtime.pid, "SIGTERM");
      stopped = true;
    } catch {
      stopped = false;
    }
  }
  if (isPidAlive(runtime.pid) && isOurGatewayPid(runtime)) {
    await waitForPidExit(runtime.pid, 5_000);
    if (isPidAlive(runtime.pid) && isOurGatewayPid(runtime)) {
      try {
        process.kill(runtime.pid, "SIGKILL");
      } catch {
        // already gone
      }
      await waitForPidExit(runtime.pid, 2_000);
    }
  }
  if (await runtimeStillServing(runtime)) {
    throw new Error(`gateway still running on port ${runtime.port} pid ${runtime.pid}`);
  }
  const portClosed = await waitForPortClosed(runtime.port, 5_000);
  if (!portClosed) {
    throw new Error(`port ${runtime.port} still open after stop; leaving runtime and overlays in place`);
  }
  if (await runtimeStillServing(runtime)) {
    throw new Error(`gateway still running on port ${runtime.port} pid ${runtime.pid}`);
  }
  unlinkIfExists(paths.pid);
  unlinkIfExists(paths.runtime);
  return stopped || !isPidAlive(runtime.pid);
}

export async function restoreCob(paths: CobPaths = resolvePaths()): Promise<{ rootConfigUnchanged: boolean }> {
  const before = readRootConfig(paths);
  await withCobLock(paths, async () => {
    const lease = readStartLease(paths);
    if (lease && isStartLeaseActive(lease)) {
      throw new Error("restore refused: cob start in progress");
    }
    await stopGateway(paths, { locked: true });
    const runtime = readRuntime(paths);
    if (runtime && (await runtimeStillServing(runtime))) {
      throw new Error(`restore refused: gateway still running on port ${runtime.port} pid ${runtime.pid}`);
    }
    if (runtime) {
      const portClosed = await waitForPortClosed(runtime.port, 5_000);
      if (!portClosed) {
        throw new Error(`restore refused: port ${runtime.port} still open; leaving overlays in place`);
      }
    }
    for (const file of [
      paths.profile,
      paths.catalog,
      paths.catalogMeta,
      paths.cobConfig,
      paths.pid,
      paths.log,
      paths.runtime,
      paths.startLease,
    ]) {
      if (file === paths.rootConfig) {
        throw new Error("internal error: refuse to delete root config");
      }
      unlinkIfExists(file);
      if (existsSync(file)) {
        throw new Error(`restore could not delete ${file}`);
      }
    }
    clearConversationState(paths.stateDir);
    if (existsSync(paths.stateDir)) {
      throw new Error(`restore could not delete ${paths.stateDir}`);
    }
  });
  const after = readRootConfig(paths);
  const unchanged =
    (before === null && after === null) ||
    (before !== null && after !== null && before.equals(after));
  if (!unchanged) {
    throw new Error("restore changed ~/.codex/config.toml; this is a cob bug");
  }
  return { rootConfigUnchanged: true };
}

export async function waitForHealth(port: number, opts: number | HealthWait = 40): Promise<void> {
  const attempts = typeof opts === "number" ? opts : (opts.attempts ?? 40);
  const nonce = typeof opts === "number" ? undefined : opts.nonce;
  const expectedPid = typeof opts === "number" ? undefined : opts.pid;
  const deadlineMs =
    typeof opts === "number" ? undefined : (opts.deadlineMs ?? START_HEALTH_DEADLINE_MS);
  const deadline = deadlineMs !== undefined ? Date.now() + deadlineMs : undefined;
  let last = "no response";
  for (let i = 0; i < attempts; i += 1) {
    if (deadline !== undefined && Date.now() >= deadline) break;
    if (expectedPid !== undefined && !isPidAlive(expectedPid)) {
      throw new Error(`gateway process ${expectedPid} exited before becoming healthy`);
    }
    try {
      const remaining = deadline !== undefined ? Math.max(1, deadline - Date.now()) : HEALTH_FETCH_TIMEOUT_MS;
      const health = await fetchHealthz(port, nonce, Math.min(HEALTH_FETCH_TIMEOUT_MS, remaining));
      if (!health) {
        last = "no response";
      } else if (
        health.ok &&
        isCobHealth(health.body) &&
        (nonce === undefined || healthNonceOk(health.body)) &&
        (expectedPid === undefined || healthPid(health.body) === expectedPid)
      ) {
        return;
      } else {
        last = `${health.status}`;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    const sleepFor =
      deadline !== undefined ? Math.min(100, Math.max(0, deadline - Date.now())) : 100;
    if (sleepFor <= 0) break;
    await sleep(sleepFor);
  }
  throw new Error(`gateway did not become healthy on ${port}: ${last}`);
}

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

async function runtimeStillServing(runtime: RuntimeState): Promise<boolean> {
  const health = await fetchHealthz(runtime.port, runtime.nonce);
  if (
    health &&
    health.ok &&
    isCobHealth(health.body) &&
    (runtime.nonce ? healthNonceOk(health.body) : true) &&
    (healthPid(health.body) === undefined || healthPid(health.body) === runtime.pid)
  ) {
    return true;
  }
  if (!isPidAlive(runtime.pid)) return false;
  if (runtime.startKey && !isSameProcess(runtime.pid, runtime.startKey)) return false;
  const identity = cobProcessIdentity(runtime.pid);
  if (identity === "unknown") return true;
  return identity === "cob" && isCobGatewayProcess(runtime.pid);
}

async function fetchHealthz(
  port: number,
  nonce?: string,
  timeoutMs = HEALTH_FETCH_TIMEOUT_MS,
): Promise<{ ok: boolean; status: number; body: unknown } | null> {
  try {
    const headers: Record<string, string> = {};
    if (nonce) headers["x-cob-nonce"] = nonce;
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body: unknown = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body };
  } catch {
    return null;
  }
}

function isCobHealth(body: unknown): boolean {
  return Boolean(isRecord(body) && body.service === "cob");
}

function healthNonceOk(body: unknown): boolean {
  return Boolean(isRecord(body) && body.nonce_ok === true);
}

function healthPid(body: unknown): number | undefined {
  return isRecord(body) && typeof body.pid === "number" ? body.pid : undefined;
}

function isOurGatewayPid(runtime: RuntimeState): boolean {
  if (!isCobGatewayProcess(runtime.pid)) return false;
  if (!runtime.startKey) return false;
  return isSameProcess(runtime.pid, runtime.startKey);
}

function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (!isPidAlive(pid)) return;
      await sleep(50);
    }
  })();
}

function waitForPortClosed(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (!(await isPortOpen(port))) return true;
      await sleep(50);
    }
    return !(await isPortOpen(port));
  })();
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (open: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(open);
    };
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.end();
      done(true);
    });
    socket.setTimeout(HEALTH_FETCH_TIMEOUT_MS, () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => {
      socket.destroy();
      done(false);
    });
  });
}

export async function startGatewayDetached(opts: {
  paths: CobPaths;
  port: number;
  ollamaUrl: string;
  spawnServe: DetachedStartSpawn;
}): Promise<{ alreadyRunning: boolean; runtime: RuntimeState }> {
  const { paths, port, spawnServe } = opts;
  const nonce = randomBytes(16).toString("hex");
  let child: ChildProcess | undefined;
  let snapshot: OverlaySnapshot | undefined;

  await acquireLock(paths.lock);
  try {
    const existing = readRuntime(paths);
    if (existing && (await isHealthyRuntime(existing))) {
      return { alreadyRunning: true, runtime: existing };
    }
    const lease = readStartLease(paths);
    if (lease && isStartLeaseActive(lease)) {
      throw new Error("cob start already in progress");
    }
    if (existing) {
      await stopGateway(paths, { locked: true });
    }
    snapshot = snapshotOverlays(paths);
    const token = heldLockToken(paths.lock);
    if (!token) {
      throw new Error("internal error: missing cob lock token");
    }
    child = spawnServe({ token, nonce });
    if (child.pid === undefined) {
      throw new Error("failed to spawn cob serve");
    }
    writeStartLease(paths, {
      pid: child.pid,
      nonce,
      startKey: processStartKey(child.pid),
      launcherPid: process.pid,
      launcherStartKey: ownStartKey(),
      createdAt: new Date().toISOString(),
    });
    await waitForLockAdopted(paths.lock, token, child.pid);
  } catch (error) {
    if (child) {
      await reapChild(child);
      const lease = readStartLease(paths);
      if (lease && lease.pid === child.pid && lease.nonce === nonce) {
        clearStartLease(paths);
      }
      if (snapshot) restoreOverlays(paths, snapshot, { preserveCatalogValidationFailure: true });
    }
    throw error;
  } finally {
    releaseLock(paths.lock);
  }

  if (!child) {
    throw new Error("internal error: detached start lost the child process");
  }

  try {
    await waitForHealth(port, {
      attempts: 120,
      deadlineMs: START_HEALTH_DEADLINE_MS,
      nonce,
      pid: child.pid,
    });
    await acquireLock(paths.lock);
    try {
      const lease = readStartLease(paths);
      if (!lease || lease.pid !== child.pid || lease.nonce !== nonce) {
        throw new Error("cob start lease was lost before commit");
      }
      const runtime = readRuntime(paths);
      if (!runtime || runtime.pid !== child.pid || runtime.nonce !== nonce) {
        throw new Error("cob serve came up but runtime pid/nonce did not match the spawned child");
      }
      if (!existsSync(paths.catalog) || !existsSync(paths.profile) || !existsSync(paths.cobConfig)) {
        throw new Error("cob serve came up but overlay files are missing");
      }
      if (!(await isHealthyRuntime(runtime))) {
        throw new Error("cob serve health check failed after overlays were verified");
      }
      clearStartLease(paths);
      if (!(await isHealthyRuntime(runtime)) || !existsSync(paths.catalog) || !existsSync(paths.profile)) {
        throw new Error("cob start commit lost the gateway before returning success");
      }
      child.unref();
      return { alreadyRunning: false, runtime };
    } finally {
      releaseLock(paths.lock);
    }
  } catch (error) {
    await rollbackDetachedStart(paths, snapshot, child, nonce);
    throw error;
  }
}

async function rollbackDetachedStart(
  paths: CobPaths,
  snapshot: OverlaySnapshot | undefined,
  child: ChildProcess,
  nonce: string,
): Promise<void> {
  await reapChild(child);
  if (!snapshot) return;
  await withCobLock(paths, async () => {
    const lease = readStartLease(paths);
    if (!lease || lease.pid !== child.pid || lease.nonce !== nonce) return;
    clearStartLease(paths);
    restoreOverlays(paths, snapshot, { preserveCatalogValidationFailure: true });
  });
}


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
