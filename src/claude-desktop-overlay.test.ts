import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  applyClaudeDesktopOverlay,
  CLAUDE_DESKTOP_PROFILE_ID,
  desktopOverlayStatus,
  restoreClaudeDesktopOverlay,
  snapshotSha,
  targetsFromRoots,
} from "./claude/desktop-overlay.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("cob claude desktop overlay", () => {
  it("snapshots SHA, applies cob 3P without stealing Claude ids, and restore is lossless", () => {
    const root = tempDir("cob-claude-desktop-");
    try {
      const normalRoot = join(root, "Claude");
      const thirdPartyRoot = join(root, "Claude-3p");
      const overlayDir = join(root, "overlay");
      mkdirSync(normalRoot, { recursive: true });
      mkdirSync(join(thirdPartyRoot, "configLibrary"), { recursive: true });
      const original = {
        deploymentMode: "1p",
        coworkUserFilesPath: "/tmp/claude-files",
        preferences: { sidebarMode: "epitaxy" },
      };
      writeFileSync(join(normalRoot, "claude_desktop_config.json"), `${JSON.stringify(original, null, 2)}\n`);
      writeFileSync(
        join(thirdPartyRoot, "claude_desktop_config.json"),
        `${JSON.stringify({ deploymentMode: "1p" }, null, 2)}\n`,
      );
      writeFileSync(join(thirdPartyRoot, "configLibrary", "_meta.json"), `${JSON.stringify({ entries: [] }, null, 2)}\n`);
      const before = sha(join(normalRoot, "claude_desktop_config.json"));
      const targets = targetsFromRoots(normalRoot, thirdPartyRoot);

      const applied = applyClaudeDesktopOverlay({
        overlayDir,
        gatewayBaseUrl: "http://127.0.0.1:18793",
        gatewayApiKey: "d".repeat(64),
        targets,
      });
      assert.equal(applied.snapshotCreated, true);
      assert.match(snapshotSha(applied.manifest), /^[0-9a-f]{64}$/);

      const normal = JSON.parse(readFileSync(targets.normalConfig, "utf8")) as { deploymentMode: string };
      const profile = JSON.parse(readFileSync(targets.cobProfile, "utf8")) as {
        inferenceGatewayBaseUrl: string;
        inferenceGatewayApiKey: string;
        inferenceModels?: Array<{ name: string }>;
        autoModeEnabled?: boolean;
        coworkEgressAllowedHosts?: string[];
      };
      const meta = JSON.parse(readFileSync(targets.meta, "utf8")) as { appliedId: string };
      assert.equal(normal.deploymentMode, "3p");
      assert.equal(profile.inferenceGatewayBaseUrl, "http://127.0.0.1:18793");
      assert.equal(profile.inferenceGatewayApiKey, "d".repeat(64));
      assert.equal(profile.inferenceGatewayApiKey === "cob", false);
      assert.equal(profile.autoModeEnabled, true);
      assert.deepEqual(profile.coworkEgressAllowedHosts, ["*"]);
      assert.deepEqual(
        (profile.inferenceModels ?? []).map((entry) => entry.name),
        ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5"],
      );
      assert.equal((profile.inferenceModels ?? []).some((entry) => entry.name.includes("4-6")), false);
      assert.equal(meta.appliedId, CLAUDE_DESKTOP_PROFILE_ID);
      assert.equal(desktopOverlayStatus(overlayDir, targets).kind, "applied");

      const second = applyClaudeDesktopOverlay({
        overlayDir,
        gatewayBaseUrl: "http://127.0.0.1:18793",
        gatewayApiKey: "d".repeat(64),
        targets,
      });
      assert.equal(second.snapshotCreated, false);

      assert.equal(restoreClaudeDesktopOverlay({ overlayDir, targets }), true);
      assert.equal(sha(targets.normalConfig), before);
      assert.equal(readFileSync(targets.normalConfig, "utf8").includes('"deploymentMode": "1p"'), true);
      try {
        readFileSync(targets.cobProfile);
        assert.fail("cob profile should be removed when it was missing");
      } catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
      }
      assert.equal(desktopOverlayStatus(overlayDir, targets).kind, "absent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
