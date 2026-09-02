import assert from "node:assert/strict";
import { spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EvalRunGuard, evalRunIdentity, liveHomeShaSnapshot, resolveLiveCodexHome } from "./eval-run-guard.js";

function newGuard(label: string, runId: string, tmpRoot: string): EvalRunGuard {
  return new EvalRunGuard({ label, runId, tmpRoot });
}

describe("eval run guard", () => {
  it("fails a duplicate run id before any home or process exists", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "cob-guard-dup-"));
    const first = newGuard("eval", "run-1", tmpRoot);
    const home = first.allocateHome("cob-guard-home-");
    assert.equal(existsSync(home), true);
    assert.throws(() => newGuard("eval", "run-1", tmpRoot), /EEXIST/);
    // The duplicate created no home of its own and spawned nothing.
    const lockDir = join(tmpRoot, "cob-run-guard-eval");
    assert.deepEqual(readdirSync(lockDir).sort(), ["run-1.lock"]);
  });

  it("executes cleanup exactly once for child-start failure, timeout, assertion failure, and success", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "cob-guard-finalize-"));

    const runScenario = async (mode: "success" | "child-fail" | "timeout" | "assert"): Promise<void> => {
      const guard = newGuard("scenario", `run-${mode}`, tmpRoot);
      const home = guard.allocateHome("cob-guard-home-");
      const port = await guard.allocateClosedPort();
      guard.registerPort(port);
      try {
        if (mode === "child-fail") {
          const child = guard.spawnAsync(process.execPath, ["-e", "process.exit(3)"]);
          await new Promise<void>((resolve) => child.once("close", () => resolve()));
          throw new Error("child start failed");
        }
        if (mode === "timeout") {
          const child = guard.spawnAsync(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
          child.kill("SIGKILL");
          await new Promise<void>((resolve) => child.once("close", () => resolve()));
          throw new Error("timed out");
        }
        if (mode === "assert") {
          throw new Error("assertion failure");
        }
      } finally {
        const proof = await guard.finalize();
        assert.equal(proof.executed, true);
        assert.equal(proof.homesRemoved, true);
        assert.equal(proof.portClosed, true);
        // A second finalize is a no-op with the recorded proof.
        const again = await guard.finalize();
        assert.equal(again, proof);
        assert.equal(existsSync(home), false);
      }
    };

    await assert.doesNotReject(() => runScenario("success"));
    await assert.rejects(() => runScenario("child-fail"), /child start failed/);
    await assert.rejects(() => runScenario("timeout"), /timed out/);
    await assert.rejects(() => runScenario("assert"), /assertion failure/);
  });

  it("snapshots the resolved live home independently of environment overrides", () => {
    const snapshot = liveHomeShaSnapshot();
    // Hashes are either 64-hex (present) or null (absent); never undefined.
    for (const value of [snapshot.configSha256, snapshot.catalogSha256, snapshot.catalogMetaSha256]) {
      assert.ok(value === null || /^[0-9a-f]{64}$/.test(value));
    }
    const tmpRoot = mkdtempSync(join(tmpdir(), "cob-guard-live-"));
    const guard = newGuard("live", "run-env", tmpRoot);
    const home = guard.allocateHome("cob-guard-home-");
    // A home inside the temp root must never appear in the live snapshot path.
    const result = spawnSync(process.execPath, ["-e", "console.log(1)"], { cwd: home, env: { ...process.env, CODEX_HOME: home } });
    assert.equal(result.status, 0);
    const snapshotAfter = liveHomeShaSnapshot();
    assert.deepEqual(snapshotAfter, snapshot);
  });

  it("resolves the live home independently of HOME overrides", () => {
    const snapshot = liveHomeShaSnapshot();
    const originalHome = process.env.HOME;
    process.env.HOME = "/nonexistent-cob-guard-home";
    try {
      // The passwd-database home wins; a HOME override must not redirect the
      // read-only live snapshot or the resolved live home.
      assert.deepEqual(liveHomeShaSnapshot(), snapshot);
      assert.equal(resolveLiveCodexHome().endsWith("/.codex"), true);
      assert.notEqual(resolveLiveCodexHome(), "/nonexistent-cob-guard-home/.codex");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it("awaits child exit after the kill during finalize", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "cob-guard-exit-"));
    const guard = newGuard("exit", "run-exit", tmpRoot);
    guard.allocateHome("cob-guard-home-");
    const child = guard.spawnAsync(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    let closeObserved = false;
    child.once("close", () => {
      closeObserved = true;
    });
    const proof = await guard.finalize();
    assert.equal(proof.stoppedProcesses, 1);
    assert.equal(proof.portClosed, true);
    assert.equal(proof.homesRemoved, true);
    assert.equal(closeObserved, true);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  });

  it("fails closed when a registered child is still running after the bounded wait", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "cob-guard-running-"));
    const guard = new EvalRunGuard({
      label: "still-running",
      runId: "run-still-running",
      tmpRoot,
      childExitWaitMs: 25,
    });
    guard.allocateHome("cob-guard-home-");
    // A registered child that never closes and never exits: the kill is a
    // no-op and no close event ever fires, so after the (tiny, injectable)
    // bounded wait finalize must reject instead of reporting success — even
    // though this child owns no port and the home proof passes.
    const neverClosing = {
      exitCode: null,
      signalCode: null,
      kill: () => false,
      once: () => undefined,
    } as unknown as ChildProcess;
    guard.registerProcess(neverClosing);
    await assert.rejects(() => guard.finalize(), /eval run cleanup failed: .*children_running=1/);
  });

  it("rejects and records the proof when a home cannot be removed", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "cob-guard-stuck-"));
    const guard = newGuard("stuck", "run-stuck", tmpRoot);
    const home = guard.allocateHome("cob-guard-home-");
    const locked = join(home, "locked");
    mkdirSync(locked, { mode: 0o700 });
    writeFileSync(join(locked, "file"), "x", { mode: 0o600 });
    // Removing the file requires write permission on `locked`; without it,
    // finalize records homesRemoved=false and rejects.
    chmodSync(locked, 0o500);
    try {
      await assert.rejects(() => guard.finalize(), /eval run cleanup failed/);
      // The failure is recorded; a second finalize replays the same recorded
      // failure instead of re-running cleanup or reporting success.
      await assert.rejects(() => guard.finalize(), /eval run cleanup failed/);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it("rejects instead of crashing when the port listen fails", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "cob-guard-listen-"));
    const { EventEmitter } = await import("node:events");
    // A loopback server whose listen fails asynchronously with EPERM: without
    // an error handler on the server, the error event crashes the process as
    // an unhandled exception instead of rejecting the allocation promise.
    const failing = new EventEmitter() as unknown as import("./eval-run-guard.js").EvalLoopbackServer;
    const failingAny = failing as unknown as {
      listen: (...args: unknown[]) => void;
      close: (cb?: (error?: Error) => void) => void;
    };
    failingAny.listen = () => {
      setImmediate(() =>
        failing.emit("error", Object.assign(new Error("SIMULATED_LISTEN_EPERM"), { code: "EPERM" })),
      );
    };
    failingAny.close = (cb) => cb?.();
    const guard = new EvalRunGuard({
      label: "listen",
      runId: "run-listen",
      tmpRoot,
      serverFactory: () => failing,
    });
    await assert.rejects(() => guard.allocateClosedPort(), /SIMULATED_LISTEN_EPERM/);
  });

  it("is concurrency-safe under concurrent finalize callers", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "cob-guard-conc-"));
    const guard = newGuard("conc", "run-conc", tmpRoot);
    guard.allocateHome("cob-guard-home-");
    guard.spawnAsync(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    const [first, second] = await Promise.all([guard.finalize(), guard.finalize()]);
    assert.equal(first, second);
    assert.equal(first.executed, true);
    assert.equal(first.homesRemoved, true);
  });

  it("builds content-free run identity receipts with aggregate outcomes", async () => {
    const { idSha8 } = await import("./eval-receipt.js");
    const identity = evalRunIdentity({ label: "g24-child-run", runId: "run-x", corpusSha256: "a".repeat(64), outcome: "fail" });
    assert.equal(identity.label, "g24-child-run");
    assert.equal(identity.outcome, "fail");
    assert.equal(identity.artifactSha256, null);
    const raw = JSON.stringify(identity);
    assert.equal(raw.includes("prompt"), false);
    // The raw run id never reaches the receipt; only its short hash.
    assert.equal(raw.includes("run-x"), false);
    assert.equal(identity.runIdSha8, idSha8("run-x"));
    // The cleanup proof line is external evidence too: hashed run id only.
    const tmpRoot = mkdtempSync(join(tmpdir(), "cob-guard-proof-"));
    const guard = newGuard("proof", "run-x", tmpRoot);
    const line = guard.formatCleanupProof({
      stoppedProcesses: 0,
      ports: [],
      portClosed: true,
      homes: [],
      homesRemoved: true,
      executed: true,
    });
    assert.match(line, /run_sha8=[0-9a-f]{8}/);
    assert.equal(line.includes("run-x"), false);
  });
});
