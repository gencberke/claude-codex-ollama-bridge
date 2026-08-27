import { spawnSync } from "node:child_process";
import { DEFAULT_PORT } from "./codex/constants.js";
import { DEFAULT_OLLAMA_URL } from "./core/ollama/constants.js";
import {
  assertNotUserClaudeHome,
  assertWorkspaceMayTouchClaudeHome,
  defaultDevClaudeHome,
  defaultLiveClaudeHome,
  isLiveClaudeHome,
} from "./claude/home.js";
import { CLAUDE_DEFAULT_DEV_PORT, CLAUDE_DEFAULT_PORT } from "./claude/constants.js";
import {
  DEFAULT_DEV_PORT,
  assertWorkspaceMayTouchHome,
  defaultDevHome,
  defaultLiveHome,
  isLiveCodexHome,
  seedIsolatedCodexHome,
} from "./codex/home.js";
import { detectInstall, type CobInstall } from "./core/install-detection.js";
import { parseCompactionProvider } from "./codex/cob-config.js";
import { assertLoopbackHttpUrl } from "./core/loopback.js";
import { resolveCodexHome, resolvePaths, type CobPaths } from "./codex/paths.js";
import { resolveClaudeHome, resolveClaudePaths, type ClaudePaths } from "./claude/paths.js";
import { DEFAULT_SURFACE, isCobSurface, type CobSurface } from "./surface.js";

export type CliFlags = {
  surface: CobSurface;
  command: string;
  port?: number;
  portExplicit: boolean;
  ollamaUrl: string;
  foreground: boolean;
  live: boolean;
  dev: boolean;
  liveHome: boolean;
  desktop: boolean;
  home?: string;
  dir?: string;
  compactionProvider?: string;
  compactionModel?: string;
};

export type CliSession = {
  flags: CliFlags;
  paths: CobPaths;
  port: number;
  install: CobInstall;
  isolated: boolean;
};

export type ClaudeCliSession = {
  flags: CliFlags;
  paths: ClaudePaths;
  port: number;
  install: CobInstall;
  isolated: boolean;
};

const FLAG_WITH_VALUE = new Set([
  "--home",
  "--dir",
  "--port",
  "--ollama-url",
  "--compaction-provider",
  "--compaction-model",
]);

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliFlags {
  const args = argv.slice(2);
  if (args.includes("--version") || args.includes("-V")) {
    return baseFlags("version", env);
  }
  const positionals = positionalArgs(args);
  let surface: CobSurface = DEFAULT_SURFACE;
  let command = "help";
  if (positionals[0] && isCobSurface(positionals[0])) {
    surface = positionals[0];
    command = positionals[1] ?? "help";
  } else if (positionals[0]) {
    command = positionals[0];
  }
  const flags = baseFlags(command, env, surface);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--foreground" || arg === "-f") flags.foreground = true;
    if (arg === "--live") flags.live = true;
    if (arg === "--dev") flags.dev = true;
    if (arg === "--live-home") flags.liveHome = true;
    if (arg === "--desktop") flags.desktop = true;
    if (arg === "--home" && args[i + 1]) {
      flags.home = args[i + 1];
      i += 1;
    }
    if (arg === "--dir" && args[i + 1]) {
      flags.dir = args[i + 1];
      i += 1;
    }
    if (arg === "--port" && args[i + 1]) {
      flags.port = Number(args[i + 1]);
      flags.portExplicit = true;
      i += 1;
    }
    if (arg === "--ollama-url" && args[i + 1]) {
      flags.ollamaUrl = args[i + 1] ?? flags.ollamaUrl;
      i += 1;
    }
    if (arg === "--compaction-provider" && args[i + 1]) {
      flags.compactionProvider = args[i + 1];
      i += 1;
    }
    if (arg === "--compaction-model" && args[i + 1]) {
      flags.compactionModel = args[i + 1];
      i += 1;
    }
    if (arg === "--native-url") {
      throw new Error(
        surface === "claude"
          ? "native Anthropic URL is pinned; --native-url is not accepted"
          : "native ChatGPT URL is pinned; --native-url is not accepted",
      );
    }
  }
  if (flags.portExplicit && (flags.port === undefined || !Number.isInteger(flags.port) || flags.port <= 0)) {
    throw new Error("invalid --port");
  }
  if (flags.compactionProvider) {
    parseCompactionProvider(flags.compactionProvider);
  }
  assertLoopbackHttpUrl(flags.ollamaUrl, "Ollama URL");
  return flags;
}

function positionalArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg.startsWith("-")) {
      if (FLAG_WITH_VALUE.has(arg)) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function baseFlags(command: string, env: NodeJS.ProcessEnv, surface: CobSurface = DEFAULT_SURFACE): CliFlags {
  return {
    surface,
    command,
    portExplicit: false,
    ollamaUrl: env.COB_OLLAMA_URL ?? DEFAULT_OLLAMA_URL,
    foreground: false,
    live: false,
    dev: false,
    liveHome: env.COB_ALLOW_LIVE_HOME === "1",
    desktop: false,
  };
}

export function resolveListenPort(opts: {
  isolated: boolean;
  portExplicit: boolean;
  port?: number;
  envPort?: string;
  surface?: CobSurface;
}): number {
  if (opts.portExplicit && opts.port !== undefined) return opts.port;
  if (opts.envPort !== undefined && opts.envPort.length > 0) {
    const parsed = Number(opts.envPort);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  if (opts.surface === "claude") {
    return opts.isolated ? CLAUDE_DEFAULT_DEV_PORT : CLAUDE_DEFAULT_PORT;
  }
  if (opts.isolated) return DEFAULT_DEV_PORT;
  return DEFAULT_PORT;
}

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

export function packReleaseTarball(install: CobInstall): { filename: string; stdout: string } {
  if (install.kind !== "workspace" || !install.packageRoot) {
    throw new Error("cob pack must run from a git checkout (workspace), not a global install");
  }
  const result = spawnSync("npm", ["pack"], {
    cwd: install.packageRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "npm pack failed");
  }
  const lines = result.stdout.trim().split(/\r?\n/);
  const filename = lines.at(-1)?.trim() ?? "";
  if (!filename.endsWith(".tgz")) {
    throw new Error(`npm pack did not print a tarball name: ${result.stdout}`);
  }
  return { filename, stdout: result.stdout };
}

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
