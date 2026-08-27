import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
    assert.match(result.stdout, /^cob \d+\.\d+\.\d+ \((workspace|global)\)\n$/);
  });

  it("--version is the same surface flag", () => {
    const result = run(["--version"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^cob \d+\.\d+\.\d+ \((workspace|global)\)\n$/);
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
});
