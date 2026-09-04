import { spawnSync } from "node:child_process";
import { CLAUDE_DEFAULT_DEV_PORT, CLAUDE_DEFAULT_PORT } from "./claude/constants.js";
import { DEFAULT_PORT } from "./codex/constants.js";
import { DEFAULT_DEV_PORT } from "./codex/home.js";
import { parseCompactionProvider } from "./codex/config/schema.js";
import { assertLoopbackHttpUrl } from "./core/loopback.js";
import { DEFAULT_OLLAMA_URL } from "./core/ollama/constants.js";
import type { CobInstall } from "./core/install-detection.js";
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
  json: boolean;
};

const VALUE_FLAGS = new Set([
  "--home",
  "--dir",
  "--port",
  "--ollama-url",
  "--compaction-provider",
  "--compaction-model",
]);

const BOOLEAN_FLAGS = new Set(["--foreground", "--live", "--dev", "--live-home", "--desktop", "--json"]);

const SESSION_COMMANDS = new Set([
  "start",
  "serve",
  "stop",
  "restore",
  "status",
  "sync",
  "smoke",
  "agents",
  "diagnostics",
  "state verify",
  "config show",
  "config apply",
]);

function flagApplies(flag: string, surface: CobSurface, command: string): boolean {
  if (command === "version" || command === "pack" || command === "help") return false;
  switch (flag) {
    case "--dev":
    case "--live-home":
    case "--home":
    case "--port":
      return SESSION_COMMANDS.has(command);
    case "--foreground":
      return command === "start";
    case "--live":
      return surface === "codex" && command === "smoke";
    case "--ollama-url":
      if (surface === "codex") {
        return command === "start" || command === "serve" || command === "sync" || command === "smoke";
      }
      return command === "start" || command === "serve";
    case "--desktop":
      return surface === "claude" && (command === "start" || command === "serve");
    case "--dir":
      return surface === "claude" && command === "agents";
    case "--compaction-provider":
    case "--compaction-model":
      return surface === "codex" && (command === "start" || command === "serve");
    case "--json":
      return surface === "codex" &&
        (command === "status" || command === "diagnostics" || command === "state verify" || command === "config show" || command === "config apply");
    default:
      return false;
  }
}

/**
 * Single-pass CLI grammar: every token is either a known positional, a known
 * boolean flag, or a known value flag with an adjacent value. Anything else —
 * unknown flags, missing values, extra positionals, or flags that do not
 * apply to the resolved command — fails closed here instead of being skipped.
 */
export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliFlags {
  const args = argv.slice(2);
  // `--version` short-circuits only as the sole argument; any other token goes
  // through the single-pass grammar and fails on unknown flags.
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
    return baseFlags("version", env);
  }
  const positionals: string[] = [];
  const booleans = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    const canonical = arg === "-f" ? "--foreground" : arg;
    if (canonical === "--native-url") {
      throw new Error("native ChatGPT URL is pinned; --native-url is not accepted");
    }
    if (!VALUE_FLAGS.has(canonical) && !BOOLEAN_FLAGS.has(canonical)) {
      throw new Error(`unknown flag: ${arg}`);
    }
    if (VALUE_FLAGS.has(canonical)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`flag ${arg} requires a value`);
      }
      values.set(canonical, value);
      i += 1;
      continue;
    }
    booleans.add(canonical);
  }
  const surfaceArg = positionals[0];
  const surfacePrefix = surfaceArg !== undefined && isCobSurface(surfaceArg);
  // The exact narrow nested subcommands `cob state verify` and
  // `cob config {show,apply}`. Keeping these explicit prevents a future
  // positional from being silently interpreted as a different command.
  const isStateVerify = !surfacePrefix && surfaceArg === "state" && positionals[1] === "verify";
  const isConfig = !surfacePrefix && surfaceArg === "config";
  const isConfigCommand = isConfig && (positionals[1] === "show" || positionals[1] === "apply");
  const isExplicitCodexConfig =
    surfacePrefix && surfaceArg === "codex" && positionals[1] === "config" &&
    (positionals[2] === "show" || positionals[2] === "apply");
  if (isConfig && !isConfigCommand) {
    throw new Error(`unknown cob config command: ${positionals[1] ?? ""}`.trim());
  }
  if (surfacePrefix && surfaceArg === "codex" && positionals[1] === "config" && !isExplicitCodexConfig) {
    throw new Error(`unknown cob config command: ${positionals[2] ?? ""}`.trim());
  }
  let surface: CobSurface = DEFAULT_SURFACE;
  let command = "help";
  if (surfacePrefix && surfaceArg) {
    surface = surfaceArg;
    command = positionals[1] ?? "help";
  } else if (surfaceArg !== undefined) {
    command = surfaceArg;
  }
  if (isStateVerify) command = "state verify";
  if (isConfigCommand) command = `config ${positionals[1]}`;
  if (isExplicitCodexConfig) command = `config ${positionals[2]}`;
  const maxPositionals = isStateVerify || isConfigCommand ? 2 : isExplicitCodexConfig ? 3 : surfacePrefix ? 2 : 1;
  if (positionals.length > maxPositionals) {
    throw new Error(`unexpected positional argument: ${positionals[maxPositionals]}`);
  }
  const flags = baseFlags(command, env, surface);
  const applyBoolean = (flag: string, set: () => void): void => {
    if (!booleans.has(flag)) return;
    assertFlagApplicable(flag, surface, command);
    set();
  };
  applyBoolean("--foreground", () => (flags.foreground = true));
  applyBoolean("--live", () => (flags.live = true));
  applyBoolean("--dev", () => (flags.dev = true));
  applyBoolean("--live-home", () => (flags.liveHome = true));
  applyBoolean("--desktop", () => (flags.desktop = true));
  applyBoolean("--json", () => (flags.json = true));
  const applyValue = (flag: string, set: (value: string) => void): void => {
    const value = values.get(flag);
    if (value === undefined) return;
    assertFlagApplicable(flag, surface, command);
    set(value);
  };
  applyValue("--home", (value) => (flags.home = value));
  applyValue("--dir", (value) => (flags.dir = value));
  applyValue("--port", (value) => {
    flags.port = parsePortNumber(value, "--port");
    flags.portExplicit = true;
  });
  applyValue("--ollama-url", (value) => (flags.ollamaUrl = value));
  applyValue("--compaction-provider", (value) => (flags.compactionProvider = value));
  applyValue("--compaction-model", (value) => (flags.compactionModel = value));
  if (flags.compactionProvider) {
    parseCompactionProvider(flags.compactionProvider);
  }
  assertLoopbackHttpUrl(flags.ollamaUrl, "Ollama URL");
  return flags;
}

