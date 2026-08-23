import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ConversationStateStore, type PublishCheckpoint } from "./conversation-state.js";
import { listenGateway } from "./gateway.js";
import type { CatalogFile, JsonObject } from "./types.js";

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

class FailingStateStore extends ConversationStateStore {
  override async publish(_draft: PublishCheckpoint): Promise<void> {
    throw new Error("forced checkpoint publication failure");
  }
}

describe("gateway durable Ollama state", () => {
  it("replays a previous_response_id chain after gateway restart", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-gateway-state-"));
    const sent: JsonObject[] = [];
    let responseNumber = 0;
    const ollamaFetch = async (_url: string, init: { body: Buffer; signal?: AbortSignal }) => {
      const body = JSON.parse(init.body.toString("utf8")) as JsonObject;
      sent.push(body);
      responseNumber += 1;
      return new Response(
        JSON.stringify({
          id: `resp-${responseNumber}`,
          object: "response",
          status: "completed",
          model: "test",
          output: [
            {
              id: `assistant-${responseNumber}`,
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: `answer-${responseNumber}` }],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const firstPort = await freePort();
    const first = await listenGateway({ port: firstPort, catalog: CATALOG, stateDir, ollamaFetch });
    try {
      const response = await fetch(`http://127.0.0.1:${firstPort}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ollama/test", input: message("user-1", "one"), temperature: 0.2 }),
      });
      assert.equal(response.status, 200, await response.text());
      const second = await fetch(`http://127.0.0.1:${firstPort}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/test",
          previous_response_id: "resp-1",
          input: message("user-2", "two"),
          temperature: 0.7,
        }),
      });
      assert.equal(second.status, 200, await second.text());
    } finally {
      await close(first);
    }
    const secondPort = await freePort();
    const restarted = await listenGateway({ port: secondPort, catalog: CATALOG, stateDir, ollamaFetch });
    try {
      const third = await fetch(`http://127.0.0.1:${secondPort}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/test",
          previous_response_id: "resp-2",
          input: message("user-3", "three"),
        }),
      });
      assert.equal(third.status, 200, await third.text());
    } finally {
      await close(restarted);
    }
    const last = sent[2]!;
    assert.equal("previous_response_id" in last, false);
    assert.deepEqual(
      (last.input as JsonObject[]).map((item) => item.id),
      ["user-1", "assistant-1", "user-2", "assistant-2", "user-3"],
    );
    assert.equal(sent[1]?.temperature, 0.7);
    assert.deepEqual(Object.keys(sent[1]!).sort(), ["input", "model", "temperature"]);
    assert.equal("previous_response_id" in (sent[1] ?? {}), false);
  });

  it("replaces Ollama history with the summarizer handoff and archives the cob envelope", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-compact-state-"));
    const ollamaBodies: JsonObject[] = [];
    let ollamaCount = 0;
    let nativeHits = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: CATALOG,
      stateDir,
      nativeFetch: async () => {
        nativeHits += 1;
        return new Response("native must not compact Ollama threads", { status: 500 });
      },
      ollamaFetch: async (_url, init) => {
        const body = JSON.parse(init.body.toString("utf8")) as JsonObject;
        ollamaBodies.push(body);
        ollamaCount += 1;
        assert.equal(JSON.stringify(body).includes("encrypted_content"), false);
        assert.equal(JSON.stringify(body).includes("compaction_trigger"), false);
        if (JSON.stringify(body).includes("You are compacting")) {
          return new Response(
            JSON.stringify({
              id: `ollama-sum-${ollamaCount}`,
              object: "response",
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "handoff after one" }],
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            id: `ollama-${ollamaCount}`,
            object: "response",
            status: "completed",
            output: [
              {
                id: `a-${ollamaCount}`,
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "done" }],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    try {
      const root = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ollama/test", input: message("user-1", "one") }),
      });
      const rootText = await root.text();
      assert.equal(root.status, 200, rootText);

      const compact = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/test",
          previous_response_id: "ollama-1",
          input: [{ type: "compaction_trigger" }],
        }),
      });
      const compactText = await compact.text();
      assert.equal(compact.status, 200, compactText);
      assert.equal(compactText.includes("cob1.1."), true);
      assert.equal(compactText.includes("gAAAAA"), false);
      const compactBody = JSON.parse(compactText) as { id?: string; output?: JsonObject[] };

      const follow = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/test",
          previous_response_id: compactBody.id,
          input: message("user-2", "two"),
        }),
      });
      assert.equal(follow.status, 200, await follow.text());
    } finally {
      await close(server);
    }
    assert.equal(nativeHits, 0);
    const followBody = ollamaBodies.at(-1);
    assert.equal(JSON.stringify(followBody).includes("encrypted_content"), false);
    const followIds = (followBody?.input as JsonObject[]).map((item) => item.id);
    assert.equal(followIds.includes("user-1"), false);
    assert.deepEqual(followIds.filter(Boolean), ["user-2"]);
    assert.match(JSON.stringify(followBody?.input), /handoff after one/);
    assert.equal(readdirSync(join(stateDir, "compact-archive")).length, 1);
    const summarizer = ollamaBodies.find((body) => JSON.stringify(body).includes("You are compacting"));
    assert.ok(summarizer);
    assert.deepEqual(Object.keys(summarizer).sort(), ["input", "instructions", "model", "stream"]);
    assert.equal("store" in summarizer, false);
    assert.equal("previous_response_id" in summarizer, false);
    const preBytes = Buffer.byteLength(JSON.stringify(summarizer.input), "utf8");
    const postBytes = Buffer.byteLength(JSON.stringify(followBody?.input), "utf8");
    assert.ok(postBytes < preBytes, `isolated replay_ratio=${postBytes / preBytes}`);
  });

  it("prefers previous_response_id when a matching compaction item is also present", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-compact-both-hints-"));
    const ollamaInputs: JsonObject[][] = [];
    let turn = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: CATALOG,
      stateDir,
      nativeFetch: async () => new Response("native must not compact Ollama threads", { status: 500 }),
      ollamaFetch: async (_url, init) => {
        const body = JSON.parse(init.body.toString("utf8")) as JsonObject;
        const input = Array.isArray(body.input) ? body.input : [];
        const summarizer = JSON.stringify(body).includes("You are compacting");
        if (summarizer) {
          return new Response(
            JSON.stringify({
              id: "ollama-sum-1",
              object: "response",
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "handoff after first turn" }],
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        ollamaInputs.push(input as JsonObject[]);
        turn += 1;
        return new Response(
          JSON.stringify({
            id: `ollama-${turn}`,
            object: "response",
            status: "completed",
            output: [
              {
                id: `a-${turn}`,
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "done" }],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    try {
      const root = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ollama/test", input: [message("user-1", "one")] }),
      });
      assert.equal(root.status, 200, await root.text());

      const compact = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/test",
          previous_response_id: "ollama-1",
          input: [{ type: "compaction_trigger" }],
        }),
      });
      const compactBody = (await compact.json()) as { id?: string; output?: JsonObject[] };
      assert.equal(compact.status, 200);
      assert.match(String(compactBody.output?.[0]?.encrypted_content), /cob1\.1\./);

      const follow = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/test",
          previous_response_id: compactBody.id,
          input: [compactBody.output?.[0], message("user-2", "two")],
        }),
      });
      assert.equal(follow.status, 200, await follow.text());

      const continueAfter = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/test",
          previous_response_id: "ollama-2",
          input: [compactBody.output?.[0], message("user-3", "three")],
        }),
      });
      assert.equal(continueAfter.status, 200, await continueAfter.text());
    } finally {
      await close(server);
    }
    assert.deepEqual(
      ollamaInputs.map((input) => input.map((item) => item.id)),
      [
        ["user-1"],
        [undefined, "user-2"],
        [undefined, "user-2", "a-2", "user-3"],
      ],
    );
    assert.equal(JSON.stringify(ollamaInputs).includes("gAAAAA"), false);
    assert.equal(JSON.stringify(ollamaInputs).includes("cob1."), false);
    assert.equal(JSON.stringify(ollamaInputs[0]).includes("one"), true);
    assert.equal(JSON.stringify(ollamaInputs[1]).includes("first turn"), true);
    assert.equal(JSON.stringify(ollamaInputs[1]).includes('"one"'), false);
  });

  it("fails closed when previous_response_id and compaction item disagree", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-compact-disagree-"));
    let ollamaCount = 0;
    const compactItems: JsonObject[] = [];
    const compactIds: string[] = [];
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: CATALOG,
      stateDir,
      nativeFetch: async () => new Response("native must not compact Ollama threads", { status: 500 }),
      ollamaFetch: async (_url, init) => {
        ollamaCount += 1;
        const body = JSON.parse(init.body.toString("utf8")) as JsonObject;
        if (JSON.stringify(body).includes("You are compacting")) {
          return new Response(
            JSON.stringify({
              id: `ollama-sum-${ollamaCount}`,
              object: "response",
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: `handoff ${ollamaCount}` }],
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            id: `ollama-${ollamaCount}`,
            object: "response",
            status: "completed",
            output: [
              {
                id: `a-${ollamaCount}`,
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "done" }],
              },
            ],
          }),
          { status: 200 },
        );
      },
    });
    try {
      for (const label of ["a", "b"] as const) {
        const root = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "ollama/test", input: message(`user-${label}`, label) }),
        });
        const rootBody = (await root.json()) as { id?: string };
        assert.equal(root.status, 200);
        const compact = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "ollama/test",
            previous_response_id: rootBody.id,
            input: [{ type: "compaction_trigger" }],
          }),
        });
        const compactBody = (await compact.json()) as { id?: string; output?: JsonObject[] };
        assert.equal(compact.status, 200, JSON.stringify(compactBody));
        compactIds.push(compactBody.id ?? "");
        compactItems.push(compactBody.output?.[0] ?? {});
      }

      const beforeConflict = ollamaCount;
      const conflict = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/test",
          previous_response_id: compactIds[0],
          input: [compactItems[1], message("user-c", "cross")],
        }),
      });
      const body: unknown = await conflict.json();
      assert.equal(conflict.status, 400);
      assert.equal((body as { error?: { code?: string } }).error?.code, "state_checkpoint_conflict");
      assert.equal(ollamaCount, beforeConflict);
    } finally {
      await close(server);
    }
  });

  it("archives a complete compact SSE before projecting it", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-compact-stream-state-"));
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: CATALOG,
      stateDir,
      compaction: { provider: "native", model: "codex-mini", ollamaThreads: "native" },
      nativeFetch: async () =>
        new Response(
          [
            'data: {"type":"response.created","response":{"id":"compact-stream-1","object":"response","output":[]}}',
            "",
            'event: response.output_item.added',
            'data: {"type":"response.output_item.added","item":{"id":"compact-item-stream","type":"compaction","encrypted_content":"gAAAAA-stream-partial"},"output_index":0}',
            "",
            'event: response.output_item.done',
            'data: {"type":"response.output_item.done","item":{"id":"compact-item-stream","type":"compaction","encrypted_content":"gAAAAA-stream-secret"},"output_index":0}',
            "",
            'event: response.completed',
            'data: {"type":"response.completed","response":{"id":"compact-stream-1","object":"response","status":"completed","output":[]}}',
            "",
          ].join("\n"),
          { status: 200 },
        ),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ollama/test", stream: true, input: [{ type: "compaction_trigger" }] }),
      });
      const projected = await response.text();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "text/event-stream");
      assert.equal(projected.includes("gAAAAA-stream-secret"), true);
      assert.equal(existsSync(join(stateDir, "checkpoints")), true);
      assert.equal(
        readFileSync(join(stateDir, "compact-archive", "Y29tcGFjdC1zdHJlYW0tMQ.json"), "utf8").includes(
          "gAAAAA-stream-secret",
        ),
        true,
      );
    } finally {
      await close(server);
    }
  });

  it("rejects compact SSE that only has output_item.added ciphertext", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-compact-added-only-"));
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: CATALOG,
      stateDir,
      compaction: { provider: "native", model: "codex-mini", ollamaThreads: "native" },
      nativeFetch: async () =>
        new Response(
          [
            'data: {"type":"response.created","response":{"id":"compact-added-1","object":"response","output":[]}}',
            "",
            'data: {"type":"response.output_item.added","item":{"id":"compact-item-added","type":"compaction","encrypted_content":"gAAAAA-added-only"},"output_index":0}',
            "",
            'data: {"type":"response.completed","response":{"id":"compact-added-1","object":"response","status":"completed","output":[]}}',
            "",
          ].join("\n"),
          { status: 200 },
        ),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ollama/test", stream: true, input: [{ type: "compaction_trigger" }] }),
      });
      const body = await response.text();
      assert.equal(response.status, 502);
      assert.equal(body.includes("gAAAAA-added-only"), false);
      assert.equal(existsSync(join(stateDir, "checkpoints")), false);
      assert.equal(existsSync(join(stateDir, "compact-archive")), false);
    } finally {
      await close(server);
    }
  });

  it("sends normal SSE publication errors before its single DONE", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-normal-stream-failure-"));
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: CATALOG,
      stateStore: new FailingStateStore(stateDir),
      ollamaFetch: async () =>
        new Response(
          'data: {"type":"response.completed","response":{"id":"normal-fail","object":"response","status":"completed","output":[]}}\n\n' +
            "data: [DONE]\n\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ollama/test", stream: true, input: [] }),
      });
      const body = await response.text();
      const errorIndex = body.indexOf('"code":"upstream_stream_error"');
      const doneIndices = [...body.matchAll(/data: \[DONE\]/g)].map((match) => match.index ?? -1);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type")?.includes("text/event-stream"), true);
      assert.equal(doneIndices.length, 1);
      assert.equal(errorIndex >= 0, true);
      assert.equal(errorIndex < doneIndices[0]!, true);
    } finally {
      await close(server);
    }
  });

  it("sends compact SSE publication errors before one DONE without ciphertext", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-compact-stream-failure-"));
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: CATALOG,
      stateStore: new FailingStateStore(stateDir),
      compaction: { provider: "native", model: "codex-mini", ollamaThreads: "native" },
      nativeFetch: async () =>
        new Response(
          [
            'data: {"type":"response.completed","response":{"id":"compact-fail","object":"response","status":"completed","output":[{"type":"compaction","id":"compact-item-fail","encrypted_content":"gAAAAA-compact-secret"}]}}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ollama/test", stream: true, input: [{ type: "compaction_trigger" }] }),
      });
      const body = await response.text();
      const errorIndex = body.indexOf('"code":"upstream_stream_error"');
      const doneIndices = [...body.matchAll(/data: \[DONE\]/g)].map((match) => match.index ?? -1);
      assert.equal(response.status, 502);
      assert.equal(body.includes("gAAAAA-compact-secret"), false);
      assert.equal(doneIndices.length, 1);
      assert.equal(errorIndex >= 0, true);
      assert.equal(errorIndex < doneIndices[0]!, true);
    } finally {
      await close(server);
    }
  });

  it("publishes normal SSE before sending exactly one DONE", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-normal-stream-success-"));
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: CATALOG,
      stateDir,
      ollamaFetch: async () =>
        new Response(
          'data: {"type":"response.completed","response":{"id":"normal-success","object":"response","status":"completed","output":[]}}\n\n' +
            "data: [DONE]\n\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ollama/test", stream: true, input: [] }),
      });
      const body = await response.text();
      assert.equal([...body.matchAll(/data: \[DONE\]/g)].length, 1);
      assert.equal(body.endsWith("data: [DONE]\n\n"), true);
      assert.equal(existsSync(join(stateDir, "checkpoints")), true);
    } finally {
      await close(server);
    }
  });

  it("returns a structured full-context error for a missing checkpoint", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-missing-state-"));
    let ollamaHits = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: CATALOG,
      stateDir,
      ollamaFetch: async () => {
        ollamaHits += 1;
        return new Response("should not run", { status: 500 });
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ollama/test", previous_response_id: "unknown", input: "new" }),
      });
      const body = (await response.json()) as { error?: { code?: string; requires_full_context?: boolean } };
      assert.equal(response.status, 400);
      assert.equal(body.error?.code, "state_checkpoint_missing");
      assert.equal(body.error?.requires_full_context, true);
      assert.equal(ollamaHits, 0);
    } finally {
      await close(server);
    }
  });

  it("does not publish malformed streamed responses", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-stream-state-"));
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: CATALOG,
      stateDir,
      ollamaFetch: async () =>
        new Response('data: {"id":"partial","object":"response","output":[]}\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ollama/test", input: "hi", stream: true }),
      });
      const text = await response.text();
      assert.match(text, /upstream_stream_error|complete response/);
      assert.equal([...text.matchAll(/data: \[DONE\]/g)].length, 1);
      assert.equal(text.indexOf('"code":"upstream_stream_error"') < text.indexOf("data: [DONE]"), true);
      const store = new ConversationStateStore(stateDir);
      assert.equal(existsSync(store.checkpointsDir), false);
    } finally {
      await close(server);
    }
  });

  it("does not publish a failed upstream response", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-failed-state-"));
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: CATALOG,
      stateDir,
      ollamaFetch: async () =>
        new Response(
          JSON.stringify({ id: "failed", object: "response", status: "failed", output: [] }),
          { status: 502, headers: { "content-type": "application/json" } },
        ),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ollama/test", input: "hi" }),
      });
      assert.equal(response.status, 502);
      assert.equal(existsSync(join(stateDir, "checkpoints")), false);
    } finally {
      await close(server);
    }
  });

  it("does not publish an aborted normal response or compact stream", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-aborted-state-"));
    const stream = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"response.created","response":{"id":"partial","object":"response","output":[]}}\n\n',
            ),
          );
        },
      });
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: CATALOG,
      stateDir,
      compaction: { provider: "native", model: "codex-mini", ollamaThreads: "native" },
      ollamaFetch: async () =>
        new Response(stream(), { status: 200, headers: { "content-type": "text/event-stream" } }),
      nativeFetch: async () =>
        new Response(stream(), { status: 200, headers: { "content-type": "text/event-stream" } }),
    });
    try {
      for (const input of [
        [],
        [{ type: "compaction_trigger" }],
      ]) {
        const controller = new AbortController();
        const request = fetch(`http://127.0.0.1:${port}/v1/responses`, {
          method: "POST",
          signal: controller.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "ollama/test",
            stream: true,
            input,
          }),
        });
        const abortTimer = setTimeout(() => controller.abort(), 50);
        await request.catch(() => undefined);
        controller.abort();
        clearTimeout(abortTimer);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(existsSync(join(stateDir, "checkpoints")), false);
      assert.equal(existsSync(join(stateDir, "compact-archive")), false);
    } finally {
      await close(server);
    }
  });
});
