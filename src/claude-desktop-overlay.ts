import { createHash } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readFileBufferOrNull, writeFileAtomic } from "./atomic.js";
import { CLAUDE_DESKTOP_GATEWAY_KEY } from "./constants.js";
import { claudeDesktopInferenceModels } from "./claude-models.js";
import { assertLoopbackHttpUrl } from "./loopback.js";

export const CLAUDE_DESKTOP_OVERLAY_SCHEMA = 1 as const;
export const CLAUDE_DESKTOP_PROFILE_ID = "c0bcaade-0000-4000-8000-000000000001";
export const CLAUDE_DESKTOP_PROFILE_NAME = "cob";
export const CLAUDE_DESKTOP_RESTART_HINT =
  "Fully quit and reopen Claude Desktop before judging picker changes.";

export type OverlayFileRole = "normalConfig" | "thirdPartyConfig" | "meta" | "cobProfile";

export type ClaudeDesktopTargets = {
  normalConfig: string;
  thirdPartyConfig: string;
  meta: string;
  cobProfile: string;
};

export type OverlayFileRecord = {
  role: OverlayFileRole;
  path: string;
  sha256: string | null;
  missing: boolean;
};

export type ClaudeDesktopOverlayManifest = {
  schema: typeof CLAUDE_DESKTOP_OVERLAY_SCHEMA;
  appliedAt: string;
  profileId: string;
  profileName: string;
  gatewayBaseUrl: string;
  files: OverlayFileRecord[];
};

export type OverlayApplyResult = {
  wrote: boolean;
  snapshotCreated: boolean;
  manifest: ClaudeDesktopOverlayManifest;
};

const FILE_ROLES: OverlayFileRole[] = ["normalConfig", "thirdPartyConfig", "meta", "cobProfile"];

export function assertClaudeDesktopOverlaySupported(platform = process.platform): void {
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error("Claude Desktop overlay is only supported on macOS and Windows");
  }
}

export function resolveClaudeDesktopTargets(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): ClaudeDesktopTargets {
  if (process.platform === "win32") {
    const local = env.LOCALAPPDATA && env.LOCALAPPDATA.length > 0 ? env.LOCALAPPDATA : join(home, "AppData", "Local");
    return targetsFromRoots(join(local, "Claude"), join(local, "Claude-3p"));
  }
  const support = join(home, "Library", "Application Support");
  return targetsFromRoots(join(support, "Claude"), join(support, "Claude-3p"));
}

export function targetsFromRoots(normalRoot: string, thirdPartyRoot: string): ClaudeDesktopTargets {
  return {
    normalConfig: join(normalRoot, "claude_desktop_config.json"),
    thirdPartyConfig: join(thirdPartyRoot, "claude_desktop_config.json"),
    meta: join(thirdPartyRoot, "configLibrary", "_meta.json"),
    cobProfile: join(thirdPartyRoot, "configLibrary", `${CLAUDE_DESKTOP_PROFILE_ID}.json`),
  };
}

export function overlayManifestPath(overlayDir: string): string {
  return join(overlayDir, "manifest.json");
}

