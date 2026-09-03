import { copyFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { samePath, type CobInstall } from "../core/install-detection.js";

export const DEFAULT_DEV_PORT = 18791;
export const DEV_HOME_DIRNAME = ".codex-cob-dev";

export const LIVE_HOME_REFUSAL =
  "workspace cob refuses to mutate the live ~/.codex home. Use cob start --dev for an isolated Codex profile, or install a release (npm pack && npm install -g) and run cob start. Pass --live-home only to debug a checkout against Desktop.";

export function defaultLiveHome(home = homedir()): string {
  return join(home, ".codex");
}

export function defaultDevHome(home = homedir()): string {
  return join(home, DEV_HOME_DIRNAME);
}

export function isLiveCodexHome(codexHome: string, liveHome = defaultLiveHome()): boolean {
  return samePath(codexHome, liveHome);
}

const MUTATING_COMMANDS = new Set(["start", "serve", "stop", "restore", "sync", "config apply"]);

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

export function seedIsolatedCodexHome(devHome: string, liveHome = defaultLiveHome()): { copiedAuth: boolean } {
  mkdirSync(devHome, { recursive: true, mode: 0o700 });
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
