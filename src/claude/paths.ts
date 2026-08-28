import { homedir } from "node:os";
import { join } from "node:path";
import { defaultLiveClaudeHome } from "./home.js";

export type ClaudePaths = {
  claudeHome: string;
  pid: string;
  log: string;
  runtime: string;
  lock: string;
  desktopToken: string;
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
    desktopToken: join(claudeHome, "desktop-gateway-token"),
    desktopOverlay: join(claudeHome, "desktop-overlay"),
    codeConfig,
    agents: join(codeConfig, "agents"),
  };
}
