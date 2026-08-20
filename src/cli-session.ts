import { spawnSync } from "node:child_process";
import { DEFAULT_OLLAMA_URL } from "./constants.js";
import {
  assertWorkspaceMayTouchHome,
  defaultDevHome,
  defaultLiveHome,
  detectInstall,
  isLiveCodexHome,
  resolveListenPort,
  seedIsolatedCodexHome,
  type CobInstall,
} from "./install.js";
import { parseCompactionProvider } from "./cob-config.js";
import { assertLoopbackHttpUrl } from "./loopback.js";
import { resolveCodexHome, resolvePaths, type CobPaths } from "./paths.js";

export type CliFlags = {
  command: string;
  port?: number;
  portExplicit: boolean;
  ollamaUrl: string;
  foreground: boolean;
  live: boolean;
  dev: boolean;
  liveHome: boolean;
  home?: string;
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

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliFlags {
  const args = argv.slice(2);
  if (args.includes("--version") || args.includes("-V")) {
    return baseFlags("version", env);
  }
  const command = args.find((arg) => !arg.startsWith("-")) ?? "help";
  const flags = baseFlags(command, env);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--foreground" || arg === "-f") flags.foreground = true;
    if (arg === "--live") flags.live = true;
    if (arg === "--dev") flags.dev = true;
    if (arg === "--live-home") flags.liveHome = true;
    if (arg === "--home" && args[i + 1]) {
      flags.home = args[i + 1];
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
      throw new Error("native ChatGPT URL is pinned; --native-url is not accepted");
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

function baseFlags(command: string, env: NodeJS.ProcessEnv): CliFlags {
  return {
    command,
    portExplicit: false,
    ollamaUrl: env.COB_OLLAMA_URL ?? DEFAULT_OLLAMA_URL,
    foreground: false,
    live: false,
    dev: false,
    liveHome: env.COB_ALLOW_LIVE_HOME === "1",
  };
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
