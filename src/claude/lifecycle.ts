import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { CLAUDE_DEFAULT_PORT } from "./constants.js";
import { DEFAULT_OLLAMA_URL } from "../core/ollama/constants.js";
import { listenClaudeGateway } from "./gateway.js";
import { desktopOverlayStatus, restoreClaudeDesktopOverlay } from "./desktop-overlay.js";
import { restoreUserClaudeAgentsOverlay, userAgentsOverlayStatus } from "./user-agents.js";
import { removeOwnedClaudeAgents } from "./agents.js";
import { resolveClaudePaths, type ClaudePaths } from "./paths.js";
import { detectInstall } from "../core/install-detection.js";
import { acquireLock, adoptLock, heldLockToken, releaseLock, waitForLockAdopted } from "../core/lock.js";
import { isCobGatewayProcess, isPidAlive, isSameProcess, ownStartKey, reapChild } from "../core/process-info.js";
import { writeFileAtomic } from "../core/atomic.js";

export type ClaudeRuntime = {
  pid: number;
  port: number;
  ollamaUrl: string;
  startedAt: string;
  version: string;
  installKind: string;
  nonce: string;
  startKey?: string;
};

export class ClaudeStopRefusedError extends Error {
  readonly code = "claude_stop_refused";
  constructor(message: string) {
    super(message);
    this.name = "ClaudeStopRefusedError";
  }
}

function stopRefusedOwnership(pid: number): ClaudeStopRefusedError {
  return new ClaudeStopRefusedError(
    `cob claude stop refused: runtime pid ${pid} could not be proven to be this home's cob claude gateway; no signal was sent and cob-owned state was kept`,
  );
}

function stopRefusedState(): ClaudeStopRefusedError {
  return new ClaudeStopRefusedError(
    "cob claude stop refused: runtime state is present but unreadable or invalid; no signal was sent and cob-owned state was kept",
  );
}

const SHUTDOWN_WAIT_MS = 5_000;
const SIGNAL_WAIT_MS = 5_000;
const KILL_WAIT_MS = 2_000;

export async function serveClaudeForeground(opts: {
  port?: number;
  ollamaUrl?: string;
  paths?: ClaudePaths;
  /** Runs after the gateway is bound and the runtime is committed, still inside the lifecycle lock. */
  onBooted?: () => void;
}): Promise<void> {
  const paths = opts.paths ?? resolveClaudePaths();
  mkdirSync(paths.claudeHome, { recursive: true });
  const port = opts.port ?? CLAUDE_DEFAULT_PORT;
  const ollamaUrl = opts.ollamaUrl ?? DEFAULT_OLLAMA_URL;

  const handoffToken = process.env.COB_LOCK_TOKEN;
  // The whole runtime decision — validation, stale cleanup, bind, and the
  // runtime write — happens inside the locked boot section, so two concurrent
  // foreground starts or a foreground/restore race cannot decide stale.
  const boot = async (): Promise<import("node:http").Server> => {
    const existingState = readClaudeRuntimeState(paths);
    if (existingState.kind === "invalid") {
      throw new Error(
        "cob claude start refused: runtime state is present but unreadable or invalid; refusing to bind over an unverifiable gateway",
      );
    }
    const existing = existingState.kind === "valid" ? existingState.runtime : undefined;
    if (existing && existing.pid !== process.pid && isPidAlive(existing.pid)) {
      if (await isClaudeHealthy(existing.port, { pid: existing.pid, nonce: existing.nonce })) {
        throw new Error(`cob claude already running on 127.0.0.1:${existing.port} (pid ${existing.pid})`);
      }
      // Alive but not verifiably healthy: stop it with the safe locked primitive
      // or refuse the start (fail closed). Never bind over a live runtime.
      await stopClaudeGateway(paths, { locked: true });
    }
    if (existing && !isPidAlive(existing.pid)) {
      unlinkIfExists(paths.pid);
      unlinkIfExists(paths.runtime);
    }
    const desktopToken = ensureClaudeDesktopToken(paths);
    const nonce = randomBytes(16).toString("hex");
    const server = await listenClaudeGateway({ port, ollamaUrl, desktopToken, healthNonce: nonce });
    const install = detectInstall();
    writeClaudeRuntime(paths, {
      pid: process.pid,
      port,
      ollamaUrl,
      startedAt: new Date().toISOString(),
      version: install.version,
      installKind: install.kind,
      nonce,
      startKey: ownStartKey(),
    });
    if (opts.onBooted) {
      try {
        opts.onBooted();
      } catch (error) {
        server.close(() => undefined);
        throw error;
      }
    }
    return server;
  };

  let server: import("node:http").Server;
  if (handoffToken) {
    adoptLock(paths.lock, handoffToken);
    try {
      server = await boot();
    } finally {
      releaseLock(paths.lock);
    }
  } else {
    await acquireLock(paths.lock);
    try {
      server = await boot();
    } finally {
      releaseLock(paths.lock);
    }
  }

  await new Promise<void>((resolve, reject) => {
    const shutdown = (): void => {
      server.close(() => resolve());
    };
    server.once("error", reject);
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  });
}

