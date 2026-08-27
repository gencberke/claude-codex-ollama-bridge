import { homedir } from "node:os";
import { join } from "node:path";
import { defaultDevClaudeHome, defaultLiveClaudeHome } from "./claude-home.js";

export type ClaudePaths = {
  claudeHome: string;
  pid: string;
  log: string;
  runtime: string;
  lock: string;
  startLease: string;
  desktopOverlay: string;
  codeConfig: string;
  agents: string;
};

export function resolveClaudeHome(override = process.env.COB_CLAUDE_HOME): string {
  return override && override.length > 0 ? override : defaultLiveClaudeHome(homedir());
}

export function resolveClaudePaths(claudeHome = resolveClaudeHome()): ClaudePaths {
  const codeConfig = join(claudeHome, "code");
  return {
    claudeHome,
    pid: join(claudeHome, "cob-claude-gateway.pid"),
    log: join(claudeHome, "cob-claude-gateway.log"),
    runtime: join(claudeHome, "cob-claude-runtime.json"),
    lock: join(claudeHome, "cob-claude.lock"),
    startLease: join(claudeHome, "cob-claude.start-lease.json"),
    desktopOverlay: join(claudeHome, "desktop-overlay"),
    codeConfig,
    agents: join(codeConfig, "agents"),
  };
}

export function resolveClaudeDevHome(): string {
  return defaultDevClaudeHome(homedir());
}
