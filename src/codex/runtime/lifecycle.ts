import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { DEFAULT_PORT } from "../constants.js";
import { DEFAULT_OLLAMA_URL } from "../../core/ollama/constants.js";
import { syncCatalogControlPlane } from "../catalog/sync.js";
import { CatalogConsumerRejectedError } from "../catalog/validator.js";
import { LIVE_DESKTOP_RESTART_HINT, parseCatalogMetadata, shouldPrintDesktopRestartHint } from "../catalog/provenance.js";
import { sha256Hex, type CatalogDiscovery, type InspectCodexIo } from "../catalog/source.js";
import { listenGateway } from "../gateway.js";
import { HEALTH_FETCH_TIMEOUT_MS, START_HEALTH_DEADLINE_MS } from "../limits.js";
import {
  isHealthyRuntime,
  isOurGatewayPid,
  readRuntime,
  runtimeStillServing,
  waitForHealth,
  waitForPidExit,
  waitForPortClosed,
  writeRuntime,
  type RuntimeState,
} from "./runtime.js";
import { resolvePaths, type CobPaths } from "../paths.js";
import { detectInstall } from "../../core/install-detection.js";
import { isLiveCodexHome } from "../home.js";
import {
  DEFAULT_CATALOG_POLICY,
  type CobFileConfig,
  type CompactionPolicy,
} from "../config/schema.js";
import { writeCobToml } from "../config/toml.js";
import {
  catalogSupportsApplyPatch,
  catalogSupportsSearchTool,
  resolveCobConfig,
  resolveSpawnableOllamaSlugs,
} from "../config/resolve.js";
import { readFileBufferOrNull, writeFileAtomic } from "../../core/atomic.js";
import { acquireLock, adoptLock, heldLockToken, releaseLock, waitForLockAdopted, withExclusiveLock } from "../../core/lock.js";
import { clearConversationState } from "../state/store.js";
import { isPidAlive, ownStartKey, processStartKey, reapChild } from "../../core/process-info.js";
import type { CatalogFile } from "../types.js";
import { isRecord } from "../../core/json.js";
import { createPrivateRotatingLogWriter, type PrivateLogWriter } from "./log-fd.js";

export { isCobProcess } from "../../core/process-info.js";
export { adoptLock, heldLockToken } from "../../core/lock.js";

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

/**
 * Every file cob owns inside a codex home. This is the single source of
 * truth; restore deletes all of them and overlay rollback derives its
 * snapshot set by excluding the files that must survive a failed start.
 */
export function cobOwnedFiles(paths: CobPaths): string[] {
  return [
    paths.profile,
    paths.catalog,
    paths.catalogMeta,
    paths.cobConfig,
    paths.log,
    paths.diagnostics,
    `${paths.diagnostics}.1`,
    paths.runtime,
    paths.pid,
    paths.startLease,
  ];
}

export function overlayStateFiles(paths: CobPaths): string[] {
  return cobOwnedFiles(paths).filter(
    (file) =>
      file !== paths.log &&
      file !== paths.diagnostics &&
      file !== `${paths.diagnostics}.1` &&
      file !== paths.startLease,
  );
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
  const state = readStartLeaseState(paths);
  return state.state === "valid" ? state.lease : null;
}

export type StartLeaseRead =
  | { state: "absent" }
  | { state: "malformed" }
  | { state: "valid"; lease: StartLease };

/**
 * Distinguish a missing lease from lease bytes cob cannot validate. A
 * malformed lease is an explicit blocked lifecycle condition: callers refuse
 * the operation instead of silently treating it as "no lease" or clearing it.
 */