export async function startClaudeGatewayDetached(opts: {
  paths: ClaudePaths;
  port: number;
  ollamaUrl: string;
  /** Mutating preparation (agents, token, anything else) runs inside the first locked section. */
  prepare?: () => void | Promise<void>;
  /**
   * Overlay/public mutations run inside the final locked commit section, after
   * the child's runtime identity and health have been re-verified. A commit
   * failure rolls the started child back.
   */
  commit?: (runtime: ClaudeRuntime) => void | Promise<void>;
  /** Wait budget for the final commit lock; defaults to the shared lock timeout. */
  commitLockTimeoutMs?: number;
  spawnServe: (input: { token: string }) => ChildProcess;
}): Promise<{ alreadyRunning: boolean; runtime: ClaudeRuntime }> {
  mkdirSync(opts.paths.claudeHome, { recursive: true });
  await acquireLock(opts.paths.lock);
  let child: ChildProcess | undefined;
  try {
    const existingState = readClaudeRuntimeState(opts.paths);
    if (existingState.kind === "invalid") {
      throw new Error(
        "cob claude start refused: runtime state is present but unreadable or invalid; resolve or restore it first",
      );
    }
    // Prepare only mutates state once the start is admissible.
    await opts.prepare?.();
    const existing = existingState.kind === "valid" ? existingState.runtime : undefined;
    if (existing && isPidAlive(existing.pid) && (await isClaudeHealthy(existing.port, { pid: existing.pid, nonce: existing.nonce }))) {
      await opts.commit?.(existing);
      return { alreadyRunning: true, runtime: existing };
    }
    if (existing) {
      await stopClaudeGateway(opts.paths, { locked: true });
    }
    const token = heldLockToken(opts.paths.lock);
    if (!token) {
      throw new Error("internal error: missing cob claude lock token");
    }
    child = opts.spawnServe({ token });
    if (child.pid === undefined) {
      throw new Error("failed to spawn cob claude serve");
    }
    await waitForLockAdopted(opts.paths.lock, token, child.pid);
  } catch (error) {
    if (child) {
      await reapChild(child);
    }
    throw error;
  } finally {
    releaseLock(opts.paths.lock);
  }
  if (!child) {
    throw new Error("internal error: detached claude start lost the child process");
  }
  child.unref();
  const childPid = child.pid;
  let runtime: ClaudeRuntime;
  try {
    runtime = await waitForClaudeRuntime(opts.paths, { pid: childPid, port: opts.port });
  } catch (error) {
    // The child is ours by direct parentage; a failed wait must not leak it.
    await reapChild(child);
    throw error;
  }
  // Verify, commit, and — on any failure — roll back while still holding the
  // lifecycle lock, so a concurrent start can never adopt the doomed child.
  await commitStartedGateway(opts.paths, child, childPid, runtime, opts.commit, opts.commitLockTimeoutMs);
  return { alreadyRunning: false, runtime };
}

