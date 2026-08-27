import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CLAUDE_AGENT_MARKER } from "./claude/agents.js";
import {
  applyUserClaudeAgentsOverlay,
  restoreUserClaudeAgentsOverlay,
  userClaudeAgentsDir,
  userAgentsOverlayStatus,
} from "./claude/user-agents.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("cob claude user agents overlay", () => {
  it("snapshots missing, writes cob-owned agent, and restore deletes it", () => {
    const root = tempDir("cob-user-agents-");
    try {
      const overlayDir = join(root, "overlay");
      const userClaudeHome = join(root, ".claude");
      const applied = applyUserClaudeAgentsOverlay({ overlayDir, userClaudeHome });
      const path = join(userClaudeAgentsDir(userClaudeHome), "cob-deepseek-0731.md");
      assert.equal(applied.snapshotCreated, true);
      assert.equal(applied.wrote.length, 1);
      assert.equal(readFileSync(path, "utf8").includes(CLAUDE_AGENT_MARKER), true);
      assert.equal(existsSync(join(userClaudeHome, "settings.json")), false);
      assert.equal(userAgentsOverlayStatus(overlayDir, userClaudeHome).kind, "applied");

      assert.equal(restoreUserClaudeAgentsOverlay({ overlayDir, userClaudeHome }), true);
      assert.equal(existsSync(path), false);
      assert.equal(userAgentsOverlayStatus(overlayDir, userClaudeHome).kind, "absent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite an unmarked cob-named file and leaves other agents", () => {
    const root = tempDir("cob-user-agents-keep-");
    try {
      const overlayDir = join(root, "overlay");
      const userClaudeHome = join(root, ".claude");
      const agentsDir = userClaudeAgentsDir(userClaudeHome);
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, "cob-deepseek-0731.md"), "user owned\n");
      writeFileSync(join(agentsDir, "my-reviewer.md"), "keep\n");
      const applied = applyUserClaudeAgentsOverlay({ overlayDir, userClaudeHome });
      assert.equal(applied.wrote.length, 0);
      assert.equal(applied.skipped.length, 1);
      assert.equal(readFileSync(join(agentsDir, "cob-deepseek-0731.md"), "utf8"), "user owned\n");
      assert.equal(readFileSync(join(agentsDir, "my-reviewer.md"), "utf8"), "keep\n");
      restoreUserClaudeAgentsOverlay({ overlayDir, userClaudeHome });
      assert.equal(readFileSync(join(agentsDir, "cob-deepseek-0731.md"), "utf8"), "user owned\n");
      assert.equal(readFileSync(join(agentsDir, "my-reviewer.md"), "utf8"), "keep\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to restore a manifest into a different home", () => {
    const root = tempDir("cob-user-agents-home-");
    try {
      const overlayDir = join(root, "overlay");
      const userClaudeHome = join(root, ".claude");
      const otherHome = join(root, ".claude-other");
      applyUserClaudeAgentsOverlay({ overlayDir, userClaudeHome });
      assert.throws(
        () => restoreUserClaudeAgentsOverlay({ overlayDir, userClaudeHome: otherHome }),
        /refusing to restore/,
      );
      assert.equal(existsSync(join(userClaudeAgentsDir(otherHome), "cob-deepseek-0731.md")), false);
      assert.equal(userAgentsOverlayStatus(overlayDir, userClaudeHome).kind, "applied");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
