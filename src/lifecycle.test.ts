import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  chmodSync,
  chownSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { uniqueTempPath } from "./core/atomic.js";
import { acquireLock, LockTimeoutError, releaseLock, STALE_CORRUPT_MS, waitForLockAdopted, withExclusiveLock } from "./core/lock.js";
import { assertCodexAcceptsCatalog } from "./codex/catalog/validator.js";
import {
  isStartLeaseActive,
  prepareProfileAndCatalog,
  readRootConfig,
  readStartLease,
  restrictExperimentalOnLiveHome,
  RootConfigUnreadableError,
  cobOwnedFiles,
  overlayStateFiles,
  restoreCob,
  restoreOverlays,
  serveForeground,
  snapshotOverlays,
  startGatewayDetached,
  stopGateway,
  syncCatalog,
  writeStartLease,
} from "./codex/runtime/lifecycle.js";
import { isHealthyRuntime, readRuntime, waitForHealth, writeRuntime } from "./codex/runtime/runtime.js";
import { closePrivateLogFd, openPrivateLogFd } from "./codex/runtime/log-fd.js";
import { runCodexCli } from "./codex/cli.js";
import type { CliFlags } from "./cli-session.js";
import { describeDiagnosticLog, describePlaintextSpawn, statusReport } from "./codex/runtime/status.js";
import { resolvePaths } from "./codex/paths.js";
import { cobProcessIdentity, isOurCobArgv, processStartKey } from "./core/process-info.js";

describe("lifecycle primitives", () => {
  it("owns diagnostic rotation files without snapshotting them as overlays", () => {
    const paths = resolvePaths(join(mkdtempSync(join(tmpdir(), "cob-diagnostic-lifecycle-")), ".codex"));
    const backup = `${paths.diagnostics}.1`;
    assert.ok(cobOwnedFiles(paths).includes(paths.diagnostics));
    assert.ok(cobOwnedFiles(paths).includes(backup));
    assert.equal(overlayStateFiles(paths).includes(paths.diagnostics), false);
    assert.equal(overlayStateFiles(paths).includes(backup), false);
  });

  it("removes both diagnostic files during restore", async () => {
    const home = mkdtempSync(join(tmpdir(), "cob-diagnostic-restore-"));
    const paths = resolvePaths(home);
    writeFileSync(paths.diagnostics, "active\n");
    writeFileSync(`${paths.diagnostics}.1`, "backup\n");
    await restoreCob(paths);
    assert.equal(existsSync(paths.diagnostics), false);
    assert.equal(existsSync(`${paths.diagnostics}.1`), false);
  });

  it("forces Gate 5 off on a live home and keeps a pinned native plaintext policy", () => {
    const cob = {
      compaction: { provider: "native" as const },
      subagents: { models: ["ollama/deepseek-v4-flash:0731-cloud"] },
      catalog: { supportsSearchTool: true, applyPatch: true },
      experimental: {
        nativePlaintextSpawn: { enabled: true, schemaSha256: "5".repeat(64) },
      },
    };
    const isolated = restrictExperimentalOnLiveHome(cob, false);
    assert.equal(isolated.catalog?.applyPatch, true);
    assert.equal(isolated.experimental?.nativePlaintextSpawn.enabled, true);
    assert.equal(isolated.experimental?.nativePlaintextSpawn.schemaSha256, "5".repeat(64));

    const live = restrictExperimentalOnLiveHome(cob, true);
    assert.equal(live.catalog?.applyPatch, false);
    assert.equal(live.experimental?.nativePlaintextSpawn.enabled, true);
    assert.equal(live.experimental?.nativePlaintextSpawn.schemaSha256, "5".repeat(64));
  });

  it("reports a stale plaintext spawn digest only while the wire is armed", () => {
    assert.equal(describePlaintextSpawn({}), undefined);
    assert.equal(describePlaintextSpawn({ native_plaintext_spawn: { enabled: false, drift: null } }), undefined);
    assert.equal(
      describePlaintextSpawn({ native_plaintext_spawn: { enabled: true, pinned: true, drift: null } }),
      "native plaintext spawn: armed",
    );
    const stale = describePlaintextSpawn({
      native_plaintext_spawn: {
        enabled: true,
        pinned: true,
        drift: { code: "native_plaintext_spawn_schema_mismatch", observed_schema_sha256: "a".repeat(64), count: 3 },
      },
    });
    assert.match(stale ?? "", /schema drift after 3 requests/);
    assert.match(stale ?? "", /native_plaintext_spawn_schema_sha256 = "a{64}"/);
    const missing = describePlaintextSpawn({
      native_plaintext_spawn: {
        enabled: true,
        pinned: true,
        drift: { code: "native_plaintext_spawn_schema_shape", count: 1 },
      },
    });
    assert.match(missing ?? "", /no replacement digest was observed/);
    assert.equal(missing?.includes('= "-"'), false);
  });

  it("formats content-free diagnostic sink health", () => {
    const line = describeDiagnosticLog({
      state: "failed",
      fd_open: false,
      dropped_event_count: 7,
      oversize_drop_count: 2,
      write_failure_count: 1,
      rotation_count: 3,
      discarded_backup_count: 2,
      last_failure_code: "write_failed",
    });
    assert.equal(
      line,
      "diagnostics: failed dropped=7 oversize=2 failures=1 rotations=3 discarded_backups=2 last_failure=write_failed",
    );
  });

  it("disarms an unpinned native plaintext policy on a live home", () => {
    // Without a digest every fingerprinted-model turn would be rejected, so the
    // live gateway degrades to the unrewritten path instead of failing closed.
    const unpinned = {
      compaction: { provider: "native" as const },
      subagents: { models: ["ollama/deepseek-v4-flash:0731-cloud"] },
      catalog: { supportsSearchTool: true, applyPatch: false },
      experimental: { nativePlaintextSpawn: { enabled: true } },
    };
    assert.equal(
      restrictExperimentalOnLiveHome(unpinned, false).experimental?.nativePlaintextSpawn.enabled,
      true,
    );
    assert.equal(
      restrictExperimentalOnLiveHome(unpinned, true).experimental?.nativePlaintextSpawn.enabled,
      false,
    );
  });

  it("gives unique temp names for concurrent writes", () => {
    const target = join(tmpdir(), "cob-atomic-target");
    const names = new Set(Array.from({ length: 20 }, () => uniqueTempPath(target)));
    assert.equal(names.size, 20);
  });

  it("holds an exclusive lock for one caller at a time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-lock-"));
    const lockPath = join(dir, "cob.lock");
    let concurrent = 0;
    let max = 0;
    await Promise.all(
      [1, 2, 3].map(() =>
        withExclusiveLock(lockPath, async () => {
          concurrent += 1;
          max = Math.max(max, concurrent);
          await new Promise((resolve) => setTimeout(resolve, 40));
          concurrent -= 1;
        }),
      ),
    );
    assert.equal(max, 1);
  });

  it("creates a complete lock record atomically, never an empty lock file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-lock-complete-"));
    const lockPath = join(dir, "cob.lock");
    await acquireLock(lockPath);
    try {
      const raw = readFileSync(lockPath, "utf8");
      assert.notEqual(raw.trim(), "");
      const parsed: unknown = JSON.parse(raw);
      assert.equal(typeof parsed, "object");
      assert.equal(typeof (parsed as { token?: unknown }).token, "string");
      assert.ok(String((parsed as { token: string }).token).length > 0);
      assert.equal((parsed as { pid?: unknown }).pid, process.pid);
    } finally {
      releaseLock(lockPath);
    }
  });

  it("recovers a stale lock from a dead pid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-stale-lock-"));
    const lockPath = join(dir, "cob.lock");
    writeFileSync(lockPath, `${JSON.stringify({ pid: 99999999, argv: "cob serve", createdAt: new Date().toISOString() })}\n`);
    let ran = false;
    await withExclusiveLock(lockPath, async () => {
      ran = true;
    });
    assert.equal(ran, true);
  });

  it("recovers an orphaned Linux inode claim only after its owner is dead", async (t) => {
    if (process.platform !== "linux") {
      t.skip("Linux claim fallback only");
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "cob-orphaned-claim-"));
    const lockPath = join(dir, "cob.lock");
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid: 99999999,
        token: "stale-lock",
        startKey: "dead-lock-owner",
        argv: "cob serve",
        createdAt: new Date().toISOString(),
      })}\n`,
    );
    const st = statSync(lockPath);
    writeFileSync(
      `${lockPath}.recover.${st.dev}.${st.ino}.claim`,
      `${JSON.stringify({
        pid: 99999999,
        token: "orphaned-recovery-claim",
        startKey: "dead-recovery-owner",
        lockDev: st.dev,
        lockIno: st.ino,
      })}\n`,
    );
    let ran = false;
    await withExclusiveLock(
      lockPath,
      async () => {
        ran = true;
      },
      1_000,
    );
    assert.equal(ran, true);
  });

  it("acquires a free lock path even if an unparseable recover temp remains", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-junk-claim-tmp-"));
    const lockPath = join(dir, "cob.lock");
    const junk = uniqueTempPath(`${lockPath}.recover.1.2.claim`);
    writeFileSync(junk, "not-a-claim-record\n");
    await acquireLock(lockPath);
    try {
      assert.equal(existsSync(lockPath), true);
      assert.equal(readFileSync(junk, "utf8"), "not-a-claim-record\n");
    } finally {
      releaseLock(lockPath);
    }
  });

  it("acquires a free lock path even if a no-startKey claim remains", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-live-claim-free-path-"));
    const lockPath = join(dir, "cob.lock");
    const claim = `${lockPath}.recover.9.9.claim`;
    writeFileSync(
      claim,
      `${JSON.stringify({
        pid: process.pid,
        token: "live-or-legacy-claim",
        lockDev: 9,
        lockIno: 9,
      })}\n`,
    );
    await acquireLock(lockPath);
    try {
      assert.equal(existsSync(lockPath), true);
      assert.equal(JSON.parse(readFileSync(claim, "utf8")).token, "live-or-legacy-claim");
    } finally {
      releaseLock(lockPath);
    }
  });

  it("does not recover a stale lock when its exact claim file is unparseable", async (t) => {
    if (process.platform !== "linux") {
      t.skip("Linux claim fallback only");
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "cob-unparseable-inode-claim-"));
    const lockPath = join(dir, "cob.lock");
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid: 99999999,
        token: "stale-lock",
        startKey: "dead-lock-owner",
        argv: "cob serve",
        createdAt: new Date().toISOString(),
      })}\n`,
    );
    const st = statSync(lockPath);
    const claim = `${lockPath}.recover.${st.dev}.${st.ino}.claim`;
    writeFileSync(claim, "garbage-claim\n");
    const before = readFileSync(lockPath);
    await assert.rejects(
      () => withExclusiveLock(lockPath, async () => undefined, 400),
      (error: unknown) => error instanceof LockTimeoutError,
    );
    assert.equal(readFileSync(lockPath).equals(before), true);
    assert.equal(readFileSync(claim, "utf8"), "garbage-claim\n");
  });

  it("does not steal a fresh empty lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-empty-lock-"));
    const lockPath = join(dir, "cob.lock");
    writeFileSync(lockPath, "");
    await assert.rejects(
      () => withExclusiveLock(lockPath, async () => undefined, 400),
      (error: unknown) => error instanceof LockTimeoutError,
    );
    assert.equal(readFileSync(lockPath, "utf8"), "");
  });

  it("recovers an aged empty lock without dropping a winner's new lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-aged-empty-lock-"));
    const lockPath = join(dir, "cob.lock");
    writeFileSync(lockPath, "not-json");
    const aged = (Date.now() - STALE_CORRUPT_MS - 2_000) / 1000;
    utimesSync(lockPath, aged, aged);
    let concurrent = 0;
    let max = 0;
    await Promise.all(
      [1, 2, 3].map(() =>
        withExclusiveLock(
          lockPath,
          async () => {
            concurrent += 1;
            max = Math.max(max, concurrent);
            await new Promise((resolve) => setTimeout(resolve, 40));
            concurrent -= 1;
          },
          2_000,
        ),
      ),
    );
    assert.equal(max, 1);
  });

  it("releaseLock does not delete a lock it no longer owns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-release-token-"));
    const lockPath = join(dir, "cob.lock");
    await acquireLock(lockPath);
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: 1, token: "other-owner", argv: "cob serve", createdAt: new Date().toISOString() })}\n`,
    );
    releaseLock(lockPath);
    assert.equal(existsSync(lockPath), true);
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).token, "other-owner");
  });

  it("cleans the catalog parser temp directory", () => {
    const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("cob-catalog-check-")));
    assert.throws(() => assertCodexAcceptsCatalog({ models: [{ slug: "gpt-x" }] }, "definitely-missing-codex-bin"));
    const after = readdirSync(tmpdir()).filter((name) => name.startsWith("cob-catalog-check-"));
    for (const name of after) {
      assert.equal(before.has(name), true, name);
    }
  });

  it("holds the cob lock until restore finishes deleting overlays", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-restore-lock-"));
    const paths = resolvePaths(dir);
    writeFileSync(paths.profile, "stale-profile\n");
    writeFileSync(paths.catalog, "{}\n");
    writeFileSync(paths.catalogMeta, "{}\n");
    writeFileSync(paths.cobConfig, "[compaction]\nprovider = \"native\"\n");
    mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(paths.stateDir, "secret-checkpoint"), "sensitive\n", { mode: 0o600 });
    await acquireLock(paths.lock);
    let finished = false;
    try {
      const restoring = restoreCob(paths).then((result) => {
        finished = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(finished, false);
      assert.equal(existsSync(paths.profile), true);
      assert.equal(existsSync(paths.catalog), true);
      releaseLock(paths.lock);
      await restoring;
      assert.equal(finished, true);
      assert.equal(existsSync(paths.profile), false);
      assert.equal(existsSync(paths.catalog), false);
      assert.equal(existsSync(paths.catalogMeta), false);
      assert.equal(existsSync(paths.cobConfig), false);
      assert.equal(existsSync(paths.stateDir), false);
      assert.equal(existsSync(paths.lock), false);
    } catch (error) {
      try {
        releaseLock(paths.lock);
      } catch {
        // already released
      }
      throw error;
    }
  });

  it("does not steal a live cob restore lock from another process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-restore-cross-"));
    const lockPath = join(dir, "cob.lock");
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
    const lockUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "core", "lock.js")).href;
    writeFileSync(
      join(dir, "dist", "cli.js"),
      `import { acquireLock } from ${JSON.stringify(lockUrl)};
