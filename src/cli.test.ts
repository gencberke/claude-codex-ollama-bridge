import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("cob executable contract", () => {
  it("version prints the install line", () => {
    const result = run(["version"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^cob \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)? \((workspace|global)\)\n$/);
  });

  it("--version is the same surface flag", () => {
    const result = run(["--version"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^cob \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)? \((workspace|global)\)\n$/);
  });

  it("root help exits 0 and names both surfaces", () => {
    const result = run(["help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /cob start \.\.\. +cob Codex/);
    assert.match(result.stdout, /cob claude start \.\.\./);
    assert.match(result.stdout, /cob pack/);
  });

  it("codex help via explicit surface exits 0", () => {
    const result = run(["codex", "help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage \(Codex\)/);
  });

  it("claude help exits 0 and stays Claude-scoped", () => {
    const result = run(["claude", "help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /cob claude — Claude Code \/ Claude Desktop Ollama bridge/);
    assert.match(result.stdout, /cob start remains cob Codex on :18790/);
  });

  it("an unknown codex command prints help and exits 1", () => {
    const result = run(["bogus-command"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Usage \(Codex\)/);
  });

  it("an unknown claude command prints claude help and exits 1", () => {
    const result = run(["claude", "bogus-command"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /cob claude — Claude Code \/ Claude Desktop Ollama bridge/);
  });

  it("--json applies to cob status and not to other commands", () => {
    assert.match(run(["status", "--json"]).stdout, /^\{\s*"schema_version": 1,/);
    const inapplicable = run(["stop", "--json"]);
    assert.equal(inapplicable.status, 1);
    assert.match(inapplicable.stderr, /flag --json does not apply/);
  });
});

describe("state verify CLI grammar", () => {
  it("refuses unknown nested state subcommands", () => {
    const result = run(["state", "prune"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /prune/);
  });

  it("bare state stays unknown", () => {
    const help = run(["state"]);
    assert.equal(help.status, 1);
    assert.match(help.stdout, /Usage \(Codex\)/);
  });

  it("state verify --json runs the real audit in an isolated home", () => {
    const home = mkdtempSync(join(tmpdir(), "cob-cli-state-verify-"));
    const result = run(["state", "verify", "--json", "--home", home]);
    assert.equal(result.status, 0);
    // Exactly one JSON object and nothing else on stdout.
    const parsed = JSON.parse(result.stdout);
    assert.equal(result.stderr, "");
    assert.equal(parsed.schema_version, 1);
    assert.equal(parsed.state_dir_present, false);
    assert.equal(parsed.clean, true);
    assert.equal(parsed.scan.limit_exceeded, false);
    // Content-free: the absolute home path never appears in the report.
    assert.equal(result.stdout.includes(home), false);
  });
});
