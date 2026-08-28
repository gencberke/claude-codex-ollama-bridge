import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { resolveClaudePaths, type ClaudePaths } from "./claude/paths.js";
import {
  commitStartedGateway,
  ensureClaudeDesktopToken,
  readClaudeRuntime,
  readClaudeRuntimeState,
  restoreClaudeGateway,
  restoreClaudeSurface,
  serveClaudeForeground,
  startClaudeGatewayDetached,
  stopClaudeGateway,
  type ClaudeRuntime,
} from "./claude/lifecycle.js";
import { isPidAlive, ownStartKey, processStartKey, reapChild } from "./core/process-info.js";
import { acquireLock, peekLockRecord, releaseLock } from "./core/lock.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runtime fixtures must keep the pid sidecar consistent with the runtime record. */
function writeRuntimeFixture(paths: ClaudePaths, record: Record<string, unknown>): void {
  mkdirSync(paths.claudeHome, { recursive: true });
  writeFileSync(paths.runtime, `${JSON.stringify(record)}\n`);
  if (typeof record.pid === "number" && Number.isInteger(record.pid) && (record.pid as number) > 0) {
    writeFileSync(paths.pid, `${record.pid}\n`);
  }
}

async function waitChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await sleep(25);
  }
  assert.ok(child.exitCode !== null || child.signalCode !== null, "child must exit");
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid;
}

