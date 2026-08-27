import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compactAttemptRawKey,
  formatCompactAttemptLog,
  noteCompactAttempt,
  resetCompactAttemptLog,
} from "./codex/compact-attempt-log.js";
import { sha256Hex8 } from "./codex/request-metrics.js";

describe("compact-attempt-log", () => {
  it("increments attempts for the same parent without logging the raw id", () => {
    resetCompactAttemptLog();
    const opts = {
      parentResponseId: "resp_secret_parent",
      threadModel: "ollama/deepseek-v4-flash:0731-cloud",
      replayHistory: [{ type: "message" }],
    };
    const first = noteCompactAttempt(opts);
    const second = noteCompactAttempt(opts);
    assert.equal(first.attempt, 1);
    assert.equal(second.attempt, 2);
    assert.equal(first.groupSha8, second.groupSha8);
    assert.equal(first.groupSha8, sha256Hex8(compactAttemptRawKey(opts)));
    assert.equal(first.groupSha8.length, 8);
    const line = formatCompactAttemptLog(second);
    assert.match(line, /compact_group=[0-9a-f]{8}/);
    assert.match(line, /compact_attempt=2/);
    assert.equal(line.includes("resp_secret_parent"), false);
    assert.equal(JSON.stringify(second).includes("resp_secret_parent"), false);
  });

  it("keeps distinct parents and history fingerprints on separate counters", () => {
    resetCompactAttemptLog();
    const parentA = noteCompactAttempt({
      parentResponseId: "resp_a",
      threadModel: "ollama/test",
      replayHistory: [],
    });
    const parentB = noteCompactAttempt({
      parentResponseId: "resp_b",
      threadModel: "ollama/test",
      replayHistory: [],
    });
    const histA = noteCompactAttempt({
      threadModel: "ollama/test",
      replayHistory: [{ type: "message", role: "user", content: "a" }],
    });
    const histAAgain = noteCompactAttempt({
      threadModel: "ollama/test",
      replayHistory: [{ type: "message", role: "user", content: "a" }],
    });
    const histB = noteCompactAttempt({
      threadModel: "ollama/test",
      replayHistory: [{ type: "message", role: "user", content: "b" }],
    });
    assert.equal(parentA.attempt, 1);
    assert.equal(parentB.attempt, 1);
    assert.notEqual(parentA.groupSha8, parentB.groupSha8);
    assert.equal(histA.attempt, 1);
    assert.equal(histAAgain.attempt, 2);
    assert.equal(histA.groupSha8, histAAgain.groupSha8);
    assert.equal(histB.attempt, 1);
    assert.notEqual(histA.groupSha8, histB.groupSha8);
  });

  it("evicts the oldest group after 256 distinct keys", () => {
    resetCompactAttemptLog();
    const first = noteCompactAttempt({
      parentResponseId: "resp_0",
      threadModel: "ollama/test",
      replayHistory: [],
    });
    assert.equal(first.attempt, 1);
    for (let index = 1; index <= 256; index += 1) {
      noteCompactAttempt({
        parentResponseId: `resp_${index}`,
        threadModel: "ollama/test",
        replayHistory: [],
      });
    }
    const revived = noteCompactAttempt({
      parentResponseId: "resp_0",
      threadModel: "ollama/test",
      replayHistory: [],
    });
    assert.equal(revived.attempt, 1);
    assert.equal(revived.groupSha8, first.groupSha8);
  });
});
