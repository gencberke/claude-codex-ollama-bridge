import { copyFileSync, existsSync, mkdirSync, readFileSync, chmodSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_DEFAULT_DEV_PORT, CLAUDE_DEFAULT_PORT, DEFAULT_PORT } from "./constants.js";
import type { CobSurface } from "./surface.js";

export const PACKAGE_NAME = "codex-ollama-bridge";
export const DEFAULT_DEV_PORT = 18791;
export const DEV_HOME_DIRNAME = ".codex-cob-dev";
export const CLAUDE_LIVE_HOME_DIRNAME = ".claude-cob";
export const CLAUDE_DEV_HOME_DIRNAME = ".claude-cob-dev";
export const USER_CLAUDE_HOME_DIRNAME = ".claude";

export const LIVE_HOME_REFUSAL =
  "workspace cob refuses to mutate the live ~/.codex home. Use cob start --dev for an isolated Codex profile, or install a release (npm pack && npm install -g) and run cob start. Pass --live-home only to debug a checkout against Desktop.";

export const LIVE_CLAUDE_HOME_REFUSAL =
  "workspace cob claude refuses to mutate the live ~/.claude-cob home. Use cob claude start --dev for an isolated cob-owned home, or pass --live-home only to debug a checkout against that live Claude surface.";

export const USER_CLAUDE_HOME_REFUSAL =
  "cob claude never mutates ~/.claude (settings.json or Claude Code home). Use cob-owned ~/.claude-cob or cob claude start --dev (~/.claude-cob-dev). Claude Desktop 3P overlay is a separate --desktop opt-in.";

export type InstallKind = "global" | "workspace" | "unknown";

export type CobInstall = {
  kind: InstallKind;
  version: string;
  cliPath: string;
  packageRoot?: string;
};

export function defaultLiveHome(home = homedir()): string {
  return join(home, ".codex");
}

export function defaultDevHome(home = homedir()): string {
  return join(home, DEV_HOME_DIRNAME);
}

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

export function isLiveCodexHome(codexHome: string, liveHome = defaultLiveHome()): boolean {
  return samePath(codexHome, liveHome);
}

export function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

function normalizePath(value: string): string {
  const resolved = resolveExisting(value);
  if (process.platform === "win32") return resolved.toLowerCase();
  return resolved;
}

export function findPackageRoot(startFile: string): string | undefined {
  let dir = dirname(resolveExisting(startFile));
  for (let i = 0; i < 10; i += 1) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (
          parsed &&
          typeof parsed === "object" &&
          "name" in parsed &&
          (parsed as { name?: unknown }).name === PACKAGE_NAME
        ) {
          return dir;
        }
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export function readPackageVersion(packageRoot: string | undefined): string {
  if (!packageRoot) return "0.0.0";
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      "version" in parsed &&
      typeof (parsed as { version?: unknown }).version === "string"
    ) {
      return (parsed as { version: string }).version;
    }
  } catch {
    // fall through
  }
  return "0.0.0";
}

function resolveExisting(startFile: string): string {
  try {
    return realpathSync(startFile);
  } catch {
    return resolve(startFile);
  }
}

export function detectInstall(cliPath = process.argv[1] ?? ""): CobInstall {
  const resolvedCli = cliPath.length > 0 ? resolveExisting(cliPath) : "";
  let packageRoot = resolvedCli.length > 0 ? findPackageRoot(resolvedCli) : undefined;
  if (!packageRoot && (cliPath.length === 0 || cliPath === process.argv[1])) {
    packageRoot = findPackageRoot(fileURLToPath(import.meta.url));
  }
  const version = readPackageVersion(packageRoot);
  const shown = resolvedCli || cliPath;
  if (!packageRoot) {
    return { kind: "unknown", version, cliPath: shown };
  }
  const workspaceMarker = join(packageRoot, "src", "cli.ts");
  if (existsSync(workspaceMarker)) {
    return { kind: "workspace", version, cliPath: shown, packageRoot };
  }
  return { kind: "global", version, cliPath: shown, packageRoot };
}

export function formatInstallLine(install: CobInstall): string {
  return `cob ${install.version} (${install.kind})`;
}

const MUTATING_COMMANDS = new Set(["start", "serve", "stop", "restore", "sync"]);

export function assertWorkspaceMayTouchHome(opts: {
  command: string;
  install: CobInstall;
  codexHome: string;
  allowLiveHome: boolean;
  liveHome?: string;
}): void {
  if (!MUTATING_COMMANDS.has(opts.command)) return;
  if (opts.allowLiveHome) return;
  if (opts.install.kind !== "workspace") return;
  if (!isLiveCodexHome(opts.codexHome, opts.liveHome ?? defaultLiveHome())) return;
  throw new Error(LIVE_HOME_REFUSAL);
}

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

export function seedIsolatedCodexHome(devHome: string, liveHome = defaultLiveHome()): { copiedAuth: boolean } {
  mkdirSync(devHome, { recursive: true });
  const src = join(liveHome, "auth.json");
  const dest = join(devHome, "auth.json");
  if (!existsSync(src) || existsSync(dest)) return { copiedAuth: false };
  copyFileSync(src, dest);
  try {
    chmodSync(dest, 0o600);
  } catch {
    // best-effort on filesystems that ignore mode
  }
  return { copiedAuth: true };
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