await acquireLock(process.argv[3]);
process.stdout.write("held\\n");
await new Promise(() => {
  setInterval(() => undefined, 60_000);
});
`,
    );
    const child = spawn(process.execPath, [join(dir, "dist", "cli.js"), "restore", lockPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn();
        };
        const timer = setTimeout(() => finish(() => reject(new Error("restore holder never acquired the lock"))), 2_000);
        child.stdout?.on("data", (chunk: Buffer) => {
          if (chunk.toString("utf8").includes("held")) finish(resolve);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          process.stderr.write(chunk);
        });
        child.on("error", (error) => finish(() => reject(error)));
        child.on("exit", (code) => finish(() => reject(new Error(`restore holder exited ${code}`))));
      });
      assert.ok(child.pid);
      assert.notEqual(cobProcessIdentity(child.pid), "foreign");
      await assert.rejects(
        () => withExclusiveLock(lockPath, async () => undefined, 400),
        (error: unknown) => error instanceof LockTimeoutError,
      );
    } finally {
      child.kill("SIGKILL");
      await Promise.race([
        new Promise<void>((resolve) => child.once("close", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 250)),
      ]);
    }
  });

  it("treats a live node /tmp/cli.js pid as foreign stale lock owner", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "cob-foreign-cli-"));
    const lockPath = join(dir, "cob.lock");
    writeFileSync(
      join(dir, "cli.js"),
      `process.stdout.write("held\\n");
setInterval(() => undefined, 60_000);
`,
    );
    const child = spawn(process.execPath, [join(dir, "cli.js"), "restore"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn();
        };
        const timer = setTimeout(() => finish(() => reject(new Error("foreign cli.js holder never started"))), 2_000);
        child.stdout?.on("data", (chunk: Buffer) => {
          if (chunk.toString("utf8").includes("held")) finish(resolve);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          process.stderr.write(chunk);
        });
        child.on("error", (error) => finish(() => reject(error)));
        child.on("exit", (code) => finish(() => reject(new Error(`foreign cli.js holder exited ${code}`))));
      });
      assert.ok(child.pid);
      if (cobProcessIdentity(child.pid) === "unknown") {
        t.skip("ps cannot inspect process argv in this environment");
        return;
      }
      assert.equal(cobProcessIdentity(child.pid), "foreign");
      writeFileSync(
        lockPath,
        `${JSON.stringify({
          pid: child.pid,
          token: "stale-cob-token",
          argv: `${join(dir, "cli.js")} restore`,
          createdAt: new Date().toISOString(),
        })}\n`,
      );
      let ran = false;
      await withExclusiveLock(lockPath, async () => {
        ran = true;
      }, 1_000);
      assert.equal(ran, true);
    } finally {
      child.kill("SIGKILL");
      await Promise.race([
        new Promise<void>((resolve) => child.once("close", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 250)),
      ]);
    }
  });

  it("recovers a lock whose live pid is not cob", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "cob-foreign-lock-"));
    const lockPath = join(dir, "cob.lock");
    const sleeper = spawn("sleep", ["30"]);
    try {
      assert.ok(sleeper.pid);
      writeFileSync(
        lockPath,
        `${JSON.stringify({ pid: sleeper.pid, argv: "sleep 30", createdAt: new Date().toISOString() })}\n`,
      );
      if (cobProcessIdentity(sleeper.pid) === "unknown") {
        t.skip("ps cannot inspect process argv in this environment");
        return;
      }
      assert.equal(cobProcessIdentity(sleeper.pid), "foreign");
      let ran = false;
      await withExclusiveLock(lockPath, async () => {
        ran = true;
      }, 1_000);
      assert.equal(ran, true);
    } finally {
      sleeper.kill("SIGKILL");
    }
  });

  it("recovers a lock whose live pid reused the recorded startKey", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "cob-startkey-reuse-"));
    const lockPath = join(dir, "cob.lock");
    const sleeper = spawn("sleep", ["30"]);
    try {
      assert.ok(sleeper.pid);
      if (processStartKey(sleeper.pid) === undefined) {
        t.skip("ps cannot inspect process start time in this environment");
        return;
      }
      writeFileSync(
        lockPath,
        `${JSON.stringify({
          pid: sleeper.pid,
          token: "stale-token",
          startKey: "not-the-real-start-key",
          argv: "cob serve",
          createdAt: new Date().toISOString(),
        })}\n`,
      );
      let ran = false;
      await withExclusiveLock(lockPath, async () => {
        ran = true;
      }, 1_000);
      assert.equal(ran, true);
    } finally {
      sleeper.kill("SIGKILL");
    }
  });

  it("refuses restore while a nonce-matching gateway is still healthy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-restore-live-"));
    const paths = resolvePaths(dir);
    writeFileSync(paths.profile, "keep-me\n");
    writeFileSync(paths.catalog, "{}\n");
    writeFileSync(paths.cobConfig, "[compaction]\nprovider = \"native\"\n");
    const nonce = "restore-nonce";
    const server = createServer((req, res) => {
      if (req.url?.includes("healthz")) {
        const presented = Array.isArray(req.headers["x-cob-nonce"])
          ? req.headers["x-cob-nonce"][0]
          : req.headers["x-cob-nonce"];
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            ok: true,
            service: "cob",
            pid: process.pid,
            nonce_ok: presented === nonce,
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      writeRuntime(paths, {
        pid: process.pid,
        port,
        ollamaUrl: "http://127.0.0.1:11434",
        startedAt: new Date().toISOString(),
        nonce,
      });
      await assert.rejects(() => restoreCob(paths), /still running/);
      assert.equal(existsSync(paths.profile), true);
      assert.equal(existsSync(paths.catalog), true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("cob argv identity", () => {
  it("does not treat a random cli.js as cob", () => {
    assert.equal(isOurCobArgv("node /tmp/cli.js restore"), false);
    assert.equal(isOurCobArgv("node /tmp/cli.js"), false);
    assert.equal(isOurCobArgv("sleep 30"), false);
  });

  it("recognizes the installed cob binary and dist/cli.js", () => {
    assert.equal(isOurCobArgv("cob restore"), true);
    assert.equal(isOurCobArgv("node /opt/cob/dist/cli.js serve --port 18790"), true);
    assert.equal(isOurCobArgv("node /Users/x/codex-ollama-bridge/dist/cli.js start"), true);
  });
});

describe("cross-process lock recovery", () => {
  it("does not let a recoverer delete the winner's new lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-lock-race-"));
    const lockPath = join(dir, "cob.lock");
    const flagDir = join(dir, "flags");
    mkdirSync(flagDir);
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: 99999999, token: "stale", argv: "cob serve", createdAt: new Date().toISOString() })}\n`,
    );
    const lockUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "core", "lock.js")).href;
    writeFileSync(
      join(dir, "racer.mjs"),
      `import { mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withExclusiveLock } from ${JSON.stringify(lockUrl)};
const lockPath = process.argv[2];
const flagDir = process.argv[3];
const held = join(flagDir, "critical");
await withExclusiveLock(lockPath, async () => {
  try {
    mkdirSync(held);
  } catch {
    writeFileSync(join(flagDir, "concurrent"), "1");
    throw new Error("concurrent critical section");
  }
  writeFileSync(join(flagDir, \`hold-\${process.pid}\`), readFileSync(lockPath));
  process.stdout.write("held\\n");
  await new Promise((resolve) => setTimeout(resolve, 120));
  rmdirSync(held);
}, 8_000);
`,
    );
    const children = Array.from({ length: 6 }, () =>
      spawn(process.execPath, [join(dir, "racer.mjs"), lockPath, flagDir], {
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    const exits = children.map(
      (child) =>
        new Promise<{ code: number | null; stderr: string }>((resolve) => {
          const err: Buffer[] = [];
          child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
          child.on("close", (code) => resolve({ code, stderr: Buffer.concat(err).toString("utf8") }));
        }),
    );
    const results = await Promise.all(exits);
    for (const result of results) {
      assert.equal(result.code, 0, result.stderr);
    }
    assert.equal(existsSync(join(flagDir, "concurrent")), false);
    const holds = readdirSync(flagDir).filter((name) => name.startsWith("hold-"));
    assert.equal(holds.length, 6);
  });
});

