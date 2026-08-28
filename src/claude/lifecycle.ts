import type { ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { CLAUDE_DEFAULT_PORT } from "./constants.js";
import { DEFAULT_OLLAMA_URL } from "../core/ollama/constants.js";
import { listenClaudeGateway } from "./gateway.js";
import { desktopOverlayStatus } from "./desktop-overlay.js";
import { userAgentsOverlayStatus } from "./user-agents.js";
import { removeOwnedClaudeAgents } from "./agents.js";
import { resolveClaudePaths, type ClaudePaths } from "./paths.js";
import { detectInstall } from "../core/install-detection.js";
import { acquireLock, adoptLock, heldLockToken, releaseLock, waitForLockAdopted } from "../core/lock.js";
import { isPidAlive, reapChild } from "../core/process-info.js";

export type ClaudeRuntime = {
  pid: number;
  port: number;
  ollamaUrl: string;
  startedAt: string;
  version: string;
  installKind: string;
};

export async function serveClaudeForeground(opts: {
  port?: number;
  ollamaUrl?: string;
  paths?: ClaudePaths;
}): Promise<void> {
  const paths = opts.paths ?? resolveClaudePaths();
  mkdirSync(paths.claudeHome, { recursive: true });
  const port = opts.port ?? CLAUDE_DEFAULT_PORT;
  const ollamaUrl = opts.ollamaUrl ?? DEFAULT_OLLAMA_URL;
  const existing = readClaudeRuntime(paths);
  if (existing && existing.pid !== process.pid && isPidAlive(existing.pid) && (await isClaudeHealthy(existing.port))) {
    throw new Error(`cob claude already running on 127.0.0.1:${existing.port} (pid ${existing.pid})`);
  }
  if (existing && !isPidAlive(existing.pid)) {
    unlinkIfExists(paths.pid);
    unlinkIfExists(paths.runtime);
  }

  const handoffToken = process.env.COB_LOCK_TOKEN;
  const boot = async (): Promise<import("node:http").Server> => {
    const server = await listenClaudeGateway({ port, ollamaUrl });
    const install = detectInstall();
    writeClaudeRuntime(paths, {
      pid: process.pid,
      port,
      ollamaUrl,
      startedAt: new Date().toISOString(),
      version: install.version,
      installKind: install.kind,
    });
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
  spawnServe: (input: { token: string }) => ChildProcess;
}): Promise<{ alreadyRunning: boolean; runtime: ClaudeRuntime }> {
  mkdirSync(opts.paths.claudeHome, { recursive: true });
  await acquireLock(opts.paths.lock);
  let child: ChildProcess | undefined;
  try {
    const existing = readClaudeRuntime(opts.paths);
    if (existing && isPidAlive(existing.pid) && (await isClaudeHealthy(existing.port))) {
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
  try {
    const runtime = await waitForClaudeRuntime(opts.paths, { pid: childPid, port: opts.port });
    await acquireLock(opts.paths.lock);
    try {
      const current = readClaudeRuntime(opts.paths);
      if (!current || current.pid !== childPid || current.port !== runtime.port) {
        throw new Error("cob claude start lost its gateway runtime before commit");
      }
      if (!isPidAlive(childPid) || !(await isClaudeHealthy(current.port))) {
        throw new Error("cob claude start commit failed the health check");
      }
    } finally {
      releaseLock(opts.paths.lock);
    }
    return { alreadyRunning: false, runtime };
  } catch (error) {
    await removeClaudeChildRuntime(opts.paths, childPid);
    throw error;
  }
}

export async function stopClaudeGateway(
  paths: ClaudePaths,
  opts: { locked?: boolean } = {},
): Promise<boolean> {
  const stopLocked = async (): Promise<boolean> => {
    const runtime = readClaudeRuntime(paths);
    if (!runtime) return false;
    if (isPidAlive(runtime.pid)) {
      try {
        process.kill(runtime.pid, "SIGTERM");
      } catch {
        // already gone
      }
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && isPidAlive(runtime.pid)) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (isPidAlive(runtime.pid)) {
        try {
          process.kill(runtime.pid, "SIGKILL");
        } catch {
          // ignore
        }
      }
    }
    unlinkIfExists(paths.pid);
    unlinkIfExists(paths.runtime);
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

export function restoreClaudeSurface(paths: ClaudePaths): void {
  unlinkIfExists(paths.pid);
  unlinkIfExists(paths.runtime);
  unlinkIfExists(paths.log);
  unlinkIfExists(paths.lock);
  removeOwnedClaudeAgents(paths);
}

export async function claudeStatusReport(paths: ClaudePaths): Promise<{ ok: boolean; text: string }> {
  const runtime = readClaudeRuntime(paths);
  if (!runtime) {
    return { ok: false, text: "cob claude: absent\nno cob-owned Claude runtime in this home" };
  }
  const alive = isPidAlive(runtime.pid);
  const healthy = alive && (await isClaudeHealthy(runtime.port));
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

export function readClaudeRuntime(paths: ClaudePaths): ClaudeRuntime | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(paths.runtime, "utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    const record = parsed as Partial<ClaudeRuntime>;
    if (typeof record.pid !== "number" || typeof record.port !== "number") return undefined;
    return {
      pid: record.pid,
      port: record.port,
      ollamaUrl: typeof record.ollamaUrl === "string" ? record.ollamaUrl : DEFAULT_OLLAMA_URL,
      startedAt: typeof record.startedAt === "string" ? record.startedAt : "",
      version: typeof record.version === "string" ? record.version : "",
      installKind: typeof record.installKind === "string" ? record.installKind : "",
    };
  } catch {
    return undefined;
  }
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

async function waitForClaudeRuntime(
  paths: ClaudePaths,
  expected: { pid: number; port: number },
): Promise<ClaudeRuntime> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const runtime = readClaudeRuntime(paths);
    if (runtime) {
      if (runtime.pid !== expected.pid && isPidAlive(runtime.pid)) {
        throw new Error(
          `cob claude start found a foreign gateway runtime (pid ${runtime.pid}, expected ${expected.pid})`,
        );
      }
      const portMatches = expected.port <= 0 || runtime.port === expected.port;
      if (runtime.pid === expected.pid && portMatches && isPidAlive(runtime.pid) && (await isClaudeHealthy(runtime.port))) {
        return runtime;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`cob claude did not become healthy on 127.0.0.1:${expected.port}`);
}

/** Removes only the runtime/pid files that still belong to the failed start's own child. */
async function removeClaudeChildRuntime(paths: ClaudePaths, childPid: number): Promise<void> {
  if (isPidAlive(childPid)) {
    try {
      process.kill(childPid, "SIGTERM");
    } catch {
      // already gone
    }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && isPidAlive(childPid)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (isPidAlive(childPid)) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  }
  const runtime = readClaudeRuntime(paths);
  if (!runtime || runtime.pid === childPid) {
    unlinkIfExists(paths.pid);
    unlinkIfExists(paths.runtime);
  }
}

async function isClaudeHealthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return Boolean(body && typeof body === "object" && (body as { surface?: unknown }).surface === "claude");
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
