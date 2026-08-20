import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

describe("stream crash isolation", () => {
  it("does not exit the process when an Ollama source stream errors", { timeout: 15_000 }, async () => {
    const child = spawn(process.execPath, [join(here, "stream-crash.harness.js")], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: Buffer[] = [];
    const stdout: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    const code = await new Promise<number | null>((resolve) => {
      child.on("close", (exitCode) => resolve(exitCode));
    });
    const err = Buffer.concat(stderr).toString("utf8");
    assert.equal(code, 0, err || Buffer.concat(stdout).toString("utf8"));
    assert.equal(err.includes("UNCAUGHT"), false);
    assert.equal(err.includes("UNHANDLED"), false);
  });
});