/**
 * Final locked commit section of a detached start. The child's runtime identity
 * and health are re-verified under the lock; the operation's commit hook runs
 * there. Any failure rolls the started child back under the same lock before it
 * is released. Exported for the start-transaction regression suite.
 */
export async function commitStartedGateway(
  paths: ClaudePaths,
  child: ChildProcess,
  childPid: number,
  runtime: ClaudeRuntime,
  commit?: (runtime: ClaudeRuntime) => void | Promise<void>,
  lockTimeoutMs?: number,
): Promise<void> {
  try {
    await acquireLock(paths.lock, lockTimeoutMs);
  } catch (error) {
    // Health is not adoption evidence: without the lock we cannot prove who
    // owns the running child, so reaping on a failed health check would race
    // the lock holder and trusting health would misclassify adoption. Fail
    // closed: no signals, no state changes, an explicitly resolvable report.
    const reason = error instanceof Error ? error.message : String(error);
    const observed = readClaudeRuntimeState(paths).kind;
    throw new Error(
      `cob claude start could not take the lifecycle lock for its commit; the result is indeterminate (observed runtime: ${observed}) and the gateway was left untouched: no signal was sent and no state was changed. Check "cob claude status", then retry start or run stop to resolve (${reason})`,
    );
  }
  let failure: unknown;
  try {
    try {
      const state = readClaudeRuntimeState(paths);
      const current = state.kind === "valid" ? state.runtime : undefined;
      if (!current || current.pid !== childPid || current.port !== runtime.port || current.nonce !== runtime.nonce) {
        throw new Error("cob claude start lost its gateway runtime before commit");
      }
      if (!isPidAlive(childPid) || !(await isClaudeHealthy(current.port, { pid: current.pid, nonce: current.nonce }))) {
        throw new Error("cob claude start commit failed the health check");
      }
      await commit?.(current);
      return;
    } catch (error) {
      failure = error;
    }
    try {
      await rollbackStartedGateway(paths, child, { pid: childPid, nonce: runtime.nonce });
    } catch (rollbackError) {
      const first = failure instanceof Error ? failure.message : String(failure);
      const second = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new Error(`cob claude start commit failed (${first}); rollback also failed: ${second}`);
    }
    throw failure;
  } finally {
    releaseLock(paths.lock);
  }
}

/**
 * Rolls back this start's own child. The state files are only touched when
 * they still describe the started gateway (pid + nonce); a foreign or absent
 * state gets none of them, and only the directly-owned child process is
 * reaped. A present-but-invalid state refuses the whole rollback (fail closed).
 */
async function rollbackStartedGateway(
  paths: ClaudePaths,
  child: ChildProcess,
  owned: { pid: number; nonce: string },
): Promise<void> {
  const state = readClaudeRuntimeState(paths);
  if (state.kind === "invalid") {
    throw new Error(
      "cob claude start rollback refused: runtime state is present but unreadable or invalid; cob-owned state was kept",
    );
  }
  if (state.kind === "absent") {
    await reapChild(child);
    return;
  }
  if (state.runtime.pid !== owned.pid || state.runtime.nonce !== owned.nonce) {
    await reapChild(child);
    return;
  }
  await stopClaudeGateway(paths, { locked: true });
}