export function readStartLeaseState(paths: CobPaths): StartLeaseRead {
  let raw: string;
  try {
    raw = readFileSync(paths.startLease, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "absent" };
    }
    return { state: "malformed" };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed.pid !== "number" || typeof parsed.nonce !== "string") {
      return { state: "malformed" };
    }
    if (!Number.isInteger(parsed.pid) || parsed.pid <= 0 || parsed.nonce.length === 0) {
      return { state: "malformed" };
    }
    return {
      state: "valid",
      lease: {
        pid: parsed.pid,
        nonce: parsed.nonce,
        startKey:
          typeof parsed.startKey === "string" && parsed.startKey.length > 0 ? parsed.startKey : undefined,
        launcherPid:
          typeof parsed.launcherPid === "number" && Number.isInteger(parsed.launcherPid) && parsed.launcherPid > 0
            ? parsed.launcherPid
            : undefined,
        launcherStartKey:
          typeof parsed.launcherStartKey === "string" && parsed.launcherStartKey.length > 0
            ? parsed.launcherStartKey
            : undefined,
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
      },
    };
  } catch {
    return { state: "malformed" };
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

export class RootConfigUnreadableError extends Error {
  readonly code = "root_config_unreadable";
  constructor(readonly cause: NodeJS.ErrnoException) {
    super(`cob cannot read ~/.codex/config.toml (${String(cause.code ?? cause)}); refusing to treat it as missing`);
    this.name = "RootConfigUnreadableError";
  }
}

export function readRootConfig(paths: CobPaths): Buffer | null {
  try {
    return readFileSync(paths.rootConfig);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw new RootConfigUnreadableError(error as NodeJS.ErrnoException);
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
  // Standalone sync is a rollback-controlled publication: any failure after a
  // write step restores the prior overlay bytes exactly, while a retained
  // consumer-rejection sidecar stays in place.
  const refuseMalformedLease = (): StartLeaseRead => {
    const leaseState = readStartLeaseState(opts.paths);
    if (leaseState.state === "malformed") {
      throw new Error(`cob sync refused: unreadable cob start lease at ${opts.paths.startLease}`);
    }
    return leaseState;
  };
  const run = async () => {
    // Checked before the snapshot: a malformed lease must block every sync
    // path, including locked callers, and never reach publication.
    refuseMalformedLease();
    const snapshot = snapshotOverlays(opts.paths);
    try {
      return await syncCatalogControlPlane({
        ...opts,
        resolveRuntimePort: () => readRuntime(opts.paths)?.port,
      });
    } catch (error) {
      restoreOverlays(opts.paths, snapshot, { preserveCatalogValidationFailure: true });
      throw error;
    }
  };
  if (opts.locked) return run();
  return withCobLock(opts.paths, async () => {
    const leaseState = refuseMalformedLease();
    if (leaseState.state === "valid" && isStartLeaseActive(leaseState.lease)) {
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
  // Narrow start-path control: a malformed lease blocks publication here so
  // neither prepare nor the foreground serve path can silently publish over
  // lease bytes cob cannot validate.
  const leaseState = readStartLeaseState(paths);
  if (leaseState.state === "malformed") {
    throw new Error(`cob start refused: unreadable cob start lease at ${paths.startLease}`);
  }
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
  const cob = restrictExperimentalOnLiveHome(resolvedCob, isLiveCodexHome(paths.codexHome));
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
    profilePort: port,
  });
  writeCobToml(paths.cobConfig, {
    compaction: cob.compaction,
    subagents: { models: spawnable },
    catalog: cob.catalog ?? DEFAULT_CATALOG_POLICY,
    experimental: cob.experimental,
    // An explicit ceiling is operator state; a start must not silently drop it.
    ...(cob.limits?.ollamaMaxResponseBytes !== undefined ? { limits: cob.limits } : {}),
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

/**
 * Gate 5 `apply_patch` stays isolated-only and is never armed in the live
 * Desktop home. Native plaintext spawn is opt-in on the live home, but only
 * with a pinned schema digest: an armed-but-unpinned policy rejects every
 * fingerprinted-model turn, which would take the Desktop gateway down instead
 * of leaving the request unrewritten.
 */
export function restrictExperimentalOnLiveHome(cob: CobFileConfig, liveHome: boolean): CobFileConfig {
  if (!liveHome) return cob;
  const applyPatchOn = cob.catalog?.applyPatch === true;
  const spawn = cob.experimental?.nativePlaintextSpawn;
  const spawnUnpinned =
    spawn?.enabled === true && !(typeof spawn.schemaSha256 === "string" && spawn.schemaSha256.length > 0);
  return {
    ...cob,
    catalog: applyPatchOn
      ? {
          ...(cob.catalog ?? DEFAULT_CATALOG_POLICY),
          applyPatch: false,
        }
      : cob.catalog,
    experimental: spawnUnpinned
      ? { nativePlaintextSpawn: { enabled: false } }
      : spawn
        ? { nativePlaintextSpawn: { ...spawn, degradeOnDrift: true } }
        : cob.experimental,
  };
}

export async function serveForeground(opts: StartOptions = {}): Promise<void> {
  const paths = opts.paths ?? resolvePaths();
  const handoffToken = process.env.COB_LOCK_TOKEN;
  let detachedLog: PrivateLogWriter | undefined;
  const boot = async () => {
    const existing = readRuntime(paths);
    if (existing && existing.pid !== process.pid && (await isHealthyRuntime(existing))) {
      throw new Error(`cob already running on 127.0.0.1:${existing.port} (pid ${existing.pid})`);
    }
    if (existing && !isPidAlive(existing.pid)) {
      unlinkIfExists(paths.pid);
      unlinkIfExists(paths.runtime);
    }
    // Only a detached child that has passed the healthy-runtime check owns a
    // fresh log. This keeps repeated `cob start` and failed preflight paths
    // from truncating an existing human log.
    if (process.env.COB_DETACHED_LOG === "1") {
      detachedLog = installDetachedLogWriter(paths.log);
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
        diagnosticPath: next.paths.diagnostics,
        nonce,
        compaction: next.compaction,
        nativePlaintextSpawn: next.cob.experimental?.nativePlaintextSpawn,
        ...(typeof next.cob.limits?.ollamaMaxResponseBytes === "number"
          ? { ollamaMaxResponseBytes: next.cob.limits.ollamaMaxResponseBytes }
          : {}),
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
  try {
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
        prepared.server.close(() => {
          detachedLog?.close();
          resolve();
        });
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
    });
  } catch (error) {
    detachedLog?.close();
    throw error;
  }
}

/** Route detached child console output through the bounded file writer. */
function installDetachedLogWriter(logPath: string): PrivateLogWriter {
  const writer = createPrivateRotatingLogWriter(logPath, true);
  const stdout = process.stdout;
  const stderr = process.stderr;
  const originalStdout = stdout.write.bind(stdout);
  const originalStderr = stderr.write.bind(stderr);
  const write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error) => void),
    maybeCallback?: (error?: Error) => void,
  ): boolean => {
    writer.write(chunk);
    if (typeof encodingOrCallback === "function") encodingOrCallback();
    else maybeCallback?.();
    return true;
  };
  stdout.write = write as typeof stdout.write;
  stderr.write = write as typeof stderr.write;
  const close = writer.close.bind(writer);
  writer.close = () => {
    stdout.write = originalStdout;
    stderr.write = originalStderr;
    close();
  };
  return writer;
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
    const leaseState = readStartLeaseState(paths);
    if (leaseState.state === "malformed") {
      throw new Error(`restore refused: unreadable cob start lease at ${paths.startLease}`);
    }
    if (leaseState.state === "valid" && isStartLeaseActive(leaseState.lease)) {
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
    for (const file of cobOwnedFiles(paths)) {
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
    // Locked-lane lease validation precedes the healthy-runtime early return:
    // a malformed lease must never be reconciled away or answered with
    // alreadyRunning.
    const leaseState = readStartLeaseState(paths);
    if (leaseState.state === "malformed") {
      throw new Error(`cob start refused: unreadable cob start lease at ${paths.startLease}`);
    }
    const existing = readRuntime(paths);
    if (existing && (await isHealthyRuntime(existing))) {
      // Reconcile before the early return: a lease matching the healthy
      // runtime's exact pid+nonce is either the live handoff window (launcher
      // still active; refuses) or the orphan of a launcher that died after
      // adoption (cleared under this lock). Any other lease survives.
      const orphanReconciled = await reconcileHealthyStartLease(paths, existing);
      if (orphanReconciled === "active") {
        throw new Error("cob start already in progress");
      }
      return { alreadyRunning: true, runtime: existing };
    }
    if (leaseState.state === "valid" && isStartLeaseActive(leaseState.lease)) {
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
    }
    // The child is only one of the rollback owners: a spawnServe failure
    // before any child exists must still restore the overlay snapshot.
    if (snapshot) {
      restoreOverlays(paths, snapshot, { preserveCatalogValidationFailure: true });
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
      if (!(await isHealthyRuntime(runtime)) || !existsSync(paths.catalog) || !existsSync(paths.profile)) {
        throw new Error("cob start commit lost the gateway before returning success");
      }
      // The lease stays in place until the last verification passes: if this
      // check fails, the lease is still the rollback ownership proof and
      // rollbackDetachedStart can claim it to restore the overlays.
      clearStartLease(paths);
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

/**
 * Classify a lease that claims a healthy runtime: "active" while the recorded
 * launcher is alive, "reconciled" when the launcher is gone and the child's
 * exact runtime identity is healthy, "foreign" for any non-matching lease.
 */
async function reconcileHealthyStartLease(
  paths: CobPaths,
  runtime: RuntimeState,
): Promise<"active" | "reconciled" | "foreign"> {
  const leaseState = readStartLeaseState(paths);
  if (leaseState.state !== "valid") return "foreign";
  const lease = leaseState.lease;
  if (lease.pid !== runtime.pid || lease.nonce !== runtime.nonce) return "foreign";
  if (
    lease.launcherPid !== undefined &&
    isLeaseProcessActive(lease.launcherPid, lease.launcherStartKey)
  ) {
    return "active";
  }
  if (!(await isHealthyRuntime(runtime))) return "foreign";
  clearStartLease(paths);
  return "reconciled";
}


function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
