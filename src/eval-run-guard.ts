import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { idSha8 } from "./eval-receipt.js";

/**
 * Reusable isolated eval run guard (pack-excluded). Owns exactly one run id
 * created exclusively, allocates temp homes and closed loopback ports without
 * referencing live paths, tracks spawned child processes, snapshots the
 * resolved live ~/.codex hashes independently of environment overrides, and
 * proves cleanup exactly once in a finally path. Receipts carry run/artifact
 * hashes and aggregate outcomes only — never conversation content or raw ids.
 */

/** Minimal structural surface allocateClosedPort needs from its loopback server. */
export type EvalLoopbackServer = Pick<import("node:http").Server, "listen" | "close" | "address"> & import("node:events").EventEmitter;

export type EvalRunGuardOptions = {
  /** Stable evaluator label, e.g. "g24-child-run". */
  label: string;
  /** Explicit run id. A deliberate rerun must mint a new id; there is no force bypass. */
  runId: string;
  /** Optional private parent directory for the run lock and temp homes. */
  tmpRoot?: string;
  /**
   * Bounded wait for killed children to close before finalize fails closed.
   * Defaults to 10 seconds; test fixtures may shrink it.
   */
  childExitWaitMs?: number;
  /**
   * Test-only seam: factory for the loopback server used by
   * allocateClosedPort. Defaults to node:http's createServer.
   */
  serverFactory?: () => EvalLoopbackServer;
};

export type EvalLiveShaSnapshot = {
  configSha256: string | null;
  catalogSha256: string | null;
  catalogMetaSha256: string | null;
};

export type EvalCleanupProof = {
  stoppedProcesses: number;
  ports: number[];
  portClosed: boolean;
  homes: string[];
  homesRemoved: boolean;
  executed: boolean;
};

export function sha256FileOrNull(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

export function isLoopbackPortOpen(port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      resolve(true);
    });
  });
}

/**
 * Resolved live ~/.codex, independent of HOME/CODEX_HOME-style overrides:
 * the passwd-database home is preferred because os.homedir() honors a
 * overridden HOME, which would redirect the read-only snapshot. Hashed
 * read-only.
 */
export function resolveLiveCodexHome(): string {
  try {
    const info = userInfo();
    if (typeof info.homedir === "string" && info.homedir.length > 0) {
      return join(info.homedir, ".codex");
    }
  } catch {
    // passwd lookup unavailable; fall through to os.homedir()
  }
  return join(homedir(), ".codex");
}

export function liveHomeShaSnapshot(): EvalLiveShaSnapshot {
  const liveHome = resolveLiveCodexHome();
  return {
    configSha256: sha256FileOrNull(join(liveHome, "config.toml")),
    catalogSha256: sha256FileOrNull(join(liveHome, "cob-catalog.json")),
    catalogMetaSha256: sha256FileOrNull(join(liveHome, "cob-catalog.meta.json")),
  };
}

export class EvalRunGuard {
  readonly label: string;
  readonly runId: string;
  readonly lockPath: string;
  readonly tmpRoot: string;
  private readonly homes: string[] = [];
  private readonly ports: number[] = [];
  private readonly processes: ChildProcess[] = [];
  private readonly childExitWaitMs: number;
  private readonly serverFactory: () => EvalLoopbackServer;
  private finalizePromise: Promise<EvalCleanupProof> | undefined;