describe("overlay rollback and start lease", () => {
  it("restores previous overlays and never touches root config", () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-overlay-snap-"));
    const paths = resolvePaths(dir);
    writeFileSync(paths.rootConfig, "ROOT\n");
    writeFileSync(paths.catalog, "PREV-CATALOG\n");
    writeFileSync(paths.profile, "PREV-PROFILE\n");
    const snapshot = snapshotOverlays(paths);
    writeFileSync(paths.catalog, "NEW-CATALOG\n");
    writeFileSync(paths.profile, "NEW-PROFILE\n");
    writeFileSync(paths.cobConfig, "NEW-TOML\n");
    writeRuntime(paths, {
      pid: 123,
      port: 9,
      ollamaUrl: "http://127.0.0.1:1",
      startedAt: new Date().toISOString(),
    });
    restoreOverlays(paths, snapshot);
    assert.equal(readFileSync(paths.rootConfig, "utf8"), "ROOT\n");
    assert.equal(readFileSync(paths.catalog, "utf8"), "PREV-CATALOG\n");
    assert.equal(readFileSync(paths.profile, "utf8"), "PREV-PROFILE\n");
    assert.equal(existsSync(paths.cobConfig), false);
    assert.equal(existsSync(paths.runtime), false);
    assert.equal(existsSync(paths.pid), false);
  });

  it("preserves only a valid new failed-validation sidecar that matches the restored catalog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-overlay-failure-meta-"));
    const paths = resolvePaths(dir);
    const catalog = '{"models":[{"slug":"gpt-5.6-sol"}]}\n';
    const previousMeta = "PREV-META\n";
    writeFileSync(paths.catalog, catalog);
    writeFileSync(paths.catalogMeta, previousMeta);
    const snapshot = snapshotOverlays(paths);
    const bin = join(dir, "codex");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    const { parseCatalogMetadata, writeCatalogValidationFailure } = await import(
      "./codex/catalog/provenance.js"
    );
    const { resolveCatalogSources } = await import("./codex/catalog/source.js");
    const sources = resolveCatalogSources(
      { liveHome: false, platform: "darwin", pathBin: bin },
      { readVersion: () => "codex-cli test" },
    );
    writeCatalogValidationFailure({
      metaPath: paths.catalogMeta,
      candidateBytes: '{"models":[]}',
      retainedCatalogBytes: catalog,
      retainedMetadataBytes: null,
      sources,
      error: new Error("Codex rejected cob catalog: test field"),
    });
    const validFailure = readFileSync(paths.catalogMeta);
    restoreOverlays(paths, snapshot, { preserveCatalogValidationFailure: true });
    assert.equal(readFileSync(paths.catalog, "utf8"), catalog);
    assert.equal(readFileSync(paths.catalogMeta).equals(validFailure), true);
    const retained = parseCatalogMetadata(validFailure.toString("utf8"));
    assert.equal(retained.schema_version, 2);
    assert.ok(retained.schema_version === 2 && retained.last_failure);
    assert.equal(existsSync(paths.profile), false);

    writeFileSync(paths.catalogMeta, validFailure);
    writeFileSync(paths.profile, "UNCOMMITTED-PROFILE\n");
    restoreOverlays(paths, snapshot, { preserveCatalogValidationFailure: true });
    assert.equal(readFileSync(paths.catalogMeta, "utf8"), previousMeta);
    assert.equal(existsSync(paths.profile), false);

    for (const arbitrary of [
      "not-json\n",
      `${JSON.stringify({
        ...(retained.schema_version === 2 ? retained : {}),
        catalog_sha256: "0".repeat(64),
      })}\n`,
      `${JSON.stringify({
        ...(retained.schema_version === 2 ? retained : {}),
        last_failure: undefined,
      })}\n`,
    ]) {
      writeFileSync(paths.catalogMeta, arbitrary);
      restoreOverlays(paths, snapshot, { preserveCatalogValidationFailure: true });
      assert.equal(readFileSync(paths.catalogMeta, "utf8"), previousMeta);
    }
  });

  it("keeps foreground failed-validation diagnostics when no prior catalog exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-foreground-reject-empty-"));
    const paths = resolvePaths(dir);
    const accept = join(dir, "accept");
    const reject = join(dir, "reject");
    writeFileSync(accept, "#!/bin/sh\nprintf '%s\\n' '{\"models\":[{\"slug\":\"gpt-5.6-sol\"}]}'\n");
    writeFileSync(reject, "#!/bin/sh\necho 'Codex rejected cob catalog: missing consumer field' >&2\nexit 1\n");
    chmodSync(accept, 0o755);
    chmodSync(reject, 0o755);
    await assert.rejects(
      () =>
        serveForeground({
          paths,
          port: 1,
          ollamaUrl: "http://127.0.0.1:1",
          locked: true,
          discovery: {
            liveHome: true,
            platform: "darwin",
            desktopBins: [accept],
            pathBin: reject,
          },
          inspect: { readVersion: () => "codex-cli test" },
        }),
      /rejected cob catalog/,
    );
    assert.equal(existsSync(paths.catalog), false);
    assert.equal(existsSync(paths.profile), false);
    assert.equal(existsSync(paths.cobConfig), false);
    assert.equal(existsSync(paths.runtime), false);
    const { parseCatalogMetadata } = await import("./codex/catalog/provenance.js");
    const metadata = parseCatalogMetadata(readFileSync(paths.catalogMeta, "utf8"));
    assert.equal(metadata.schema_version, 2);
    assert.equal(metadata.schema_version === 2 ? metadata.catalog_sha256 : "unexpected", null);
    assert.ok(metadata.schema_version === 2 && metadata.last_failure);
  });

  it("restores exact last-good overlays when startup fails after a handled catalog rejection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-foreground-post-sync-fail-"));
    const paths = resolvePaths(dir);
    const accept = join(dir, "accept");
    const reject = join(dir, "reject");
    writeFileSync(accept, "#!/bin/sh\nprintf '%s\\n' '{\"models\":[{\"slug\":\"gpt-5.6-sol\"}]}'\n");
    writeFileSync(reject, "#!/bin/sh\necho 'Codex rejected cob catalog: missing consumer field' >&2\nexit 1\n");
    chmodSync(accept, 0o755);
    chmodSync(reject, 0o755);
    const catalog = '{"models":[{"slug":"gpt-5.6-sol","visibility":"list"}]}\n';
    writeFileSync(paths.catalog, catalog);
    writeFileSync(paths.profile, "PREV-PROFILE\n");
    // The strict cob.toml grammar rejects bare text; a comment is a valid
    // last-good placeholder that the parser skips.
    writeFileSync(paths.cobConfig, "# PREV-TOML\n");
    const discovery = {
      liveHome: true,
      platform: "darwin" as const,
      desktopBins: [accept],
      pathBin: reject,
    };
    const { resolveCatalogSources } = await import("./codex/catalog/source.js");
    const { writeCatalogProvenance } = await import("./codex/catalog/provenance.js");
    writeCatalogProvenance({
      metaPath: paths.catalogMeta,
      catalogBytes: catalog,
      sources: resolveCatalogSources(discovery, { readVersion: () => "codex-cli test" }),
    });
    const before = snapshotOverlays(paths);
    const occupied = createServer((_req, res) => res.end("occupied"));
    await new Promise<void>((resolve, rejectListen) => {
      occupied.once("error", rejectListen);
      occupied.listen(0, "127.0.0.1", () => resolve());
    });
    const address = occupied.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      await assert.rejects(
        () =>
          serveForeground({
            paths,
            port,
            ollamaUrl: "http://127.0.0.1:1",
            locked: true,
            discovery,
            inspect: { readVersion: () => "codex-cli test" },
          }),
        /EADDRINUSE|address already in use/i,
      );
      for (const file of [paths.profile, paths.catalog, paths.catalogMeta, paths.cobConfig]) {
        assert.equal(readFileSync(file).equals(before[file]!), true, file);
      }
      assert.equal(existsSync(paths.runtime), false);
      assert.equal(existsSync(paths.pid), false);
    } finally {
      await new Promise<void>((resolve, rejectClose) => {
        occupied.close((error) => (error ? rejectClose(error) : resolve()));
      });
    }
  });

  it("rolls back overlays when prepare fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-prepare-fail-"));
    const paths = resolvePaths(dir);
    writeFileSync(paths.rootConfig, "ROOT\n");
    writeFileSync(paths.catalog, "PREV-CATALOG\n");
    const previous = process.env.COB_CODEX_BIN;
    process.env.COB_CODEX_BIN = "definitely-missing-codex-bin-for-cob-test";
    try {
      await assert.rejects(
        () =>
          serveForeground({
            paths,
            port: 1,
            ollamaUrl: "http://127.0.0.1:1",
            locked: true,
          }),
        /ENOENT|not found|codex/i,
      );
      assert.equal(readFileSync(paths.rootConfig, "utf8"), "ROOT\n");
      assert.equal(readFileSync(paths.catalog, "utf8"), "PREV-CATALOG\n");
      assert.equal(existsSync(paths.runtime), false);
    } finally {
      if (previous === undefined) delete process.env.COB_CODEX_BIN;
      else process.env.COB_CODEX_BIN = previous;
    }
  });

  it("closes a listening gateway when a later runtime write fails", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "cob-serve-runtime-fail-"));
    const paths = resolvePaths(dir);
    const brokenParent = join("/dev", `cob-runtime-failure-${process.pid}-${Date.now()}`);
    try {
      mkdirSync(brokenParent);
      rmdirSync(brokenParent);
      t.skip("/dev is writable in this environment");
      return;
    } catch {
      // The test needs an unwritable parent that is still absent during rollback.
    }
    const codexBin = join(dir, "fake-codex");
    writeFileSync(
      codexBin,
      "#!/bin/sh\nprintf '%s\\n' '{\"models\":[{\"slug\":\"gpt-test\",\"visibility\":\"list\"}]}'\n",
    );
    chmodSync(codexBin, 0o755);
    const brokenPaths = { ...paths, runtime: join(brokenParent, "runtime") };
    const port = await freePort();
    await assert.rejects(
      () =>
        serveForeground({
          paths: brokenPaths,
          port,
          ollamaUrl: "http://127.0.0.1:1",
          locked: true,
          discovery: { liveHome: false, platform: "darwin", pathBin: codexBin },
          inspect: { readVersion: () => "codex-cli test" },
        }),
      /EACCES|EPERM|permission|read-only/i,
    );
    await assert.rejects(
      () => fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) }),
    );
    assert.equal(existsSync(paths.runtime), false);
  });

  it("refuses restore while a start lease pid is alive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-lease-restore-"));
    const paths = resolvePaths(dir);
    writeFileSync(paths.profile, "keep-me\n");
    writeFileSync(paths.catalog, "{}\n");
    writeFileSync(paths.cobConfig, "[compaction]\nprovider = \"native\"\n");
    writeFileSync(paths.rootConfig, "ROOT\n");
    const sleeper = spawn("sleep", ["30"]);
    try {
      assert.ok(sleeper.pid);
      writeStartLease(paths, {
        pid: sleeper.pid,
        nonce: "lease-nonce",
        startKey: processStartKey(sleeper.pid),
        createdAt: new Date().toISOString(),
      });
      const lease = readStartLease(paths);
      assert.ok(lease);
      assert.equal(isStartLeaseActive(lease), true);
      await assert.rejects(() => restoreCob(paths), /start in progress/);
      assert.equal(existsSync(paths.profile), true);
      assert.equal(existsSync(paths.catalog), true);
      assert.equal(readFileSync(paths.rootConfig, "utf8"), "ROOT\n");
    } finally {
      sleeper.kill("SIGKILL");
    }
  });

  it("refuses public sync while the live start launcher owns the lease", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-sync-lease-"));
    const paths = resolvePaths(dir);
    writeStartLease(paths, {
      pid: 99999999,
      nonce: "child-nonce",
      startKey: "dead-child",
      launcherPid: process.pid,
      launcherStartKey: processStartKey(process.pid),
      createdAt: new Date().toISOString(),
    });
    await assert.rejects(
      () => syncCatalog({ paths, ollamaUrl: "http://127.0.0.1:1" }),
      /cob start in progress/,
    );
  });

  it("keeps a configured no-tools model visible with shell disabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-sync-spawn-tools-"));
    const paths = resolvePaths(dir);
    const bin = join(dir, "fake-codex");
    writeFileSync(bin, "#!/bin/sh\nprintf '%s\\n' '{\"models\":[{\"slug\":\"gpt-5.6-sol\",\"visibility\":\"list\"}]}'\n");
    chmodSync(bin, 0o755);
    const ollamaPort = await freePort();
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          models: [
            {
              name: "deepseek-v4-flash:0731-cloud",
              capabilities: ["completion", "thinking"],
              details: { context_length: 32768 },
            },
          ],
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(ollamaPort, "127.0.0.1", () => resolve());
    });
    try {
      await syncCatalog({
        paths,
        ollamaUrl: `http://127.0.0.1:${ollamaPort}`,
        locked: true,
        discovery: { liveHome: false, platform: "darwin", pathBin: bin },
        inspect: { readVersion: () => "codex-cli test" },
      });
      const catalog = JSON.parse(readFileSync(paths.catalog, "utf8")) as {
        models: Array<Record<string, unknown>>;
      };
      const row = catalog.models.find(
        (model) => model.slug === "ollama/deepseek-v4-flash:0731-cloud",
      );
      assert.equal(row?.visibility, "list");
      assert.equal(row?.shell_type, "disabled");
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("refreshes the v2 profile when sync updates the catalog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-sync-profile-"));
    const paths = resolvePaths(dir);
    // A clean runner has no Codex installation; pin the producer the same way
    // the sibling sync tests do instead of relying on the ambient PATH.
    const bin = join(dir, "fake-codex");
    writeFileSync(bin, "#!/bin/sh\nprintf '%s\\n' '{\"models\":[{\"slug\":\"gpt-5.6-sol\",\"visibility\":\"list\"}]}'\n");
    chmodSync(bin, 0o755);
    const gatewayPort = 19876;
    const ollamaPort = await freePort();
    writeRuntime(paths, {
      pid: process.pid,
      port: gatewayPort,
      ollamaUrl: `http://127.0.0.1:${ollamaPort}`,
      startedAt: new Date().toISOString(),
    });
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [] }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(ollamaPort, "127.0.0.1", () => resolve());
    });
    try {
      await syncCatalog({
        paths,
        ollamaUrl: `http://127.0.0.1:${ollamaPort}`,
        discovery: { liveHome: false, platform: "darwin", pathBin: bin },
        inspect: { readVersion: () => "codex-cli test" },
      });
      const profile = readFileSync(paths.profile, "utf8");
      assert.match(profile, /openai_base_url = "http:\/\/127\.0\.0\.1:19876\/v1"/);
      assert.match(profile, /remote_compaction_v2 = true/);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("preserves explicit search false and clears failed-attempt metadata after a successful sync", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-sync-search-off-"));
    const paths = resolvePaths(dir);
    const bin = join(dir, "fake-codex");
    writeFileSync(bin, "#!/bin/sh\nprintf '%s\\n' '{\"models\":[{\"slug\":\"gpt-5.6-sol\",\"visibility\":\"list\"}]}'\n");
    chmodSync(bin, 0o755);
    writeFileSync(
      paths.cobConfig,
      `[compaction]\nprovider = "native"\n\n[catalog]\nsupports_search_tool = false\n`,
    );
    const { parseCatalogMetadata, writeCatalogValidationFailure } = await import(
      "./codex/catalog/provenance.js"
    );
    const { resolveCatalogSources } = await import("./codex/catalog/source.js");
    const sources = resolveCatalogSources(
      { liveHome: false, platform: "darwin", pathBin: bin },
      { readVersion: () => "codex-cli test" },
    );
    writeCatalogValidationFailure({
      metaPath: paths.catalogMeta,
      candidateBytes: '{"models":[]}',
      retainedCatalogBytes: null,
      retainedMetadataBytes: null,
      sources,
      error: new Error(`Codex rejected cob catalog (path ${realpathSync(bin)} codex-cli test)`),
    });
    assert.equal(parseCatalogMetadata(readFileSync(paths.catalogMeta, "utf8")).schema_version, 2);
    await syncCatalog({
      paths,
      ollamaUrl: "http://127.0.0.1:1",
      locked: true,
      discovery: { liveHome: false, platform: "darwin", pathBin: bin },
      inspect: { readVersion: () => "codex-cli test" },
    });
    assert.match(readFileSync(paths.cobConfig, "utf8"), /supports_search_tool = false/);
    const catalog = JSON.parse(readFileSync(paths.catalog, "utf8")) as {
      models: Array<{ slug?: string; supports_search_tool?: boolean }>;
    };
    const ollama = catalog.models.find((model) => String(model.slug).startsWith("ollama/"));
    if (ollama) assert.equal(ollama.supports_search_tool, false);
    // The v2 failure attempt is cleared; degraded Ollama discovery now persists
    // as schema 3 evidence instead of a bare v1 sidecar.
    const finalMeta = parseCatalogMetadata(readFileSync(paths.catalogMeta, "utf8"));
    assert.equal(finalMeta.schema_version, 3);
    assert.equal(
      finalMeta.schema_version === 3 && "ollama_discovery" in finalMeta
        ? finalMeta.ollama_discovery?.state
        : "",
      "degraded",
    );
  });

  it("keeps Gate 5 isolated and applies patch only to the configured spawn row during sync", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-sync-patch-opt-in-"));
    const paths = resolvePaths(dir);
    const bin = join(dir, "fake-codex");
    writeFileSync(
      bin,
      "#!/bin/sh\nprintf '%s\\n' '{\"models\":[{\"slug\":\"gpt-5.6-sol\",\"visibility\":\"list\",\"apply_patch_tool_type\":\"freeform\"}]}'\n",
    );
    chmodSync(bin, 0o755);
    writeFileSync(
      paths.cobConfig,
      `[compaction]\nprovider = "native"\n\n[subagents]\nmodels = ["ollama/deepseek-v4-flash:0731-cloud"]\n\n[catalog]\napply_patch = true\n`,
    );
    const ollamaPort = await freePort();
    const ollama = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          models: [
            { name: "deepseek-v4-flash:cloud", capabilities: ["completion", "tools", "thinking"] },
            { name: "deepseek-v4-flash:0731-cloud", capabilities: ["completion", "tools", "thinking"] },
          ],
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      ollama.once("error", reject);
      ollama.listen(ollamaPort, "127.0.0.1", () => resolve());
    });
    try {
      await syncCatalog({
        paths,
        ollamaUrl: `http://127.0.0.1:${ollamaPort}`,
        locked: true,
        discovery: { liveHome: false, platform: "darwin", pathBin: bin },
        inspect: { readVersion: () => "codex-cli test" },
      });
      const catalog = JSON.parse(readFileSync(paths.catalog, "utf8")) as {
        models: Array<Record<string, unknown>>;
      };
      const spawn = catalog.models.find((model) => model.slug === "ollama/deepseek-v4-flash:0731-cloud");
      const nonSpawn = catalog.models.find((model) => model.slug === "ollama/deepseek-v4-flash:cloud");
      const native = catalog.models.find((model) => model.slug === "gpt-5.6-sol");
      assert.equal(spawn?.apply_patch_tool_type, "freeform");
      assert.equal("apply_patch_tool_type" in (nonSpawn ?? {}), false);
      assert.equal(native?.apply_patch_tool_type, "freeform");
      assert.equal(spawn?.shell_type, "unified_exec");
      assert.equal(spawn?.multi_agent_version, "v1");
      assert.match(readFileSync(paths.cobConfig, "utf8"), /apply_patch = true/);
    } finally {
      await new Promise<void>((resolve, reject) => {
        ollama.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rolls back a failed detached start and restores previous overlays", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-start-rollback-"));
    const paths = resolvePaths(dir);
    writeFileSync(paths.rootConfig, "ROOT\n");
    writeFileSync(paths.catalog, "PREV-CATALOG\n");
    writeFileSync(paths.profile, "PREV-PROFILE\n");
    writeFileSync(paths.cobConfig, "[compaction]\nprovider = \"native\"\n");
    const port = await freePort();
    await assert.rejects(
      () =>
        startGatewayDetached({
          paths,
          port,
          ollamaUrl: "http://127.0.0.1:1",
          spawnServe: ({ token, nonce }) =>
            spawnFakeServe(dir, {
              token,
              nonce,
              port,
              crashAfterOverlays: true,
            }),
        }),
      /healthy|handoff|did not become/i,
    );
    assert.equal(readFileSync(paths.rootConfig, "utf8"), "ROOT\n");
    assert.equal(readFileSync(paths.catalog, "utf8"), "PREV-CATALOG\n");
    assert.equal(readFileSync(paths.profile, "utf8"), "PREV-PROFILE\n");
    assert.equal(existsSync(paths.runtime), false);
    assert.equal(existsSync(paths.startLease), false);
  });

  it("keeps a valid failed-validation sidecar through detached rollback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-start-rollback-failure-meta-"));
    const paths = resolvePaths(dir);
    const catalog = '{"models":[{"slug":"gpt-5.6-sol"}]}\n';
    writeFileSync(paths.catalog, catalog);
    writeFileSync(paths.profile, "PREV-PROFILE\n");
    writeFileSync(paths.cobConfig, "PREV-TOML\n");
    const bin = join(dir, "codex");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    const failurePath = join(dir, "failure-meta.json");
    const { resolveCatalogSources } = await import("./codex/catalog/source.js");
    const { writeCatalogValidationFailure } = await import("./codex/catalog/provenance.js");
    writeCatalogValidationFailure({
      metaPath: failurePath,
      candidateBytes: '{"models":[]}',
      retainedCatalogBytes: catalog,
      retainedMetadataBytes: null,
      sources: resolveCatalogSources(
        { liveHome: false, platform: "darwin", pathBin: bin },
        { readVersion: () => "codex-cli test" },
      ),
      error: new Error("Codex rejected cob catalog: detached test"),
    });
    const failureMetadata = readFileSync(failurePath, "utf8");
    const port = await freePort();
    await assert.rejects(
      () =>
        startGatewayDetached({
          paths,
          port,
          ollamaUrl: "http://127.0.0.1:1",
          spawnServe: ({ token, nonce }) =>
            spawnFakeServe(dir, {
              token,
              nonce,
              port,
              crashAfterOverlays: true,
              crashCatalogMeta: failureMetadata,
              crashRetainedCatalog: catalog,
              crashRestoredProfile: "PREV-PROFILE\n",
              crashRestoredCobConfig: "PREV-TOML\n",
            }),
        }),
      /healthy|handoff|did not become/i,
    );
    assert.equal(readFileSync(paths.catalog, "utf8"), catalog);
    assert.equal(readFileSync(paths.catalogMeta, "utf8"), failureMetadata);
    assert.equal(readFileSync(paths.profile, "utf8"), "PREV-PROFILE\n");
    assert.equal(readFileSync(paths.cobConfig, "utf8"), "PREV-TOML\n");
    assert.equal(existsSync(paths.runtime), false);
    assert.equal(existsSync(paths.startLease), false);
  });

  it("reconciles an orphan healthy-start lease whose launcher died", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-start-orphan-lease-"));
    const paths = resolvePaths(dir);
    const nonce = "orphan-lease-nonce";
    const port = await freePort();
    const gateway = spawnPlainHealthGateway(dir, port);
    try {
      writeRuntime(paths, {
        pid: gateway.pid!,
        port,
        ollamaUrl: "http://127.0.0.1:1",
        startedAt: new Date().toISOString(),
        nonce,
        startKey: processStartKey(gateway.pid!),
      });
      await waitForHealth(port, { attempts: 100, nonce, pid: gateway.pid });
      writeStartLease(paths, {
        pid: gateway.pid!,
        nonce,
        startKey: processStartKey(gateway.pid!),
        launcherPid: await deadProcessPid(),
        createdAt: new Date().toISOString(),
      });
      const result = await startGatewayDetached({
        paths,
        port,
        ollamaUrl: "http://127.0.0.1:1",
        spawnServe: () => {
          throw new Error("must not spawn while the runtime is healthy");
        },
      });
      assert.equal(result.alreadyRunning, true);
      assert.equal(result.runtime.nonce, nonce);
      assert.equal(readStartLease(paths), null);
    } finally {
      gateway.kill("SIGKILL");
    }
  });

  it("keeps a live-launcher lease over a healthy runtime with start in progress", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-start-live-lease-"));
    const paths = resolvePaths(dir);
    const nonce = "live-launcher-nonce";
    const port = await freePort();
    const gateway = spawnPlainHealthGateway(dir, port);
    const launcher = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    try {
      writeRuntime(paths, {
        pid: gateway.pid!,
        port,
        ollamaUrl: "http://127.0.0.1:1",
        startedAt: new Date().toISOString(),
        nonce,
        startKey: processStartKey(gateway.pid!),
      });
      await waitForHealth(port, { attempts: 100, nonce, pid: gateway.pid });
      writeStartLease(paths, {
        pid: gateway.pid!,
        nonce,
        startKey: processStartKey(gateway.pid!),
        launcherPid: launcher.pid!,
        launcherStartKey: processStartKey(launcher.pid!),
        createdAt: new Date().toISOString(),
      });
      await assert.rejects(
        () =>
          startGatewayDetached({
            paths,
            port,
            ollamaUrl: "http://127.0.0.1:1",
            spawnServe: () => {
              throw new Error("must not spawn while the launcher is live");
            },
          }),
        /already in progress/,
      );
      assert.equal(readStartLease(paths)?.nonce, nonce);
    } finally {
      gateway.kill("SIGKILL");
      launcher.kill("SIGKILL");
    }
  });

  it("does not count a live child as an adopted lock after the record vanished", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-lock-vanished-"));
    const lockPath = join(dir, "lock");
    const token = await acquireLock(lockPath);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      unlinkSync(lockPath);
      await assert.rejects(
        () => waitForLockAdopted(lockPath, token, child.pid!, 300),
        /not adopted|disappeared/,
      );
    } finally {
      child.kill("SIGKILL");
      releaseLock(lockPath);
    }
  });

  it("restores overlays even when spawnServe fails before a child exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-start-prechild-"));
    const paths = resolvePaths(dir);
    writeFileSync(paths.rootConfig, "ROOT\n");
    writeFileSync(paths.catalog, "PREV-CATALOG\n");
    writeFileSync(paths.profile, "PREV-PROFILE\n");
    writeFileSync(paths.cobConfig, "PREV-TOML\n");
    const port = await freePort();
    await assert.rejects(
      () =>
        startGatewayDetached({
          paths,
          port,
          ollamaUrl: "http://127.0.0.1:1",
          spawnServe: () => {
            throw new Error("spawn exploded before returning a child");
          },
        }),
      /spawn exploded/,
    );
    assert.equal(readFileSync(paths.rootConfig, "utf8"), "ROOT\n");
    assert.equal(readFileSync(paths.catalog, "utf8"), "PREV-CATALOG\n");
    assert.equal(readFileSync(paths.profile, "utf8"), "PREV-PROFILE\n");
    assert.equal(readFileSync(paths.cobConfig, "utf8"), "PREV-TOML\n");
    assert.equal(existsSync(paths.startLease), false);
    assert.equal(existsSync(paths.runtime), false);
  });

  it("keeps the start lease as rollback ownership proof through a commit-lost failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-start-commit-lost-"));
    const paths = resolvePaths(dir);
    writeFileSync(paths.rootConfig, "ROOT\n");
    writeFileSync(paths.catalog, "PREV-CATALOG\n");
    writeFileSync(paths.profile, "PREV-PROFILE\n");
    writeFileSync(paths.cobConfig, "PREV-TOML\n");
    const port = await freePort();
    await assert.rejects(
      () =>
        startGatewayDetached({
          paths,
          port,
          ollamaUrl: "http://127.0.0.1:1",
          spawnServe: ({ token, nonce }) =>
            spawnFakeServe(dir, {
              token,
              nonce,
              port,
              unlinkProfileAfterHealth: true,
            }),
        }),
      /commit lost/,
    );
    assert.equal(readFileSync(paths.rootConfig, "utf8"), "ROOT\n");
    assert.equal(readFileSync(paths.catalog, "utf8"), "PREV-CATALOG\n");
    assert.equal(readFileSync(paths.profile, "utf8"), "PREV-PROFILE\n");
    assert.equal(readFileSync(paths.cobConfig, "utf8"), "PREV-TOML\n");
    assert.equal(existsSync(paths.startLease), false);
    assert.equal(existsSync(paths.runtime), false);
  });

  it("does not roll back over a newer lock-protected operation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-start-rollback-owner-"));
    const paths = resolvePaths(dir);
    writeFileSync(paths.rootConfig, "ROOT\n");
    writeFileSync(paths.catalog, "PREV-CATALOG\n");
    writeFileSync(paths.profile, "PREV-PROFILE\n");
    writeFileSync(paths.cobConfig, "PREV-TOML\n");
    const port = await freePort();
    const ready = join(dir, "new-operation-ready");
    const helper = join(dir, "new-operation.mjs");
    const lockUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "core", "lock.js")).href;
    const lifecycleUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "codex", "runtime", "lifecycle.js")).href;
    const pathsUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "codex", "paths.js")).href;
    const processInfoUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "core", "process-info.js")).href;
    writeFileSync(
      helper,
      `import { unlinkSync, writeFileSync } from "node:fs";
import { withExclusiveLock } from ${JSON.stringify(lockUrl)};
import { writeStartLease } from ${JSON.stringify(lifecycleUrl)};
import { resolvePaths } from ${JSON.stringify(pathsUrl)};
import { processStartKey } from ${JSON.stringify(processInfoUrl)};
const paths = resolvePaths(process.argv[2]);
const ready = process.argv[3];
await withExclusiveLock(paths.lock, async () => {
  writeFileSync(paths.profile, "NEW-PROFILE\\n");
  writeFileSync(paths.catalog, "NEW-CATALOG\\n");
  writeFileSync(paths.cobConfig, "NEW-TOML\\n");
  writeStartLease(paths, {
    pid: process.pid,
    nonce: "new-operation",
    startKey: processStartKey(process.pid),
    createdAt: new Date().toISOString(),
  });
  writeFileSync(ready, "ready\\n");
  await new Promise((resolve) => setTimeout(resolve, 500));
});
`,
    );
    let helperProcess: ReturnType<typeof spawn> | undefined;
    const first = startGatewayDetached({
      paths,
      port,
      ollamaUrl: "http://127.0.0.1:1",
      spawnServe: ({ token, nonce }) => {
        helperProcess = spawn(process.execPath, [helper, dir, ready], {
          stdio: ["ignore", "ignore", "ignore"],
        });
        return spawnFakeServe(dir, {
          token,
          nonce,
          port,
          delayListenMs: 200,
          runtimeNonce: "wrong-runtime-nonce",
        });
      },
    });
    try {
      await assert.rejects(() => first, /runtime pid\/nonce|healthy|commit/i);
      assert.equal(await waitFor(() => existsSync(ready), 2_000), true);
      assert.ok(helperProcess);
      if (helperProcess.exitCode === null) {
        await new Promise<void>((resolve) => helperProcess?.once("close", () => resolve()));
      }
      assert.equal(readFileSync(paths.catalog, "utf8"), "NEW-CATALOG\n");
      assert.equal(readFileSync(paths.profile, "utf8"), "NEW-PROFILE\n");
      assert.equal(readFileSync(paths.cobConfig, "utf8"), "NEW-TOML\n");
    } finally {
      helperProcess?.kill("SIGKILL");
      try {
        unlinkSync(paths.startLease);
      } catch {
        // already cleared
      }
    }
  });

  it("does not report start success if restore runs during health", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-start-restore-race-"));
    const paths = resolvePaths(dir);
    writeFileSync(paths.rootConfig, "ROOT\n");
    writeFileSync(paths.catalog, "PREV-CATALOG\n");
    writeFileSync(paths.profile, "PREV-PROFILE\n");
    writeFileSync(paths.cobConfig, "[compaction]\nprovider = \"native\"\n");
    const port = await freePort();
    const starting = startGatewayDetached({
      paths,
      port,
      ollamaUrl: "http://127.0.0.1:1",
      spawnServe: ({ token, nonce }) =>
        spawnFakeServe(dir, {
          token,
          nonce,
          port,
          delayListenMs: 400,
        }),
    });
    const leaseSeen = await waitFor(() => existsSync(paths.startLease), 3_000);
    assert.equal(leaseSeen, true);
    await assert.rejects(() => restoreCob(paths), /start in progress/);
    const started = await starting;
    assert.equal(started.alreadyRunning, false);
    assert.equal(existsSync(paths.catalog), true);
    assert.equal(existsSync(paths.profile), true);
    assert.equal(existsSync(paths.runtime), true);
    assert.notEqual(readFileSync(paths.catalog, "utf8"), "PREV-CATALOG\n");
    await stopGateway(paths);
  });

  it("lets stop complete during start without deadlock, and start does not false-succeed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-start-stop-"));
    const paths = resolvePaths(dir);
    writeFileSync(paths.catalog, "PREV-CATALOG\n");
    writeFileSync(paths.profile, "PREV-PROFILE\n");
    writeFileSync(paths.cobConfig, "[compaction]\nprovider = \"native\"\n");
    const port = await freePort();
    const starting = startGatewayDetached({
      paths,
      port,
      ollamaUrl: "http://127.0.0.1:1",
      spawnServe: ({ token, nonce }) =>
        spawnFakeServe(dir, {
          token,
          nonce,
          port,
          delayListenMs: 200,
        }),
    });
    await waitFor(() => existsSync(paths.startLease), 3_000);
    const stop = stopGateway(paths);
    const startResult = await starting.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await stop.catch(() => undefined);
    if (startResult.ok) {
      await stopGateway(paths).catch(() => undefined);
    } else {
      assert.match(String(startResult.error), /healthy|lease|overlay|commit|did not become|still open/i);
      assert.equal(readFileSync(paths.catalog, "utf8"), "PREV-CATALOG\n");
    }
  });

  it("fails closed when a foreign listener still holds the port", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-foreign-port-"));
    const paths = resolvePaths(dir);
    writeFileSync(paths.rootConfig, "ROOT\n");
    writeFileSync(paths.profile, "keep-profile\n");
    writeFileSync(paths.catalog, "keep-catalog\n");
    writeFileSync(paths.cobConfig, "keep-toml\n");
    const foreign = createServer((req, res) => {
      res.end("not-cob");
    });
    await new Promise<void>((resolve) => {
      foreign.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = foreign.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      writeRuntime(paths, {
        pid: 99999999,
        port,
        ollamaUrl: "http://127.0.0.1:11434",
        startedAt: new Date().toISOString(),
        nonce: "foreign-nonce",
      });
      await assert.rejects(() => stopGateway(paths), /still open/);
      assert.equal(existsSync(paths.runtime), true);
      assert.equal(existsSync(paths.profile), true);
      assert.equal(existsSync(paths.catalog), true);
      assert.equal(readFileSync(paths.rootConfig, "utf8"), "ROOT\n");
      assert.equal(await isHealthyRuntime(readRuntime(paths)!), false);
      await assert.rejects(
        () =>
          startGatewayDetached({
            paths,
            port,
            ollamaUrl: "http://127.0.0.1:1",
            spawnServe: () => {
              throw new Error("start must not spawn over a foreign listener");
            },
          }),
        /still open|already running/i,
      );
      assert.equal(existsSync(paths.runtime), true);
      assert.equal(readFileSync(paths.catalog, "utf8"), "keep-catalog\n");
    } finally {
      await new Promise<void>((resolve, reject) => {
        foreign.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rejects a second start while a start lease is active, or treats a committed gateway as already running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-start-start-"));
    const paths = resolvePaths(dir);
    writeFileSync(paths.catalog, "PREV-CATALOG\n");
    writeFileSync(paths.profile, "PREV-PROFILE\n");
    writeFileSync(paths.cobConfig, "[compaction]\nprovider = \"native\"\n");
    const port = await freePort();
    const first = startGatewayDetached({
      paths,
      port,
      ollamaUrl: "http://127.0.0.1:1",
      spawnServe: ({ token, nonce }) =>
        spawnFakeServe(dir, {
          token,
          nonce,
          port,
          delayListenMs: 250,
        }),
    });
    await waitFor(() => existsSync(paths.startLease), 3_000);
    const second = startGatewayDetached({
      paths,
      port,
      ollamaUrl: "http://127.0.0.1:1",
      spawnServe: () => {
        throw new Error("second start must not spawn while the first lease is active");
      },
    });
    const secondResult = await second.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const firstResult = await first;
    if (secondResult.ok) {
      assert.equal(secondResult.value.alreadyRunning, true);
      assert.equal(secondResult.value.runtime.pid, firstResult.runtime.pid);
    } else {
      assert.match(String(secondResult.error), /in progress|already running/i);
    }
    assert.equal(firstResult.alreadyRunning, false);
    await stopGateway(paths);
  });
});

describe("cob status desktop overlay", () => {
  it("does not write root config.toml while reporting a missing Desktop overlay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-status-missing-"));
    const paths = resolvePaths(dir);
    const original = 'model = "gpt-5.6-luna"\n[features]\nremote_compaction_v2 = true\n';
    writeFileSync(paths.rootConfig, original);
    const report = await statusReport(paths);
    assert.equal(readFileSync(paths.rootConfig, "utf8"), original);
    assert.equal(report.ok, false);
    assert.match(report.text, /^cob: broken\n/);
    assert.match(report.text, /desktop overlay: broken/);
    assert.match(report.text, /openai_base_url is missing/);
    assert.match(report.text, /cob restore does not revert config.toml/);
  });

  it("reports unknown provenance when a live catalog has no sidecar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-status-unknown-"));
    const paths = resolvePaths(dir);
    writeFileSync(
      paths.catalog,
      `${JSON.stringify({
        models: [
          { slug: "gpt-5.6-sol", visibility: "list", priority: 0 },
          { slug: "gpt-5.6-terra", visibility: "list", priority: 1 },
          { slug: "gpt-5.6-luna", visibility: "list", priority: 2 },
        ],
      })}\n`,
    );
    writeFileSync(
      paths.profile,
      `model_provider = "openai"\nopenai_base_url = "http://127.0.0.1:18790/v1"\nmodel_catalog_json = ${JSON.stringify(paths.catalog)}\n`,
    );
    writeFileSync(
      paths.rootConfig,
      `model_provider = "openai"\nopenai_base_url = "http://127.0.0.1:18790/v1"\nmodel_catalog_json = ${JSON.stringify(paths.catalog)}\n`,
    );
    const report = await statusReport(paths, {
      discovery: { liveHome: true, platform: "darwin", desktopBins: [], pathBin: undefined },
    });
    assert.equal(report.ok, false);
    assert.match(report.text, /^cob: unknown\n/);
    assert.match(report.text, /catalog provenance: unknown/);
    assert.match(report.text, /cob sync or cob start/);
  });

  it("reports a ready Desktop overlay when root keys match cob, provenance is fresh, and the gateway is stopped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-status-ready-"));
    const paths = resolvePaths(dir);
    const bin = join(dir, "fake-codex");
    writeFileSync(bin, "#!/bin/sh\nprintf '%s\\n' 'codex-cli test'\n");
    chmodSync(bin, 0o755);
    const catalog = {
      models: [
        { slug: "gpt-5.6-sol", visibility: "list", priority: 0 },
        { slug: "gpt-5.6-terra", visibility: "list", priority: 1 },
        { slug: "gpt-5.6-luna", visibility: "list", priority: 2 },
        { slug: "ollama/deepseek-v4-flash:0731-cloud", visibility: "list", priority: 3 },
      ],
    };
    const catalogText = `${JSON.stringify(catalog, null, 2)}\n`;
    writeFileSync(paths.catalog, catalogText);
    const { resolveCatalogSources } = await import("./codex/catalog/source.js");
    const { writeCatalogProvenance } = await import("./codex/catalog/provenance.js");
    const discovery = { liveHome: true, platform: "darwin" as const, desktopBins: [], pathBin: bin };
    writeCatalogProvenance({
      metaPath: paths.catalogMeta,
      catalogBytes: catalogText,
      sources: resolveCatalogSources(discovery, { readVersion: () => "codex-cli test" }),
    });
    writeFileSync(
      paths.profile,
      `model_provider = "openai"\nopenai_base_url = "http://127.0.0.1:18790/v1"\nmodel_catalog_json = ${JSON.stringify(paths.catalog)}\n`,
    );
    const original = [
      "model_reasoning_effort = \"medium\"",
      'model = "ollama/deepseek-v4-flash:0731-cloud"',
      'model_provider = "openai"',
      'openai_base_url = "http://127.0.0.1:18790/v1"',
      `model_catalog_json = ${JSON.stringify(paths.catalog)}`,
      "",
      "[features]",
      "remote_compaction_v2 = true",
      "",
    ].join("\n");
    writeFileSync(paths.rootConfig, original);
    const report = await statusReport(paths, {
      discovery,
      inspect: { readVersion: () => "" },
    });
    assert.equal(readFileSync(paths.rootConfig, "utf8"), original);
    assert.equal(report.ok, false);
    assert.match(report.text, /^cob: ready\n/);
    assert.match(report.text, /gateway: stopped/);
    assert.match(report.text, /desktop overlay: ready \(gateway stopped; run cob start\)/);
    assert.match(report.text, /catalog provenance: fresh/);
  });

  it("treats a stopped isolated home with no catalog as stale, not ready", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-status-isolated-"));
    const paths = resolvePaths(dir);
    const report = await statusReport(paths);
    assert.equal(report.ok, false);
    assert.match(report.text, /^cob: stale\n/);
    assert.match(report.text, /isolated Codex home/);
    assert.match(report.text, /desktop overlay: no root config.toml/);
  });

  it("never invokes a Codex subprocess from status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-status-nospawn-"));
    const paths = resolvePaths(dir);
    const marker = join(dir, "spawned");
    const bin = join(dir, "fake-codex");
    writeFileSync(bin, `#!/bin/sh\nprintf '' > ${JSON.stringify(marker)}\nprintf '%s\\n' 'codex-cli spawned'\n`);
    chmodSync(bin, 0o755);
    const catalog = {
      models: [
        { slug: "gpt-5.6-sol", visibility: "list", priority: 0 },
        { slug: "gpt-5.6-terra", visibility: "list", priority: 1 },
        { slug: "gpt-5.6-luna", visibility: "list", priority: 2 },
      ],
    };
    const catalogText = `${JSON.stringify(catalog, null, 2)}\n`;
    writeFileSync(paths.catalog, catalogText);
    const { resolveCatalogSources } = await import("./codex/catalog/source.js");
    const { writeCatalogProvenance } = await import("./codex/catalog/provenance.js");
    const discovery = { liveHome: false, platform: "darwin" as const, desktopBins: [], pathBin: bin };
    writeCatalogProvenance({
      metaPath: paths.catalogMeta,
      catalogBytes: catalogText,
      sources: resolveCatalogSources(discovery, { readVersion: () => "codex-cli test" }),
    });
    const report = await statusReport(paths, { discovery });
    assert.equal(existsSync(marker), false);
    assert.match(report.text, /catalog provenance: fresh/);
  });

  it("changes the first line and exit code when catalog provenance is stale", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-status-stale-"));
    const paths = resolvePaths(dir);
    writeFileSync(
      paths.catalog,
      `${JSON.stringify({
        models: [
          { slug: "gpt-5.6-sol", visibility: "list", priority: 0 },
          { slug: "gpt-5.6-terra", visibility: "list", priority: 1 },
          { slug: "gpt-5.6-luna", visibility: "list", priority: 2 },
        ],
      })}\n`,
    );
    writeFileSync(paths.catalogMeta, JSON.stringify({ schema_version: 1, catalog_sha256: "deadbeef" }));
    const report = await statusReport(paths, {
      discovery: { liveHome: false, platform: "darwin", desktopBins: [], pathBin: undefined },
    });
    assert.equal(report.ok, false);
    assert.match(report.text, /^cob: stale\n/);
    assert.match(report.text, /catalog provenance: stale/);
  });

  it("emits a stable JSON status derived from the same assessment as the human output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-status-json-"));
    const paths = resolvePaths(dir);
    const report = await statusReport(paths, {
      discovery: { liveHome: false, platform: "darwin", desktopBins: [], pathBin: undefined },
    });
    assert.equal(report.json.schema_version, 1);
    assert.equal(report.json.kind, "stale");
    assert.equal(report.json.needs_action, !report.ok);
    assert.match(report.text, new RegExp(`^cob: ${report.json.kind}\n`));
    assert.equal(report.json.gateway.running, false);
    assert.equal(report.json.gateway.healthy, false);
    assert.equal(report.json.overlay, "absent");
    assert.equal(report.json.catalog.present, false);
    assert.equal(report.json.catalog.freshness, "missing");
    assert.deepEqual(report.json.action_codes, ["cob_start", "cob_sync"]);
    assert.equal(report.json.home.kind, "isolated");
    // JSON must serialize without throwing and without leaking the runtime nonce.
    const serialized = JSON.stringify(report.json);
    assert.equal(serialized.includes("nonce"), false);
    assert.doesNotThrow(() => JSON.parse(serialized));
    // Content-free JSON: no absolute home path or account identifier; only
    // the stable home kind leaves the machine.
    assert.equal(serialized.includes("codex_home"), false);
    assert.equal(serialized.includes(dir), false);
    assert.equal(serialized.includes(homedir()), false);
  });

  it("serializes missing and corrupt sidecars and stopped gateways without throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-status-json-corrupt-"));
    const paths = resolvePaths(dir);
    writeFileSync(paths.catalog, "{}\n");
    writeFileSync(paths.catalogMeta, "{not json");
    const report = await statusReport(paths, {
      discovery: { liveHome: false, platform: "darwin", desktopBins: [], pathBin: undefined },
    });
    assert.doesNotThrow(() => JSON.stringify(report.json));
    assert.equal(report.json.catalog.meta_present, true);
    assert.notEqual(report.json.catalog.freshness, "fresh");
    assert.equal(report.json.gateway.running, false);
  });

  it("does not report a stale runtime record as a running gateway", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-status-stale-runtime-"));
    const paths = resolvePaths(dir);
    const dead = spawnSync("true");
    assert.equal(dead.status, 0);
    assert.ok(dead.pid);
    writeRuntime(paths, {
      pid: dead.pid!,
      port: 1,
      ollamaUrl: "http://127.0.0.1:1",
      startedAt: "2026-08-31T00:00:00.000Z",
    });
    const report = await statusReport(paths);
    assert.equal(report.json.gateway.healthy, false);
    // The runtime JSON alone is not evidence: a dead recorded pid must not
    // report running=true, and status stays read-only.
    assert.equal(report.json.gateway.running, false);
    assert.ok(report.json.action_codes.includes("cob_start"));
    assert.match(report.text, /no live cob process/);
  });

  it("keeps the previous catalog and embeds its provenance when a second consumer rejects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-sync-reject-"));
    const paths = resolvePaths(dir);
    const accept = join(dir, "accept");
    const reject = join(dir, "reject");
    writeFileSync(accept, "#!/bin/sh\nprintf '%s\\n' '{\"models\":[{\"slug\":\"gpt-5.6-sol\"}]}'\n");
    writeFileSync(reject, "#!/bin/sh\necho 'Codex rejected cob catalog: supports_parallel_tool_calls' >&2\nexit 1\n");
    chmodSync(accept, 0o755);
    chmodSync(reject, 0o755);
    const previous = `${JSON.stringify({
      models: [
        { slug: "gpt-5.6-sol", visibility: "list", priority: 0 },
        { slug: "gpt-5.6-terra", visibility: "list", priority: 1 },
        { slug: "gpt-5.6-luna", visibility: "list", priority: 2 },
      ],
    })}\n`;
    writeFileSync(paths.catalog, previous);
    const discovery = {
      liveHome: true,
      platform: "darwin" as const,
      desktopBins: [accept],
      pathBin: reject,
    };
    const { parseCatalogMetadata, writeCatalogProvenance } = await import(
      "./codex/catalog/provenance.js"
    );
    const { resolveCatalogSources } = await import("./codex/catalog/source.js");
    writeCatalogProvenance({
      metaPath: paths.catalogMeta,
      catalogBytes: previous,
      sources: resolveCatalogSources(discovery, { readVersion: () => "codex-cli test" }),
    });
    const previousMetadata = parseCatalogMetadata(readFileSync(paths.catalogMeta, "utf8"));
    await assert.rejects(
      () =>
        syncCatalog({
          paths,
          ollamaUrl: "http://127.0.0.1:1",
          locked: true,
          discovery,
          inspect: { readVersion: () => "codex-cli test" },
        }),
      /rejected cob catalog/,
    );
    assert.equal(readFileSync(paths.catalog, "utf8"), previous);
    const metadata = parseCatalogMetadata(readFileSync(paths.catalogMeta, "utf8"));
    assert.equal(metadata.schema_version, 2);
    assert.equal(metadata.schema_version === 2 ? metadata.active.state : "", "known");
    assert.deepEqual(
      metadata.schema_version === 2 ? metadata.active : undefined,
      previousMetadata.schema_version === 1
        ? {
            state: "known",
            generated_at: previousMetadata.generated_at,
            producer: previousMetadata.producer,
            validators: previousMetadata.validators,
          }
        : undefined,
    );
    assert.equal(
      metadata.schema_version === 2 ? metadata.catalog_sha256 : undefined,
      previousMetadata.catalog_sha256,
    );
    assert.equal(
      metadata.schema_version === 2 ? metadata.last_failure?.rejected_validator?.path : undefined,
      realpathSync(reject),
    );
    assert.match(
      metadata.schema_version === 2 ? (metadata.last_failure?.diagnostic.summary ?? "") : "",
      /supports_parallel_tool_calls/,
    );
  });

  it("starts from the last known-good catalog when a second consumer rejects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-start-keep-"));
    const paths = resolvePaths(dir);
    const accept = join(dir, "accept");
    const reject = join(dir, "reject");
    writeFileSync(accept, "#!/bin/sh\nprintf '%s\\n' '{\"models\":[{\"slug\":\"gpt-5.6-sol\"}]}'\n");
    writeFileSync(reject, "#!/bin/sh\necho 'Codex rejected cob catalog: supports_parallel_tool_calls' >&2\nexit 1\n");
    chmodSync(accept, 0o755);
    chmodSync(reject, 0o755);
    const previous = `${JSON.stringify({
      models: [
        { slug: "gpt-5.6-sol", visibility: "list", priority: 0 },
        { slug: "gpt-5.6-terra", visibility: "list", priority: 1 },
        { slug: "gpt-5.6-luna", visibility: "list", priority: 2 },
      ],
    })}\n`;
    writeFileSync(paths.catalog, previous);
    writeFileSync(paths.catalogMeta, "PREV-META\n");
    const prepared = await prepareProfileAndCatalog({
      paths,
      ollamaUrl: "http://127.0.0.1:1",
      locked: true,
      discovery: {
        liveHome: true,
        platform: "darwin",
        desktopBins: [accept],
        pathBin: reject,
      },
      inspect: { readVersion: () => "codex-cli test" },
    });
    assert.equal(prepared.wrote, false);
    assert.equal(readFileSync(paths.catalog, "utf8"), previous);
    const { parseCatalogMetadata } = await import("./codex/catalog/provenance.js");
    const metadata = parseCatalogMetadata(readFileSync(paths.catalogMeta, "utf8"));
    assert.equal(metadata.schema_version, 2);
    assert.equal(metadata.schema_version === 2 ? metadata.active.state : "", "unknown");
    assert.match(String(prepared.ollamaError), /supports_parallel_tool_calls/);
  });

  it("reports a redacted failed validation for a retained legacy catalog with no sidecar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-sync-reject-legacy-"));
    const paths = resolvePaths(dir);
    const accept = join(dir, "accept");
    const reject = join(dir, "reject");
    writeFileSync(accept, "#!/bin/sh\nprintf '%s\\n' '{\"models\":[{\"slug\":\"gpt-5.6-sol\"}]}'\n");
    writeFileSync(
      reject,
      "#!/bin/sh\necho 'Codex rejected cob catalog: field supports_parallel_tool_calls secret=DO-NOT-PERSIST' >&2\nexit 1\n",
    );
    chmodSync(accept, 0o755);
    chmodSync(reject, 0o755);
    const previous = `${JSON.stringify({
      models: [
        { slug: "gpt-5.6-sol", visibility: "list", priority: 0 },
        { slug: "gpt-5.6-terra", visibility: "list", priority: 1 },
        { slug: "gpt-5.6-luna", visibility: "list", priority: 2 },
      ],
    })}\n`;
    writeFileSync(paths.catalog, previous);
    assert.equal(existsSync(paths.catalogMeta), false);
    const discovery = {
      liveHome: true,
      platform: "darwin" as const,
      desktopBins: [accept],
      pathBin: reject,
    };
    await assert.rejects(
      () =>
        syncCatalog({
          paths,
          ollamaUrl: "http://127.0.0.1:1",
          locked: true,
          discovery,
          inspect: { readVersion: () => "codex-cli test" },
        }),
      /rejected cob catalog/,
    );
    assert.equal(readFileSync(paths.catalog, "utf8"), previous);
    assert.equal(existsSync(paths.catalogMeta), true);
    const diagnostic = readFileSync(paths.catalogMeta, "utf8");
    assert.doesNotMatch(diagnostic, /DO-NOT-PERSIST/);
    const { parseCatalogMetadata } = await import("./codex/catalog/provenance.js");
    const metadata = parseCatalogMetadata(diagnostic);
    assert.equal(metadata.schema_version, 2);
    assert.equal(metadata.schema_version === 2 ? metadata.active.state : "", "unknown");
    assert.match(
      metadata.schema_version === 2 && metadata.active.state === "unknown"
        ? metadata.active.reason
        : "",
      /legacy catalog had no cob-catalog\.meta\.json/,
    );

    const report = await statusReport(paths, {
      discovery,
      inspect: {
        readVersion: () => {
          throw new Error("status must not execute Codex");
        },
      },
    });
    assert.equal(report.ok, false);
    assert.match(report.text, /^cob: unknown\n/);
    assert.match(report.text, /last candidate validation: failed/);
    assert.match(report.text, /supports_parallel_tool_calls/);
    assert.match(report.text, /legacy catalog had no cob-catalog\.meta\.json/);
    assert.doesNotMatch(report.text, /DO-NOT-PERSIST/);
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on("error", reject);
  });
}