export async function stopClaudeGateway(
  paths: ClaudePaths,
  opts: { locked?: boolean } = {},
): Promise<boolean> {
  const stopLocked = async (): Promise<boolean> => {
    const state = readClaudeRuntimeState(paths);
    if (state.kind === "absent") return false;
    if (state.kind === "invalid") throw stopRefusedState();
    const runtime = state.runtime;
    const requested = await requestAuthenticatedShutdown(runtime);
    if (requested) {
      await waitUntilDead(runtime.pid, SHUTDOWN_WAIT_MS);
    }
    if (isPidAlive(runtime.pid)) {
      if (!isOurClaudeGatewayPid(runtime)) throw stopRefusedOwnership(runtime.pid);
      try {
        process.kill(runtime.pid, "SIGTERM");
      } catch {
        // already gone
      }
      await waitUntilDead(runtime.pid, SIGNAL_WAIT_MS);
      if (isPidAlive(runtime.pid)) {
        // The pid may have been reused while we waited; prove identity again.
        if (!isOurClaudeGatewayPid(runtime)) throw stopRefusedOwnership(runtime.pid);
        try {
          process.kill(runtime.pid, "SIGKILL");
        } catch {
          // ignore
        }
        await waitUntilDead(runtime.pid, KILL_WAIT_MS);
        if (isPidAlive(runtime.pid)) {
          throw new ClaudeStopRefusedError(
            `cob claude stop could not confirm gateway exit (pid ${runtime.pid}); cob-owned state was kept`,
          );
        }
      }
    }
    const current = readClaudeRuntimeState(paths);
    if (current.kind === "absent") {
      unlinkIfExists(paths.pid);
      unlinkIfExists(paths.runtime);
    } else if (
      current.kind === "valid" &&
      current.runtime.pid === runtime.pid &&
      current.runtime.nonce === runtime.nonce
    ) {
      unlinkIfExists(paths.pid);
      unlinkIfExists(paths.runtime);
    }
    return true;
  };
  if (opts.locked) return stopLocked();
  await acquireLock(paths.lock);
  try {
    return await stopLocked();
  } finally {
    releaseLock(paths.lock);
  }
}

async function waitUntilDead(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isPidAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Restore is one locked transaction: stop under the held lock, clean cob-owned
 * surface files, restore overlays, then release. The lock file itself is only
 * ever removed by releaseLock, never by the cleanup helpers.
 */
export async function restoreClaudeGateway(paths: ClaudePaths): Promise<{
  stopped: boolean;
  agentsRestored: boolean;
  desktopRestored: boolean;
}> {
  await acquireLock(paths.lock);
  try {
    const stopped = await stopClaudeGateway(paths, { locked: true });
    // Revalidate before any cleanup: state may have been replaced or corrupted
    // externally while we stopped, and a live gateway must never be orphaned.
    const after = readClaudeRuntimeState(paths);
    if (after.kind === "invalid") {
      throw new Error(
        "cob claude restore refused: runtime state is unreadable or invalid after stop; cob-owned state was kept",
      );
    }
    if (after.kind === "valid" && isPidAlive(after.runtime.pid)) {
      throw new Error(
        `cob claude restore refused: a live gateway (pid ${after.runtime.pid}) appeared during restore; cob-owned state was kept`,
      );
    }
    restoreClaudeSurface(paths);
    const agentsRestored = restoreUserClaudeAgentsOverlay({ overlayDir: paths.desktopOverlay });
    const desktopRestored = restoreClaudeDesktopOverlay({ overlayDir: paths.desktopOverlay });
    return { stopped, agentsRestored, desktopRestored };
  } finally {
    releaseLock(paths.lock);
  }
}

export function restoreClaudeSurface(paths: ClaudePaths): void {
  unlinkIfExists(paths.pid);
  unlinkIfExists(paths.runtime);
  unlinkIfExists(paths.log);
  unlinkIfExists(paths.desktopToken);
  removeOwnedClaudeAgents(paths);
}

export async function claudeStatusReport(paths: ClaudePaths): Promise<{ ok: boolean; text: string }> {
  const state = readClaudeRuntimeState(paths);
  if (state.kind === "absent") {
    return { ok: false, text: "cob claude: absent\nno cob-owned Claude runtime in this home" };
  }
  if (state.kind === "invalid") {
    return {
      ok: false,
      text: "cob claude: broken\nruntime state is present but unreadable or invalid; stop/restore refuse to act on it",
    };
  }
  const runtime = state.runtime;
  const alive = isPidAlive(runtime.pid);
  const healthy = alive && (await isClaudeHealthy(runtime.port, { pid: runtime.pid, nonce: runtime.nonce }));
  if (healthy) {
    const overlay = desktopOverlayStatus(paths.desktopOverlay);
    const agents = userAgentsOverlayStatus(paths.desktopOverlay);
    return {
      ok: true,
      text: `cob claude: ok\npid ${runtime.pid} on 127.0.0.1:${runtime.port}\nhome ${paths.claudeHome}\n${overlay.text}\n${agents.text}`,
    };
  }
  return {
    ok: false,
    text: `cob claude: broken\npid ${runtime.pid} alive=${alive} on 127.0.0.1:${runtime.port}`,
  };
}

export type ClaudeRuntimeState =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "valid"; runtime: ClaudeRuntime };

