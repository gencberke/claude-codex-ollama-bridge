import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  HUMAN_LOG_MAX_BYTES,
  createPrivateRotatingLogWriter,
  resetPrivateLogFiles,
} from "./codex/runtime/log-fd.js";

describe("bounded detached gateway log", () => {
  it("resets only on an explicit fresh writer and caps current plus archive", () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-log-rotate-"));
    const path = join(dir, "cob-gateway.log");
    writeFileSync(path, "old\n", { mode: 0o600 });
    writeFileSync(`${path}.1`, "older\n", { mode: 0o600 });
    const writer = createPrivateRotatingLogWriter(path, true);
    assert.equal(readFileSync(path, "utf8"), "");
    assert.equal(existsSync(`${path}.1`), false);
    writer.write(Buffer.alloc(HUMAN_LOG_MAX_BYTES + 32, 120));
    writer.close();
    assert.ok(statSync(path).size <= HUMAN_LOG_MAX_BYTES);
    assert.ok(statSync(`${path}.1`).size <= HUMAN_LOG_MAX_BYTES);
  });

  it("does not remove a symlink while validating a reset target", () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-log-reset-link-"));
    const real = join(dir, "real.log");
    const path = join(dir, "cob-gateway.log");
    writeFileSync(real, "keep\n", { mode: 0o600 });
    symlinkSync(real, path);
    assert.throws(() => resetPrivateLogFiles(path), /ELOOP|log target/i);
    assert.equal(readFileSync(real, "utf8"), "keep\n");
  });
});