function assertFlagApplicable(flag: string, surface: CobSurface, command: string): void {
  if (!flagApplies(flag, surface, command)) {
    throw new Error(`flag ${flag} does not apply to cob ${surface === "codex" ? "" : `${surface} `}${command}`);
  }
}

/** Ports are strictly decimal digit strings in the 1..65535 range; shared by --port and COB_PORT. */
export function parsePortNumber(value: string, field: string): number {
  if (!/^[0-9]+$/.test(value) || value.length > 5 || Number(value) < 1 || Number(value) > 65535) {
    throw new Error(`${field} must be a decimal port between 1 and 65535`);
  }
  return Number(value);
}

/**
 * The Codex surface relies on POSIX-only lifecycle pieces (fork/uid checks,
 * detached spawn, symlinks); the Claude surface runs on Windows too.
 */
export function isSurfaceSupportedOn(surface: CobSurface, platform: NodeJS.Platform): boolean {
  if (surface === "codex") return platform !== "win32";
  return true;
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
    json: false,
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
  if (opts.envPort !== undefined) {
    return parsePortNumber(opts.envPort, opts.surface === "claude" ? "COB_CLAUDE_PORT" : "COB_PORT");
  }
  if (opts.surface === "claude") {
    return opts.isolated ? CLAUDE_DEFAULT_DEV_PORT : CLAUDE_DEFAULT_PORT;
  }
  if (opts.isolated) return DEFAULT_DEV_PORT;
  return DEFAULT_PORT;
}

export type PackCommandRunner = (
  args: string[],
  cwd: string,
) => { status: number | null; stdout: string; stderr: string; error?: Error };

function runNpm(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const result = spawnSync("npm", args, { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

export function packReleaseTarball(
  install: CobInstall,
  run: PackCommandRunner = runNpm,
): { filename: string; stdout: string } {
  if (install.kind !== "workspace" || !install.packageRoot) {
    throw new Error("cob pack must run from a git checkout (workspace), not a global install");
  }
  const build = run(["run", "build"], install.packageRoot);
  if (build.status !== 0) {
    throw new Error(build.stderr.trim() || build.error?.message || "npm run build failed");
  }
  const packed = run(["pack"], install.packageRoot);
  if (packed.status !== 0) {
    throw new Error(packed.stderr.trim() || packed.error?.message || packed.stdout.trim() || "npm pack failed");
  }
  const lines = packed.stdout.trim().split(/\r?\n/);
  const filename = lines.at(-1)?.trim() ?? "";
  if (!filename.endsWith(".tgz")) {
    throw new Error(`npm pack did not print a tarball name: ${packed.stdout}`);
  }
  return { filename, stdout: packed.stdout };
}