/**
 * Distinguishes a missing runtime from one that exists but cannot be trusted.
 * Stop/restore fail closed on "invalid": a live gateway with corrupt state must
 * not lose its ownership proof or have its state deleted underneath it.
 */
export function readClaudeRuntimeState(paths: ClaudePaths): ClaudeRuntimeState {
  let bytes: Buffer;
  try {
    bytes = readFileSync(paths.runtime);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // A lone pid sidecar without runtime state is inconsistent, not absent:
      // refusing keeps the ownership proof for a possibly live gateway.
      try {
        readFileSync(paths.pid);
        return { kind: "invalid" };
      } catch (sidecarError) {
        if ((sidecarError as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
        return { kind: "invalid" };
      }
    }
    return { kind: "invalid" };
  }
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object") return { kind: "invalid" };
    const record = parsed as Partial<ClaudeRuntime>;
    const pid = record.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return { kind: "invalid" };
    const port = record.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      return { kind: "invalid" };
    }
    if (typeof record.nonce !== "string" || record.nonce.length === 0) return { kind: "invalid" };
    const runtime: ClaudeRuntime = {
      pid,
      port,
      ollamaUrl: typeof record.ollamaUrl === "string" ? record.ollamaUrl : DEFAULT_OLLAMA_URL,
      startedAt: typeof record.startedAt === "string" ? record.startedAt : "",
      version: typeof record.version === "string" ? record.version : "",
      installKind: typeof record.installKind === "string" ? record.installKind : "",
      nonce: record.nonce,
      startKey: typeof record.startKey === "string" && record.startKey.length > 0 ? record.startKey : undefined,
    };
    // The pid sidecar must exist and agree with the runtime record.
    const sidecarRaw = readFileSync(paths.pid, "utf8").trim();
    const sidecarPid = Number(sidecarRaw);
    if (!Number.isInteger(sidecarPid) || sidecarPid <= 0 || sidecarPid !== pid) {
      return { kind: "invalid" };
    }
    return { kind: "valid", runtime };
  } catch {
    return { kind: "invalid" };
  }
}

export function readClaudeRuntime(paths: ClaudePaths): ClaudeRuntime | undefined {
  const state = readClaudeRuntimeState(paths);
  return state.kind === "valid" ? state.runtime : undefined;
}

