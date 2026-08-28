import type { CliFlags } from "../cli-session.js";
import { resolveListenPort } from "../cli-session.js";
import { detectInstall, type CobInstall } from "../core/install-detection.js";
import { assertWorkspaceMayTouchHome, defaultDevHome, defaultLiveHome, isLiveCodexHome, seedIsolatedCodexHome } from "./home.js";
import { resolveCodexHome, resolvePaths, type CobPaths } from "./paths.js";

export type CliSession = {
  flags: CliFlags;
  paths: CobPaths;
  port: number;
  install: CobInstall;
  isolated: boolean;
};

export function resolveCliSession(
  flags: CliFlags,
  env: NodeJS.ProcessEnv = process.env,
): CliSession {
  const install = detectInstall();
  const liveHome = defaultLiveHome();
  const home = flags.home ?? (flags.dev ? defaultDevHome() : resolveCodexHome(env.COB_CODEX_HOME));
  const isolated = flags.dev || !isLiveCodexHome(home, liveHome);
  const port = resolveListenPort({
    isolated: flags.dev,
    portExplicit: flags.portExplicit,
    port: flags.port,
    envPort: env.COB_PORT,
    surface: "codex",
  });
  assertWorkspaceMayTouchHome({
    command: flags.command,
    install,
    codexHome: home,
    allowLiveHome: flags.liveHome || env.COB_ALLOW_LIVE_HOME === "1",
    liveHome,
  });
  if ((flags.command === "start" || flags.command === "serve") && isolated) {
    seedIsolatedCodexHome(home, liveHome);
  }
  return {
    flags,
    paths: resolvePaths(home),
    port,
    install,
    isolated,
  };
}
