import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ConversationStateError, encodeResponseId, MAX_STATE_CHAIN_DEPTH, type StateHistoryItem } from "./codex/state/schema.js";
import { MAX_UPSTREAM_BODY_BYTES } from "./core/http/body.js";
import { ConversationStateStore } from "./codex/state/store.js";
import { createStateHistoryItems, historyItemIdentity, mergeStateHistory } from "./codex/state/history.js";
import { formatStateVerifyReport, verifyStateIntegrity } from "./codex/state/verify.js";
import { readdirSync as readdirSnapshotSync } from "node:fs";

function snapshotDir(dir: string): Map<string, { mode: number; bytes: number }> {
  const snapshot = new Map<string, { mode: number; bytes: number }>();
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSnapshotSync(current)) {
      const path = join(current, name);
      const key = `${prefix}${name}`;
      const stat = statSync(path);
      if (stat.isDirectory()) {
        snapshot.set(`${key}/`, { mode: stat.mode, bytes: 0 });
        walk(path, `${key}/`);
      } else {
        snapshot.set(key, { mode: stat.mode, bytes: stat.size });
      }
    }
  };
  walk(dir, "");
  return snapshot;
}

function newStore(options?: ConstructorParameters<typeof ConversationStateStore>[1]): ConversationStateStore {
  return new ConversationStateStore(mkdtempSync(join(tmpdir(), "cob-state-test-")), options);
}

/**
 * Sabotages the checkpoints directory after the parent resolution inside
 * publish, so the candidate checkpoint write fails with EACCES while the
 * candidate archive write (compact archive dir) still succeeds.
 */
class SabotagedCheckpointsStore extends ConversationStateStore {
  constructor(stateDir: string, private readonly sabotage: () => void) {
    super(stateDir);
  }

  async resolve(responseId: string) {
    const resolved = await super.resolve(responseId);
    this.sabotage();
    return resolved;
  }
}

function draft(
  id: string,
  input: unknown,
  output: unknown[],
  parentResponseId?: string,
  replacementHistory?: StateHistoryItem[],
  baseHistory: StateHistoryItem[] = [],
) {
  const providerInput = createStateHistoryItems(input, id, "request");
  const providerOutput = createStateHistoryItems(output, id, "response");
  const history = replacementHistory
    ? replacementHistory
    : mergeStateHistory(mergeStateHistory(baseHistory, providerInput), providerOutput);
  return {
    responseId: id,
    parentResponseId,
    requestInput: input,
    output,
    providerInput,
    providerOutput,
    ...(replacementHistory ? { replacementHistory } : {}),
    history,
    responseBody: { id, object: "response", output },
    model: "ollama/test",
    provenance: { source: "ollama-response" as const, gateway: "cob" as const },
    isCompactionReplacement: replacementHistory !== undefined,
  };
}

