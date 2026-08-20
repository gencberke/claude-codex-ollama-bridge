import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { uniqueTempPath } from "./atomic.js";
import { acquireLock, LockTimeoutError, releaseLock, STALE_CORRUPT_MS, withExclusiveLock } from "./lock.js";
import { assertCodexAcceptsCatalog } from "./catalog.js";
import {
  isHealthyRuntime,
  isStartLeaseActive,
  readRuntime,
  readStartLease,
  restoreCob,
  restoreOverlays,
  serveForeground,
  snapshotOverlays,
  startGatewayDetached,
  stopGateway,
  syncCatalog,
  statusReport,
  writeRuntime,
  writeStartLease,
} from "./lifecycle.js";
import { resolvePaths } from "./paths.js";
import { cobProcessIdentity, isOurCobArgv, processStartKey } from "./process-info.js";

describe("lifecycle primitives", () => {
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
    const lockUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "lock.js")).href;
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
    const lockUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "lock.js")).href;
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
    const previousBin = process.env.COB_CODEX_BIN;
    const previousSkip = process.env.COB_SKIP_CATALOG_CHECK;
    process.env.COB_CODEX_BIN = codexBin;
    process.env.COB_SKIP_CATALOG_CHECK = "1";
    const port = await freePort();
    try {
      await assert.rejects(
        () =>
          serveForeground({
            paths: brokenPaths,
            port,
            ollamaUrl: "http://127.0.0.1:1",
            locked: true,
          }),
        /EACCES|EPERM|permission|read-only/i,
      );
      await assert.rejects(
        () => fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) }),
      );
      assert.equal(existsSync(paths.runtime), false);
    } finally {
      if (previousBin === undefined) delete process.env.COB_CODEX_BIN;
      else process.env.COB_CODEX_BIN = previousBin;
      if (previousSkip === undefined) delete process.env.COB_SKIP_CATALOG_CHECK;
      else process.env.COB_SKIP_CATALOG_CHECK = previousSkip;
    }
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

  it("refreshes the v2 profile when sync updates the catalog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-sync-profile-"));
    const paths = resolvePaths(dir);
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
    const previousSkip = process.env.COB_SKIP_CATALOG_CHECK;
    process.env.COB_SKIP_CATALOG_CHECK = "1";
    try {
      await syncCatalog({ paths, ollamaUrl: `http://127.0.0.1:${ollamaPort}` });
      const profile = readFileSync(paths.profile, "utf8");
      assert.match(profile, /openai_base_url = "http:\/\/127\.0\.0\.1:19876\/v1"/);
      assert.match(profile, /remote_compaction_v2 = true/);
    } finally {
      if (previousSkip === undefined) delete process.env.COB_SKIP_CATALOG_CHECK;
      else process.env.COB_SKIP_CATALOG_CHECK = previousSkip;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
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
    const lockUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "lock.js")).href;
    const lifecycleUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "lifecycle.js")).href;
    const pathsUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "paths.js")).href;
    const processInfoUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "process-info.js")).href;
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

  it("reports a ready Desktop overlay when root keys match cob and the gateway is stopped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-status-ready-"));
    const paths = resolvePaths(dir);
    writeFileSync(paths.catalog, '{"models":[]}\n');
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
    const report = await statusReport(paths);
    assert.equal(readFileSync(paths.rootConfig, "utf8"), original);
    assert.equal(report.ok, false);
    assert.match(report.text, /^cob: ready\n/);
    assert.match(report.text, /gateway: stopped/);
    assert.match(report.text, /desktop overlay: ready \(gateway stopped; run cob start\)/);
  });

  it("treats a stopped isolated home with no root config as ready, not absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-status-isolated-"));
    const paths = resolvePaths(dir);
    const report = await statusReport(paths);
    assert.equal(report.ok, false);
    assert.match(report.text, /^cob: ready\n/);
    assert.match(report.text, /isolated Codex home/);
    assert.match(report.text, /desktop overlay: no root config.toml/);
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

function spawnFakeServe(
  dir: string,
  opts: {
    token: string;
    nonce: string;
    port: number;
    crashAfterOverlays?: boolean;
    delayListenMs?: number;
    runtimeNonce?: string;
  },
) {
  const script = join(dir, `fake-serve-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  const lockUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "lock.js")).href;
  const lifecycleUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "lifecycle.js")).href;
  const pathsUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "paths.js")).href;
  writeFileSync(
    script,
    `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { adoptLock, releaseLock } from ${JSON.stringify(lockUrl)};
import { writeRuntime } from ${JSON.stringify(lifecycleUrl)};
import { resolvePaths } from ${JSON.stringify(pathsUrl)};

const paths = resolvePaths(process.env.COB_CODEX_HOME);
adoptLock(paths.lock, process.env.COB_LOCK_TOKEN ?? "");
writeFileSync(paths.profile, "profile\\n");
writeFileSync(paths.catalog, "{\\"models\\":[]}\\n");
writeFileSync(paths.cobConfig, "[compaction]\\nprovider = \\"native\\"\\n");
if (process.env.COB_FAKE_SERVE_CRASH === "1") {
  releaseLock(paths.lock);
  process.exit(1);
}
releaseLock(paths.lock);
const delay = Number(process.env.COB_FAKE_SERVE_DELAY_MS ?? "0");
if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
const port = Number(process.env.COB_PORT);
const nonce = process.env.COB_RUNTIME_NONCE;
const runtimeNonce = process.env.COB_FAKE_SERVE_RUNTIME_NONCE || nonce;
const server = createServer((req, res) => {
  const url = req.url ?? "";
  if (url.includes("healthz") || url.includes("/health")) {
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
      COB_FAKE_SERVE_DELAY_MS: String(opts.delayListenMs ?? 0),
      COB_FAKE_SERVE_RUNTIME_NONCE: opts.runtimeNonce ?? "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
