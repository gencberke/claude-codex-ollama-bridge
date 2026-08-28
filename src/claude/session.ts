import type { CliFlags } from "../cli-session.js";
import { resolveListenPort } from "../cli-session.js";
import {
  assertNotUserClaudeHome,
  assertWorkspaceMayTouchClaudeHome,
  defaultDevClaudeHome,
  defaultLiveClaudeHome,
  isLiveClaudeHome,
} from "./home.js";
import { detectInstall, type CobInstall } from "../core/install-detection.js";
import { resolveClaudeHome, resolveClaudePaths, type ClaudePaths } from "./paths.js";

export type ClaudeCliSession = {
  flags: CliFlags;
  paths: ClaudePaths;
  port: number;
  install: CobInstall;
  isolated: boolean;
};

export function resolveClaudeCliSession(
  flags: CliFlags,
  env: NodeJS.ProcessEnv = process.env,
): ClaudeCliSession {
  const install = detectInstall();
  const liveHome = defaultLiveClaudeHome();
  const home = flags.home ?? (flags.dev ? defaultDevClaudeHome() : resolveClaudeHome(env.COB_CLAUDE_HOME));
  assertNotUserClaudeHome(home);
  const isolated = flags.dev || !isLiveClaudeHome(home, liveHome);
  const port = resolveListenPort({
    isolated: flags.dev,
    portExplicit: flags.portExplicit,
    port: flags.port,
    envPort: env.COB_CLAUDE_PORT,
    surface: "claude",
  });
  assertWorkspaceMayTouchClaudeHome({
    command: flags.command,
    install,
    claudeHome: home,
    allowLiveHome: flags.liveHome || env.COB_ALLOW_LIVE_HOME === "1",
    liveHome,
  });
  return {
    flags,
    paths: resolveClaudePaths(home),
    port,
    install,
    isolated,
  };
}
