import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DEFAULT_PORT } from "./constants.js";
import { DEFAULT_DEV_PORT, isLiveCodexHome } from "./install.js";
import { samePath } from "./install-detection.js";

/**
 * Isolated eval lane gate. Does not spawn Codex, write root config, or
 * bypass approval. Pack-excluded.
 */
export type EvalLane = "g2_g4_readonly" | "g5_apply_patch" | "g6h_controller" | "g8r_replay" | "g9_compact";

export type EvalSandbox = "read-only" | "workspace-write" | "danger-full-access";

export type EvalPreflightInput = {
  lane: EvalLane;
  codexHome: string;
  gatewayPort: number;
  liveHome: string;
  sandbox: EvalSandbox;
  approvalPolicy: string;
  requireDevPort?: boolean;
  repoPath?: string;
  workspacePath?: string;
  disposableWorkspace?: boolean;
  applyPatch?: boolean;
  nativePlaintextSpawn?: boolean;
  expectedLive?: {
    configSha256?: string;
    catalogSha256?: string;
  };
};

export type EvalLiveSnapshot = {
  configSha256: string;
  catalogSha256: string;
};

export type EvalPreflightOk = {
  ok: true;
  lane: EvalLane;
  sandbox: "read-only" | "workspace-write";
  approvalPolicy: "never";
  live: EvalLiveSnapshot;
};

export type EvalPreflightCode =
  | "live_home_refused"
  | "live_port_refused"
  | "dev_port_required"
  | "live_sha_drift"
  | "experimental_on_live_home"
  | "approval_policy_not_effective"
  | "sandbox_not_effective"
  | "workspace_not_disposable"
  | "apply_patch_required"
  | "apply_patch_not_isolated";

export type EvalPreflightFail = {
  ok: false;
  code: EvalPreflightCode;
  message: string;
};

export type EvalPreflightResult = EvalPreflightOk | EvalPreflightFail;

export function snapshotFileSha256(path: string): string {
  if (!existsSync(path)) return "missing";
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function snapshotLiveEval(liveHome: string): EvalLiveSnapshot {
  return {
    configSha256: snapshotFileSha256(join(liveHome, "config.toml")),
    catalogSha256: snapshotFileSha256(join(liveHome, "cob-catalog.json")),
  };
}

export function runEvalPreflight(input: EvalPreflightInput): EvalPreflightResult {
  if (isLiveCodexHome(input.codexHome, input.liveHome)) {
    return fail("live_home_refused", "eval lanes must use an isolated Codex home, not ~/.codex");
  }
  if (input.gatewayPort === DEFAULT_PORT) {
    return fail("live_port_refused", "eval lanes must not bind the live Desktop port 18790");
  }
  if (input.requireDevPort === true && input.gatewayPort !== DEFAULT_DEV_PORT) {
    return fail("dev_port_required", "isolated Codex canaries must use cob start --dev (18791)");
  }
  if (input.applyPatch === true && isLiveCodexHome(input.codexHome, input.liveHome)) {
    return fail("experimental_on_live_home", "apply_patch must stay off on the live Desktop home");
  }
  if (input.nativePlaintextSpawn === true && isLiveCodexHome(input.codexHome, input.liveHome)) {
    return fail("experimental_on_live_home", "native_plaintext_spawn must stay off on the live Desktop home");
  }
  if (input.approvalPolicy !== "never") {
    return fail(
      "approval_policy_not_effective",
      `eval lanes require approval_policy="never"; got ${input.approvalPolicy || "empty"}`,
    );
  }

  const sandbox = assertSandbox(input);
  if (!sandbox.ok) return sandbox;

  const live = snapshotLiveEval(input.liveHome);
  if (input.expectedLive?.configSha256 && input.expectedLive.configSha256 !== live.configSha256) {
    return fail("live_sha_drift", "live ~/.codex/config.toml SHA changed during eval setup");
  }
  if (input.expectedLive?.catalogSha256 && input.expectedLive.catalogSha256 !== live.catalogSha256) {
    return fail("live_sha_drift", "live cob-catalog.json SHA changed during eval setup");
  }

  return {
    ok: true,
    lane: input.lane,
    sandbox: sandbox.sandbox,
    approvalPolicy: "never",
    live,
  };
}

function assertSandbox(
  input: EvalPreflightInput,
): { ok: true; sandbox: "read-only" | "workspace-write" } | EvalPreflightFail {
  if (input.sandbox === "danger-full-access") {
    return fail("sandbox_not_effective", "eval lanes reject danger-full-access");
  }
  if (input.lane === "g2_g4_readonly") {
    if (input.sandbox !== "read-only") {
      return fail("sandbox_not_effective", "G2–G4 require sandbox=read-only");
    }
    if (input.applyPatch === true) {
      return fail("apply_patch_not_isolated", "G2–G4 must not arm apply_patch");
    }
    return { ok: true, sandbox: "read-only" };
  }
  if (input.lane === "g5_apply_patch") {
    if (input.sandbox !== "workspace-write") {
      return fail("sandbox_not_effective", "G5 requires sandbox=workspace-write on a disposable workspace");
    }
    if (input.applyPatch !== true) {
      return fail("apply_patch_required", "G5 requires isolated catalog.apply_patch=true");
    }
    if (!isDisposableWorkspace(input)) {
      return fail(
        "workspace_not_disposable",
        "G5 requires a disposable git workspace distinct from the cob repo and live home",
      );
    }
    return { ok: true, sandbox: "workspace-write" };
  }
  if (input.sandbox !== "read-only" && input.sandbox !== "workspace-write") {
    return fail("sandbox_not_effective", `unsupported sandbox ${input.sandbox}`);
  }
  return { ok: true, sandbox: input.sandbox };
}

function isDisposableWorkspace(input: EvalPreflightInput): boolean {
  if (input.disposableWorkspace !== true) return false;
  const workspace = input.workspacePath;
  if (!workspace || !existsSync(join(workspace, ".git"))) return false;
  if (input.repoPath && samePath(workspace, input.repoPath)) return false;
  if (samePath(workspace, input.liveHome) || samePath(workspace, input.codexHome)) return false;
  return true;
}

function fail(code: EvalPreflightCode, message: string): EvalPreflightFail {
  return { ok: false, code, message };
}