  constructor(opts: EvalRunGuardOptions) {
    this.label = opts.label;
    this.runId = opts.runId;
    this.tmpRoot = opts.tmpRoot ?? tmpdir();
    this.childExitWaitMs = opts.childExitWaitMs ?? 10_000;
    this.serverFactory = opts.serverFactory ?? createServer;
    const lockDir = join(this.tmpRoot, `cob-run-guard-${opts.label}`);
    mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    this.lockPath = join(lockDir, `${opts.runId}.lock`);
    // Exclusive creation fails a duplicate run id before Codex, cob, or any
    // model request starts. No force bypass exists.
    const fd = openSync(this.lockPath, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify({ label: opts.label, runId: opts.runId, pid: process.pid })}\n`);
    closeSync(fd);
  }

  allocateHome(prefix: string): string {
    const home = mkdtempSync(join(this.tmpRoot, prefix));
    this.homes.push(home);
    return home;
  }

  /**
   * Allocate a loopback port that is currently closed and remember it for the
   * cleanup proof. Never references a live or shared port. A listen failure
   * (for example EPERM in a restricted sandbox) rejects this promise; the
   * error handler below is what turns the server's async error event into a
   * rejection instead of an unhandled crash, and the server is always closed.
   */
  async allocateClosedPort(): Promise<number> {
    const server = this.serverFactory();
    // The port must be captured before the finally closes the server:
    // server.address() is null once the server is closed.
    let port = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          port = (server.address() as { port: number }).port;
          resolve();
        });
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (await isLoopbackPortOpen(port)) {
      throw new Error(`allocated loopback port ${port} is unexpectedly open`);
    }
    this.ports.push(port);
    return port;
  }

  registerProcess(child: ChildProcess): ChildProcess {
    this.processes.push(child);
    return child;
  }

  /** Register an externally managed port (for example a fixed isolated port) for the cleanup proof. */
  registerPort(port: number): void {
    this.ports.push(port);
  }

  /** Async child spawn so the parent can serve fake endpoints and observe cancellation. */
  spawnAsync(command: string, args: string[], options: import("node:child_process").SpawnOptions = {}): ChildProcess {
    return this.registerProcess(spawn(command, args, options));
  }

  /**
   * Stop only processes owned by this run (awaiting each child's exit after
   * the kill, bounded), prove every owned port closed, and remove only the
   * exact temp homes. Executed exactly once even under concurrent callers; a
   * second call replays the recorded result — the proof on success, the
   * rejection on failure — without touching the filesystem again. A failed
   * verification (a child still running after the bounded wait, a port still
   * open, a home left behind) throws after the state is recorded, so a
   * harness can never report success over an incomplete cleanup.
   */
  async finalize(): Promise<EvalCleanupProof> {
    if (!this.finalizePromise) {
      this.finalizePromise = this.runFinalize();
    }
    return this.finalizePromise;
  }

  private async runFinalize(): Promise<EvalCleanupProof> {
    let stoppedProcesses = 0;
    const killed: ChildProcess[] = [];
    for (const child of this.processes) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        stoppedProcesses += 1;
        killed.push(child);
      }
    }
    // Await child exit after the kill so the port/home proofs observe a
    // terminated child. The wait is bounded so a wedged child cannot hang
    // the harness; any child still running after the bound fails the proof.
    if (killed.length > 0) {
      const exited = Promise.all(
        killed.map((child) => new Promise<void>((resolve) => child.once("close", () => resolve()))),
      );
      const bounded = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.childExitWaitMs);
        timer.unref();
      });
      await Promise.race([exited, bounded]);
    }
    // Fail closed: a registered child that is still running after the
    // bounded wait means cleanup is unproven, even when it owns no port or
    // home that a later check would catch.
    const childrenRunning = this.processes.filter(
      (child) => child.exitCode === null && child.signalCode === null,
    ).length;
    const ownedPorts = [...new Set(this.ports)];
    const stillOpen: number[] = [];
    for (const port of ownedPorts) {
      if (await isLoopbackPortOpen(port)) stillOpen.push(port);
    }
    const ownedHomes = [...new Set(this.homes)];
    for (const home of ownedHomes) {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // Recorded via homesRemoved below; the harness must fail on it.
      }
    }
    const homesRemoved = ownedHomes.every((home) => !existsSync(home));
    const proof: EvalCleanupProof = {
      stoppedProcesses,
      ports: ownedPorts,
      portClosed: stillOpen.length === 0,
      homes: ownedHomes,
      homesRemoved,
      executed: true,
    };
    if (childrenRunning > 0 || !proof.portClosed || !proof.homesRemoved) {
      throw new Error(
        `eval run cleanup failed: label=${this.label} run_sha8=${idSha8(this.runId)} ` +
          `children_running=${childrenRunning} ports_open=${stillOpen.length} ` +
          `homes_remaining=${ownedHomes.filter((home) => existsSync(home)).length}`,
      );
    }
    return proof;
  }

  /** Content-free cleanup log line for evidence records: the run id is hashed. */
  formatCleanupProof(proof: EvalCleanupProof): string {
    return (
      `cleanup proof: label=${this.label} run_sha8=${idSha8(this.runId)} ` +
      `stopped_processes=${proof.stoppedProcesses} ports=${proof.ports.join(",") || "-"} ` +
      `port_closed=${proof.portClosed} homes_removed=${proof.homesRemoved}`
    );
  }
}

/** Content-free receipt fragment: run identity (hashed) plus aggregate outcomes. */
export function evalRunIdentity(receipt: {
  label: string;
  runId: string;
  artifactSha256?: string | null;
  corpusSha256?: string | null;
  outcome?: "pass" | "fail" | "inconclusive";
}): Record<string, unknown> {
  return {
    label: receipt.label,
    runIdSha8: idSha8(receipt.runId),
    artifactSha256: receipt.artifactSha256 ?? null,
    corpusSha256: receipt.corpusSha256 ?? null,
    outcome: receipt.outcome ?? "inconclusive",
  };
}
