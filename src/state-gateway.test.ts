import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ConversationStateStore } from "./codex/state/store.js";
import type { PublishCheckpoint } from "./codex/state/schema.js";
import { listenGateway } from "./codex/gateway.js";
import { acquireLock, releaseLock } from "./core/lock.js";
import { ollamaCompactHandoffSkeleton, ollamaSummarizerInstructionCopyCount } from "./codex/compaction/summary.js";
import type { CatalogFile } from "./codex/types.js";
import type { JsonObject } from "./core/json.js";
import type { GatewayDiagnosticEventV1 } from "./codex/diagnostic-event.js";

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

/**
 * Resolves once the gateway handler has entered publish(), not before, and a
 * second latch once that publish attempt has settled (committed or thrown).
 */
class LatchingStateStore extends ConversationStateStore {
  private resolvePublishEntered?: () => void;
  private resolvePublishSettled?: () => void;
  readonly publishEntered: Promise<void> = new Promise<void>((resolve) => {
    this.resolvePublishEntered = resolve;
  });
  readonly publishSettled: Promise<void> = new Promise<void>((resolve) => {
    this.resolvePublishSettled = resolve;
  });

  override async publish(draft: PublishCheckpoint, options?: { signal?: AbortSignal }): Promise<void> {
    this.resolvePublishEntered?.();
    try {
      return await super.publish(draft, options);
    } finally {
      this.resolvePublishSettled?.();
    }
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

  it("promotes archived string shorthand to typed items only when replaying an Ollama continuation", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-gateway-string-replay-"));
    const sent: JsonObject[] = [];
    let responseNumber = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: CATALOG,
      stateDir,
      ollamaFetch: async (_url, init) => {
        const body = JSON.parse(init.body.toString("utf8")) as JsonObject;
        sent.push(body);
        responseNumber += 1;
        return new Response(
          JSON.stringify({
            id: `string-resp-${responseNumber}`,
            object: "response",
            status: "completed",
            model: "test",
            output: [
              {
                id: `string-assistant-${responseNumber}`,
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: `answer-${responseNumber}` }],
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
        body: JSON.stringify({ model: "ollama/test", input: "one" }),
      });
      assert.equal(root.status, 200, await root.text());

      const follow = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/test",
          previous_response_id: "string-resp-1",
          input: "two",
        }),
      });
      assert.equal(follow.status, 200, await follow.text());
    } finally {
      await close(server);
    }

    assert.equal(sent[0]?.input, "one");
    assert.deepEqual(sent[1]?.input, [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "one" }],
      },
      {
        id: "string-assistant-1",
        type: "message",
        role: "assistant",
        content: [{ type: "input_text", text: "answer-1" }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "two" }],
      },
    ]);
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
                  content: [{ type: "output_text", text: ollamaCompactHandoffSkeleton({ Completed: "handoff after one" }) }],
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
        body: JSON.stringify({
          model: "ollama/test",
          input: message("user-1", `one ${"x".repeat(4000)}`),
        }),
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
    assert.deepEqual(Object.keys(summarizer).sort(), [
      "input",
      "instructions",
      "model",
      "stream",
      "temperature",
    ]);
    assert.equal("store" in summarizer, false);
    assert.equal("previous_response_id" in summarizer, false);
    assert.equal(ollamaSummarizerInstructionCopyCount(summarizer), 1);
    assert.equal(JSON.stringify(followBody).includes("x".repeat(32)), false);
    const preBytes = Buffer.byteLength(JSON.stringify(summarizer.input), "utf8");
    const postBytes = Buffer.byteLength(JSON.stringify(followBody?.input), "utf8");
    assert.ok(postBytes < preBytes / 2, `isolated replay_ratio=${postBytes / preBytes}`);
  });

  it("accepts a valid SSE Ollama summarizer response", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-compact-sse-summarizer-"));
    let ollamaCount = 0;
    const port = await freePort();
    const summaryText = ollamaCompactHandoffSkeleton({ Completed: "handoff from sse" });
    const completedFrame = `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "sum-sse-1",
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: summaryText }],
          },
        ],
      },
    })}\n\n`;
    const server = await listenGateway({
      port,
      catalog: CATALOG,
      stateDir,
      nativeFetch: async () => new Response("native must not compact Ollama threads", { status: 500 }),
      ollamaFetch: async (_url, init) => {
        const body = JSON.parse(init.body.toString("utf8")) as JsonObject;
        ollamaCount += 1;
        if (JSON.stringify(body).includes("You are compacting")) {
          return new Response(`${completedFrame}data: [DONE]\n\n`, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
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
      const compactText = await compact.text();
      assert.equal(compact.status, 200, compactText);
      assert.equal(compactText.includes("cob1.1."), true);
      assert.equal(compactText.includes("gAAAAA"), false);
      assert.equal(readdirSync(join(stateDir, "compact-archive")).length, 1);
    } finally {
      await close(server);
    }
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
                  content: [{ type: "output_text", text: ollamaCompactHandoffSkeleton({ Completed: "handoff after first turn" }) }],
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
                  content: [{ type: "output_text", text: ollamaCompactHandoffSkeleton({ Completed: `handoff ${ollamaCount}` }) }],
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

  it("fails native compaction SSE ordering closed without a checkpoint or raw relay", async () => {
    const completedFrame = (id: string) =>
      `data: {"type":"response.completed","response":{"id":"${id}","object":"response","status":"completed","output":[{"type":"compaction","id":"${id}-item","encrypted_content":"gAAAAA-${id}-secret"}]}}`;
    const failedFrame =
      'data: {"type":"response.failed","response":{"id":"compact-bad","object":"response","status":"failed","error":{"type":"upstream_error","code":"boom"}}}';
    const cases: Array<{ name: string; frames: string[] }> = [
      { name: "completed then failed", frames: [completedFrame("t1"), "", failedFrame, ""] },
      { name: "failed then completed", frames: [failedFrame, "", completedFrame("t2"), ""] },
      { name: "two valid completed", frames: [completedFrame("t3a"), "", completedFrame("t3b"), ""] },
      { name: "done before completed", frames: ["data: [DONE]", "", completedFrame("t4"), ""] },
      {
        name: "data after terminal done",
        frames: [completedFrame("t5"), "", "data: [DONE]", "", 'data: {"type":"ping","data":"late"}', ""],
      },
    ];
    for (const entry of cases) {
      const stateDir = mkdtempSync(join(tmpdir(), "cob-compact-ordering-"));
      const port = await freePort();
      const server = await listenGateway({
        port,
        catalog: CATALOG,
        stateDir,
        compaction: { provider: "native", model: "codex-mini", ollamaThreads: "native" },
        nativeFetch: async () =>
          new Response(entry.frames.join("\n"), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      });
      try {
        const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "ollama/test", stream: true, input: [{ type: "compaction_trigger" }] }),
        });
        const body = await response.text();
        assert.equal(response.status, 502, `case=${entry.name} status=${response.status}`);
        assert.equal(body.includes("gAAAAA-"), false, `case=${entry.name} leaked ciphertext`);
        assert.equal(existsSync(join(stateDir, "checkpoints")), false, `case=${entry.name}`);
        assert.equal(existsSync(join(stateDir, "compact-archive")), false, `case=${entry.name}`);
      } finally {
        await close(server);
      }
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
      const errorIndex = body.indexOf('"code":"native_compaction_checkpoint_failed"');
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

  it("publishes and continues when Ollama closes after response.completed without upstream DONE", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-normal-stream-no-done-"));
    let turn = 0;
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: CATALOG,
      stateDir,
      ollamaFetch: async () => {
        turn += 1;
        if (turn === 1) {
          return new Response(
            'data: {"type":"response.completed","response":{"id":"normal-no-done","object":"response","status":"completed","output":[]}}\n\n',
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response(
          JSON.stringify({
            id: "normal-after-no-done",
            object: "response",
            status: "completed",
            output: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    try {
      const first = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ollama/test", stream: true, input: "one" }),
      });
      const firstBody = await first.text();
      assert.equal(first.status, 200);
      assert.equal(firstBody.includes('"code":"upstream_stream_error"'), false);
      assert.equal([...firstBody.matchAll(/data: \[DONE\]/g)].length, 1);
      assert.equal(firstBody.endsWith("data: [DONE]\n\n"), true);
      assert.equal(readdirSync(join(stateDir, "checkpoints")).length, 1);

      const second = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/test",
          previous_response_id: "normal-no-done",
          input: "two",
        }),
      });
      assert.equal(second.status, 200, await second.clone().text());
      assert.equal(turn, 2);
      assert.equal(readdirSync(join(stateDir, "checkpoints")).length, 2);
    } finally {
      await close(server);
    }
  });

  it("does not publish response.incomplete when upstream closes without DONE", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-incomplete-stream-no-done-"));
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: CATALOG,
      stateDir,
      ollamaFetch: async () =>
        new Response(
          'data: {"type":"response.incomplete","response":{"id":"incomplete-no-done","object":"response","status":"incomplete","output":[]}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ollama/test", stream: true, input: "one" }),
      });
      const body = await response.text();
      assert.equal(response.status, 200);
      assert.equal(body.includes("response.incomplete"), true);
      assert.equal(body.includes('"code":"upstream_stream_error"'), false);
      assert.equal([...body.matchAll(/data: \[DONE\]/g)].length, 0);
      assert.equal(existsSync(join(stateDir, "checkpoints")), false);
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

  it("does not publish partial streamed responses", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-stream-state-"));
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: CATALOG,
      stateDir,
      ollamaFetch: async () =>
        new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n', {
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
      assert.match(text, /"delta":"partial"/);
      assert.equal(text.includes('"code":"upstream_stream_error"'), false);
      assert.equal([...text.matchAll(/data: \[DONE\]/g)].length, 0);
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

describe("gateway Ollama response terminal transaction", () => {
  const invalidJsonEnvelopes: [string, JsonObject][] = [
    ["missing status", { id: "json-no-status", object: "response", output: [] }],
    ["failed status", { id: "json-failed", object: "response", status: "failed", output: [] }],
    ["missing object", { id: "json-no-object", status: "completed", output: [] }],
    ["compaction shell", { id: "json-compaction", object: "response.compaction", status: "completed", output: [] }],
    ["empty id", { id: "", object: "response", status: "completed", output: [] }],
    ["missing id", { object: "response", status: "completed", output: [] }],
    ["missing output", { id: "json-no-output", object: "response", status: "completed" }],
    ["typeless output item", { id: "json-typeless", object: "response", status: "completed", output: [{ role: "assistant" }] }],
    ["primitive output item", { id: "json-primitive", object: "response", status: "completed", output: ["ok"] }],
    ["provider-private object", { ok: "private" }],
  ];

  for (const [label, envelope] of invalidJsonEnvelopes) {
    it(`rejects a non-normal Ollama JSON body: ${label}`, async () => {
      const stateDir = mkdtempSync(join(tmpdir(), "cob-json-invalid-"));
      const port = await freePort();
      const server = await listenGateway({
        port,
        catalog: CATALOG,
        stateDir,
        ollamaFetch: async () =>
          new Response(JSON.stringify(envelope), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      });
      try {
        const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "ollama/test", input: "hi" }),
        });
        assert.equal(response.status, 502);
        const payload = (await response.json()) as { error?: { code?: string } };
        assert.equal(payload.error?.code, "ollama_response_invalid");
        assert.equal(existsSync(join(stateDir, "checkpoints")), false);
      } finally {
        await close(server);
      }
    });
  }

  const completedFrame =
    'data: {"type":"response.completed","response":{"id":"tailed","object":"response","status":"completed","output":[]}}\n\n';
  const failedFrame = 'data: {"type":"response.failed","response":{"status":"failed"}}\n\n';
  const typedErrorFrame = 'data: {"type":"error","error":{"message":"upstream exploded"}}\n\n';
  const doneFrame = "data: [DONE]\n\n";
  const deltaFrame = 'data: {"delta":"one"}\n\n';

  const taintedSseCases: [string, string[]][] = [
    ["failed terminal followed by completed", [failedFrame, completedFrame, doneFrame]],
    ["typed error followed by completed", [typedErrorFrame, completedFrame, doneFrame]],
    ["completed followed by failed", [completedFrame, failedFrame, doneFrame]],
    ["duplicate completed", [completedFrame, completedFrame, doneFrame]],
    ["DONE before completed", [doneFrame, completedFrame]],
    ["DONE only", [doneFrame]],
    ["duplicate DONE", [doneFrame, doneFrame]],
    ["data after DONE", [completedFrame, doneFrame, deltaFrame]],
    ["malformed frame before completed", ["data: not-json\n\n", completedFrame]],
    ["malformed frame after DONE", [completedFrame, doneFrame, "data: {broken-trailing\n\n"]],
  ];

  for (const [label, frames] of taintedSseCases) {
    it(`withholds success for a tainted Ollama SSE stream: ${label}`, async () => {
      const stateDir = mkdtempSync(join(tmpdir(), "cob-sse-taint-"));
      const port = await freePort();
      const server = await listenGateway({
        port,
        catalog: CATALOG,
        stateDir,
        ollamaFetch: async () =>
          new Response(frames.join(""), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      });
      try {
        const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "ollama/test", stream: true, input: [] }),
        });
        const body = await response.text();
        assert.equal([...body.matchAll(/data: \[DONE\]/g)].length, 0);
        assert.equal(body.includes("tailed"), false);
        assert.equal(body.includes("response.failed"), false);
        assert.equal(body.includes("upstream exploded"), false);
        assert.equal(body.includes("broken-trailing"), false);
        assert.equal(existsSync(join(stateDir, "checkpoints")), false);
        assert.equal(response.status, 200);
      } finally {
        await close(server);
      }
    });
  }

  it("relays a typed Ollama SSE error terminal once and never completes", async () => {
    const previous = process.env.COB_DIAGNOSTIC_JSONL;
    process.env.COB_DIAGNOSTIC_JSONL = "1";
    const events: GatewayDiagnosticEventV1[] = [];
    const stateDir = mkdtempSync(join(tmpdir(), "cob-sse-typed-error-"));
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: CATALOG,
      stateDir,
      diagnosticSink: { write: (event) => events.push(event) },
      ollamaFetch: async () =>
        new Response(
          `${deltaFrame}${typedErrorFrame}${doneFrame}`,
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
      assert.equal(response.status, 200);
      // The ordinary prefix is relayed live; the typed error is the single,
      // cob-owned terminal and a success [DONE] never follows it.
      assert.equal(body.includes("upstream exploded"), false);
      assert.equal(body.includes("ollama_response_error"), true);
      assert.equal([...body.matchAll(/data: \[DONE\]/g)].length, 0);
      assert.equal(body.includes("one"), true);
      assert.equal(existsSync(join(stateDir, "checkpoints")), false);
      const end = events.find((event) => event.kind === "request_end") as
        | Extract<GatewayDiagnosticEventV1, { kind: "request_end" }>
        | undefined;
      assert.equal(end?.terminal, "non_success");
      assert.equal(end?.non_success_kind, "error");
      assert.equal(end?.error_code, "ollama_response_error");
    } finally {
      await close(server);
      if (previous === undefined) delete process.env.COB_DIAGNOSTIC_JSONL;
      else process.env.COB_DIAGNOSTIC_JSONL = previous;
    }
  });

  it("suppresses a malformed Ollama line while keeping the ordinary prefix", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-sse-malformed-mid-"));
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: CATALOG,
      stateDir,
      ollamaFetch: async () =>
        new Response(`${deltaFrame}data: {broken-mid\n\n${doneFrame}`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ollama/test", stream: true, input: [] }),
      });
      const body = await response.text();
      assert.equal(response.status, 200);
      // The ordinary frame parsed before the malformed line stays relayed
      // live; the unparseable line never reaches the client and the tainted
      // stream ends without a success terminal or [DONE].
      assert.equal(body.includes("one"), true);
      assert.equal(body.includes("broken-mid"), false);
      assert.equal([...body.matchAll(/data: \[DONE\]/g)].length, 0);
      assert.equal(existsSync(join(stateDir, "checkpoints")), false);
    } finally {
      await close(server);
    }
  });

  it("does not checkpoint a JSON Ollama response when the client aborts before the commit", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-abort-before-commit-"));
    const state = new LatchingStateStore(stateDir);
    const port = await freePort();
    const server = await listenGateway({
      port,
      catalog: CATALOG,
      stateStore: state,
      ollamaFetch: async () =>
        new Response(
          JSON.stringify({ id: "resp_abort_commit", object: "response", status: "completed", output: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const lockPath = join(state.stateDir, ".state.lock");
    try {
      await acquireLock(lockPath);
      try {
        // Deterministic synchronization: the test lock makes publish() wait at
        // the lock grant, the entry latch confirms publish() was reached — the
        // request is already past body reading — before the client aborts, and
        // the settled latch waits out the full publish attempt. Aborts that
        // arrive before publish() (BodyAbortedError) cannot pass this test,
        // and with a removed in-lock check the commit would land before the
        // settled latch resolves. The in-lock abort check is therefore the
        // only gate between the handler and the checkpoint commit here.
        const controller = new AbortController();
        const pending = fetch(`http://127.0.0.1:${port}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "ollama/test", input: [] }),
          signal: controller.signal,
        }).catch(() => undefined);
        await Promise.race([
          state.publishEntered,
          new Promise((_, reject) => setTimeout(() => reject(new Error("publish() was never entered")), 2_000)),
        ]);
        controller.abort();
        releaseLock(lockPath);
        await Promise.race([
          state.publishSettled,
          new Promise((_, reject) => setTimeout(() => reject(new Error("publish() never settled")), 2_000)),
        ]);
        await pending;
        assert.equal(existsSync(join(state.stateDir, "checkpoints")), false);
      } finally {
        releaseLock(lockPath);
      }
    } finally {
      await close(server);
    }
  });
});
