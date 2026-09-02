import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ollamaCompactHandoffSkeleton } from "./codex/compaction/summary.js";
import { finalizeG9, initialG9State, reduceG9 } from "./eval-g9.js";
import { listenGateway } from "./codex/gateway.js";
import type { EvalLiveShaSnapshot, EvalRunIdentity } from "./eval-receipt.js";
import type { CatalogFile } from "./codex/types.js";
import type { G9State } from "./eval-g9.js";
import type { JsonObject } from "./core/json.js";

/** The only summary shape the scorer accepts: the exact seven-section handoff. */
const VALID_SUMMARY = ollamaCompactHandoffSkeleton({ Completed: "handoff after baseline" });
const NONCE_LINE = "Completed: handoff after baseline";

const CATALOG: CatalogFile = {
  models: [{ slug: "codex-mini" }, { slug: "ollama/test" }],
};

const RUN: EvalRunIdentity = {
  model: "ollama/test",
  child: "child-1",
  session: "sess-1",
  requestId: "req-1",
  corpusSha256: "a".repeat(64),
};

const LIVE = {
  configSha256: "c".repeat(64),
  catalogSha256: "d".repeat(64),
  catalogMetaSha256: "e".repeat(64),
};

function message(id: string, text: string): JsonObject {
  return {
    id,
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
    server.on("error", reject);
  });
}

async function close(server: { close: (callback: (error?: Error) => void) => void }): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

