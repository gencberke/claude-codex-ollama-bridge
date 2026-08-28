import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ollamaCompactHandoffSkeleton } from "./codex/compaction/summary.js";
import { ollamaWireUnsafeReason } from "./eval-g8r.js";
import { finalizeG9, initialG9State, reduceG9 } from "./eval-g9.js";
import { listenGateway } from "./codex/gateway.js";
import type { CatalogFile } from "./codex/types.js";
import type { JsonObject } from "./core/json.js";

const CATALOG: CatalogFile = {
  models: [{ slug: "codex-mini" }, { slug: "ollama/test" }],
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
    state = reduceG9(state, { type: "baseline", responseId: "resp-1" });
    state = reduceG9(state, {
      type: "compact_incomplete",
      ollamaHitsDelta: 1,
      httpStatus: 400,
      code: "compaction_summary_incomplete",
    });
    state = reduceG9(state, { type: "compact_ok", responseId: "compact-2", parentResponseId: "resp-1" });
    const late = finalizeG9(state);
    assert.equal(late.verdict, "fail");
    assert.equal(late.code, "compaction_continuation_incomplete");
  });

  it("fails closed when cob would retry an incomplete summary", () => {
    let state = reduceG9(initialG9State(), { type: "baseline", responseId: "resp-1" });
    state = reduceG9(state, {
      type: "compact_incomplete",
      ollamaHitsDelta: 2,
      httpStatus: 400,
      code: "compaction_summary_incomplete",
    });
    assert.equal(state.verdict, "fail");
    assert.equal(state.code, "cob_compact_retry_forbidden");
  });

  it("requires a valid seven-section compact then two nonce continuations", async () => {
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
      state = reduceG9(state, { type: "baseline", responseId: baselineBody.id ?? "" });

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
      state = reduceG9(state, {
        type: "compact_ok",
        responseId: compactBody.id ?? "",
        parentResponseId: baselineBody.id ?? "",
      });

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
        type: "continuation",
        responseId: firstBody.id ?? "",
        parentResponseId: compactBody.id ?? "",
        noncePresent: JSON.stringify(firstOllama).includes(firstNonce),
        ollamaUnsafe: ollamaWireUnsafeReason(firstOllama),
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
        ollamaUnsafe: ollamaWireUnsafeReason(secondOllama),
      });
    } finally {
      await close(server);
    }
    state = finalizeG9(state);
    assert.equal(state.verdict, "pass", state.reason);
    assert.equal(state.code, "compact_and_two_continuations");
    assert.equal(state.continuationCount, 2);
    assert.match(JSON.stringify(ollamaBodies.at(-1)), /handoff after baseline/);
  });
});
