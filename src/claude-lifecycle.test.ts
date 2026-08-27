import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveClaudePaths } from "./claude-paths.js";
import { stopClaudeGateway } from "./claude-lifecycle.js";
import { acquireLock, releaseLock } from "./lock.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid;
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