describe("G9 compact protocol", () => {
  it("does not treat compact-ok without continuation as gold", () => {
    let state = initialG9State();
    state = reduceG9(state, { type: "baseline", responseId: "resp-1", run: RUN });
    state = reduceG9(state, {
      type: "compact_incomplete",
      ollamaHitsDelta: 1,
      httpStatus: 400,
      code: "compaction_summary_incomplete",
      run: RUN,
    });
    state = reduceG9(state, {
      type: "compact_ok",
      responseId: "compact-2",
      parentResponseId: "resp-1",
      preBytes: 1000,
      postBytes: 200,
      handoffSummary: VALID_SUMMARY,
      run: RUN,
    });
    const late = finalizeG9(state, LIVE, LIVE);
    assert.equal(late.verdict, "fail");
    assert.equal(late.code, "compaction_continuation_incomplete");
  });

  it("fails closed when cob would retry an incomplete summary", () => {
    let state = reduceG9(initialG9State(), { type: "baseline", responseId: "resp-1", run: RUN });
    state = reduceG9(state, {
      type: "compact_incomplete",
      ollamaHitsDelta: 2,
      httpStatus: 400,
      code: "compaction_summary_incomplete",
      run: RUN,
    });
    assert.equal(state.verdict, "fail");
    assert.equal(state.code, "cob_compact_retry_forbidden");
  });

  it("requires a valid seven-section compact then two derived-nonce continuations", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-g9-"));
    const ollamaBodies: JsonObject[] = [];
    let summarizerMode: "incomplete" | "complete" = "incomplete";
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: CATALOG,
      stateDir,
      nativeFetch: async () => new Response("native must not compact Ollama threads", { status: 500 }),
      ollamaFetch: async (_url, init) => {
        const body = JSON.parse(init.body.toString("utf8")) as JsonObject;
        ollamaBodies.push(body);
        if (JSON.stringify(body).includes("You are compacting")) {
          const text =
            summarizerMode === "incomplete"
              ? "plain recap"
              : ollamaCompactHandoffSkeleton({ Completed: "handoff after baseline" });
          return new Response(
            JSON.stringify({
              id: `sum-${summarizerMode}`,
              object: "response",
              status: "completed",
              output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        const turn = ollamaBodies.filter((item) => !JSON.stringify(item).includes("You are compacting")).length;
        return new Response(
          JSON.stringify({
            id: `resp-${turn}`,
            object: "response",
            status: "completed",
            model: "test",
            output: [
              {
                id: `assistant-${turn}`,
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: `answer-${turn}` }],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    let state = initialG9State();
    try {
      const baseline = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ollama/test", input: message("user-1", "one") }),
      });
      const baselineBody = (await baseline.json()) as { id?: string };
      assert.equal(baseline.status, 200);
      state = reduceG9(state, { type: "baseline", responseId: baselineBody.id ?? "", run: RUN });

      const incompleteHits = ollamaBodies.length;
      const incomplete = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/test",
          previous_response_id: baselineBody.id,
          input: [{ type: "compaction_trigger" }],
        }),
      });
      const incompleteJson = (await incomplete.json()) as { error?: { code?: string } };
      assert.equal(incomplete.status, 400);
      state = reduceG9(state, {
        type: "compact_incomplete",
        ollamaHitsDelta: ollamaBodies.length - incompleteHits,
        httpStatus: incomplete.status,
        code: incompleteJson.error?.code ?? "",
        run: RUN,
      });
      assert.equal(state.phase, "compact", state.reason);

      summarizerMode = "complete";
      const compact = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/test",
          previous_response_id: baselineBody.id,
          input: [{ type: "compaction_trigger" }],
        }),
      });
      const compactBody = (await compact.json()) as { id?: string };
      assert.equal(compact.status, 200, JSON.stringify(compactBody));
      const compactOllama = ollamaBodies.at(-1);

      const firstNonce = "G9_FIRST_NONCE";
      const secondNonce = "G9_SECOND_NONCE";
      const first = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/test",
          previous_response_id: compactBody.id,
          input: message("user-2", firstNonce),
        }),
      });
      const firstBody = (await first.json()) as { id?: string };
      assert.equal(first.status, 200);
      const firstOllama = ollamaBodies.at(-1);
      state = reduceG9(state, {
        type: "compact_ok",
        responseId: compactBody.id ?? "",
        parentResponseId: baselineBody.id ?? "",
        // The un-compacted replay at real G24 corpus scale is ~16x this
        // two-turn unit fixture; the threshold gate stays meaningful.
        preBytes: JSON.stringify(compactOllama).length * 16,
        postBytes: JSON.stringify(firstOllama).length,
        handoffSummary: VALID_SUMMARY,
        run: RUN,
      });
      state = reduceG9(state, {
        type: "continuation",
        responseId: firstBody.id ?? "",
        parentResponseId: compactBody.id ?? "",
        noncePresent: JSON.stringify(firstOllama).includes(firstNonce),
        ollamaBody: firstOllama,
        run: RUN,
      });

      const second = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/test",
          previous_response_id: firstBody.id,
          input: message("user-3", secondNonce),
        }),
      });
      const secondBody = (await second.json()) as { id?: string };
      assert.equal(second.status, 200);
      const secondOllama = ollamaBodies.at(-1);
      state = reduceG9(state, {
        type: "continuation",
        responseId: secondBody.id ?? "",
        parentResponseId: firstBody.id ?? "",
        noncePresent: JSON.stringify(secondOllama).includes(secondNonce),
        ollamaBody: secondOllama,
        run: RUN,
      });
    } finally {
      await close(server);
    }
    state = finalizeG9(state, LIVE, LIVE);
    assert.equal(state.verdict, "pass", state.reason);
    assert.equal(state.code, "compact_and_two_continuations");
    assert.equal(state.continuationCount, 2);
    assert.match(JSON.stringify(ollamaBodies.at(-1)), /handoff after baseline/);
  });
});

