import type { IncomingMessage } from "node:http";
import { connect } from "node:net";
import { DEFAULT_OLLAMA_URL } from "../../core/ollama/constants.js";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../core/atomic.js";
import { isRecord } from "../../core/json.js";
import { cobProcessIdentity, isCobGatewayProcess, isPidAlive, isSameProcess } from "../../core/process-info.js";
import { DEFAULT_PORT } from "../constants.js";
import { HEALTH_FETCH_TIMEOUT_MS, START_HEALTH_DEADLINE_MS } from "../limits.js";
import type { CompactionPolicy } from "../config/schema.js";
import type { CobPaths } from "../paths.js";
import { resolvePaths } from "../paths.js";

/**
 * Codex runtime file, pid/nonce identity, and health probing primitives.
 */

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

export async function runtimeStillServing(runtime: RuntimeState): Promise<boolean> {
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

export async function fetchHealthz(
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

export function isCobHealth(body: unknown): boolean {
  return Boolean(isRecord(body) && body.service === "cob");
}

export function healthNonceOk(body: unknown): boolean {
  return Boolean(isRecord(body) && body.nonce_ok === true);
}

export function healthPid(body: unknown): number | undefined {
  return isRecord(body) && typeof body.pid === "number" ? body.pid : undefined;
}

export function isOurGatewayPid(runtime: RuntimeState): boolean {
  if (!isCobGatewayProcess(runtime.pid)) return false;
  if (!runtime.startKey) return false;
  return isSameProcess(runtime.pid, runtime.startKey);
}

export function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (!isPidAlive(pid)) return;
      await sleep(50);
    }
  })();
}

export function waitForPortClosed(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (!(await isPortOpen(port))) return true;
      await sleep(50);
    }
    return !(await isPortOpen(port));
  })();
}

export function isPortOpen(port: number): Promise<boolean> {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
