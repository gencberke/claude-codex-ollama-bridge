import { createHash } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readFileBufferOrNull, writeFileAtomic } from "../core/atomic.js";
import {
  CLAUDE_SPAWN_AGENTS,
  isOwnedClaudeAgentFile,
  renderClaudeAgentFile,
} from "./agents.js";
import { defaultUserClaudeHome } from "./home.js";
import { samePath } from "../core/install-detection.js";

export const USER_AGENTS_OVERLAY_SCHEMA = 1 as const;

export type UserAgentFileRecord = {
  name: string;
  missing: boolean;
  sha256: string | null;
};

export type UserAgentsOverlayManifest = {
  schema: typeof USER_AGENTS_OVERLAY_SCHEMA;
  appliedAt: string;
  agentsDir: string;
  files: UserAgentFileRecord[];
};

export type UserAgentsApplyResult = {
  wrote: string[];
  skipped: string[];
  snapshotCreated: boolean;
  manifest: UserAgentsOverlayManifest;
};

export function userClaudeAgentsDir(userClaudeHome = defaultUserClaudeHome()): string {
  return join(userClaudeHome, "agents");
}

export function userAgentsOverlayDir(overlayDir: string): string {
  return join(overlayDir, "user-agents");
}

export function userAgentsManifestPath(overlayDir: string): string {
  return join(userAgentsOverlayDir(overlayDir), "manifest.json");
}

/** cob-owned ~/.claude/agents/cob-*.md only. Never settings.json. */
export function applyUserClaudeAgentsOverlay(opts: {
  overlayDir: string;
  userClaudeHome?: string;
  now?: Date;
}): UserAgentsApplyResult {
  const agentsDir = userClaudeAgentsDir(opts.userClaudeHome ?? defaultUserClaudeHome());
  mkdirSync(userAgentsOverlayDir(opts.overlayDir), { recursive: true });
  let snapshotCreated = false;
  let manifest = readUserAgentsManifest(opts.overlayDir);
  if (!manifest) {
    manifest = writeUserAgentsSnapshot(opts.overlayDir, agentsDir, opts.now ?? new Date());
    snapshotCreated = true;
  }

  const wrote: string[] = [];
  const skipped: string[] = [];
  mkdirSync(agentsDir, { recursive: true });
  for (const agent of CLAUDE_SPAWN_AGENTS) {
    const path = join(agentsDir, `${agent.name}.md`);
    if (existsSync(path) && !isOwnedClaudeAgentFile(path)) {
      skipped.push(path);
      continue;
    }
    writeFileAtomic(path, renderClaudeAgentFile(agent));
    wrote.push(path);
  }
  return { wrote, skipped, snapshotCreated, manifest };
}

export function restoreUserClaudeAgentsOverlay(opts: {
  overlayDir: string;
  userClaudeHome?: string;
}): boolean {
  const manifest = readUserAgentsManifest(opts.overlayDir);
  if (!manifest) return false;
  const agentsDir = userClaudeAgentsDir(opts.userClaudeHome ?? defaultUserClaudeHome());
  if (!samePath(manifest.agentsDir, agentsDir)) {
    throw new Error(
      `cob claude user-agents overlay manifest targets ${manifest.agentsDir}; refusing to restore into ${agentsDir}`,
    );
  }
  for (const file of manifest.files) {
    const dest = join(agentsDir, file.name);
    const copy = join(userAgentsOverlayDir(opts.overlayDir), file.name);
    if (file.missing) {
      if (!existsSync(dest) || isOwnedClaudeAgentFile(dest)) {
        unlinkIfExists(dest);
      }
      unlinkIfExists(copy);
      continue;
    }
    const bytes = readFileBufferOrNull(copy);
    if (!bytes) {
      throw new Error(`cob claude user-agents snapshot missing ${file.name}`);
    }
    writeFileAtomic(dest, bytes);
    unlinkIfExists(copy);
  }
  unlinkIfExists(userAgentsManifestPath(opts.overlayDir));
  return true;
}

export function readUserAgentsManifest(overlayDir: string): UserAgentsOverlayManifest | undefined {
  const bytes = readFileBufferOrNull(userAgentsManifestPath(overlayDir));
  if (!bytes) return undefined;
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    const record = parsed as Partial<UserAgentsOverlayManifest>;
    if (record.schema !== USER_AGENTS_OVERLAY_SCHEMA) return undefined;
    if (typeof record.agentsDir !== "string" || !Array.isArray(record.files)) return undefined;
    return record as UserAgentsOverlayManifest;
  } catch {
    return undefined;
  }
}

export function userAgentsOverlayStatus(
  overlayDir: string,
  userClaudeHome?: string,
): { kind: "absent" | "applied" | "partial"; text: string } {
  const manifest = readUserAgentsManifest(overlayDir);
  if (!manifest) {
    return { kind: "absent", text: "user agents overlay: absent" };
  }
  const agentsDir = userClaudeAgentsDir(userClaudeHome ?? defaultUserClaudeHome());
  let owned = 0;
  for (const agent of CLAUDE_SPAWN_AGENTS) {
    if (isOwnedClaudeAgentFile(join(agentsDir, `${agent.name}.md`))) owned += 1;
  }
  if (owned === CLAUDE_SPAWN_AGENTS.length) {
    return { kind: "applied", text: `user agents overlay: applied n=${owned}` };
  }
  return { kind: "partial", text: `user agents overlay: partial n=${owned}` };
}

function writeUserAgentsSnapshot(
  overlayDir: string,
  agentsDir: string,
  now: Date,
): UserAgentsOverlayManifest {
  const snapDir = userAgentsOverlayDir(overlayDir);
  const files: UserAgentFileRecord[] = CLAUDE_SPAWN_AGENTS.map((agent) => {
    const name = `${agent.name}.md`;
    const path = join(agentsDir, name);
    const bytes = readFileBufferOrNull(path);
    if (!bytes) {
      return { name, missing: true, sha256: null };
    }
    writeFileAtomic(join(snapDir, name), bytes);
    return {
      name,
      missing: false,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  const manifest: UserAgentsOverlayManifest = {
    schema: USER_AGENTS_OVERLAY_SCHEMA,
    appliedAt: now.toISOString(),
    agentsDir,
    files,
  };
  writeFileAtomic(userAgentsManifestPath(overlayDir), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // missing is fine
  }
}
