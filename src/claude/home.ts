import { homedir } from "node:os";
import { join } from "node:path";
import { samePath, type CobInstall } from "../core/install-detection.js";

export const CLAUDE_LIVE_HOME_DIRNAME = ".claude-cob";
export const CLAUDE_DEV_HOME_DIRNAME = ".claude-cob-dev";
export const USER_CLAUDE_HOME_DIRNAME = ".claude";

export const LIVE_CLAUDE_HOME_REFUSAL =
  "workspace cob claude refuses to mutate the live ~/.claude-cob home. Use cob claude start --dev for an isolated cob-owned home, or pass --live-home only to debug a checkout against that live Claude surface.";

export const USER_CLAUDE_HOME_REFUSAL =
  "cob claude never mutates ~/.claude (settings.json or Claude Code home). Use cob-owned ~/.claude-cob or cob claude start --dev (~/.claude-cob-dev). Claude Desktop 3P overlay is a separate --desktop opt-in.";

export function defaultLiveClaudeHome(home = homedir()): string {
  return join(home, CLAUDE_LIVE_HOME_DIRNAME);
}

export function defaultDevClaudeHome(home = homedir()): string {
  return join(home, CLAUDE_DEV_HOME_DIRNAME);
}

export function defaultUserClaudeHome(home = homedir()): string {
  return join(home, USER_CLAUDE_HOME_DIRNAME);
}

export function isLiveClaudeHome(claudeHome: string, liveHome = defaultLiveClaudeHome()): boolean {
  return samePath(claudeHome, liveHome);
}

export function isUserClaudeHome(claudeHome: string, userHome = defaultUserClaudeHome()): boolean {
  return samePath(claudeHome, userHome);
}

export function assertNotUserClaudeHome(claudeHome: string, userHome = defaultUserClaudeHome()): void {
  if (isUserClaudeHome(claudeHome, userHome)) {
    throw new Error(USER_CLAUDE_HOME_REFUSAL);
  }
}

const MUTATING_COMMANDS = new Set(["start", "serve", "stop", "restore", "sync"]);

export function assertWorkspaceMayTouchClaudeHome(opts: {
  command: string;
  install: CobInstall;
  claudeHome: string;
  allowLiveHome: boolean;
  liveHome?: string;
}): void {
  if (!MUTATING_COMMANDS.has(opts.command)) return;
  if (opts.allowLiveHome) return;
  if (opts.install.kind !== "workspace") return;
  if (!isLiveClaudeHome(opts.claudeHome, opts.liveHome ?? defaultLiveClaudeHome())) return;
  throw new Error(LIVE_CLAUDE_HOME_REFUSAL);
}
