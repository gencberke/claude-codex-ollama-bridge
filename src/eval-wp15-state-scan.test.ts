import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ConversationStateStore } from "./codex/state/store.js";
import { ConversationStateError } from "./codex/state/schema.js";
import { BENCH_COMPACT_ITEM, BENCH_MODEL, compactDraft, runOp } from "./eval-wp15-state-scan.js";

const RETENTION = { maxNodes: 1_000_000, maxHeads: 1_000_000, maxBytes: 1e12, maxAgeMs: 1e12 };

describe("WP15 state-scan lookup lane", () => {
  it("keeps the empty-population lookup a measured miss", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-wp15-test-"));
    try {
      const result = await runOp(stateDir, "lookup", 0, 0);
      assert.deepEqual(result, { ok: true, summary: { responseId: "miss" } });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("fails the benchmark path on a conflicting compaction fixture instead of false success", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-wp15-test-"));
    try {
      const store = new ConversationStateStore(stateDir, RETENTION);
      // Two published compaction replacements matching the same bench item make
      // the lookup ambiguous: the lane must rethrow state_checkpoint_conflict,
      // never report a deterministic "miss".
      await store.publish(compactDraft("resp-conflict-a"));
      await store.publish(compactDraft("resp-conflict-b"));
      await assert.rejects(
        () => runOp(stateDir, "lookup", 2, 0),
        (error: unknown) => error instanceof ConversationStateError && error.code === "state_checkpoint_conflict",
      );
      assert.deepEqual(BENCH_COMPACT_ITEM, { type: "compaction", id: "comp-bench-1" });
      assert.equal(BENCH_MODEL, "bench-model");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});