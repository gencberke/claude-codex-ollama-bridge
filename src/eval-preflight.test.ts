import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_PORT } from "./constants.js";
import { DEFAULT_DEV_PORT } from "./install.js";
import { runEvalPreflight, snapshotFileSha256, snapshotLiveEval } from "./eval-preflight.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function fakeLive(config = "root-config", catalog = "catalog"): { liveHome: string; configSha256: string; catalogSha256: string } {
  const liveHome = tempDir("cob-eval-live-");
  writeFileSync(join(liveHome, "config.toml"), config);
  writeFileSync(join(liveHome, "cob-catalog.json"), catalog);
  return {
    liveHome,
    configSha256: snapshotFileSha256(join(liveHome, "config.toml")),
    catalogSha256: snapshotFileSha256(join(liveHome, "cob-catalog.json")),
  };
}

function failCode(result: ReturnType<typeof runEvalPreflight>): string {
  assert.equal(result.ok, false);
  return result.ok ? "" : result.code;
}

describe("eval preflight", () => {
  it("allows G2–G4 read-only never on an isolated home", () => {
    const { liveHome, configSha256, catalogSha256 } = fakeLive();
    const result = runEvalPreflight({
      lane: "g2_g4_readonly",
      codexHome: tempDir("cob-eval-dev-"),
      gatewayPort: DEFAULT_DEV_PORT,
      requireDevPort: true,
      liveHome,
      sandbox: "read-only",
      approvalPolicy: "never",
      nativePlaintextSpawn: true,
      expectedLive: { configSha256, catalogSha256 },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.sandbox, "read-only");
      assert.equal(result.approvalPolicy, "never");
      assert.equal(result.live.configSha256, configSha256);
    }
  });

  it("allows G5 only on a disposable git workspace with apply_patch", () => {
    const { liveHome } = fakeLive();
    const repo = tempDir("cob-eval-repo-");
    const workspace = tempDir("cob-eval-ws-");
    mkdirSync(join(workspace, ".git"));
    const result = runEvalPreflight({
      lane: "g5_apply_patch",
      codexHome: tempDir("cob-eval-dev-"),
      gatewayPort: DEFAULT_DEV_PORT,
      liveHome,
      sandbox: "workspace-write",
      approvalPolicy: "never",
      applyPatch: true,
      repoPath: repo,
      workspacePath: workspace,
      disposableWorkspace: true,
    });
    assert.equal(result.ok, true);
  });

  it("refuses live home, live port, approval, and non-disposable G5", () => {
    const { liveHome, configSha256 } = fakeLive();
    const repo = tempDir("cob-eval-repo-");
    mkdirSync(join(repo, ".git"));
    assert.equal(
      runEvalPreflight({
        lane: "g6h_controller",
        codexHome: liveHome,
        gatewayPort: DEFAULT_DEV_PORT,
        liveHome,
        sandbox: "workspace-write",
        approvalPolicy: "never",
      }).ok,
      false,
    );
    assert.equal(
      failCode(
        runEvalPreflight({
          lane: "g8r_replay",
          codexHome: tempDir("cob-eval-dev-"),
          gatewayPort: DEFAULT_PORT,
          liveHome,
          sandbox: "read-only",
          approvalPolicy: "never",
        }),
      ),
      "live_port_refused",
    );
    assert.equal(
      failCode(
        runEvalPreflight({
          lane: "g2_g4_readonly",
          codexHome: tempDir("cob-eval-dev-"),
          gatewayPort: DEFAULT_DEV_PORT,
          liveHome,
          sandbox: "read-only",
          approvalPolicy: "on-request",
        }),
      ),
      "approval_policy_not_effective",
    );
    assert.equal(
      failCode(
        runEvalPreflight({
          lane: "g2_g4_readonly",
          codexHome: tempDir("cob-eval-dev-"),
          gatewayPort: DEFAULT_DEV_PORT,
          liveHome,
          sandbox: "workspace-write",
          approvalPolicy: "never",
        }),
      ),
      "sandbox_not_effective",
    );
    assert.equal(
      failCode(
        runEvalPreflight({
          lane: "g5_apply_patch",
          codexHome: tempDir("cob-eval-dev-"),
          gatewayPort: DEFAULT_DEV_PORT,
          liveHome,
          sandbox: "workspace-write",
          approvalPolicy: "never",
          applyPatch: true,
          repoPath: repo,
          workspacePath: repo,
          disposableWorkspace: true,
        }),
      ),
      "workspace_not_disposable",
    );
    assert.equal(
      failCode(
        runEvalPreflight({
          lane: "g6h_controller",
          codexHome: tempDir("cob-eval-dev-"),
          gatewayPort: DEFAULT_DEV_PORT,
          requireDevPort: true,
          liveHome,
          sandbox: "workspace-write",
          approvalPolicy: "never",
          expectedLive: { configSha256: "not-the-live-sha" },
        }),
      ),
      "live_sha_drift",
    );
    assert.equal(snapshotLiveEval(liveHome).configSha256, configSha256);
  });
});
