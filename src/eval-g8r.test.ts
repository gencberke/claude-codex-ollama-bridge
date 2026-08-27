import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createConnection, createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { G8R_PASS, listCheckpointIds, ollamaWireUnsafeReason, scoreG8rReplay } from "./eval-g8r.js";
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

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(250);
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

describe("G8-R completed checkpoint replay", () => {
  it("fails closed when epoch A is still listening or history is not expanded", () => {
    assert.equal(
      scoreG8rReplay({
        epochAPortOpenAfterStop: true,
        parentResponseId: "resp-1",
        epochACheckpointIds: ["resp-1"],
        epochBCheckpointIds: ["resp-1", "resp-2"],
        replayOllamaBody: { model: "test", input: [{ role: "user" }, { role: "assistant" }, { role: "user" }] },
      }).code,
      "port_still_open",
    );
    assert.equal(
      ollamaWireUnsafeReason({ previous_response_id: "resp-1", input: [] }),
      "previous_response_id_on_ollama",
    );
    assert.equal(ollamaWireUnsafeReason({ input: [], extra: "cob1.1.abc" }), "forbidden_ollama_wire:cob1.");
  });

  it("replays one completed checkpoint after the gateway port is closed", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-g8r-"));
    const sent: JsonObject[] = [];
    let responseNumber = 0;
    const ollamaFetch = async (_url: string, init: { body: Buffer }) => {
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
        body: JSON.stringify({ model: "ollama/test", input: message("user-1", "one") }),
      });
      assert.equal(response.status, 200, await response.text());
    } finally {
      await close(first);
    }
    const epochACheckpointIds = listCheckpointIds(stateDir);
    const epochAPortOpenAfterStop = await portOpen(firstPort);
    const secondPort = await freePort();
    const restarted = await listenGateway({ port: secondPort, catalog: CATALOG, stateDir, ollamaFetch });
    try {
      const replay = await fetch(`http://127.0.0.1:${secondPort}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ollama/test",
          previous_response_id: "resp-1",
          input: message("user-2", "two"),
        }),
      });
      const replayText = await replay.text();
      assert.equal(replay.status, 200, replayText);
      const body = JSON.parse(replayText) as { id?: string };
      const score = scoreG8rReplay({
        epochAPortOpenAfterStop,
        parentResponseId: "resp-1",
        replayResponseId: body.id,
        epochACheckpointIds,
        epochBCheckpointIds: listCheckpointIds(stateDir),
        replayOllamaBody: sent[1],
      });
      assert.equal(score.verdict, "pass", score.reason);
      assert.equal(score.code, G8R_PASS);
      assert.equal(score.receipts.parentSha8.length, 8);
    } finally {
      await close(restarted);
    }
    assert.deepEqual(
      (sent[1]?.input as JsonObject[]).map((item) => item.id),
      ["user-1", "assistant-1", "user-2"],
    );
  });
});
