import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  CLAUDE_AGENT_MARKER,
  CLAUDE_SPAWN_ALLOWLIST,
  claudeAgentsDir,
  projectClaudeAgentsDir,
  removeOwnedClaudeAgents,
  renderClaudeAgentFile,
  syncClaudeSpawnAgents,
  syncProjectClaudeAgents,
} from "./claude-agents.js";
import { applyCobRouteDirective } from "./claude-route.js";
import { resolveClaudePaths } from "./claude-paths.js";
import { USER_CLAUDE_HOME_REFUSAL } from "./install.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("cob claude spawn agents", () => {
  it("writes cob-prefixed agents with cob-route into the cob-owned code dir", () => {
    const home = tempDir("cob-claude-agents-");
    try {
      const paths = resolveClaudePaths(home);
      const result = syncClaudeSpawnAgents(paths);
      const body = readFileSync(join(paths.agents, "cob-deepseek-0731.md"), "utf8");
      assert.equal(result.wrote.length, 1);
      assert.equal(body.includes(CLAUDE_AGENT_MARKER), true);
      assert.equal(body.includes("<!-- cob-route: deepseek-v4-flash:0731-cloud -->"), true);
      assert.equal(CLAUDE_SPAWN_ALLOWLIST.includes("deepseek-v4-flash:0731-cloud"), true);
      assert.equal(claudeAgentsDir(home), paths.agents);
      assert.equal(body.includes("claude-opus-5"), false);
      const routed = applyCobRouteDirective(
        { model: "haiku", system: body, messages: [] },
        CLAUDE_SPAWN_ALLOWLIST,
      );
      assert.equal(routed.applied, true);
      assert.equal(routed.payload.model, "deepseek-v4-flash:0731-cloud");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not overwrite a cob-named file that cob does not own", () => {
    const home = tempDir("cob-claude-agents-keep-");
    try {
      const paths = resolveClaudePaths(home);
      mkdirSync(paths.agents, { recursive: true });
      const path = join(paths.agents, "cob-deepseek-0731.md");
      writeFileSync(path, "user owned\n");
      const result = syncClaudeSpawnAgents(paths);
      assert.equal(result.wrote.length, 0);
      assert.equal(readFileSync(path, "utf8"), "user owned\n");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("prunes owned cob-*.md files that left the roster", () => {
    const home = tempDir("cob-claude-agents-prune-");
    try {
      const paths = resolveClaudePaths(home);
      mkdirSync(paths.agents, { recursive: true });
      writeFileSync(
        join(paths.agents, "cob-stale.md"),
        renderClaudeAgentFile({
          name: "cob-stale",
          model: "deepseek-v4-flash:0731-cloud",
          description: "stale",
        }),
      );
      const result = syncClaudeSpawnAgents(paths);
      assert.equal(result.pruned.some((path) => path.endsWith("cob-stale.md")), true);
      const leftover = removeOwnedClaudeAgents(paths);
      assert.equal(leftover.some((path) => path.endsWith("cob-deepseek-0731.md")), true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses the live ~/.claude home", () => {
    const paths = resolveClaudePaths(join(homedir(), ".claude"));
    assert.throws(() => syncClaudeSpawnAgents(paths), (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.equal((error as Error).message, USER_CLAUDE_HOME_REFUSAL);
      return true;
    });
  });

  it("writes cob-prefixed agents into a project .claude/agents dir", () => {
    const project = tempDir("cob-claude-project-");
    try {
      const result = syncProjectClaudeAgents(project);
      const path = join(project, ".claude", "agents", "cob-deepseek-0731.md");
      const body = readFileSync(path, "utf8");
      assert.equal(result.wrote.length, 1);
      assert.equal(result.agentsDir, projectClaudeAgentsDir(project));
      assert.equal(body.includes("cob-deepseek-0731"), true);
      assert.equal(body.includes("built-in haiku"), true);
      assert.equal(body.includes("<!-- cob-route: deepseek-v4-flash:0731-cloud -->"), true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("refuses project sync into ~/.claude or $HOME", () => {
    assert.throws(() => syncProjectClaudeAgents(homedir()), (error: unknown) => {
      assert.equal((error as Error).message, USER_CLAUDE_HOME_REFUSAL);
      return true;
    });
    assert.throws(() => syncProjectClaudeAgents(join(homedir(), ".claude")), (error: unknown) => {
      assert.equal((error as Error).message, USER_CLAUDE_HOME_REFUSAL);
      return true;
    });
  });
});