function spawnFakeClaudeServe(
  root: string,
  opts: { token: string; mode?: string; adoptDelayMs?: number; foreignPid?: number },
): ChildProcess {
  const markers = join(root, "markers");
  const script = join(root, `fake-claude-serve-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  const dist = dirname(fileURLToPath(import.meta.url));
  const lockUrl = pathToFileURL(join(dist, "core", "lock.js")).href;
  const pathsUrl = pathToFileURL(join(dist, "claude", "paths.js")).href;
  writeFileSync(
    script,
    `import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adoptLock, releaseLock } from ${JSON.stringify(lockUrl)};
import { resolveClaudePaths } from ${JSON.stringify(pathsUrl)};
const markers = ${JSON.stringify(markers)};
mkdirSync(markers, { recursive: true });
const paths = resolveClaudePaths(process.env.COB_CLAUDE_HOME);
if (process.env.COB_FAKE_CLAUDE_MODE === "exit-before-adopt") process.exit(1);
writeFileSync(join(markers, "adopting"), "");
const delay = Number(process.env.COB_FAKE_CLAUDE_ADOPT_DELAY_MS ?? "0");
if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
const mode = process.env.COB_FAKE_CLAUDE_MODE ?? "";
if (mode !== "unpublish" && mode !== "skip-adopt") {
  adoptLock(paths.lock, process.env.COB_LOCK_TOKEN ?? "");
  writeFileSync(join(markers, "adopted"), "");
  releaseLock(paths.lock);
}
const nonce = randomBytes(8).toString("hex");
let runtimePid = process.pid;
let port = 0;
const server = createServer((req, res) => {
  const respond = (status, body) => {
    res.setHeader("content-type", "application/json");
    res.writeHead(status);
    res.end(JSON.stringify(body));
  };
  if (req.method === "POST" && req.url === "/cob/shutdown") {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try {
        const body = JSON.parse(raw || "{}");
        if (body.nonce === nonce) {
          respond(200, { ok: true });
          setTimeout(() => process.exit(0), 20);
          return;
        }
      } catch {}
      respond(403, { error: "nonce rejected" });
      return;
    });
    return;
  }
  const presented = req.headers["x-cob-nonce"];
  respond(200, { ok: true, surface: "claude", pid: runtimePid, nonce_ok: presented === nonce });
});
await new Promise((resolve, reject) => {
  server.listen(0, "127.0.0.1", () => resolve(undefined));
  server.on("error", reject);
});
port = server.address().port;
runtimePid = Number(process.env.COB_FAKE_CLAUDE_FOREIGN_PID) || process.pid;
if (mode !== "unpublish") {
  writeFileSync(paths.runtime, JSON.stringify({
    pid: runtimePid,
    port,
    ollamaUrl: "http://127.0.0.1:1",
    startedAt: new Date().toISOString(),
    version: "test",
    installKind: "test",
    nonce,
  }));
  writeFileSync(paths.pid, String(runtimePid));
}
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
`,
  );
  return spawn(process.execPath, [script], {
    env: {
      ...process.env,
      COB_CLAUDE_HOME: join(root, ".claude-cob"),
      COB_LOCK_TOKEN: opts.token,
      COB_FAKE_CLAUDE_MODE: opts.mode ?? "",
      COB_FAKE_CLAUDE_ADOPT_DELAY_MS: String(opts.adoptDelayMs ?? 0),
      COB_FAKE_CLAUDE_FOREIGN_PID: opts.foreignPid ? String(opts.foreignPid) : "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("cob claude lifecycle", () => {
  it("refuses to signal non-positive or non-integer pids", () => {
    assert.equal(isPidAlive(0), false);
    assert.equal(isPidAlive(-1), false);
    assert.equal(isPidAlive(1.5), false);
    assert.equal(isPidAlive(Number.NaN), false);
    assert.equal(isPidAlive(Number.POSITIVE_INFINITY), false);
  });

  it("parses only a fully identified runtime", () => {
    const root = tempDir("cob-claude-runtime-parse-");
    try {
      const paths = resolveClaudePaths(join(root, ".claude-cob"));
      const cases: Array<[Record<string, unknown>, boolean]> = [
        [{ pid: 0, port: 1, nonce: "n" }, false],
        [{ pid: -1, port: 1, nonce: "n" }, false],
        [{ pid: 1.5, port: 1, nonce: "n" }, false],
        [{ pid: deadPid(), port: 0, nonce: "n" }, false],
        [{ pid: deadPid(), port: 70000, nonce: "n" }, false],
        [{ pid: deadPid(), port: 1 }, false],
        [{ pid: deadPid(), port: 1, nonce: "n", startKey: "start key" }, true],
      ];
      for (const [fixture, valid] of cases) {
        rmSync(paths.runtime, { force: true });
        rmSync(paths.pid, { force: true });
        writeRuntimeFixture(paths, fixture);
        const runtime = readClaudeRuntime(paths);
        assert.equal(runtime !== undefined, valid, JSON.stringify(fixture));
        if (valid) {
          assert.equal(runtime?.nonce, "n");
          assert.equal(runtime?.startKey, "start key");
        }
      }
      rmSync(paths.runtime, { force: true });
      rmSync(paths.pid, { force: true });
      writeRuntimeFixture(paths, { pid: deadPid(), port: 1, nonce: "n" });
      rmSync(paths.runtime);
      assert.equal(
        readClaudeRuntimeState(paths).kind,
        "invalid",
        "a lone pid sidecar without runtime state is inconsistent, not absent",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stop refuses to signal a live pid it cannot prove ownership for", async () => {
    const root = tempDir("cob-claude-stop-refuse-");
    try {
      const paths = resolveClaudePaths(join(root, ".claude-cob"));
      writeRuntimeFixture(paths, { pid: process.pid, port: 1, nonce: "n", startKey: "bogus" });
      await assert.rejects(stopClaudeGateway(paths), /refused/);
      assert.equal(existsSync(paths.runtime), true, "fail-closed stop must keep the runtime state");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stop and restore refuse a present-but-invalid runtime and keep all cob state", async () => {
    const root = tempDir("cob-claude-runtime-invalid-");
    try {
      const paths = resolveClaudePaths(join(root, ".claude-cob"));
      mkdirSync(paths.claudeHome, { recursive: true });
      const clearState = (): void => {
        rmSync(paths.runtime, { force: true });
        rmSync(paths.pid, { force: true });
      };
      const makeBroken = (): void => {
        clearState();
        writeFileSync(paths.runtime, "{ not json\n");
      };
      const makeZeroPid = (): void => {
        clearState();
        writeRuntimeFixture(paths, { pid: 0, port: 1, nonce: "n" });
      };
      const makeMismatchedSidecar = (): void => {
        clearState();
        writeRuntimeFixture(paths, { pid: deadPid(), port: 1, nonce: "n" });
        writeFileSync(paths.pid, "999999\n");
      };
      const makeLoneSidecar = (): void => {
        clearState();
        writeFileSync(paths.pid, "999999\n");
      };
      const brokenBuilders = [makeBroken, makeZeroPid, makeMismatchedSidecar, makeLoneSidecar];
      for (const build of brokenBuilders) {
        build();
        await assert.rejects(stopClaudeGateway(paths), /refused/);
        await assert.rejects(restoreClaudeGateway(paths), /refused/);
        assert.equal(existsSync(paths.lock), false, "restore must still release its lock on refusal");
      }
      makeLoneSidecar();
      await assert.rejects(stopClaudeGateway(paths), /refused/);
      assert.equal(existsSync(paths.pid), true, "a lone pid sidecar must be kept, not silently cleared");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("proven-identity stop re-verifies before each signal and confirms exit before cleanup", async () => {
    const root = tempDir("cob-claude-stop-signal-");
    try {
      const paths = resolveClaudePaths(join(root, ".claude-cob"));
      mkdirSync(paths.claudeHome, { recursive: true });
      const binDir = join(root, "fake-cob");
      mkdirSync(binDir, { recursive: true });
      const bin = join(binDir, "cob");
      const readyMarker = join(binDir, "trap-ready");
      writeFileSync(
        bin,
        'import { writeFileSync } from "node:fs";\n' +
          `writeFileSync(${JSON.stringify(readyMarker)}, "");\n` +
          'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);\n',
      );
      const child = spawn(process.execPath, [bin, "claude", "serve"], { stdio: "ignore" });
      let startKey: string | undefined;
      const identityDeadline = Date.now() + 5_000;
      while (Date.now() < identityDeadline) {
        startKey = child.pid === undefined ? undefined : processStartKey(child.pid);
        if (startKey && existsSync(readyMarker)) break;
        await sleep(25);
      }
      assert.ok(startKey, "test child must expose a ps start key");
      assert.equal(existsSync(readyMarker), true, "the trap must be registered before stop runs");
      writeRuntimeFixture(paths, { pid: child.pid, port: 1, nonce: "sig-nonce", startKey });
      assert.equal(await stopClaudeGateway(paths), true);
      assert.equal(existsSync(paths.runtime), false, "cleanup waits for the proven exit");
      await waitChildExit(child, 5_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("start prepare and commit run inside the lifecycle lock and commit failure rolls the child back", async () => {
    const root = tempDir("cob-claude-start-commit-");
    try {
      const paths = resolveClaudePaths(join(root, ".claude-cob"));
      mkdirSync(paths.claudeHome, { recursive: true });
      const observed: { prepareLocked: boolean; commitLocked: boolean; commitRuntime?: ClaudeRuntime } = {
        prepareLocked: false,
        commitLocked: false,
      };
      let child: ChildProcess | undefined;
      await assert.rejects(
        startClaudeGatewayDetached({
          paths,
          port: 0,
          ollamaUrl: "http://127.0.0.1:1",
          prepare: () => {
            observed.prepareLocked = peekLockRecord(paths.lock)?.pid === process.pid;
          },
          commit: (runtime) => {
            observed.commitLocked = peekLockRecord(paths.lock)?.pid === process.pid;
            observed.commitRuntime = runtime;
            throw new Error("overlay commit boom");
          },
          spawnServe: ({ token }) => {
            child = spawnFakeClaudeServe(root, { token });
            return child;
          },
        }),
        /overlay commit boom/,
      );
      assert.equal(observed.prepareLocked, true, "prepare must run while start owns the lock");
      assert.equal(observed.commitLocked, true, "commit must run while start owns the lock");
      assert.ok(observed.commitRuntime);
      assert.equal(existsSync(paths.lock), false, "start must release the lock even when commit fails");
      assert.equal(existsSync(paths.runtime), false, "a failed commit must roll the child runtime back");
      assert.ok(child);
      await waitChildExit(child, 5_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rollback under the commit lock kills only its own child and keeps foreign runtime state", async () => {
    const root = tempDir("cob-claude-rollback-foreign-");
    try {
      const paths = resolveClaudePaths(join(root, ".claude-cob"));
      mkdirSync(paths.claudeHome, { recursive: true });
      let child: ChildProcess | undefined;
      await assert.rejects(
        startClaudeGatewayDetached({
          paths,
          port: 0,
          ollamaUrl: "http://127.0.0.1:1",
          commit: () => {
            // Simulate another gateway taking over the state before a commit failure.
            writeRuntimeFixture(paths, { pid: process.pid, port: 1, nonce: "foreign", startKey: ownStartKey() });
            throw new Error("overlay commit boom");
          },
          spawnServe: ({ token }) => {
            child = spawnFakeClaudeServe(root, { token });
            return child;
          },
        }),
        /overlay commit boom/,
      );
      assert.ok(child);
      const state = readClaudeRuntimeState(paths);
      assert.equal(state.kind, "valid", "foreign runtime state must survive the rollback");
      if (state.kind === "valid") {
        assert.equal(state.runtime.pid, process.pid, "rollback must not delete another gateway's state");
        assert.equal(state.runtime.nonce, "foreign");
      }
      await waitChildExit(child, 5_000);
      await assert.rejects(stopClaudeGateway(paths), /refused/, "foreign state must not be stopped by the failed start");
      rmSync(paths.runtime, { force: true });
      rmSync(paths.pid, { force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rollback refuses a present-but-invalid runtime without signals or deletion", async () => {
    const root = tempDir("cob-claude-rollback-invalid-");
    try {
      const paths = resolveClaudePaths(join(root, ".claude-cob"));
      mkdirSync(paths.claudeHome, { recursive: true });
      let child: ChildProcess | undefined;
      await assert.rejects(
        startClaudeGatewayDetached({
          paths,
          port: 0,
          ollamaUrl: "http://127.0.0.1:1",
          commit: () => {
            writeFileSync(paths.runtime, "{ not json\n");
            throw new Error("overlay commit boom");
          },
          spawnServe: ({ token }) => {
            child = spawnFakeClaudeServe(root, { token });
            return child;
          },
        }),
        /rollback also failed.*unreadable or invalid/s,
      );
      assert.ok(child);
      assert.equal(existsSync(paths.runtime), true, "invalid runtime state must be preserved");
      await reapChild(child);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("foreground serve decides runtime state inside the locked boot section", async () => {
    const root = tempDir("cob-claude-foreground-lock-");
    const dist = dirname(fileURLToPath(import.meta.url));
    const cli = join(dist, "cli.js");
    // Reserve a concrete free port: serve records it in the runtime, so 0 is not usable.
    const reserved = createServer();
    await new Promise<void>((resolve) => reserved.listen(0, "127.0.0.1", () => resolve(undefined)));
    const port = (reserved.address() as { port: number }).port;
    await new Promise<void>((resolve) => reserved.close(() => resolve()));
    const serve = (): ChildProcess =>
      spawn(
        process.execPath,
        [cli, "claude", "serve", "--port", String(port), "--home", paths.claudeHome],
        { env: serveEnv, stdio: ["ignore", "pipe", "pipe"] },
      );
    const paths = resolveClaudePaths(join(root, ".claude-cob"));
    const serveEnv = { ...process.env, COB_CLAUDE_HOME: paths.claudeHome };
    let first: ChildProcess | undefined;
    let second: ChildProcess | undefined;
    try {
      first = serve();
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && readClaudeRuntimeState(paths).kind !== "valid") {
        await sleep(50);
      }
      const state = readClaudeRuntimeState(paths);
      assert.equal(state.kind, "valid", "real serve must publish a consistent runtime");
      const runningPid = state.kind === "valid" ? state.runtime.pid : 0;

      second = serve();
      const secondExit = new Promise<{ code: number | null; stderr: string }>((resolve) => {
        let stderr = "";
        second?.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        second?.on("exit", (code) => resolve({ code, stderr }));
      });
      const outcome = await secondExit;
      assert.notEqual(outcome.code, 0, "a second foreground serve must fail under the lock");
      assert.match(outcome.stderr, /already running/);
      const afterRefusal = readClaudeRuntimeState(paths);
      assert.equal(afterRefusal.kind, "valid", "the refused serve must not overwrite the runtime");
      if (afterRefusal.kind === "valid") {
        assert.equal(afterRefusal.runtime.pid, runningPid);
      }

      assert.equal(await stopClaudeGateway(paths), true, "authenticated shutdown must stop the real gateway");
      await waitChildExit(first, 5_000);
    } finally {
      first?.kill("SIGKILL");
      second?.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("foreground start refuses a live-but-unhealthy runtime instead of overwriting it", async () => {
    const root = tempDir("cob-claude-foreground-live-");
    try {
      const paths = resolveClaudePaths(join(root, ".claude-cob"));
      const foreign = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeRuntimeFixture(paths, { pid: foreign.pid, port: 1, nonce: "n", startKey: "bogus" });
      await assert.rejects(
        serveClaudeForeground({ port: 59999, ollamaUrl: "http://127.0.0.1:1", paths }),
        /refused/,
        "a live runtime must be stopped safely or the start must fail closed",
      );
      const state = readClaudeRuntimeState(paths);
      assert.equal(state.kind, "valid", "the refused start must keep the existing runtime state");
      if (state.kind === "valid") {
        assert.equal(state.runtime.pid, foreign.pid, "the live process must keep its ownership state");
      }
      assert.equal(isPidAlive(foreign.pid ?? 0), true, "the live-but-unhealthy process must not be killed by PID-only logic");
      await reapChild(foreign);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("commit lock timeout reports indeterminate and leaves the gateway untouched", async () => {
    const root = tempDir("cob-claude-commit-lock-adopted-");
    try {
      const paths = resolveClaudePaths(join(root, ".claude-cob"));
      mkdirSync(paths.claudeHome, { recursive: true });
      const child = spawnFakeClaudeServe(root, { token: "unused", mode: "skip-adopt" });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && readClaudeRuntimeState(paths).kind !== "valid") {
        await sleep(25);
      }
      const state = readClaudeRuntimeState(paths);
      assert.equal(state.kind, "valid");
      if (state.kind !== "valid") return;
      await acquireLock(paths.lock);
      try {
        await assert.rejects(
          commitStartedGateway(paths, child, state.runtime.pid, state.runtime, undefined, 250),
          /indeterminate.*no signal was sent and no state was changed/s,
        );
        assert.equal(isPidAlive(state.runtime.pid), true, "no signal may be sent without adoption proof");
        assert.equal(readClaudeRuntimeState(paths).kind, "valid", "no state may change without the lock");
      } finally {
        releaseLock(paths.lock);
      }
      await reapChild(child);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("commit lock timeout leaves even an uncommitted live child running (fail closed)", async () => {
    const root = tempDir("cob-claude-commit-lock-orphan-");
    try {
      const paths = resolveClaudePaths(join(root, ".claude-cob"));
      mkdirSync(paths.claudeHome, { recursive: true });
      // unpublish: a live health server with no runtime state at all.
      const child = spawnFakeClaudeServe(root, { token: "unused", mode: "unpublish" });
      await sleep(300);
      assert.equal(isPidAlive(child.pid ?? 0), true);
      await acquireLock(paths.lock);
      try {
        await assert.rejects(
          commitStartedGateway(
            paths,
            child,
            child.pid ?? 1,
            { pid: child.pid ?? 1, port: 1, ollamaUrl: "", startedAt: "", version: "", installKind: "", nonce: "x" },
            undefined,
            250,
          ),
          /indeterminate.*no signal was sent and no state was changed/s,
        );
        assert.equal(isPidAlive(child.pid ?? 0), true, "ownership is unproven without the lock; no signal may be sent");
      } finally {
        releaseLock(paths.lock);
      }
      await reapChild(child);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("alreadyRunning start still commits overlays under the held lock", async () => {    const root = tempDir("cob-claude-start-running-commit-");
    try {
      const paths = resolveClaudePaths(join(root, ".claude-cob"));
      mkdirSync(paths.claudeHome, { recursive: true });
      const first = await startClaudeGatewayDetached({
        paths,
        port: 0,
        ollamaUrl: "http://127.0.0.1:1",
        spawnServe: ({ token }) => spawnFakeClaudeServe(root, { token }),
      });
      assert.equal(first.alreadyRunning, false);
      let commitCalls = 0;
      let commitLocked = false;
      const second = await startClaudeGatewayDetached({
        paths,
        port: 0,
        ollamaUrl: "http://127.0.0.1:1",
        commit: () => {
          commitCalls += 1;
          commitLocked = peekLockRecord(paths.lock)?.pid === process.pid;
        },
        spawnServe: () => {
          throw new Error("alreadyRunning start must not spawn");
        },
      });
      assert.equal(second.alreadyRunning, true);
      assert.equal(second.runtime.pid, first.runtime.pid);
      assert.equal(commitCalls, 1);
      assert.equal(commitLocked, true);
      assert.equal(await stopClaudeGateway(paths), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("enforces 0600 on an existing token and rejects non-regular token paths", () => {
    const root = tempDir("cob-claude-token-");
    try {
      const paths = resolveClaudePaths(join(root, ".claude-cob"));
      mkdirSync(paths.claudeHome, { recursive: true });
      writeFileSync(paths.desktopToken, `${"c".repeat(64)}\n`, { mode: 0o644 });
      const token = ensureClaudeDesktopToken(paths);
      assert.equal(token, "c".repeat(64));
      assert.equal(lstatSync(paths.desktopToken).mode & 0o777, 0o600, "existing token must be forced to 0600");

      if (process.platform !== "win32") {
        // A FIFO must fail closed immediately, not block the open. The probe
        // runs in a subprocess with a timeout, so a regression fails fast
        // instead of hanging the suite.
        rmSync(paths.desktopToken, { force: true });
        const mkfifo = spawnSync("mkfifo", [paths.desktopToken]);
        if (mkfifo.status === 0) {
          const dist = dirname(fileURLToPath(import.meta.url));
          const probe = join(root, "fifo-probe.mjs");
          writeFileSync(
            probe,
            `import { ensureClaudeDesktopToken } from ${JSON.stringify(pathToFileURL(join(dist, "claude", "lifecycle.js")).href)};