function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return check();
  })();
}

function spawnPlainHealthGateway(dir: string, port: number): ChildProcess {
  const script = join(dir, `plain-health-${Math.random().toString(16).slice(2)}.mjs`);
  writeFileSync(
    script,
    `import { createServer } from "node:http";
const server = createServer((_req, res) => {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, service: "cob", pid: process.pid, nonce_ok: true }));
});
server.listen(Number(process.argv[2]), "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
`,
  );
  return spawn(process.execPath, [script, String(port)], { stdio: "ignore" });
}

async function deadProcessPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid!;
}

function spawnFakeServe(
  dir: string,
  opts: {
    token: string;
    nonce: string;
    port: number;
    crashAfterOverlays?: boolean;
    crashCatalogMeta?: string;
    crashRetainedCatalog?: string;
    crashRestoredProfile?: string;
    crashRestoredCobConfig?: string;
    delayListenMs?: number;
    unlinkProfileAfterHealth?: boolean;
    runtimeNonce?: string;
  },
) {
  const script = join(dir, `fake-serve-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  const lockUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "core", "lock.js")).href;
  const lifecycleUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "codex", "runtime", "runtime.js")).href;
  const pathsUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "codex", "paths.js")).href;
  writeFileSync(
    script,
    `import { createServer } from "node:http";
import { unlinkSync, writeFileSync } from "node:fs";
import { adoptLock, releaseLock } from ${JSON.stringify(lockUrl)};
import { writeRuntime } from ${JSON.stringify(lifecycleUrl)};
import { resolvePaths } from ${JSON.stringify(pathsUrl)};

const paths = resolvePaths(process.env.COB_CODEX_HOME);
adoptLock(paths.lock, process.env.COB_LOCK_TOKEN ?? "");
writeFileSync(paths.profile, "profile\\n");
writeFileSync(paths.catalog, "{\\"models\\":[]}\\n");
writeFileSync(paths.cobConfig, "[compaction]\\nprovider = \\"native\\"\\n");
// The launcher's handoff watch polls the adopted lock record; a real serve
// boot keeps that window open long enough to observe. Emulate it here.
await new Promise((resolve) => setTimeout(resolve, 120));
if (process.env.COB_FAKE_SERVE_CRASH === "1") {
  if (process.env.COB_FAKE_SERVE_RETAINED_CATALOG) {
    writeFileSync(paths.catalog, process.env.COB_FAKE_SERVE_RETAINED_CATALOG);
  }
  if (process.env.COB_FAKE_SERVE_RESTORED_PROFILE) {
    writeFileSync(paths.profile, process.env.COB_FAKE_SERVE_RESTORED_PROFILE);
  }
  if (process.env.COB_FAKE_SERVE_RESTORED_COB_CONFIG) {
    writeFileSync(paths.cobConfig, process.env.COB_FAKE_SERVE_RESTORED_COB_CONFIG);
  }
  if (process.env.COB_FAKE_SERVE_CATALOG_META) {
    writeFileSync(paths.catalogMeta, process.env.COB_FAKE_SERVE_CATALOG_META);
  }
  releaseLock(paths.lock);
  process.exit(1);
}
releaseLock(paths.lock);
const delay = Number(process.env.COB_FAKE_SERVE_DELAY_MS ?? "0");
if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
const port = Number(process.env.COB_PORT);
const nonce = process.env.COB_RUNTIME_NONCE;
const runtimeNonce = process.env.COB_FAKE_SERVE_RUNTIME_NONCE || nonce;
let healthHits = 0;
const server = createServer((req, res) => {
  const url = req.url ?? "";
  if (url.includes("healthz") || url.includes("/health")) {
    healthHits += 1;
    if (healthHits === 2 && process.env.COB_FAKE_SERVE_UNLINK_PROFILE_AFTER === "1") {
      unlinkSync(paths.profile);
    }
    const presented = Array.isArray(req.headers["x-cob-nonce"])
      ? req.headers["x-cob-nonce"][0]
      : req.headers["x-cob-nonce"];
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      service: "cob",
      pid: process.pid,
      nonce_ok: presented === nonce,
    }));
    return;
  }
  if (url.includes("/cob/shutdown")) {
    res.statusCode = 200;
    res.end("{}");
    process.exit(0);
  }
  res.statusCode = 404;
  res.end();
});
await new Promise((resolve, reject) => {
  server.listen(port, "127.0.0.1", () => resolve(undefined));
  server.on("error", reject);
});
writeRuntime(paths, {
  pid: process.pid,
  port,
  ollamaUrl: "http://127.0.0.1:1",
  startedAt: new Date().toISOString(),
  nonce: runtimeNonce,
});
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
`,
  );
  return spawn(process.execPath, [script], {
    env: {
      ...process.env,
      COB_CODEX_HOME: dir,
      COB_LOCK_TOKEN: opts.token,
      COB_RUNTIME_NONCE: opts.nonce,
      COB_PORT: String(opts.port),
      COB_FAKE_SERVE_CRASH: opts.crashAfterOverlays ? "1" : "",
      COB_FAKE_SERVE_CATALOG_META: opts.crashCatalogMeta ?? "",
      COB_FAKE_SERVE_RETAINED_CATALOG: opts.crashRetainedCatalog ?? "",
      COB_FAKE_SERVE_RESTORED_PROFILE: opts.crashRestoredProfile ?? "",
      COB_FAKE_SERVE_RESTORED_COB_CONFIG: opts.crashRestoredCobConfig ?? "",
      COB_FAKE_SERVE_DELAY_MS: String(opts.delayListenMs ?? 0),
      COB_FAKE_SERVE_UNLINK_PROFILE_AFTER: opts.unlinkProfileAfterHealth ? "1" : "",
      COB_FAKE_SERVE_RUNTIME_NONCE: opts.runtimeNonce ?? "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function holdsOpenDescriptorFor(filePath: string): boolean | undefined {
  const real = realpathSync(filePath);
  const result = spawnSync("lsof", ["-wFn", real], { encoding: "utf8" });
  if (result.error) return undefined;
  return (result.stdout ?? "").includes(`n${real}`);
}

describe("private log target", () => {
  it("refuses a symlinked log target without touching the real file", () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-log-symlink-"));
    const real = join(dir, "real.log");
    writeFileSync(real, "REAL\n", { mode: 0o600 });
    const link = join(dir, "link.log");
    symlinkSync(real, link);
    try {
      assert.throws(() => openPrivateLogFd(link), /ELOOP|log target/i);
      assert.equal(readFileSync(real, "utf8"), "REAL\n");
      assert.notEqual(existsSync(link), false);
    } finally {
      unlinkSync(link);
    }
  });

  it("refuses a directory log target", () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-log-dir-"));
    assert.throws(() => openPrivateLogFd(dir), /EISDIR|log target/i);
  });

  it("re-privileges an existing non-private log and appends through the fd", () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-log-mode-"));
    const logPath = join(dir, "cob.log");
    writeFileSync(logPath, "PREV\n", { mode: 0o644 });
    const fd = openPrivateLogFd(logPath);
    try {
      assert.equal(fstatSync(fd).mode & 0o777, 0o600);
      writeSync(fd, Buffer.from("APPEND\n"));
    } finally {
      closePrivateLogFd(fd);
    }
    assert.equal(readFileSync(logPath, "utf8"), "PREV\nAPPEND\n");
    assert.equal(statSync(logPath).mode & 0o777, 0o600);
  });

  it("rejects a log target owned by a different uid", (t) => {
    if (process.getuid?.() === undefined) {
      t.skip("uid checks unsupported on this platform");
      return;
    }
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      t.skip("requires root to simulate a foreign owner");
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "cob-log-uid-"));
    const logPath = join(dir, "cob.log");
    writeFileSync(logPath, "ROOT-OWNED\n", { mode: 0o600 });
    chownSync(logPath, 1, 1);
    assert.throws(() => openPrivateLogFd(logPath), /not owned/);
  });

  it("closes the launcher log fd when a detached start fails", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "cob-logfd-close-"));
    const paths = resolvePaths(dir);
    writeFileSync(paths.rootConfig, "ROOT\n");
    const foreign = createServer((req, res) => {
      res.end("not-cob");
    });
    await new Promise<void>((resolve) => {
      foreign.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = foreign.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    writeRuntime(paths, {
      pid: 99999999,
      port,
      ollamaUrl: "http://127.0.0.1:11434",
      startedAt: new Date().toISOString(),
      nonce: "foreign-nonce",
    });
    const flags: CliFlags = {
      surface: "codex",
      command: "start",
      port,
      portExplicit: true,
      ollamaUrl: "http://127.0.0.1:11434",
      foreground: false,
      live: false,
      dev: true,
      liveHome: false,
      desktop: false,
      json: false,
      home: dir,
    };
    try {
      await assert.rejects(() => runCodexCli(flags), /still open|already running/i);
      let leaked = holdsOpenDescriptorFor(paths.log);
      if (leaked === undefined) {
        t.skip("no per-process fd listing on this platform");
        return;
      }
      for (let i = 0; i < 100 && leaked; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        leaked = holdsOpenDescriptorFor(paths.log);
      }
      assert.equal(leaked, false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        foreign.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("root config read taxonomy", () => {
  it("returns null only for a missing root config", () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-rootcfg-missing-"));
    const paths = resolvePaths(dir);
    assert.equal(readRootConfig(paths), null);
  });

  it("fails typed when the root config is unreadable", async (t) => {
    if (process.getuid?.() === 0) {
      t.skip("permission failure requires a non-root process");
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "cob-rootcfg-eacces-"));
    const paths = resolvePaths(dir);
    writeFileSync(paths.rootConfig, "model = \"x\"\n", { mode: 0o600 });
    chmodSync(paths.rootConfig, 0o000);
    try {
      assert.throws(() => readRootConfig(paths), RootConfigUnreadableError);
    } finally {
      chmodSync(paths.rootConfig, 0o600);
    }
  });

  it("fails typed when the root config path is a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-rootcfg-eisdir-"));
    const paths = resolvePaths(dir);
    mkdirSync(paths.rootConfig, { recursive: true });
    assert.throws(() => readRootConfig(paths), (error: unknown) => {
      assert.ok(error instanceof RootConfigUnreadableError);
      assert.match(String(error), /EISDIR/);
      assert.doesNotMatch(String(error), /model =/);
      return true;
    });
  });
});

describe("standalone sync publication rollback", () => {
  const ROOT_BYTES = "ROOT\n";
  const BUNDLED_A = JSON.stringify({
    models: [{ slug: "gpt-5.6-sol", visibility: "list", priority: 0 }],
  });
  const BUNDLED_B = JSON.stringify({
    models: [
      { slug: "gpt-5.6-sol", visibility: "list", priority: 9 },
      { slug: "gpt-5.7-terra", visibility: "list", priority: 1 },
    ],
  });

  function writeCodexBin(dir: string, name: "accept" | "reject", bundledPath: string): string {
    const path = join(dir, name);
    const emit = `if [ "$3" = "--bundled" ]; then\n  cat "${bundledPath}"\n  exit 0\nfi\n`;
    const body =
      name === "reject"
        ? `${emit}echo 'Codex rejected cob catalog: missing consumer field' >&2\nexit 1\n`
        : `${emit}exit 0\n`;
    writeFileSync(path, `#!/bin/sh\n${body}`);
    chmodSync(path, 0o755);
    return path;
  }

  function brokenParent(): { path: string; cleanup: () => void } {
    const path = join(tmpdir(), `cob-sync-broken-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(path);
    chmodSync(path, 0o555);
    return {
      path,
      cleanup: () => {
        chmodSync(path, 0o755);
        rmSync(path, { recursive: true, force: true });
      },
    };
  }

  function syncHome(dir: string, bin: string) {
    const paths = resolvePaths(dir);
    writeFileSync(paths.rootConfig, ROOT_BYTES);
    writeFileSync(paths.cobConfig, "# cob\n");
    const bundledPath = join(dir, "bundled.json");
    writeFileSync(bundledPath, BUNDLED_A);
    const discovery = { liveHome: false, platform: "darwin" as const, pathBin: bin };
    const inspect = { readVersion: () => "codex-cli test" };
    const syncOpts = () => ({
      paths,
      ollamaUrl: "http://127.0.0.1:1",
      discovery,
      inspect,
      locked: true,
    });
    const published = () => ({
      catalog: readFileSync(paths.catalog),
      meta: readFileSync(paths.catalogMeta),
      profile: readFileSync(paths.profile),
    });
    return { paths, bundledPath, syncOpts, published };
  }

  it("restores exact prior overlays when publication fails after the catalog write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-sync-rollback-meta-"));
    const accept = writeCodexBin(dir, "accept", join(dir, "bundled.json"));
    const { paths, bundledPath, syncOpts, published } = syncHome(dir, accept);
    await syncCatalog(syncOpts());
    const before = published();
    writeFileSync(bundledPath, BUNDLED_B);
    const broken = brokenParent();
    try {
      await assert.rejects(
        () => syncCatalog({ ...syncOpts(), paths: { ...paths, catalogMeta: join(broken.path, "meta") } }),
        /EACCES|EPERM|permission|read-only/i,
      );
      assert.equal(readFileSync(paths.catalog).equals(before.catalog), true, "catalog bytes");
      assert.equal(readFileSync(paths.catalogMeta).equals(before.meta), true, "metadata bytes");
      assert.equal(readFileSync(paths.profile).equals(before.profile), true, "profile bytes");
      assert.equal(readFileSync(paths.rootConfig, "utf8"), ROOT_BYTES);
      assert.equal(existsSync(paths.runtime), false);
    } finally {
      broken.cleanup();
    }
  });

  it("restores exact prior overlays when publication fails at the profile write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-sync-rollback-profile-"));
    const accept = writeCodexBin(dir, "accept", join(dir, "bundled.json"));
    const { paths, bundledPath, syncOpts, published } = syncHome(dir, accept);
    await syncCatalog(syncOpts());
    const before = published();
    writeFileSync(bundledPath, BUNDLED_B);
    const broken = brokenParent();
    try {
      await assert.rejects(
        () => syncCatalog({ ...syncOpts(), paths: { ...paths, profile: join(broken.path, "profile") } }),
        /EACCES|EPERM|permission|read-only/i,
      );
      assert.equal(readFileSync(paths.catalog).equals(before.catalog), true, "catalog bytes");
      assert.equal(readFileSync(paths.catalogMeta).equals(before.meta), true, "metadata bytes");
      assert.equal(readFileSync(paths.profile).equals(before.profile), true, "profile bytes");
      assert.equal(readFileSync(paths.rootConfig, "utf8"), ROOT_BYTES);
    } finally {
      broken.cleanup();
    }
  });

  it("keeps the consumer-rejection sidecar while restoring last-good publication bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-sync-rollback-reject-"));
    const accept = writeCodexBin(dir, "accept", join(dir, "bundled.json"));
    const { paths, syncOpts, published } = syncHome(dir, accept);
    await syncCatalog(syncOpts());
    const before = published();
    const reject = writeCodexBin(dir, "reject", join(dir, "bundled.json"));
    await assert.rejects(
      () => syncCatalog({ ...syncOpts(), discovery: { liveHome: false, platform: "darwin" as const, pathBin: reject } }),
      /rejected cob catalog/,
    );
    const { parseCatalogMetadata } = await import("./codex/catalog/provenance.js");
    const retained = parseCatalogMetadata(readFileSync(paths.catalogMeta, "utf8"));
    assert.equal(retained.schema_version, 2);
    assert.ok(retained.schema_version === 2 && retained.last_failure);
    assert.equal(readFileSync(paths.catalog).equals(before.catalog), true, "catalog bytes");
    assert.equal(readFileSync(paths.profile).equals(before.profile), true, "profile bytes");
    assert.equal(readFileSync(paths.rootConfig, "utf8"), ROOT_BYTES);
  });

  it("keeps write-if-changed behavior across successful standalone syncs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-sync-write-if-changed-"));
    const accept = writeCodexBin(dir, "accept", join(dir, "bundled.json"));
    const { paths, syncOpts, published } = syncHome(dir, accept);
    const first = await syncCatalog(syncOpts());
    assert.equal(first.wrote, true);
    const before = published();
    const second = await syncCatalog(syncOpts());
    assert.equal(second.wrote, false);
    assert.equal(readFileSync(paths.catalog).equals(before.catalog), true);
    assert.equal(readFileSync(paths.profile).equals(before.profile), true);
  });
});

describe("WP1.6 lifecycle hardening", () => {
  const MALFORMED_LEASE = "{not-json\n";

  function writeMalformedLease(paths: { startLease: string }): void {
    writeFileSync(paths.startLease, MALFORMED_LEASE, { mode: 0o600 });
  }

  it("blocks sync, start, and restore when the start lease bytes are malformed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-lease-malformed-"));
    const paths = resolvePaths(dir);
    writeMalformedLease(paths);
    try {
      await assert.rejects(
        () => syncCatalog({ paths, ollamaUrl: "http://127.0.0.1:1" }),
        /unreadable cob start lease/,
      );
      await assert.rejects(
        async () =>
          startGatewayDetached({
            paths,
            port: await freePort(),
            ollamaUrl: "http://127.0.0.1:1",
            spawnServe: () => {
              throw new Error("must not spawn over a malformed lease");
            },
          }),
        /unreadable cob start lease/,
      );
      await assert.rejects(() => restoreCob(paths), /unreadable cob start lease/);
      assert.equal(readFileSync(paths.startLease, "utf8"), MALFORMED_LEASE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses locked sync over a malformed lease without touching any bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-lease-locked-"));
    const paths = resolvePaths(dir);
    writeMalformedLease(paths);
    try {
      await assert.rejects(
        () => syncCatalog({ paths, ollamaUrl: "http://127.0.0.1:1", locked: true }),
        /unreadable cob start lease/,
      );
      assert.equal(readFileSync(paths.startLease, "utf8"), MALFORMED_LEASE);
      assert.equal(existsSync(paths.catalog), false);
      assert.equal(existsSync(paths.profile), false);
      assert.equal(existsSync(paths.cobConfig), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses detached start before the healthy-runtime early return", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-lease-healthy-runtime-"));
    const paths = resolvePaths(dir);
    const port = await freePort();
    const gateway = spawnPlainHealthGateway(dir, port);
    try {
      writeRuntime(paths, {
        pid: gateway.pid!,
        port,
        ollamaUrl: "http://127.0.0.1:1",
        startedAt: new Date().toISOString(),
        nonce: "healthy-runtime-nonce",
        startKey: processStartKey(gateway.pid!),
      });
      await waitForHealth(port, { attempts: 100, nonce: "healthy-runtime-nonce", pid: gateway.pid });
      writeMalformedLease(paths);
      let spawnCalls = 0;
      await assert.rejects(
        () =>
          startGatewayDetached({
            paths,
            port,
            ollamaUrl: "http://127.0.0.1:1",
            spawnServe: () => {
              spawnCalls += 1;
              throw new Error("must not spawn over a malformed lease");
            },
          }),
        /unreadable cob start lease/,
      );
      assert.equal(spawnCalls, 0);
      assert.equal(readFileSync(paths.startLease, "utf8"), MALFORMED_LEASE);
    } finally {
      gateway.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not publish overlays when the prepare start path sees a malformed lease", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-lease-prepare-"));
    const paths = resolvePaths(dir);
    writeMalformedLease(paths);
    try {
      await assert.rejects(
        () =>
          prepareProfileAndCatalog({ paths, ollamaUrl: "http://127.0.0.1:1", locked: true }),
        /unreadable cob start lease/,
      );
      assert.equal(readFileSync(paths.startLease, "utf8"), MALFORMED_LEASE);
      assert.equal(existsSync(paths.catalog), false);
      assert.equal(existsSync(paths.profile), false);
      assert.equal(existsSync(paths.cobConfig), false);
      assert.equal(existsSync(paths.rootConfig), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed runtime pid and port values", () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-runtime-malformed-"));
    const paths = resolvePaths(dir);
    try {
      const write = (value: unknown) => {
        writeFileSync(paths.runtime, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      };
      const base = { ollamaUrl: "http://127.0.0.1:1", startedAt: "2026-08-31T00:00:00Z" };
      write({ ...base, pid: -5, port: 18791 });
      assert.equal(readRuntime(paths), null);
      write({ ...base, pid: 1.5, port: 18791 });
      assert.equal(readRuntime(paths), null);
      write({ ...base, pid: 4242, port: 0 });
      assert.equal(readRuntime(paths), null);
      write({ ...base, pid: 4242, port: 70000 });
      assert.equal(readRuntime(paths), null);
      write({ ...base, pid: 4242, port: 18791 });
      const runtime = readRuntime(paths);
      assert.ok(runtime);
      assert.equal(runtime?.pid, 4242);
      assert.equal(runtime?.port, 18791);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
