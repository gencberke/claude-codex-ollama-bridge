import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packReleaseTarball, parseCliArgs, resolveCliSession } from "./cli-session.js";
import {
  LIVE_HOME_REFUSAL,
  PACKAGE_NAME,
  assertWorkspaceMayTouchHome,
  detectInstall,
  findPackageRoot,
  formatInstallLine,
  resolveListenPort,
  samePath,
  seedIsolatedCodexHome,
} from "./install.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("install identity", () => {
  it("treats a checkout with src/cli.ts as workspace", () => {
    const root = tempDir("cob-install-ws-");
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: PACKAGE_NAME, version: "0.1.0" }),
      );
      writeFileSync(join(root, "src", "cli.ts"), "");
      mkdirSync(join(root, "dist"), { recursive: true });
      const cli = join(root, "dist", "cli.js");
      writeFileSync(cli, "");
      const install = detectInstall(cli);
      assert.equal(install.kind, "workspace");
      assert.equal(install.version, "0.1.0");
      assert.equal(samePath(install.packageRoot ?? "", root), true);
      assert.equal(samePath(findPackageRoot(cli) ?? "", root), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats a packed tree without src/cli.ts as global", () => {
    const root = tempDir("cob-install-g-");
    try {
      mkdirSync(join(root, "dist"), { recursive: true });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: PACKAGE_NAME, version: "0.1.0" }),
      );
      const cli = join(root, "dist", "cli.js");
      writeFileSync(cli, "");
      const install = detectInstall(cli);
      assert.equal(install.kind, "global");
      assert.equal(install.version, "0.1.0");
      assert.match(formatInstallLine(install), /cob 0\.1\.0 \(global\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("follows a Homebrew-style bin symlink to the packed package root", () => {
    const root = tempDir("cob-install-link-");
    try {
      mkdirSync(join(root, "dist"), { recursive: true });
      mkdirSync(join(root, "bin"), { recursive: true });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: PACKAGE_NAME, version: "0.1.1" }),
      );
      const cli = join(root, "dist", "cli.js");
      writeFileSync(cli, "");
      const cobBin = join(root, "bin", "cob");
      symlinkSync(cli, cobBin);
      const install = detectInstall(cobBin);
      assert.equal(install.kind, "global");
      assert.equal(install.version, "0.1.1");
      assert.equal(samePath(install.packageRoot ?? "", root), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("live home guard", () => {
  it("refuses workspace mutating commands against live ~/.codex", () => {
    const live = join(tempDir("cob-live-"), ".codex");
    mkdirSync(live, { recursive: true });
    assert.throws(
      () =>
        assertWorkspaceMayTouchHome({
          command: "start",
          install: { kind: "workspace", version: "0.1.0", cliPath: "/repo/dist/cli.js" },
          codexHome: live,
          allowLiveHome: false,
          liveHome: live,
        }),
      (error: unknown) => error instanceof Error && error.message === LIVE_HOME_REFUSAL,
    );
  });

  it("allows global installs, status, --live-home, and isolated homes", () => {
    const live = join(tempDir("cob-live-ok-"), ".codex");
    const isolated = join(tempDir("cob-iso-"), "dev");
    mkdirSync(live, { recursive: true });
    const workspace = { kind: "workspace" as const, version: "0.1.0", cliPath: "/repo/dist/cli.js" };
    assertWorkspaceMayTouchHome({
      command: "start",
      install: { kind: "global", version: "0.1.0", cliPath: "/usr/lib/cob/dist/cli.js" },
      codexHome: live,
      allowLiveHome: false,
      liveHome: live,
    });
    assertWorkspaceMayTouchHome({
      command: "status",
      install: workspace,
      codexHome: live,
      allowLiveHome: false,
      liveHome: live,
    });
    assertWorkspaceMayTouchHome({
      command: "start",
      install: workspace,
      codexHome: live,
      allowLiveHome: true,
      liveHome: live,
    });
    assertWorkspaceMayTouchHome({
      command: "start",
      install: workspace,
      codexHome: isolated,
      allowLiveHome: false,
      liveHome: live,
    });
  });
});

describe("dev home seed and ports", () => {
  it("copies auth.json once into an isolated home", () => {
    const live = tempDir("cob-auth-src-");
    const dev = tempDir("cob-auth-dst-");
    try {
      writeFileSync(join(live, "auth.json"), '{"tokens":{}}\n', { mode: 0o600 });
      writeFileSync(join(live, "config.toml"), "must-not-copy\n");
      assert.equal(seedIsolatedCodexHome(dev, live).copiedAuth, true);
      assert.equal(readFileSync(join(dev, "auth.json"), "utf8"), '{"tokens":{}}\n');
      assert.equal(seedIsolatedCodexHome(dev, live).copiedAuth, false);
      assert.throws(() => readFileSync(join(dev, "config.toml")));
    } finally {
      rmSync(live, { recursive: true, force: true });
      rmSync(dev, { recursive: true, force: true });
    }
  });

  it("uses 18791 for --dev unless --port or COB_PORT is set", () => {
    assert.equal(resolveListenPort({ isolated: true, portExplicit: false }), 18791);
    assert.equal(resolveListenPort({ isolated: true, portExplicit: true, port: 19000 }), 19000);
    assert.equal(resolveListenPort({ isolated: true, portExplicit: false, envPort: "19100" }), 19100);
    assert.equal(resolveListenPort({ isolated: false, portExplicit: false }), 18790);
  });
});

describe("cli session", () => {
  it("parses --version and --dev", () => {
    assert.equal(parseCliArgs(["node", "cob", "--version"]).command, "version");
    const flags = parseCliArgs(["node", "cob", "start", "--dev", "--home", "/tmp/cob-dev-x"]);
    assert.equal(flags.command, "start");
    assert.equal(flags.dev, true);
    assert.equal(flags.home, "/tmp/cob-dev-x");
  });

  it("points --dev --home at the isolated tree and port 18791", () => {
    const home = tempDir("cob-session-dev-");
    try {
      const flags = parseCliArgs(["node", "cob", "status", "--dev", "--home", home]);
      const session = resolveCliSession(flags, { ...process.env, COB_CODEX_HOME: "" });
      assert.equal(session.paths.codexHome, home);
      assert.equal(session.port, 18791);
      assert.equal(session.isolated, true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not pack from a global install", () => {
    assert.throws(
      () => packReleaseTarball({ kind: "global", version: "0.1.0", cliPath: "/usr/bin/cob" }),
      /workspace/,
    );
  });
});

describe("npm pack manifest", () => {
  it("keeps tests and harnesses out of the published files list", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      files: string[];
    };
    assert.equal(pkg.files.includes("dist/*.js"), true);
    assert.equal(pkg.files.includes("!dist/*.test.js"), true);
    assert.equal(pkg.files.includes("!dist/*.harness.js"), true);
    assert.equal(pkg.files.includes("src"), false);
  });
});
