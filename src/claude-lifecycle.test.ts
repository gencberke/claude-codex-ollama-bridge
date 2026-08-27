import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { resolveClaudePaths } from "./claude/paths.js";
import { startClaudeGatewayDetached, stopClaudeGateway } from "./claude/lifecycle.js";
import { acquireLock, releaseLock } from "./core/lock.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid;
}

function spawnFakeClaudeServe(
  root: string,
  opts: { token: string; mode?: string; adoptDelayMs?: number },
): ChildProcess {
  const markers = join(root, "markers");
  const script = join(root, `fake-claude-serve-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  const dist = dirname(fileURLToPath(import.meta.url));
  const lockUrl = pathToFileURL(join(dist, "core", "lock.js")).href;
  const pathsUrl = pathToFileURL(join(dist, "claude", "paths.js")).href;
  writeFileSync(
    script,
    `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { adoptLock, releaseLock } from ${JSON.stringify(lockUrl)};
import { resolveClaudePaths } from ${JSON.stringify(pathsUrl)};
const markers = ${JSON.stringify(markers)};
const paths = resolveClaudePaths(process.env.COB_CLAUDE_HOME);
if (process.env.COB_FAKE_CLAUDE_MODE === "exit-before-adopt") process.exit(1);
writeFileSync(join(markers, "adopting"), "");
const delay = Number(process.env.COB_FAKE_CLAUDE_ADOPT_DELAY_MS ?? "0");
if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
adoptLock(paths.lock, process.env.COB_LOCK_TOKEN ?? "");
writeFileSync(join(markers, "adopted"), "");
releaseLock(paths.lock);
const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, surface: "claude" }));
});
await new Promise((resolve, reject) => {
  server.listen(0, "127.0.0.1", () => resolve(undefined));
  server.on("error", reject);
});
const port = server.address().port;
writeFileSync(paths.runtime, JSON.stringify({
  pid: process.pid,
  port,
  ollamaUrl: "http://127.0.0.1:1",
  startedAt: new Date().toISOString(),
  version: "test",
  installKind: "test",
}));
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
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("cob claude lifecycle", () => {
  it("public stop serializes on the held lock instead of a false success", async () => {
    const root = tempDir("cob-claude-stop-");
    try {
      const paths = resolveClaudePaths(join(root, ".claude-cob"));
      mkdirSync(paths.claudeHome, { recursive: true });
      writeFileSync(paths.runtime, `${JSON.stringify({ pid: deadPid(), port: 1 })}\n`);
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
      writeFileSync(paths.runtime, `${JSON.stringify({ pid: deadPid(), port: 1 })}\n`);
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