export function applyClaudeDesktopOverlay(opts: {
  overlayDir: string;
  gatewayBaseUrl: string;
  targets?: ClaudeDesktopTargets;
  now?: Date;
}): OverlayApplyResult {
  assertLoopbackHttpUrl(opts.gatewayBaseUrl, "Claude Desktop gateway URL");
  const targets = opts.targets ?? resolveClaudeDesktopTargets();
  mkdirSync(opts.overlayDir, { recursive: true });
  const manifestFile = overlayManifestPath(opts.overlayDir);
  let snapshotCreated = false;
  let manifest = readOverlayManifest(opts.overlayDir);
  if (!manifest) {
    manifest = writeSnapshot(opts.overlayDir, targets, opts.gatewayBaseUrl, opts.now ?? new Date());
    snapshotCreated = true;
  } else {
    manifest = {
      ...manifest,
      gatewayBaseUrl: opts.gatewayBaseUrl,
      appliedAt: (opts.now ?? new Date()).toISOString(),
    };
    writeFileAtomic(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  const normal = readJsonObject(targets.normalConfig);
  normal.deploymentMode = "3p";
  writeJson(targets.normalConfig, normal);

  const thirdParty = readJsonObject(targets.thirdPartyConfig);
  thirdParty.deploymentMode = "3p";
  writeJson(targets.thirdPartyConfig, thirdParty);

  const profile = readJsonObject(targets.cobProfile);
  profile.inferenceProvider = "gateway";
  profile.inferenceGatewayBaseUrl = opts.gatewayBaseUrl;
  profile.inferenceGatewayApiKey = CLAUDE_DESKTOP_GATEWAY_KEY;
  profile.inferenceGatewayAuthScheme = "bearer";
  profile.deploymentDisplayName = CLAUDE_DESKTOP_PROFILE_NAME;
  profile.chatTabEnabled = true;
  profile.disableDeploymentModeChooser = true;
  profile.coworkEgressAllowedHosts = ["*"];
  profile.autoModeEnabled = true;
  profile.inferenceModels = claudeDesktopInferenceModels();
  writeJson(targets.cobProfile, profile);

  const meta = readJsonObject(targets.meta);
  meta.appliedId = CLAUDE_DESKTOP_PROFILE_ID;
  meta.entries = cobMetaEntries(meta.entries);
  writeJson(targets.meta, meta);

  return { wrote: true, snapshotCreated, manifest };
}

export function restoreClaudeDesktopOverlay(opts: {
  overlayDir: string;
  targets?: ClaudeDesktopTargets;
}): boolean {
  const manifest = readOverlayManifest(opts.overlayDir);
  if (!manifest) return false;
  const targets = opts.targets ?? resolveClaudeDesktopTargets();
  for (const file of manifest.files) {
    const dest = pathForRole(targets, file.role);
    const copy = join(opts.overlayDir, `${file.role}.json`);
    if (file.missing) {
      unlinkIfExists(dest);
      continue;
    }
    const bytes = readFileBufferOrNull(copy);
    if (!bytes) {
      throw new Error(`cob claude desktop overlay snapshot missing ${file.role}`);
    }
    writeFileAtomic(dest, bytes);
  }
  for (const role of FILE_ROLES) {
    unlinkIfExists(join(opts.overlayDir, `${role}.json`));
  }
  unlinkIfExists(overlayManifestPath(opts.overlayDir));
  return true;
}

export function readOverlayManifest(overlayDir: string): ClaudeDesktopOverlayManifest | undefined {
  const bytes = readFileBufferOrNull(overlayManifestPath(overlayDir));
  if (!bytes) return undefined;
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    const record = parsed as Partial<ClaudeDesktopOverlayManifest>;
    if (record.schema !== CLAUDE_DESKTOP_OVERLAY_SCHEMA) return undefined;
    if (typeof record.gatewayBaseUrl !== "string" || !Array.isArray(record.files)) return undefined;
    return record as ClaudeDesktopOverlayManifest;
  } catch {
    return undefined;
  }
}

export function desktopOverlayStatus(
  overlayDir: string,
  targets?: ClaudeDesktopTargets,
): { kind: "absent" | "applied" | "stale"; text: string } {
  const manifest = readOverlayManifest(overlayDir);
  if (!manifest) {
    return { kind: "absent", text: "desktop overlay: absent" };
  }
  const live = targets ?? resolveClaudeDesktopTargets();
  const meta = readJsonObject(live.meta);
  const profile = readJsonObject(live.cobProfile);
  const appliedId = typeof meta.appliedId === "string" ? meta.appliedId : "";
  const baseUrl = typeof profile.inferenceGatewayBaseUrl === "string" ? profile.inferenceGatewayBaseUrl : "";
  const sha = snapshotSha(manifest);
  if (appliedId === CLAUDE_DESKTOP_PROFILE_ID && baseUrl === manifest.gatewayBaseUrl) {
    return {
      kind: "applied",
      text: `desktop overlay: applied sha256=${sha} gateway=${manifest.gatewayBaseUrl}`,
    };
  }
  return {
    kind: "stale",
    text: `desktop overlay: stale sha256=${sha} expected ${manifest.gatewayBaseUrl}`,
  };
}

export function snapshotSha(manifest: ClaudeDesktopOverlayManifest): string {
  const material = manifest.files
    .map((file) => `${file.role}:${file.missing ? "missing" : file.sha256 ?? ""}`)
    .join("|");
  return createHash("sha256").update(material, "utf8").digest("hex");
}

function writeSnapshot(
  overlayDir: string,
  targets: ClaudeDesktopTargets,
  gatewayBaseUrl: string,
  now: Date,
): ClaudeDesktopOverlayManifest {
  const files: OverlayFileRecord[] = FILE_ROLES.map((role) => {
    const path = pathForRole(targets, role);
    const bytes = readFileBufferOrNull(path);
    if (!bytes) {
      return { role, path, sha256: null, missing: true };
    }
    writeFileAtomic(join(overlayDir, `${role}.json`), bytes);
    return {
      role,
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      missing: false,
    };
  });
  const manifest: ClaudeDesktopOverlayManifest = {
    schema: CLAUDE_DESKTOP_OVERLAY_SCHEMA,
    appliedAt: now.toISOString(),
    profileId: CLAUDE_DESKTOP_PROFILE_ID,
    profileName: CLAUDE_DESKTOP_PROFILE_NAME,
    gatewayBaseUrl,
    files,
  };
  writeFileAtomic(overlayManifestPath(overlayDir), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function pathForRole(targets: ClaudeDesktopTargets, role: OverlayFileRole): string {
  switch (role) {
    case "normalConfig":
      return targets.normalConfig;
    case "thirdPartyConfig":
      return targets.thirdPartyConfig;
    case "meta":
      return targets.meta;
    case "cobProfile":
      return targets.cobProfile;
  }
}

function cobMetaEntries(existing: unknown): Array<{ id: string; name: string }> {
  const entries: Array<{ id: string; name: string }> = [];
  if (Array.isArray(existing)) {
    for (const entry of existing) {
      if (!entry || typeof entry !== "object") continue;
      const id = (entry as { id?: unknown }).id;
      const name = (entry as { name?: unknown }).name;
      if (typeof id !== "string" || id === CLAUDE_DESKTOP_PROFILE_ID) continue;
      entries.push({ id, name: typeof name === "string" ? name : id });
    }
  }
  entries.push({ id: CLAUDE_DESKTOP_PROFILE_ID, name: CLAUDE_DESKTOP_PROFILE_NAME });
  return entries;
}

function readJsonObject(path: string): Record<string, unknown> {
  const bytes = readFileBufferOrNull(path);
  if (!bytes) return {};
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeJson(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // missing is fine
  }
}

export function overlayDirExists(overlayDir: string): boolean {
  return existsSync(overlayManifestPath(overlayDir));
}
