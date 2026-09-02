import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { G8R_PASS, listCheckpointIds, ollamaWireUnsafeReason, scoreG8rReplay } from "./eval-g8r.js";
import { listenGateway } from "./codex/gateway.js";
import type { EvalRunIdentity } from "./eval-receipt.js";
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

const CORPUS_SHA256 = "a".repeat(64);

describe("G8-R completed checkpoint replay", () => {
  const RUN: EvalRunIdentity = {
    model: "codex-mini",
    child: "child-1",
    session: "sess-1",
    requestId: "req-1",
    corpusSha256: CORPUS_SHA256,
  };
  const LIVE = {
    configSha256: "c".repeat(64),
    catalogSha256: "d".repeat(64),
    catalogMetaSha256: "e".repeat(64),
  };

  it("fails closed when epoch A is still listening or history is not expanded", () => {
    assert.equal(
      scoreG8rReplay({
        run: RUN,
        liveBefore: LIVE,
        liveAfter: LIVE,
        epochAPortOpenAfterStop: true,
        parentResponseId: "resp-1",
        replayResponseId: "resp-2",
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
    assert.equal(
      ollamaWireUnsafeReason({ input: [{ nested: { previous_response_id: "resp-1" } }] }),
      "forbidden_ollama_wire:previous_response_id",
    );
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
        run: RUN,
        liveBefore: LIVE,
        liveAfter: LIVE,
        epochAPortOpenAfterStop,
        parentResponseId: "resp-1",
        replayResponseId: body.id ?? "",
        epochACheckpointIds,
        epochBCheckpointIds: listCheckpointIds(stateDir),
        replayOllamaBody: sent[1],
      });
      assert.equal(score.verdict, "pass", score.reason);
      assert.equal(score.code, G8R_PASS);
      assert.match(score.receipts.parentSha256, /^[0-9a-f]{64}$/);
      assert.match(score.receipts.runSha256, /^[0-9a-f]{64}$/);
      assert.match(score.receipts.artifactSha256, /^[0-9a-f]{64}$/);
      assert.equal(score.receipts.corpusSha256, CORPUS_SHA256);
    } finally {
      await close(restarted);
    }
    assert.deepEqual(
      (sent[1]?.input as JsonObject[]).map((item) => item.id),
      ["user-1", "assistant-1", "user-2"],
    );
  });
});

