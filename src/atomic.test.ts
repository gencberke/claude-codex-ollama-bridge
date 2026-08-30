import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { readFileBufferOrNull, writeFileAtomic } from "./core/atomic.js";

describe("writeFileAtomic", () => {
  it("writes and reads back the payload", () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-atomic-"));
    const path = join(dir, "out.json");
    writeFileAtomic(path, '{"k":1}\n');
    assert.equal(readFileBufferOrNull(path)?.toString("utf8"), '{"k":1}\n');
  });

  it("leaves no temp file behind when the write fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-atomic-"));
    // renameSync onto an existing directory fails, exercising the cleanup path.
    const target = join(dir, "already-a-dir");
    mkdirSync(target);
    assert.throws(() => {
      writeFileAtomic(target, "data");
    });
    const leftovers = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  });

  it("preserves an existing regular file's mode when no explicit mode is given", () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-atomic-"));
    const path = join(dir, "secret.json");
    writeFileAtomic(path, "one\n", 0o600);
    writeFileAtomic(path, "two\n");
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});