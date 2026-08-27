import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { packReleaseTarball, parseCliArgs, resolveClaudeCliSession, resolveCliSession, resolveListenPort } from "./cli-session.js";
import { LIVE_HOME_REFUSAL, assertWorkspaceMayTouchHome, seedIsolatedCodexHome } from "./codex/home.js";
import { USER_CLAUDE_HOME_REFUSAL } from "./claude/home.js";
import {
  PACKAGE_NAME,
  detectInstall,
  findPackageRoot,
  formatInstallLine,
  samePath,
} from "./core/install-detection.js";

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
    assert.equal(flags.surface, "codex");
  });

  it("parses cob claude start as the Claude surface", () => {
    const flags = parseCliArgs(["node", "cob", "claude", "start", "--dev"]);
    assert.equal(flags.surface, "claude");
    assert.equal(flags.command, "start");
    assert.equal(flags.dev, true);
    assert.equal(flags.desktop, false);
  });

  it("parses cob claude start --desktop", () => {
    const flags = parseCliArgs(["node", "cob", "claude", "start", "--dev", "--desktop"]);
    assert.equal(flags.surface, "claude");
    assert.equal(flags.desktop, true);
    assert.equal(flags.dev, true);
  });

  it("parses cob claude agents --dir", () => {
    const flags = parseCliArgs(["node", "cob", "claude", "agents", "--dir", "/tmp/cob-proj"]);
    assert.equal(flags.surface, "claude");
    assert.equal(flags.command, "agents");
    assert.equal(flags.dir, "/tmp/cob-proj");
  });

  it("refuses ~/.claude as a cob claude home", () => {
    const flags = parseCliArgs(["node", "cob", "claude", "status", "--home", join(homedir(), ".claude")]);
    assert.throws(() => resolveClaudeCliSession(flags), (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.equal((error as Error).message, USER_CLAUDE_HOME_REFUSAL);
      return true;
    });
  });

  it("points cob claude --dev at port 18793", () => {
    const home = tempDir("cob-claude-dev-");
    try {
      const flags = parseCliArgs(["node", "cob", "claude", "status", "--dev", "--home", home]);
      const session = resolveClaudeCliSession(flags, { ...process.env, COB_CLAUDE_HOME: "", COB_CLAUDE_PORT: "" });
      assert.equal(session.paths.claudeHome, home);
      assert.equal(session.port, 18793);
      assert.equal(session.isolated, true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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
    const ran: string[] = [];
    assert.throws(
      () =>
        packReleaseTarball({ kind: "global", version: "0.1.0", cliPath: "/usr/bin/cob" }, (args) => {
          ran.push(args.join(" "));
          return { status: 0, stdout: "", stderr: "" };
        }),
      /workspace/,
    );
    assert.deepEqual(ran, []);
  });

  it("runs the production build before npm pack", () => {
    const calls: { args: string[]; cwd: string }[] = [];
    const packed = packReleaseTarball(
      { kind: "workspace", version: "0.2.0", cliPath: "/pkg/dist/cli.js", packageRoot: "/pkg" },
      (args, cwd) => {
        calls.push({ args, cwd });
        if (args[0] === "pack") {
          return { status: 0, stdout: "\ncob-0.2.0.tgz\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    );
    assert.deepEqual(
      calls.map((call) => call.args.join(" ")),
      ["run build", "pack"],
    );
    for (const call of calls) {
      assert.equal(call.cwd, "/pkg");
    }
    assert.equal(packed.filename, "cob-0.2.0.tgz");
  });

  it("refuses to pack when the production build fails", () => {
    const ran: string[] = [];
    assert.throws(
      () =>
        packReleaseTarball(
          { kind: "workspace", version: "0.2.0", cliPath: "/pkg/dist/cli.js", packageRoot: "/pkg" },
          (args) => {
            ran.push(args.join(" "));
            return { status: args.includes("build") ? 2 : 0, stdout: "", stderr: "tsc failed" };
          },
        ),
      /tsc failed/,
    );
    assert.deepEqual(ran, ["run build"]);
  });
});

describe("npm pack manifest", () => {
  it("keeps tests and harnesses out of the published files list", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      files: string[];
    };
    assert.equal(pkg.files.includes("dist/**/*.js"), true);
    assert.equal(pkg.files.includes("!dist/**/*.test.js"), true);
    assert.equal(pkg.files.includes("!dist/**/*.harness.js"), true);
    assert.equal(pkg.files.includes("!dist/**/gate6h.js"), true);
    assert.equal(pkg.files.includes("!dist/**/eval-*.js"), true);
    assert.equal(pkg.files.includes("src"), false);
  });

  it("emits the executable entrypoint next to compiled tests", () => {
    assert.equal(existsSync(new URL("./cli.js", import.meta.url)), true);
  });
});