import { resolveClaudePaths } from ${JSON.stringify(pathToFileURL(join(dist, "claude", "paths.js")).href)};
try {
  ensureClaudeDesktopToken(resolveClaudePaths(${JSON.stringify(paths.claudeHome)}));
  console.log("no-throw");
} catch (error) {
  console.log(String(error.message).includes("private regular file") ? "refused" : "other");
}
`,
          );
          const probeResult = spawnSync(process.execPath, [probe], { encoding: "utf8", timeout: 2_000 });
          assert.equal(probeResult.signal, null, "the FIFO open blocked; O_NONBLOCK protection regressed");
          assert.equal(probeResult.stdout?.trim(), "refused", "a FIFO token path must be rejected");
          rmSync(probe, { force: true });
        }

        // Hardlinks and special mode bits refuse the token path.
        rmSync(paths.desktopToken, { force: true });
        writeFileSync(paths.desktopToken, `${"c".repeat(64)}\n`, { mode: 0o600 });
        const hardlink = `${paths.desktopToken}.link`;
        linkSync(paths.desktopToken, hardlink);
        assert.throws(() => ensureClaudeDesktopToken(paths), /private regular file/, "hardlinked token must be rejected");
        rmSync(hardlink, { force: true });

        chmodSync(paths.desktopToken, 0o4600);
        assert.throws(() => ensureClaudeDesktopToken(paths), /private regular file/, "setuid token must be rejected");
      }

      rmSync(paths.desktopToken);
      symlinkSync(join(root, "missing-target"), paths.desktopToken);
      assert.throws(() => ensureClaudeDesktopToken(paths), /private regular file/);

      rmSync(paths.desktopToken);
      mkdirSync(paths.desktopToken);
      assert.throws(() => ensureClaudeDesktopToken(paths), /private regular file/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stop refuses a spoofed health listener even with a matching start key", async () => {
    const root = tempDir("cob-claude-stop-spoof-");
    const fake = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/cob/shutdown") {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, surface: "claude" }));
    });
    try {
      const paths = resolveClaudePaths(join(root, ".claude-cob"));
      mkdirSync(paths.claudeHome, { recursive: true });
      await new Promise<void>((resolve, reject) => {
        fake.listen(0, "127.0.0.1", () => resolve(undefined));
        fake.on("error", reject);
      });
      const fakePort = (fake.address() as { port: number }).port;
      writeRuntimeFixture(paths, { pid: process.pid, port: fakePort, nonce: "n", startKey: ownStartKey() });
      await assert.rejects(stopClaudeGateway(paths), /refused/);
      assert.equal(existsSync(paths.runtime), true);
    } finally {
      fake.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("public stop serializes on the held lock instead of a false success", async () => {
    const root = tempDir("cob-claude-stop-");
    try {
      const paths = resolveClaudePaths(join(root, ".claude-cob"));
      mkdirSync(paths.claudeHome, { recursive: true });
      writeRuntimeFixture(paths, { pid: deadPid(), port: 1, nonce: "n" });
      await acquireLock(paths.lock);
      let finished = false;
      const stopping = stopClaudeGateway(paths).then((stopped) => {
        finished = true;
        return stopped;
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(finished, false, "stop must wait while another holder owns the lock");
      assert.equal(existsSync(paths.runtime), true, "stop must not delete runtime while waiting");
      releaseLock(paths.lock);
      assert.equal(await stopping, true);
      assert.equal(existsSync(paths.runtime), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("internal locked stop bypasses re-acquisition and still removes the runtime", async () => {
    const root = tempDir("cob-claude-stop-locked-");
    try {
      const paths = resolveClaudePaths(join(root, ".claude-cob"));
      mkdirSync(paths.claudeHome, { recursive: true });
      writeRuntimeFixture(paths, { pid: deadPid(), port: 1, nonce: "n" });
      await acquireLock(paths.lock);
      try {
        assert.equal(await stopClaudeGateway(paths, { locked: true }), true);
        assert.equal(existsSync(paths.runtime), false);
      } finally {
        releaseLock(paths.lock);
      }
      assert.equal(existsSync(paths.lock), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restoreClaudeSurface never deletes the lock file itself", async () => {
    const root = tempDir("cob-claude-restore-lock-");
    try {
      const paths = resolveClaudePaths(join(root, ".claude-cob"));
      mkdirSync(paths.claudeHome, { recursive: true });
      writeRuntimeFixture(paths, { pid: deadPid(), port: 1, nonce: "n" });
      await acquireLock(paths.lock);
      try {
        restoreClaudeSurface(paths);
        assert.equal(existsSync(paths.runtime), false);
        assert.equal(existsSync(paths.lock), true, "only the lock owner may remove the lock file");
      } finally {
        releaseLock(paths.lock);
      }
      assert.equal(existsSync(paths.lock), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restore runs stop, surface cleanup, and overlay restore as one locked transaction", async () => {
    const root = tempDir("cob-claude-restore-");
    try {
      mkdirSync(join(root, "markers"), { recursive: true });
      const paths = resolveClaudePaths(join(root, ".claude-cob"));
      mkdirSync(paths.claudeHome, { recursive: true });
      let childPid = 0;
      let child: ChildProcess | undefined;
      const started = startClaudeGatewayDetached({
        paths,
        port: 0,
        ollamaUrl: "http://127.0.0.1:1",
        spawnServe: ({ token }) => {
          child = spawnFakeClaudeServe(root, { token });
          childPid = child.pid ?? 0;
          return child;
        },
      });
      const result = await started;
      assert.equal(result.alreadyRunning, false);
      assert.ok(child);

      const restored = await restoreClaudeGateway(paths);
      assert.equal(restored.stopped, true);
      assert.equal(restored.agentsRestored, false);
      assert.equal(restored.desktopRestored, false);
      assert.equal(existsSync(paths.runtime), false);
      assert.equal(existsSync(paths.pid), false);
      assert.equal(existsSync(paths.log), false);
      assert.equal(existsSync(paths.lock), false, "restore must release the lock it owns");

      const deadline = Date.now() + 5_000;
      while (
        child.exitCode === null &&
        child.signalCode === null &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(child.exitCode !== null || child.signalCode !== null, "restore must stop the gateway child");
      assert.ok(childPid > 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

it("holds the lock until the detached child adopts it, then start/stop stay consistent", async () => {
  const root = tempDir("cob-claude-handoff-");
  try {
    mkdirSync(join(root, "markers"), { recursive: true });
    const paths = resolveClaudePaths(join(root, ".claude-cob"));
    mkdirSync(paths.claudeHome, { recursive: true });
    const orderingViolations: string[] = [];
    let sawLock = false;
    let childPid = 0;
    const started = startClaudeGatewayDetached({
      paths,
      port: 0,
      ollamaUrl: "http://127.0.0.1:1",
      spawnServe: ({ token }) => {
        const child = spawnFakeClaudeServe(root, { token, adoptDelayMs: 400 });
        childPid = child.pid ?? 0;
        return child;
      },
    });
    const watcher = (async () => {
      const deadline = Date.now() + 20_000;
      while (!existsSync(paths.runtime) && Date.now() < deadline) {
        if (existsSync(paths.lock)) {
          sawLock = true;
        } else if (sawLock && !existsSync(join(root, "markers", "adopted"))) {
          orderingViolations.push("lock absent before the child adopted it");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();
    const result = await started;
    await watcher;
    assert.deepEqual(orderingViolations, []);
    assert.equal(result.alreadyRunning, false);
    assert.equal(result.runtime.pid, childPid);

    const second = await startClaudeGatewayDetached({
      paths,
      port: 0,
      ollamaUrl: "http://127.0.0.1:1",
      spawnServe: () => {
        throw new Error("second start must not spawn while the gateway is healthy");
      },
    });
    assert.equal(second.alreadyRunning, true);
    assert.equal(second.runtime.pid, childPid);

    assert.equal(await stopClaudeGateway(paths), true);
    assert.equal(existsSync(paths.runtime), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("fails closed and reaps the child when it dies before adopting", async () => {
  const root = tempDir("cob-claude-handoff-fail-");
  try {
    const paths = resolveClaudePaths(join(root, ".claude-cob"));
    mkdirSync(paths.claudeHome, { recursive: true });
    await assert.rejects(
      startClaudeGatewayDetached({
        paths,
        port: 0,
        ollamaUrl: "http://127.0.0.1:1",
        spawnServe: ({ token }) =>
          spawnFakeClaudeServe(root, { token, mode: "exit-before-adopt" }),
      }),
      /child exited before adopting/,
    );
    assert.equal(existsSync(paths.lock), false);
    assert.equal(existsSync(paths.runtime), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps a concurrent stop and start mutually consistent under the lock", async () => {
  const root = tempDir("cob-claude-stop-race-");
  try {
    const paths = resolveClaudePaths(join(root, ".claude-cob"));
    mkdirSync(paths.claudeHome, { recursive: true });
    let childPid = 0;
    const started = startClaudeGatewayDetached({
      paths,
      port: 0,
      ollamaUrl: "http://127.0.0.1:1",
      spawnServe: ({ token }) => {
        const child = spawnFakeClaudeServe(root, { token, adoptDelayMs: 800 });
        childPid = child.pid ?? 0;
        return child;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stopping = stopClaudeGateway(paths);
    const [startSettled, stopSettled] = await Promise.allSettled([started, stopping]);
    assert.equal(stopSettled.status, "fulfilled");
    const stopped = stopSettled.status === "fulfilled" ? stopSettled.value : false;
    if (!stopped) {
      assert.equal(
        startSettled.status,
        "fulfilled",
        "a stop that found nothing to kill must not fail the pending start",
      );
    }
    if (startSettled.status === "fulfilled") {
      assert.equal(
        startSettled.value.runtime.pid,
        childPid,
        "start must only commit the runtime of the child it spawned",
      );
    }
    await stopClaudeGateway(paths);
    assert.equal(existsSync(paths.runtime), false);
    assert.equal(existsSync(paths.lock), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("rejects a foreign runtime and cleans up only its own child", async () => {
  const root = tempDir("cob-claude-foreign-");
  try {
    const paths = resolveClaudePaths(join(root, ".claude-cob"));
    mkdirSync(paths.claudeHome, { recursive: true });
    let child: ChildProcess | undefined;
    await assert.rejects(
      startClaudeGatewayDetached({
        paths,
        port: 0,
        ollamaUrl: "http://127.0.0.1:1",
        spawnServe: ({ token }) => {
          child = spawnFakeClaudeServe(root, { token, foreignPid: process.pid });
          return child;
        },
      }),
      /foreign gateway runtime/,
    );
    assert.equal(existsSync(paths.lock), false);
    assert.equal(existsSync(paths.runtime), true);
    const deadline = Date.now() + 3_000;
    while (
      child &&
      child.exitCode === null &&
      child.signalCode === null &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(child !== undefined && (child.exitCode !== null || child.signalCode !== null));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