describe("G9 evidence integrity", () => {
  const BASELINE = { type: "baseline", responseId: "resp-1", run: RUN };
  const COMPACT_OK = {
    type: "compact_ok",
    responseId: "compact-2",
    parentResponseId: "resp-1",
    preBytes: 1000,
    postBytes: 200,
    handoffSummary: VALID_SUMMARY,
    run: RUN,
  };
  const SAFE_CONT = {
    type: "continuation",
    noncePresent: true,
    ollamaBody: {
      model: "test",
      input: [{ role: "user", content: [{ type: "input_text", text: NONCE_LINE }] }],
    },
    run: RUN,
  };

  function g9(state: G9State, event: unknown): G9State {
    return reduceG9(state, event as Parameters<typeof reduceG9>[1]);
  }

  function compacted(): G9State {
    return g9(g9(initialG9State(), BASELINE), COMPACT_OK);
  }

  it("rejects incomplete run identity and cross-run events", () => {
    let state = g9(initialG9State(), { ...BASELINE, run: { ...RUN, child: "" } });
    assert.equal(state.verdict, "fail");
    assert.equal(state.code, "run_identity_incomplete");

    state = g9(initialG9State(), BASELINE);
    state = g9(state, { ...COMPACT_OK, run: { ...RUN, session: "sess-OTHER" } });
    assert.equal(state.code, "run_identity_mismatch");

    const crossSession = g9(initialG9State(), BASELINE);
    const crossRequest = g9(crossSession, { ...COMPACT_OK, run: { ...RUN, requestId: "req-OTHER" } });
    assert.equal(crossRequest.code, "run_identity_mismatch");
    const crossChild = g9(initialG9State(), BASELINE);
    const crossCorpus = g9(crossChild, { ...COMPACT_OK, run: { ...RUN, corpusSha256: "b".repeat(64) } });
    assert.equal(crossCorpus.code, "run_identity_mismatch");
    const crossModel = g9(g9(initialG9State(), BASELINE), { ...COMPACT_OK, run: { ...RUN, model: "ollama/other" } });
    assert.equal(crossModel.code, "run_identity_mismatch");
  });

  it("rejects a corpus hash that is not exactly 64 lowercase hex", () => {
    let state = g9(initialG9State(), { ...BASELINE, run: { ...RUN, corpusSha256: "corpus-sha-1" } });
    assert.equal(state.code, "run_identity_corpus_sha256_invalid");

    state = g9(initialG9State(), { ...BASELINE, run: { ...RUN, corpusSha256: "A".repeat(64) } });
    assert.equal(state.code, "run_identity_corpus_sha256_invalid");

    state = g9(initialG9State(), { ...BASELINE, run: { ...RUN, corpusSha256: "a".repeat(63) } });
    assert.equal(state.code, "run_identity_corpus_sha256_invalid");
  });

  it("fails closed on empty response ids and compact parent mismatch", () => {
    let state = g9(initialG9State(), { ...BASELINE, responseId: "" });
    assert.equal(state.code, "empty_response_id");

    state = g9(initialG9State(), BASELINE);
    state = g9(state, { ...COMPACT_OK, responseId: "" });
    assert.equal(state.code, "empty_response_id");

    const offChain = g9(initialG9State(), BASELINE);
    state = g9(offChain, { ...COMPACT_OK, parentResponseId: "resp-OTHER" });
    assert.equal(state.code, "compact_parent_mismatch");
  });

  it("rejects a compact that does not shrink the Ollama-bound replay", () => {
    let state = g9(initialG9State(), BASELINE);
    state = g9(state, { ...COMPACT_OK, postBytes: 1000 });
    assert.equal(state.code, "compact_no_shrink");

    state = g9(initialG9State(), BASELINE);
    state = g9(state, { ...COMPACT_OK, postBytes: 1200 });
    assert.equal(state.code, "compact_no_shrink");

    const invalidBytes = g9(initialG9State(), BASELINE);
    state = g9(invalidBytes, { ...COMPACT_OK, preBytes: -1, postBytes: 0 });
    assert.equal(state.code, "compact_bytes_incomplete");
  });

  it("validates the raw handoff text; declared flags cannot fake a recap", () => {
    // A harness may no longer vouch with booleans: the scorer re-validates
    // the raw summary text with the shared product validator.
    let state = g9(initialG9State(), BASELINE);
    state = g9(state, { ...COMPACT_OK, handoffSummary: undefined as unknown as string });
    assert.equal(state.code, "compact_handoff_sections_incomplete");

    // The exact negative from the live canary: a plain recap is not gold.
    state = g9(initialG9State(), BASELINE);
    state = g9(state, { ...COMPACT_OK, handoffSummary: "plain recap" });
    assert.equal(state.code, "compact_handoff_sections_incomplete");

    // Reordered headings fail the exact/ordered contract.
    state = g9(initialG9State(), BASELINE);
    state = g9(state, {
      ...COMPACT_OK,
      handoffSummary: "Goal: keep\nCompleted: done\nConstraints: fewer",
    });
    assert.equal(state.code, "compact_handoff_sections_incomplete");

    // A partial handoff (missing tail sections) fails.
    state = g9(initialG9State(), BASELINE);
    state = g9(state, { ...COMPACT_OK, handoffSummary: "Goal: keep\nPending: none" });
    assert.equal(state.code, "compact_handoff_sections_incomplete");
  });

  it("derives the correlation nonce from the handoff, not from a boolean", () => {
    // A valid handoff whose Completed line is too short cannot correlate
    // continuations, so the compact is not gold.
    let state = g9(initialG9State(), BASELINE);
    state = g9(state, { ...COMPACT_OK, handoffSummary: ollamaCompactHandoffSkeleton({ Completed: "x" }) });
    assert.equal(state.code, "compact_handoff_nonce_missing");

    // The harness boolean is ignored: a nonce claim without the nonce in the
    // captured body fails, and a body carrying the nonce passes.
    state = compacted();
    state = g9(state, {
      ...SAFE_CONT,
      responseId: "cont-1",
      parentResponseId: "compact-2",
      noncePresent: true,
      ollamaBody: { model: "test", input: [{ role: "user", content: "nothing here" }] },
    });
    assert.equal(state.code, "continuation_nonce_missing");

    state = compacted();
    state = g9(state, {
      ...SAFE_CONT,
      responseId: "cont-1",
      parentResponseId: "compact-2",
      noncePresent: false,
    });
    assert.equal(state.phase, "cont2", state.reason);
  });

  it("requires the continuation body model to match the run identity model", () => {
    let state = compacted();
    state = g9(state, {
      ...SAFE_CONT,
      responseId: "cont-1",
      parentResponseId: "compact-2",
      ollamaBody: { model: "other", input: [{ role: "user", content: NONCE_LINE }] },
    });
    assert.equal(state.code, "model_mismatch");

    state = compacted();
    state = g9(state, {
      ...SAFE_CONT,
      responseId: "cont-1",
      parentResponseId: "compact-2",
      ollamaBody: { input: [{ role: "user", content: NONCE_LINE }] },
    });
    assert.equal(state.code, "model_mismatch");
  });

  it("fails closed on malformed and unknown events instead of throwing or dropping", () => {
    let state = g9(initialG9State(), null);
    assert.equal(state.code, "malformed_event");

    state = g9(initialG9State(), { type: "mystery" });
    assert.equal(state.code, "unknown_event");

    state = g9(initialG9State(), { type: "" });
    assert.equal(state.code, "malformed_event");
  });

  it("fails closed on cyclic continuation bodies instead of throwing", () => {
    const cyclic: Record<string, unknown> = { model: "test", input: [] };
    cyclic.self = cyclic;
    const state = g9(compacted(), { ...SAFE_CONT, responseId: "cont-1", parentResponseId: "compact-2", ollamaBody: cyclic });
    assert.equal(state.code, "ollama_body_circular");
  });

  it("enforces the explicit G24 replay-reduction threshold", () => {
    let state = g9(initialG9State(), BASELINE);
    state = g9(state, { ...COMPACT_OK, postBytes: 260 });
    assert.equal(state.code, "compact_shrink_below_threshold");

    state = g9(initialG9State(), BASELINE);
    state = g9(state, { ...COMPACT_OK, postBytes: 240 });
    assert.equal(state.code, "need_continuation", state.reason);
  });

  it("requires continuations to chain compact then cont1 then cont2", () => {
    let state = compacted();
    state = g9(state, { ...SAFE_CONT, responseId: "cont-1", parentResponseId: "resp-1" });
    assert.equal(state.code, "continuation_parent_mismatch");

    state = compacted();
    state = g9(state, { ...SAFE_CONT, responseId: "cont-1", parentResponseId: "compact-2" });
    assert.equal(state.phase, "cont2", state.reason);
    state = g9(state, { ...SAFE_CONT, responseId: "cont-2", parentResponseId: "compact-2" });
    assert.equal(state.code, "continuation_parent_mismatch");

    const emptyId = compacted();
    state = g9(emptyId, { ...SAFE_CONT, responseId: "", parentResponseId: "compact-2" });
    assert.equal(state.code, "empty_response_id");
  });

  it("inspects the raw continuation body with the shared unsafe-wire check", () => {
    let state = compacted();
    state = g9(state, {
      ...SAFE_CONT,
      responseId: "cont-1",
      parentResponseId: "compact-2",
      ollamaBody: { model: "test", previous_response_id: "x", input: [] },
    });
    assert.equal(state.code, "previous_response_id_on_ollama");

    state = compacted();
    state = g9(state, {
      ...SAFE_CONT,
      responseId: "cont-1",
      parentResponseId: "compact-2",
      ollamaBody: { model: "test", input: [{ content: [{ encrypted_content: "x" }] }] },
    });
    assert.equal(state.code, "forbidden_ollama_wire:encrypted_content");
  });

  it("records the replay ratio and passes a same-run chained protocol", () => {
    let state = g9(initialG9State(), BASELINE);
    state = g9(state, COMPACT_OK);
    assert.equal((state as { replayRatio?: unknown }).replayRatio, 0.2);
    state = g9(state, { ...SAFE_CONT, responseId: "cont-1", parentResponseId: "compact-2" });
    state = g9(state, { ...SAFE_CONT, responseId: "cont-2", parentResponseId: "cont-1" });
    state = finalizeG9(state, LIVE, LIVE);
    assert.equal(state.verdict, "pass", state.reason);
    assert.equal(state.code, "compact_and_two_continuations");
    assert.equal(state.continuationCount, 2);
    const last = state.receipts.at(-1)!;
    assert.match(last.receiptSha256, /^[0-9a-f]{64}$/);
    assert.equal(last.corpusSha256, RUN.corpusSha256);
    assert.match(last.runSha256, /^[0-9a-f]{64}$/);
    assert.match(last.artifactSha256, /^[0-9a-f]{64}$/);
  });

  it("refuses pass when live SHA snapshots are missing, metadata-less, or mutated", () => {
    const passed = g9(g9(g9(g9(initialG9State(), BASELINE), COMPACT_OK), { ...SAFE_CONT, responseId: "cont-1", parentResponseId: "compact-2" }), { ...SAFE_CONT, responseId: "cont-2", parentResponseId: "cont-1" });
    assert.equal(finalizeG9(passed, LIVE, LIVE).verdict, "pass");
    assert.equal(
      finalizeG9(passed, LIVE, { ...LIVE, configSha256: "f".repeat(64) }).code,
      "post_run_sha_mutation",
    );
    assert.equal(
      // A typed snapshot cannot omit metadata; the runtime check still fails
      // closed on a metadata-less object that reaches it (test-boundary cast).
      finalizeG9(
        passed,
        { configSha256: LIVE.configSha256, catalogSha256: LIVE.catalogSha256 } as unknown as EvalLiveShaSnapshot,
        LIVE,
      ).code,
      "live_sha_snapshot_incomplete",
    );
    assert.equal(
      finalizeG9(passed, LIVE, { ...LIVE, catalogMetaSha256: "" }).code,
      "live_sha_snapshot_incomplete",
    );
  });

  it("rejects duplicate response ids across the chain", () => {
    let state = g9(initialG9State(), BASELINE);
    state = g9(state, { ...COMPACT_OK, responseId: "resp-1" });
    assert.equal(state.code, "duplicate_response_id");

    state = compacted();
    state = g9(state, { ...SAFE_CONT, responseId: "compact-2", parentResponseId: "compact-2" });
    assert.equal(state.code, "duplicate_response_id");

    let chain = g9(initialG9State(), BASELINE);
    chain = g9(chain, COMPACT_OK);
    chain = g9(chain, { ...SAFE_CONT, responseId: "cont-1", parentResponseId: "compact-2" });
    chain = g9(chain, { ...SAFE_CONT, responseId: "resp-1", parentResponseId: "cont-1" });
    assert.equal(chain.code, "duplicate_response_id");
  });
});
