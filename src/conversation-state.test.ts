import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  ConversationStateError,
  ConversationStateStore,
  createStateHistoryItems,
  historyItemIdentity,
  mergeStateHistory,
  type StateHistoryItem,
} from "./conversation-state.js";

function newStore(options?: ConstructorParameters<typeof ConversationStateStore>[1]): ConversationStateStore {
  return new ConversationStateStore(mkdtempSync(join(tmpdir(), "cob-state-test-")), options);
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
    ];
    for (const [index, corpus] of corpora.entries()) {
      const a = createStateHistoryItems(corpus.base, `resp-a-${index}`, "response");
      const b = createStateHistoryItems(corpus.extra, `resp-b-${index}`, "request");
      const merged = mergeStateHistory(a, b);
      const reference = referenceMerge(a, b);
      assert.deepEqual(
        merged.map((item) => item.identity),
        reference.map((item) => item.identity),
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