describe("durable Ollama conversation state", () => {
  it("recovers a multi-turn chain after constructing a new store", async () => {
    const store = newStore();
    await store.publish(draft("resp-1", [{ id: "user-1", type: "message", text: "one" }], [{ id: "out-1", type: "message", text: "first" }]));
    await store.publish(
      draft(
        "resp-2",
        [{ id: "user-2", type: "message", text: "two" }],
        [{ id: "out-2", type: "message", text: "second" }],
        "resp-1",
        undefined,
        (await store.resolve("resp-1")).history,
      ),
    );
    const restarted = new ConversationStateStore(store.stateDir);
    const resolved = await restarted.resolve("resp-2");
    assert.deepEqual(
      resolved.history.map((item) => (item.value as { id?: string }).id),
      ["user-1", "out-1", "user-2", "out-2"],
    );
  });

  it("publishes concurrent forks without overwriting the parent or sibling", async () => {
    const store = newStore();
    await store.publish(draft("root", [{ id: "u-root", type: "message", text: "root" }], [{ id: "a-root", type: "message", text: "root answer" }]));
    const rootHistory = (await store.resolve("root")).history;
    await Promise.all([
      store.publish(draft("fork-a", [{ id: "u-a", type: "message", text: "same" }], [{ id: "a-a", type: "message", text: "a" }], "root", undefined, rootHistory)),
      store.publish(draft("fork-b", [{ id: "u-b", type: "message", text: "same" }], [{ id: "a-b", type: "message", text: "b" }], "root", undefined, rootHistory)),
    ]);
    assert.equal((await store.resolve("fork-a")).checkpoint.responseId, "fork-a");
    assert.equal((await store.resolve("fork-b")).checkpoint.responseId, "fork-b");
    assert.equal(readdirSync(store.checkpointsDir).filter((name) => name.endsWith(".json")).length, 3);
  });

  it("refuses to commit a publish whose signal aborted before the lock", async () => {
    const store = newStore();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      store.publish(
        draft("resp-aborted", [{ id: "user-1", type: "message", text: "hi" }], [{ id: "out-1", type: "message", text: "lost" }]),
        { signal: controller.signal },
      ),
      (error: unknown) =>
        error instanceof ConversationStateError && error.code === "state_publish_aborted",
    );
    assert.equal(existsSync(store.checkpointsDir), false);
  });

  it("deduplicates identity-backed replay but keeps identical text items distinct", () => {
    const existing = createStateHistoryItems(
      [
        { id: "same-1", type: "message", text: "same" },
        { id: "same-2", type: "message", text: "same" },
      ],
      "resp-1",
      "response",
    );
    const replay = createStateHistoryItems(
      [
        { id: "same-1", type: "message", text: "same" },
        { type: "message", text: "same" },
      ],
      "resp-2",
      "request",
    );
    const merged = mergeStateHistory(existing, replay);
    assert.equal(merged.length, 3);
    assert.deepEqual(
      merged.map((item) => (item.value as { id?: string }).id),
      ["same-1", "same-2", undefined],
    );
  });

  it("deduplicates an earlier value after the same item id changes and replays", () => {
    const additions = createStateHistoryItems(
      [
        { id: "reused", type: "message", text: "A" },
        { id: "reused", type: "message", text: "B" },
        { id: "reused", type: "message", text: "A" },
      ],
      "resp-aba",
      "response",
    );

    const merged = mergeStateHistory([], additions);

    assert.deepEqual(
      merged.map((item) => (item.value as { text: string }).text),
      ["A", "B"],
    );
  });

  it("archives raw compact bytes and uses replacement history", async () => {
    const store = newStore();
    await store.publish(draft("resp-1", [{ id: "old", type: "message", text: "full replay" }], []));
    const raw = Buffer.from('{"id":"compact-1","object":"response.compaction","output":[{"type":"compaction","encrypted_content":"secret"}]}');
    const replacement = createStateHistoryItems(
      [{ id: "old", type: "message", text: "full replay" }],
      "resp-1",
      "response",
    );
    const archive = await store.archiveRawCompactResponse("compact-1", raw);
    const compactDraft = draft(
      "compact-1",
      [],
      [{ type: "compaction", encrypted_content: "secret" }],
      "resp-1",
      replacement,
    );
    await store.publish({
      ...compactDraft,
      providerOutput: [],
      responseBody: {
        id: "compact-1",
        object: "response.compaction",
        output: [{ type: "compaction", encrypted_content: "secret" }],
      },
      provenance: { source: "native-compact", gateway: "cob", compactModel: "codex-mini" },
      rawCompactArchive: archive,
    });
    assert.equal(readFileSync(join(store.stateDir, archive), "utf8"), raw.toString("utf8"));
    assert.deepEqual((await store.resolve("compact-1")).history[0]?.value, replacement[0]?.value);
    assert.equal((readFileSync(store.compactArchivePath("compact-1")).toString("utf8")).includes("secret"), true);
    assert.equal((readFileSync(store.checkpointPath("compact-1")).toString("utf8")).includes("secret"), true);
    assert.equal(statSync(store.stateDir).mode & 0o777, 0o700);
    assert.equal(statSync(store.checkpointsDir).mode & 0o777, 0o700);
    assert.equal(statSync(store.compactArchiveDir).mode & 0o777, 0o700);
    assert.equal(statSync(store.checkpointPath("compact-1")).mode & 0o777, 0o600);
    assert.equal(statSync(store.compactArchivePath("compact-1")).mode & 0o777, 0o600);
    const byFingerprint = await store.resolveCompactionItem(
      { type: "compaction", encrypted_content: "secret" },
      "ollama/test",
    );
    assert.equal(byFingerprint.responseId, "compact-1");
    assert.equal(await store.lineageContains("compact-1", "compact-1"), true);
    assert.equal(await store.lineageContains("compact-1", "resp-1"), true);
    assert.equal(await store.lineageContains("resp-1", "compact-1"), false);
  });

  it("stores ollama-summary replacement history without the cob envelope", async () => {
    const store = newStore();
    await store.publish(draft("resp-1", [{ id: "old", type: "message", text: "full replay" }], []));
    const envelope = "cob1.1.aGFuZG9mZg";
    const replacement = createStateHistoryItems(
      [{ type: "message", role: "assistant", content: [{ type: "input_text", text: "handoff" }] }],
      "compact-sum-1",
      "replacement",
    );
    const raw = Buffer.from(
      JSON.stringify({
        id: "compact-sum-1",
        object: "response",
        output: [{ type: "compaction", id: "item-sum-1", encrypted_content: envelope }],
      }),
    );
    const archive = await store.archiveRawCompactResponse("compact-sum-1", raw);
    await store.publish({
      ...draft(
        "compact-sum-1",
        [],
        [{ type: "compaction", id: "item-sum-1", encrypted_content: envelope }],
        "resp-1",
        replacement,
      ),
      providerInput: [],
      providerOutput: [],
      provenance: { source: "ollama-summary", gateway: "cob", compactModel: "ollama/test" },
      rawCompactArchive: archive,
    });
    const resolved = await store.resolve("compact-sum-1");
    assert.equal(resolved.checkpoint.provenance.source, "ollama-summary");
    assert.equal(JSON.stringify(resolved.history).includes("full replay"), false);
    assert.equal(JSON.stringify(resolved.history).includes("encrypted_content"), false);
    assert.match(JSON.stringify(resolved.history), /handoff/);
    await assert.rejects(
      () =>
        store.resolveCompactionItem(
          { type: "compaction", id: "item-sum-1", encrypted_content: "cob1.1.dGFtcGVy" },
          "ollama/test",
        ),
      (error: unknown) => error instanceof ConversationStateError && error.code === "state_checkpoint_missing",
    );
    const byId = await store.resolveCompactionItem({ type: "compaction", id: "item-sum-1" }, "ollama/test");
    assert.equal(byId.responseId, "compact-sum-1");
  });

  it("fails closed for missing, corrupt, incompatible, and unsafe checkpoints", async () => {
    const store = newStore();
    await assert.rejects(
      () => store.resolve("missing"),
      (error: unknown) => error instanceof ConversationStateError && error.code === "state_checkpoint_missing",
    );
    mkdirSync(store.checkpointsDir, { recursive: true, mode: 0o700 });
    const corrupt = store.checkpointPath("corrupt");
    writeFileSync(corrupt, "{not-json\n", { mode: 0o600 });
    await assert.rejects(
      () => store.resolve("corrupt"),
      (error: unknown) => error instanceof ConversationStateError && error.code === "state_checkpoint_corrupt",
    );
    const incompatible = store.checkpointPath("incompatible");
    writeFileSync(incompatible, JSON.stringify({ schemaVersion: 999, responseId: "incompatible" }), { mode: 0o600 });
    await assert.rejects(
      () => store.resolve("incompatible"),
      (error: unknown) => error instanceof ConversationStateError && error.code === "state_checkpoint_incompatible",
    );

    await store.publish(draft("unsafe", [{ id: "u", type: "message", text: "safe" }], []));
    const unsafePath = store.checkpointPath("unsafe");
    const unsafe = JSON.parse(readFileSync(unsafePath, "utf8")) as {
      history: StateHistoryItem[];
    };
    unsafe.history[0]!.value = { type: "reasoning", encrypted_content: "gAAAAAsecret" };
    unsafe.history[0]!.identity = historyItemIdentity(unsafe.history[0]!.value, unsafe.history[0]!.provenance);
    writeFileSync(unsafePath, `${JSON.stringify(unsafe)}\n`, { mode: 0o600 });
    chmodSync(unsafePath, 0o600);
    await assert.rejects(
      () => store.resolve("unsafe"),
      (error: unknown) => error instanceof ConversationStateError && error.code === "state_checkpoint_unsafe",
    );
  });

  it("retains reachable ancestors while cleaning unreachable forks", async () => {
    const store = newStore({ maxNodes: 10, maxHeads: 1 });
    await store.publish(draft("root", [{ id: "u0" }], []));
    const rootHistory = (await store.resolve("root")).history;
    await store.publish(draft("a", [{ id: "ua" }], [], "root", undefined, rootHistory));
    await store.publish(draft("b", [{ id: "ub" }], [], "root", undefined, rootHistory));
    await store.cleanup();
    assert.equal(existsSync(store.checkpointPath("b")), true);
    assert.equal(existsSync(store.checkpointPath("root")), true);
    assert.equal(existsSync(store.checkpointPath("a")), false);
    await store.resolve("b");
  });

  it("refuses to commit a child whose ancestry was pruned before the publish lock", async () => {
    const store = newStore({ maxNodes: 2, maxHeads: 1 });
    await store.publish(draft("root", [{ id: "u-root" }], []));
    const rootHistory = (await store.resolve("root")).history;
    await store.publish(draft("a", [{ id: "u-a" }], [], "root", undefined, rootHistory));
    const aHistory = (await store.resolve("a")).history;
    // The request prepares the continuation against a while the publish
    // lock is still held by another conversation turn.
    const staleC = draft("c", [{ id: "u-c" }], [], "a", undefined, aHistory);
    // The sibling commit prunes the now-unreachable fork before c reaches
    // the lock.
    await store.publish(draft("b", [{ id: "u-b" }], [], "root", undefined, rootHistory));
    assert.equal(existsSync(store.checkpointPath("a")), false);
    await assert.rejects(
      () => store.publish(staleC),
      (error: unknown) => error instanceof ConversationStateError && error.code === "state_checkpoint_missing",
    );
    assert.equal(existsSync(store.checkpointPath("c")), false);
    assert.equal(existsSync(store.checkpointPath("b")), true);
    await store.resolve("b");
  });

  it("preserves the previous checkpoint state when retention is exhausted", async () => {
    const store = newStore();
    await store.publish(draft("old", [{ id: "u-old", type: "message", text: "old" }], []));
    const tight = new ConversationStateStore(store.stateDir, { maxHeads: 1, maxBytes: 1024 });
    const oversized = draft(
      "big",
      [{ id: "u-big", type: "message", text: "x".repeat(2048) }],
      [{ id: "o-big", type: "message", text: "y".repeat(2048) }],
    );
    await assert.rejects(
      () => tight.publish(oversized),
      (error: unknown) => error instanceof ConversationStateError && error.code === "state_retention_exhausted",
    );
    assert.equal(existsSync(store.checkpointPath("old")), true);
    await store.resolve("old");
    assert.equal(existsSync(store.checkpointPath("big")), false);
  });

  it("preserves planned removals when the candidate archive write fails", async () => {
    const store = new ConversationStateStore(mkdtempSync(join(tmpdir(), "cob-state-test-")), {
      maxNodes: 1,
      maxHeads: 1,
    });
    await store.publish(draft("old", [{ id: "u-old", type: "message", text: "old" }], []));
    writeFileSync(
      store.compactArchivePath("sum-1"),
      '{"id":"sum-1","object":"response"}',
      { mode: 0o600 },
    );
    const replacement = createStateHistoryItems(
      [{ type: "message", role: "assistant", content: [{ type: "input_text", text: "handoff" }] }],
      "sum-1",
      "replacement",
    );
    await assert.rejects(
      () =>
        store.publish({
          ...draft("sum-1", [], [{ type: "compaction", encrypted_content: "secret" }], undefined, replacement),
          providerInput: [],
          providerOutput: [],
          responseBody: {
            id: "sum-1",
            object: "response.compaction",
            output: [{ type: "compaction", encrypted_content: "secret" }],
          },
          provenance: { source: "native-compact", gateway: "cob", compactModel: "codex-mini" },
          rawCompactBody: Buffer.from('{"id":"sum-1","object":"response","output":[]}'),
        }),
      (error: unknown) => error instanceof ConversationStateError && error.code === "state_checkpoint_conflict",
    );
    assert.equal(existsSync(store.checkpointPath("old")), true);
    await store.resolve("old");
    assert.equal(existsSync(store.checkpointPath("sum-1")), false);
  });

  it("preserves a corrupt checkpoint's archive during explicit cleanup while true orphans remain reclaimable", async () => {
    const store = newStore();
    mkdirSync(store.checkpointsDir, { recursive: true, mode: 0o700 });
    mkdirSync(store.compactArchiveDir, { recursive: true, mode: 0o700 });
    writeFileSync(store.checkpointPath("corrupt"), "{not-json\n", { mode: 0o600 });
    const corruptArchive = Buffer.from('{"id":"corrupt","object":"response.compaction"}');
    writeFileSync(store.compactArchivePath("corrupt"), corruptArchive, { mode: 0o600 });
    const orphan = Buffer.from('{"id":"orphan","object":"response.compaction"}');
    writeFileSync(store.compactArchivePath("orphan"), orphan, { mode: 0o600 });
    await store.cleanup();
    assert.equal(readFileSync(store.checkpointPath("corrupt")).equals(Buffer.from("{not-json\n")), true);
    assert.equal(readFileSync(store.compactArchivePath("corrupt")).equals(corruptArchive), true);
    assert.equal(existsSync(store.compactArchivePath("orphan")), false);
  });

  it("preserves a corrupt checkpoint's archive during the post-publish orphan cleanup", async () => {
    const store = newStore();
    await store.publish(draft("old", [{ id: "u-old", type: "message", text: "old" }], []));
    writeFileSync(store.checkpointPath("corrupt"), "{not-json\n", { mode: 0o600 });
    const corruptArchive = Buffer.from('{"id":"corrupt","object":"response.compaction"}');
    writeFileSync(store.compactArchivePath("corrupt"), corruptArchive, { mode: 0o600 });
    const rootHistory = (await store.resolve("old")).history;
    await store.publish(
      draft("next", [{ id: "u-next", type: "message", text: "next" }], [], "old", undefined, rootHistory),
    );
    assert.equal(existsSync(store.checkpointPath("next")), true);
    assert.equal(readFileSync(store.checkpointPath("corrupt")).equals(Buffer.from("{not-json\n")), true);
    assert.equal(readFileSync(store.compactArchivePath("corrupt")).equals(corruptArchive), true);
  });

  it("removes only the archive created by a failed candidate checkpoint write", async () => {
    const store = new SabotagedCheckpointsStore(mkdtempSync(join(tmpdir(), "cob-state-test-")), () => {
      chmodSync(store.checkpointsDir, 0o500);
    });
    await store.publish(draft("old", [{ id: "u-old", type: "message", text: "old" }], []));
    writeFileSync(store.compactArchivePath("kept"), '{"id":"kept","object":"response"}', { mode: 0o600 });
    const replacement = createStateHistoryItems(
      [{ type: "message", role: "assistant", content: [{ type: "input_text", text: "handoff" }] }],
      "victim",
      "replacement",
    );
    await assert.rejects(
      () =>
        store.publish({
          ...draft("victim", [], [{ type: "compaction", encrypted_content: "secret" }], "old", replacement),
          providerInput: [],
          providerOutput: [],
          responseBody: {
            id: "victim",
            object: "response.compaction",
            output: [{ type: "compaction", encrypted_content: "secret" }],
          },
          provenance: { source: "native-compact", gateway: "cob", compactModel: "codex-mini" },
          rawCompactBody: Buffer.from('{"id":"victim","object":"response.compaction"}'),
        }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "EACCES",
    );
    try {
      assert.equal(existsSync(store.compactArchivePath("victim")), false);
      assert.equal(existsSync(store.checkpointPath("victim")), false);
      assert.equal(existsSync(store.checkpointPath("old")), true);
      assert.equal(readFileSync(store.compactArchivePath("kept"), "utf8"), '{"id":"kept","object":"response"}');
      await store.resolve("old");
    } finally {
      chmodSync(store.checkpointsDir, 0o700);
    }
  });

  it("never removes a pre-existing matching archive when the candidate checkpoint write fails", async () => {
    const store = new SabotagedCheckpointsStore(mkdtempSync(join(tmpdir(), "cob-state-test-")), () => {
      chmodSync(store.checkpointsDir, 0o500);
    });
    await store.publish(draft("old", [{ id: "u-old", type: "message", text: "old" }], []));
    const raw = Buffer.from('{"id":"victim","object":"response.compaction"}');
    writeFileSync(store.compactArchivePath("victim"), raw, { mode: 0o600 });
    const replacement = createStateHistoryItems(
      [{ type: "message", role: "assistant", content: [{ type: "input_text", text: "handoff" }] }],
      "victim",
      "replacement",
    );
    await assert.rejects(
      () =>
        store.publish({
          ...draft("victim", [], [{ type: "compaction", encrypted_content: "secret" }], "old", replacement),
          providerInput: [],
          providerOutput: [],
          responseBody: {
            id: "victim",
            object: "response.compaction",
            output: [{ type: "compaction", encrypted_content: "secret" }],
          },
          provenance: { source: "native-compact", gateway: "cob", compactModel: "codex-mini" },
          rawCompactBody: raw,
        }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "EACCES",
    );
    try {
      assert.equal(readFileSync(store.compactArchivePath("victim")).equals(raw), true);
      assert.equal(existsSync(store.checkpointPath("victim")), false);
      await store.resolve("old");
    } finally {
      chmodSync(store.checkpointsDir, 0o700);
    }
  });

  it("prunes obsolete checkpoint and archive pairs after a successful commit", async () => {
    const store = newStore();
    await store.publish(draft("head-1", [{ id: "u1" }], []));
    const replacement = createStateHistoryItems(
      [{ type: "message", role: "assistant", content: [{ type: "input_text", text: "handoff" }] }],
      "head-2",
      "replacement",
    );
    await store.publish({
      ...draft("head-2", [], [{ type: "compaction", encrypted_content: "note-old" }], undefined, replacement),
      providerInput: [],
      providerOutput: [],
      responseBody: {
        id: "head-2",
        object: "response.compaction",
        output: [{ type: "compaction", encrypted_content: "note-old" }],
      },
      provenance: { source: "native-compact", gateway: "cob", compactModel: "codex-mini" },
      rawCompactBody: Buffer.from('{"id":"head-2","object":"response.compaction"}'),
    });
    assert.equal(existsSync(store.compactArchivePath("head-2")), true);
    const tight = new ConversationStateStore(store.stateDir, { maxNodes: 1, maxHeads: 1 });
    await tight.publish(draft("head-3", [{ id: "u3" }], []));
    assert.equal(existsSync(store.checkpointPath("head-3")), true);
    await tight.resolve("head-3");
    assert.equal(existsSync(store.checkpointPath("head-1")), false);
    assert.equal(existsSync(store.checkpointPath("head-2")), false);
    assert.equal(existsSync(store.compactArchivePath("head-2")), false);
  });

  it("keeps a successful publish successful when post-commit pruning fails", async () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    try {
      const store = newStore();
      await store.publish(
        { ...draft("lru-a", [{ id: "ua" }], []), createdAt: "2026-01-01T00:00:00.000Z" },
      );
      await store.publish(
        { ...draft("lru-b", [{ id: "ub" }], []), createdAt: "2026-01-02T00:00:00.000Z" },
      );
      mkdirSync(store.compactArchivePath("lru-a"), { recursive: true, mode: 0o700 });
      const tight = new ConversationStateStore(store.stateDir, { maxNodes: 1, maxHeads: 1 });
      await tight.publish({ ...draft("lru-c", [{ id: "uc" }], []), createdAt: "2026-01-03T00:00:00.000Z" });
      assert.equal(existsSync(store.checkpointPath("lru-c")), true);
      await tight.resolve("lru-c");
      assert.equal(existsSync(store.checkpointPath("lru-a")), false);
      assert.equal(existsSync(store.checkpointPath("lru-b")), true);
      await tight.resolve("lru-b");
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /planned_n=2 removed_n=0 code=state_prune_io_error/);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("fails closed when a stored identity no longer matches value or provenance", async () => {
    const store = newStore();
    await store.publish(draft("tamper", [{ id: "u", type: "message", text: "original" }], []));
    const path = store.checkpointPath("tamper");
    const checkpoint = JSON.parse(readFileSync(path, "utf8")) as {
      history: StateHistoryItem[];
    };
    checkpoint.history[0]!.value = { id: "u", type: "message", text: "mutated" };
    writeFileSync(path, `${JSON.stringify(checkpoint)}\n`, { mode: 0o600 });
    await assert.rejects(
      () => store.resolve("tamper"),
      (error: unknown) => error instanceof ConversationStateError && error.code === "state_checkpoint_corrupt",
    );

    const again = JSON.parse(readFileSync(path, "utf8")) as { history: StateHistoryItem[] };
    again.history[0]!.value = { id: "u", type: "message", text: "original" };
    again.history[0]!.provenance = { ...again.history[0]!.provenance, sourceResponseId: "other" };
    writeFileSync(path, `${JSON.stringify(again)}\n`, { mode: 0o600 });
    await assert.rejects(
      () => store.resolve("tamper"),
      (error: unknown) => error instanceof ConversationStateError && error.code === "state_checkpoint_corrupt",
    );

    const valid = createStateHistoryItems([{ id: "u", type: "message", text: "original" }], "tamper", "request");
    const restored = JSON.parse(readFileSync(path, "utf8")) as { history: StateHistoryItem[] };
    restored.history[0] = valid[0]!;
    writeFileSync(path, `${JSON.stringify(restored)}\n`, { mode: 0o600 });
    const resolved = await store.resolve("tamper");
    assert.equal((resolved.history[0]?.value as { text?: string }).text, "original");
  });

  it("matches the reference merge membership rules on generated histories", () => {
    const corpora: Array<{
      base: Array<{ id?: string; type: string; text: string }>;
      extra: Array<{ id?: string; type: string; text: string }>;
    }> = [
      {
        base: [
          { id: "same-1", type: "message", text: "same" },
          { type: "message", text: "plain" },
        ],
        extra: [
          { id: "same-1", type: "message", text: "same" },
          { id: "same-1", type: "message", text: "changed" },
          { type: "message", text: "plain" },
        ],
      },
      {
        base: [{ id: "a", type: "message", text: "one" }],
        extra: [{ id: "b", type: "message", text: "two" }],
      },
      {
        base: [
          { id: "dup", type: "function_call", text: "{}" },
          { id: "dup", type: "function_call", text: "{}" },
        ],
        extra: [{ id: "dup", type: "function_call", text: "{}" }],
      },
      {
        base: [],
        extra: [
          { type: "message", text: "anon-1" },
          { type: "message", text: "anon-2" },
        ],
      },
      {
        base: [{ id: "keep", type: "reasoning", text: "thought" }],
        extra: [
          { id: "keep", type: "reasoning", text: "thought" },
          { id: "keep", type: "reasoning", text: "other" },
        ],
      },
      {
        base: [
          { id: "reused-base", type: "message", text: "A" },
          { id: "reused-base", type: "message", text: "B" },
        ],
        extra: [{ id: "reused-base", type: "message", text: "A" }],
      },
      {
        base: [{ id: "reused-extra", type: "message", text: "A" }],
        extra: [
          { id: "reused-extra", type: "message", text: "B" },
          { id: "reused-extra", type: "message", text: "A" },
          { id: "reused-extra", type: "message", text: "C" },
          { id: "reused-extra", type: "message", text: "B" },
        ],
      },
    ];
    for (const [index, corpus] of corpora.entries()) {
      const a = createStateHistoryItems(corpus.base, `resp-a-${index}`, "response");
      const b = createStateHistoryItems(corpus.extra, `resp-b-${index}`, "request");
      const merged = mergeStateHistory(a, b);
      const reference = referenceMerge(a, b);
      assert.deepEqual(
        merged,
        reference,
        `corpus ${index}`,
      );
    }
  });
});

function referenceMerge(base: readonly StateHistoryItem[], additions: readonly StateHistoryItem[]): StateHistoryItem[] {
  const merged = [...base];
  for (const addition of additions) {
    const exists =
      merged.some((item) => item.identity === addition.identity) ||
      (addition.provenance.itemId !== undefined &&
        merged.some(
          (item) =>
            item.provenance.itemId === addition.provenance.itemId &&
            JSON.stringify(item.value) === JSON.stringify(addition.value),
        ));
    if (exists) continue;
    merged.push(addition);
  }
  return merged;
}

describe("state integrity audit (cob state verify)", () => {
  it("classifies a clean store without mutating any byte", async () => {
    const store = newStore();
    await store.publish(draft("root", [{ id: "u-root" }], [{ id: "a-root", type: "message", text: "ok" }]));
    await store.publish(draft("child", [{ id: "u-child" }], [], "root"));
    const before = snapshotDir(store.stateDir);
    const report = verifyStateIntegrity(store.stateDir);
    assert.deepEqual(snapshotDir(store.stateDir), before);
    assert.equal(report.schema_version, 1);
    assert.equal(report.clean, true);
    assert.equal(report.checkpoints.total, 2);
    assert.equal(report.checkpoints.valid, 2);
    assert.equal(report.checkpoints.corrupt, 0);
    assert.equal(report.lineage.max_depth, 2);
    const raw = JSON.stringify(report);
    assert.equal(raw.includes("root"), false);
    assert.equal(raw.includes("u-root"), false);
    assert.equal(raw.includes(store.stateDir), false);
  });

  it("classifies corrupt, unsafe-permission, missing-archive, and orphan fixtures", async () => {
    const store = newStore();
    await store.publish(draft("good", [{ id: "u-good" }], []));
    // Corrupt JSON.
    writeFileSync(join(store.checkpointsDir, "bmFtZQ.json"), "{not json", { mode: 0o600 });
    // Invalid filename encoding.
    writeFileSync(join(store.checkpointsDir, "not-base64url!!.json"), "{}", { mode: 0o600 });
    // Unsafe permissions on a validly encoded file.
    const unsafeEncoded = Buffer.from("resp-unsafe", "utf8").toString("base64url");
    writeFileSync(join(store.checkpointsDir, `${unsafeEncoded}.json`), "{}\n", { mode: 0o644 });
    // Orphan archive (no matching checkpoint file).
    writeFileSync(store.compactArchivePath("orphan-1"), "{}", { mode: 0o600 });
    // Temporary file is reported but does not fail the audit.
    writeFileSync(join(store.checkpointsDir, "leftover.tmp"), "x", { mode: 0o600 });
    const before = snapshotDir(store.stateDir);
    const report = verifyStateIntegrity(store.stateDir);
    assert.deepEqual(snapshotDir(store.stateDir), before);
    assert.equal(report.checkpoints.corrupt, 1);
    assert.equal(report.checkpoints.invalid_filename, 1);
    assert.equal(report.checkpoints.permission_failing, 1);
    assert.equal(report.archives.orphan, 1);
    assert.equal(report.temporary_files, 1);
    assert.equal(report.clean, false);
    // Content-free report: no encoded filename or state root leaks.
    const raw = JSON.stringify(report);
    assert.equal(raw.includes("not-base64url"), false);
    assert.equal(raw.includes(unsafeEncoded), false);
    assert.equal(raw.includes("orphan-1"), false);
    assert.equal(raw.includes(store.stateDir), false);
  });

  it("flags a compaction replacement whose archive file is missing", async () => {
    const store = newStore();
    const replacement = createStateHistoryItems(
      [{ type: "message", role: "assistant", content: [{ type: "input_text", text: "handoff" }] }],
      "cmp-1",
      "replacement",
    );
    await store.publish({
      ...draft("cmp-1", [], [{ type: "compaction", encrypted_content: "note" }], undefined, replacement),
      providerInput: [],
      providerOutput: [],
      responseBody: {
        id: "cmp-1",
        object: "response.compaction",
        output: [{ type: "compaction", encrypted_content: "note" }],
      },
      provenance: { source: "native-compact", gateway: "cob", compactModel: "codex-mini" },
      rawCompactBody: Buffer.from('{"id":"cmp-1","object":"response.compaction"}'),
    });
    const before = snapshotDir(store.stateDir);
    const report = verifyStateIntegrity(store.stateDir);
    assert.deepEqual(snapshotDir(store.stateDir), before);
    assert.equal(report.clean, true);
    // Remove the archive through an unrelated manual mutation; verify only reads.
    const { unlinkSync } = await import("node:fs");
    unlinkSync(store.compactArchivePath("cmp-1"));
    const after = verifyStateIntegrity(store.stateDir);
    assert.equal(after.checkpoints.missing_archive, 1);
    assert.equal(after.clean, false);
  });

  it("fails closed for a non-directory or symlinked state root", () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-state-verify-root-"));
    const fileRoot = join(dir, "not-a-dir");
    writeFileSync(fileRoot, "x", { mode: 0o600 });
    const fileReport = verifyStateIntegrity(fileRoot);
    assert.equal(fileReport.state_dir_present, true);
    assert.equal(fileReport.clean, false);
    assert.ok(fileReport.unsafe_directories >= 1);

    const outside = mkdtempSync(join(tmpdir(), "cob-state-verify-outside-"));
    const linkRoot = join(dir, "linked-root");
    symlinkSync(outside, linkRoot);
    const linkReport = verifyStateIntegrity(linkRoot);
    assert.equal(linkReport.clean, false);
    assert.ok(linkReport.unsafe_directories >= 1);
    // The linked target was never followed.
    assert.equal(linkReport.checkpoints.total, 0);
  });

  it("fails closed for unsafe state directory modes and symlinked subdirectories", async () => {
    const store = newStore();
    await store.publish(draft("root", [{ id: "u-root" }], []));
    chmodSync(store.stateDir, 0o755);
    const loose = verifyStateIntegrity(store.stateDir);
    assert.ok(loose.unsafe_directories >= 1);
    assert.equal(loose.clean, false);
    chmodSync(store.stateDir, 0o700);

    const outside = mkdtempSync(join(tmpdir(), "cob-state-verify-outside2-"));
    writeFileSync(join(outside, "bmFtZQ.json"), "{not json", { mode: 0o600 });
    rmSync(store.checkpointsDir, { recursive: true });
    symlinkSync(outside, store.checkpointsDir);
    const linked = verifyStateIntegrity(store.stateDir);
    assert.equal(linked.checkpoints.total, 0);
    assert.ok(linked.unsafe_directories >= 1);
    assert.equal(linked.clean, false);
  });

  it("fails closed when a replacement archive is a symlink, unsafe, or oversized", async () => {
    const store = newStore();
    const replacement = createStateHistoryItems(
      [{ type: "message", role: "assistant", content: [{ type: "input_text", text: "handoff" }] }],
      "cmp-1",
      "replacement",
    );
    await store.publish({
      ...draft("cmp-1", [], [{ type: "compaction", encrypted_content: "note" }], undefined, replacement),
      providerInput: [],
      providerOutput: [],
      responseBody: {
        id: "cmp-1",
        object: "response.compaction",
        output: [{ type: "compaction", encrypted_content: "note" }],
      },
      provenance: { source: "native-compact", gateway: "cob", compactModel: "codex-mini" },
      rawCompactBody: Buffer.from('{"id":"cmp-1","object":"response.compaction"}'),
    });
    const archivePath = store.compactArchivePath("cmp-1");
    const archiveBytes = readFileSync(archivePath);

    chmodSync(archivePath, 0o644);
    const unsafe = verifyStateIntegrity(store.stateDir);
    assert.equal(unsafe.checkpoints.valid, 0);
    assert.equal(unsafe.checkpoints.corrupt, 1);
    assert.equal(unsafe.clean, false);
    chmodSync(archivePath, 0o600);

    const outside = mkdtempSync(join(tmpdir(), "cob-state-verify-archive-"));
    const outsideArchive = join(outside, "archive.json");
    writeFileSync(outsideArchive, archiveBytes, { mode: 0o600 });
    unlinkSync(archivePath);
    symlinkSync(outsideArchive, archivePath);
    const linked = verifyStateIntegrity(store.stateDir);
    assert.equal(linked.checkpoints.corrupt, 1);
    assert.equal(linked.clean, false);

    unlinkSync(archivePath);
    writeFileSync(archivePath, Buffer.alloc(MAX_UPSTREAM_BODY_BYTES + 1, 0), { mode: 0o600 });
    const oversized = verifyStateIntegrity(store.stateDir);
    assert.equal(oversized.checkpoints.valid, 0);
    assert.equal(oversized.checkpoints.corrupt, 1);
    assert.equal(oversized.clean, false);
  });

  it("does not let a corrupt or non-replacement checkpoint make its archive look valid", async () => {
    const store = newStore();
    const replacement = createStateHistoryItems(
      [{ type: "message", role: "assistant", content: [{ type: "input_text", text: "handoff" }] }],
      "cmp-1",
      "replacement",
    );
    await store.publish({
      ...draft("cmp-1", [], [{ type: "compaction", encrypted_content: "note" }], undefined, replacement),
      providerInput: [],
      providerOutput: [],
      responseBody: {
        id: "cmp-1",
        object: "response.compaction",
        output: [{ type: "compaction", encrypted_content: "note" }],
      },
      provenance: { source: "native-compact", gateway: "cob", compactModel: "codex-mini" },
      rawCompactBody: Buffer.from('{"id":"cmp-1","object":"response.compaction"}'),
    });
    await store.publish(draft("plain", [{ id: "u-plain" }], []));
    writeFileSync(store.compactArchivePath("plain"), "{}", { mode: 0o600 });
    const before = verifyStateIntegrity(store.stateDir);
    assert.equal(before.archives.linked, 1);
    assert.equal(before.archives.orphan, 1);

    // Corrupting the replacement checkpoint revokes the archive's linked
    // status instead of shielding it as a valid link.
    writeFileSync(store.checkpointPath("cmp-1"), "{not json", { mode: 0o600 });
    const after = verifyStateIntegrity(store.stateDir);
    assert.equal(after.checkpoints.corrupt, 1);
    assert.equal(after.archives.linked, 0);
    assert.equal(after.archives.orphan, 2);
    assert.equal(after.clean, false);
  });

  it("counts root-level temporary files and includes them in the scan budget", async () => {
    const store = newStore();
    await store.publish(draft("root", [{ id: "u-root" }], []));
    writeFileSync(join(store.stateDir, "leftover.tmp"), "x", { mode: 0o600 });
    const report = verifyStateIntegrity(store.stateDir);
    assert.equal(report.temporary_files, 1);
    assert.ok(report.scan.files_scanned >= 1);
    assert.equal(report.clean, true);
  });

  it("records an explicit finding when lineage exceeds the store chain-depth invariant", () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-state-verify-depth-"));
    const stateDir = join(dir, "cob-state");
    const checkpointsDir = join(stateDir, "checkpoints");
    mkdirSync(checkpointsDir, { recursive: true, mode: 0o700 });
    // One node beyond the store's fail-closed MAX_STATE_CHAIN_DEPTH + 1 limit.
    const total = MAX_STATE_CHAIN_DEPTH + 3;
    for (let index = 0; index < total; index += 1) {
      const responseId = `d${index}`;
      const checkpoint = {
        schemaVersion: 1,
        responseId,
        ...(index > 0 ? { parentResponseId: `d${index - 1}` } : {}),
        requestInput: null,
        output: [],
        providerInput: [],
        providerOutput: [],
        history: [],
        responseBody: { id: responseId, output: [] },
        route: "ollama",
        model: "m",
        provenance: { source: "ollama-response", gateway: "cob" },
        isCompactionReplacement: false,
        createdAt: "2026-08-31T00:00:00.000Z",
      };
      writeFileSync(
        join(checkpointsDir, `${encodeResponseId(responseId)}.json`),
        `${JSON.stringify(checkpoint)}\n`,
        { mode: 0o600 },
      );
    }
    const report = verifyStateIntegrity(stateDir);
    assert.equal(report.checkpoints.valid, total);
    assert.ok(report.lineage.over_depth >= 1);
    assert.equal(report.clean, false);
  });

  it("stops reading file contents once the scan cap is exceeded and fails closed", async () => {
    const store = newStore();
    await store.publish(draft("ok-1", [{ id: "u-1" }], []));
    // Two fixtures that a content scan would classify; past the cap they must
    // stay unclassified because contents are never read.
    writeFileSync(join(store.checkpointsDir, "bmFtZQ.json"), "{not json", { mode: 0o600 });
    writeFileSync(join(store.checkpointsDir, "bmFtZQ2.json"), "{not json", { mode: 0o600 });
    const unsafeEncoded = Buffer.from("resp-overcap", "utf8").toString("base64url");
    writeFileSync(join(store.checkpointsDir, `${unsafeEncoded}.json`), "{}\n", { mode: 0o644 });
    const before = snapshotDir(store.stateDir);
    const report = verifyStateIntegrity(store.stateDir, { scanFileLimit: 5 });
    assert.deepEqual(snapshotDir(store.stateDir), before);
    assert.equal(report.scan.limit_exceeded, true);
    assert.equal(report.scan.limit, 5);
    assert.ok(report.scan.files_scanned > 5);
    assert.equal(report.clean, false);
    // Bounded: contents were never read, so no content-derived findings.
    assert.equal(report.checkpoints.corrupt, 0);
    assert.equal(report.checkpoints.permission_failing, 0);
    assert.equal(report.checkpoints.valid, 0);
    assert.equal(report.checkpoints.total, 4);
    assert.equal(report.lineage.max_depth, 0);
  });

  it("treats a missing state root as a clean empty audit", () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-state-verify-absent-"));
    const report = verifyStateIntegrity(join(dir, "cob-state"));
    assert.equal(report.state_dir_present, false);
    assert.equal(report.clean, true);
    assert.equal(report.checkpoints.total, 0);
  });

  it("serializes identical human and JSON modes from one report", () => {
    const store = newStore();
    const report = verifyStateIntegrity(store.stateDir);
    const serialized = JSON.stringify(report);
    assert.doesNotThrow(() => JSON.parse(serialized));
    const formatted = formatStateVerifyReport(report);
    assert.match(formatted, /^state verify: clean/);
    assert.equal(formatted.includes(store.stateDir), false);
  });
});
