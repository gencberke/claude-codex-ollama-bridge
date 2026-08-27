import { execFileSync } from "node:child_process";

const PS_TIMEOUT_MS = 500;

export type ProcessIdentity = "cob" | "foreign" | "unknown";

const COB_SUBCOMMAND = /(?:^|\s)(serve|start|sync|stop|restore|status|smoke)(?:\s|$)/;
const COB_BIN = /(?:^|[/\s])cob(?:\s|$)/;
const COB_BIN_WITH_ARGS = /(?:^|[/\s])cob\s/;

/**
 * Identify our CLI. A bare `node /tmp/cli.js` must not count as cob: stop/restore
 * would otherwise SIGTERM a PID-reused foreign process.
 */
export function isOurCobArgv(args: string): boolean {
  if (COB_BIN_WITH_ARGS.test(args) && COB_SUBCOMMAND.test(args)) return true;
  if (COB_BIN.test(args) && !args.includes(".js")) return true;
  if (!COB_SUBCOMMAND.test(args)) return false;
  if (args.includes("dist/cli.js")) return true;
  if (/codex-ollama-bridge[/\\].*cli\.js/.test(args)) return true;
  return false;
}

export function cobProcessIdentity(pid: number): ProcessIdentity {
  const args = readProcessArgs(pid);
  if (args === undefined) return "unknown";
  if (!args) return "unknown";
  return isOurCobArgv(args) ? "cob" : "foreign";
}

export function isCobProcess(pid: number): boolean {
  return cobProcessIdentity(pid) === "cob";
}

/** Only `serve` / `start` may receive SIGTERM/SIGKILL from stop/restore. */
export function isCobGatewayProcess(pid: number): boolean {
  const args = readProcessArgs(pid);
  if (!args) return false;
  return isOurCobArgv(args) && /(?:^|\s)(serve|start)(?:\s|$)/.test(args);
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: process exists but we cannot signal it. Treat as alive (fail-closed).
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Process birth identity from `ps -o lstart=`. Used to refuse SIGTERM/SIGKILL
 * when a recorded PID has been reused by a later process.
 */
export function processStartKey(pid: number): string | undefined {
  try {
    const lstart = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: PS_TIMEOUT_MS,
      killSignal: "SIGKILL",
      env: { ...process.env, LC_ALL: "C" },
    }).trim();
    return lstart.length > 0 ? lstart : undefined;
  } catch {
    return undefined;
  }
}

let cachedOwnStartKey: { value: string | undefined } | undefined;

/** Cached `ps` start key for this process. Avoids a `ps` spawn every lock retry. */
export function ownStartKey(): string | undefined {
  if (cachedOwnStartKey) return cachedOwnStartKey.value;
  const value = processStartKey(process.pid);
  cachedOwnStartKey = { value };
  return value;
}

export function isSameProcess(pid: number, startKey: string | undefined): boolean {
  if (!startKey) return false;
  const live = processStartKey(pid);
  if (!live) return false;
  return live === startKey;
}

function readProcessArgs(pid: number): string | undefined {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "args="], {
      encoding: "utf8",
      timeout: PS_TIMEOUT_MS,
      killSignal: "SIGKILL",
    }).trim();
  } catch {
    return undefined;
  }
}