describe("G8-R evidence integrity", () => {
  const RUN: EvalRunIdentity = {
    model: "codex-mini",
    child: "child-1",
    session: "sess-1",
    requestId: "req-1",
    corpusSha256: CORPUS_SHA256,
  };
  const LIVE = {
    configSha256: "c".repeat(64),
    catalogSha256: "d".repeat(64),
    catalogMetaSha256: "e".repeat(64),
  };
  const SAFE_BODY = {
    model: "test",
    input: [{ role: "user" }, { role: "assistant" }, { role: "user" }],
  };
  const BASE = {
    run: RUN,
    liveBefore: LIVE,
    liveAfter: LIVE,
    epochAPortOpenAfterStop: false,
    parentResponseId: "resp-1",
    replayResponseId: "resp-2",
    epochACheckpointIds: ["resp-1"],
    epochBCheckpointIds: ["resp-1", "resp-2"],
    replayOllamaBody: SAFE_BODY,
  };

  function scoreG8r(obs: object) {
    return scoreG8rReplay(obs as unknown as Parameters<typeof scoreG8rReplay>[0]);
  }

  it("requires complete run identity and unmutated live SHA snapshots", () => {
    assert.equal(scoreG8r({ ...BASE, run: { ...RUN, requestId: "" } }).code, "run_identity_incomplete");
    assert.equal(
      scoreG8r({ ...BASE, liveAfter: { ...LIVE, catalogSha256: "" } }).code,
      "live_sha_snapshot_incomplete",
    );
    assert.equal(
      scoreG8r({ ...BASE, liveAfter: { ...LIVE, catalogMetaSha256: "" } }).code,
      "live_sha_snapshot_incomplete",
    );
    assert.equal(
      scoreG8r({ ...BASE, liveAfter: { ...LIVE, configSha256: "f".repeat(64) } }).code,
      "post_run_sha_mutation",
    );
  });

  it("requires non-empty parent and replay response ids", () => {
    assert.equal(scoreG8r({ ...BASE, parentResponseId: "" }).code, "parent_response_missing");
    assert.equal(scoreG8r({ ...BASE, replayResponseId: "" }).code, "replay_response_missing");
  });

  it("rejects duplicate and malformed checkpoint evidence", () => {
    assert.equal(
      scoreG8r({ ...BASE, epochBCheckpointIds: ["resp-1", "resp-2", "resp-2"] }).code,
      "duplicate_checkpoint_filename",
    );
    assert.equal(scoreG8r({ ...BASE, epochACheckpointIds: ["resp-1", "resp-1"] }).code, "duplicate_checkpoint_filename");
    assert.equal(scoreG8r({ ...BASE, epochACheckpointIds: ["resp-1", ""] }).code, "malformed_observation");
    assert.equal(
      scoreG8r({ ...BASE, epochACheckpointIds: "resp-1" as unknown as string[] }).code,
      "malformed_observation",
    );
    assert.equal(
      scoreG8r({ ...BASE, epochBCheckpointIds: ["resp-2"] }).code,
      "checkpoint_lineage_missing",
    );
  });

  it("rejects encrypted_content anywhere in the replay body", () => {
    assert.equal(
      ollamaWireUnsafeReason({
        input: [{ role: "user", content: [{ type: "encrypted_content", data: "opaque" }] }],
      }),
      "forbidden_ollama_wire:encrypted_content",
    );
    assert.equal(
      scoreG8r({ ...BASE, replayOllamaBody: { model: "t", input: [{ nested: { encrypted_content: "x" } }] } })
        .code,
      "forbidden_ollama_wire:encrypted_content",
    );
  });

  it("fails closed on cyclic scorer input instead of throwing", () => {
    const cyclic: Record<string, unknown> = { model: "test", input: [{ role: "user" }] };
    cyclic.loop = cyclic;
    const score = scoreG8r({ ...BASE, replayOllamaBody: cyclic });
    assert.equal(score.verdict, "fail");
    assert.equal(score.code, "ollama_body_circular");
    assert.equal(ollamaWireUnsafeReason(cyclic), "ollama_body_circular");
  });

  it("derives expanded history from the captured input items", () => {
    assert.equal(
      scoreG8r({ ...BASE, replayOllamaBody: { model: "test", input: [{ role: "user" }, { role: "user" }, { role: "user" }] } })
        .code,
      "history_not_expanded",
    );
    assert.equal(
      scoreG8r({
        ...BASE,
        replayOllamaBody: {
          model: "test",
          input: [{ role: "user" }, { role: "assistant" }, { role: "assistant" }],
        },
      }).code,
      "history_not_expanded",
    );
    assert.equal(
      scoreG8r({ ...BASE, replayOllamaBody: { model: "test", input: [{ role: 7 }, { role: "assistant" }, { role: "user" }] } })
        .code,
      "history_not_expanded",
    );
  });

  it("decodes only canonical base64url checkpoint filenames", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cob-g8r-names-"));
    const checkpoints = join(stateDir, "checkpoints");
    mkdirSync(checkpoints);
    writeFileSync(join(checkpoints, `${Buffer.from("resp-1", "utf8").toString("base64url")}.json`), "{}");
    assert.deepEqual(listCheckpointIds(stateDir), ["resp-1"]);
    writeFileSync(join(checkpoints, "arbitrary-id.json"), "{}");
    assert.throws(() => listCheckpointIds(stateDir), /malformed_checkpoint_filename/);
    writeFileSync(join(checkpoints, "resp+slash.json"), "{}");
    assert.throws(() => listCheckpointIds(stateDir), /malformed_checkpoint_filename/);
  });

  it("passes a fully evidenced replay", () => {
    const result = scoreG8r(BASE);
    assert.equal(result.verdict, "pass", result.reason);
    assert.equal(result.code, G8R_PASS);
  });
});