function writeClaudeRuntime(paths: ClaudePaths, runtime: ClaudeRuntime): void {
  writeFileSync(paths.runtime, `${JSON.stringify(runtime, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(paths.pid, `${runtime.pid}\n`, { mode: 0o600 });
  try {
    chmodSync(paths.runtime, 0o600);
    chmodSync(paths.pid, 0o600);
  } catch {
    // best-effort
  }
}

/**
 * Reads or creates the per-install 256-bit Desktop gateway token. The token is
 * the only credential that lets a local client reach the Claude Code keychain
 * through cob; it lives in a cob-owned 0600 regular file inside the cob claude
 * home. The file is opened O_NOFOLLOW|O_NONBLOCK (a FIFO can never block the
 * open) and verified by fstat (regular file, no hardlinks, no special mode
 * bits) before its bytes are trusted; mode enforcement happens on the same
 * verified fd with fchmod, so there is no path TOCTOU window.
 */
export function ensureClaudeDesktopToken(paths: ClaudePaths): string {
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const nonBlock = typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0;
  let fd: number | undefined;
  try {
    try {
      fd = openSync(paths.desktopToken, fsConstants.O_RDONLY | noFollow | nonBlock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        fd = undefined;
      } else if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new Error(tokenPathRefusal());
      } else {
        throw error;
      }
    }
    if (fd !== undefined) {
      const st = fstatSync(fd);
      // POSIX special bits: S_ISUID 0o4000, S_ISGID 0o2000, S_ISVTX 0o1000.
      const specialBits = 0o4000 | 0o2000 | 0o1000;
      if (!st.isFile() || st.nlink > 1 || (st.mode & specialBits) !== 0) {
        throw new Error(tokenPathRefusal());
      }
      const content = readFileSync(fd, "utf8").trim();
      if (/^[0-9a-f]{64}$/.test(content)) {
        if ((st.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
        return content;
      }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const token = randomBytes(32).toString("hex");
  writeFileAtomic(paths.desktopToken, `${token}\n`, 0o600);
  return token;
}

function tokenPathRefusal(): string {
  return "cob claude refused the desktop gateway token path: it is not a private regular file; remove it and run cob claude start again";
}

async function waitForClaudeRuntime(
  paths: ClaudePaths,
  expected: { pid: number; port: number },
): Promise<ClaudeRuntime> {
  const deadline = Date.now() + 10_000;
  let sawInvalid = false;
  while (Date.now() < deadline) {
    const state = readClaudeRuntimeState(paths);
    if (state.kind === "valid") {
      sawInvalid = false;
      const runtime = state.runtime;
      if (runtime.pid !== expected.pid && isPidAlive(runtime.pid)) {
        throw new Error(
          `cob claude start found a foreign gateway runtime (pid ${runtime.pid}, expected ${expected.pid})`,
        );
      }
      const portMatches = expected.port <= 0 || runtime.port === expected.port;
      if (
        runtime.pid === expected.pid &&
        portMatches &&
        isPidAlive(runtime.pid) &&
        (await isClaudeHealthy(runtime.port, { pid: runtime.pid, nonce: runtime.nonce }))
      ) {
        return runtime;
      }
    } else if (state.kind === "invalid") {
      sawInvalid = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    sawInvalid
      ? `cob claude did not become healthy on 127.0.0.1:${expected.port}; runtime state was present but unreadable or invalid`
      : `cob claude did not become healthy on 127.0.0.1:${expected.port}`,
  );
}

async function requestAuthenticatedShutdown(runtime: ClaudeRuntime): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/cob/shutdown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce: runtime.nonce }),
      signal: AbortSignal.timeout(1_500),
    });
    void response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    // The gateway may already be gone; ownership below decides what happens.
    return false;
  }
}

function isOurClaudeGatewayPid(runtime: ClaudeRuntime): boolean {
  return isCobGatewayProcess(runtime.pid) && isSameProcess(runtime.pid, runtime.startKey);
}

/** Health is bound to the runtime identity: a spoofed listener on the port is not healthy. */
export async function isClaudeHealthy(
  port: number,
  expected: { pid: number; nonce: string },
): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { "x-cob-nonce": expected.nonce },
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    if (!body || typeof body !== "object") return false;
    const record = body as { surface?: unknown; pid?: unknown; nonce_ok?: unknown };
    if (record.surface !== "claude") return false;
    if (record.pid !== expected.pid) return false;
    if (record.nonce_ok !== true) return false;
    return true;
  } catch {
    return false;
  }
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // missing is fine
  }
}

export function openClaudeLog(paths: ClaudePaths): number {
  mkdirSync(paths.claudeHome, { recursive: true });
  const fd = openSync(paths.log, "a", 0o600);
  try {
    chmodSync(paths.log, 0o600);
  } catch {
    // best-effort
  }
  return fd;
}
