import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import {
  evaluateWsFallback,
  formatTurnResult,
  parseTurnsArg,
  parseWsArgs,
  probeWebSocketUpgrade,
  runTurnPattern,
} from "./eval-ws-fallback.js";

describe("websocket fallback benchmark", () => {
  it("parses the turns argument fail-closed", () => {
    assert.deepEqual(parseTurnsArg(undefined), [1, 10, 20]);
    assert.deepEqual(parseTurnsArg("1,5"), [1, 5]);
    assert.throws(() => parseTurnsArg("0"), /--turns/);
    assert.throws(() => parseTurnsArg("1,abc"), /--turns/);
  });

  it("parses CLI arguments sequentially and fail-closed", () => {
    assert.deepEqual(parseWsArgs([]), { turns: [1, 10, 20], out: undefined });
    assert.deepEqual(parseWsArgs(["--out", "receipt.json"]), { turns: [1, 10, 20], out: "receipt.json" });
    assert.deepEqual(parseWsArgs(["--turns", "1,5", "--out", "receipt.json"]), {
      turns: [1, 5],
      out: "receipt.json",
    });
    assert.throws(() => parseWsArgs(["--bogus"]), /unknown argument/);
    assert.throws(() => parseWsArgs(["--out"]), /--out/);
    assert.throws(() => parseWsArgs(["--out", ""]), /--out/);
    assert.throws(() => parseWsArgs(["--out", "--turns"]), /--out/);
    assert.throws(() => parseWsArgs(["--turns"]), /--turns/);
    assert.throws(() => parseWsArgs(["--turns", ""]), /--turns/);
  });

  it("probes a 426 upgrade rejection from a plain HTTP server", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(426, { "content-type": "text/plain" });
      res.end("upgrade_required");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const probe = await probeWebSocketUpgrade(port);
      assert.equal(probe.status, 426);
      assert.equal(probe.upgrade_accepted, false);
      // Handshake cost is measured and becomes part of the fallback tax.
      assert.ok(probe.elapsed_ms >= 0);
      assert.ok(probe.request_bytes > 0);
      assert.ok(probe.response_bytes > 0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("formats a content-free turn result", () => {
    const formatted = formatTurnResult({
      pattern: "ws-fallback",
      turns: 10,
      http_requests: 10,
      upgrade_attempts: 10,
      fallbacks: 10,
      handshake_connections: 10,
      handshake_ms_p50: 0.5,
      handshake_ms_p95: 2.5,
      handshake_bytes: 5000,
      latency_p50_ms: 1.5,
      latency_p95_ms: 4.5,
      request_bytes: 2000,
      response_bytes: 3000,
      output_sha256: "c".repeat(64),
    });
    assert.match(formatted, /pattern=ws-fallback turns=10 /);
    assert.match(formatted, /fallbacks=10 /);
    assert.match(formatted, /handshake_connections=10 /);
    assert.match(formatted, /handshake_bytes=5000 /);
    assert.equal(formatted.includes("cob-ws-fallback turn fixture"), false);
  });

  it("runs both patterns over one, ten, and twenty turns in-process with a fake upstream", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "cob-ws-test-"));
    const { EvalRunGuard } = await import("./eval-run-guard.js");
    const guard = new EvalRunGuard({ label: "ws-test", runId: `test-${Date.now()}`, tmpRoot });
    const stateDir = guard.allocateHome("cob-ws-state-");
    const port = await guard.allocateClosedPort();
    guard.registerPort(port);
    const gateway = await import("./codex/gateway.js");
    const server = await gateway.listenGateway({
      port,
      catalog: { models: [{ slug: "codex-mini" }, { slug: "ollama/test" }] },
      stateDir,
      ollamaFetch: async () =>
        new Response(
          JSON.stringify({
            id: `t-${Math.random().toString(36).slice(2, 8)}`,
            object: "response",
            status: "completed",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    try {
      const single = await runTurnPattern(port, "ws-fallback", 1);
      assert.equal(single.fallbacks, 1);
      assert.equal(single.http_requests, 1);
      // The 426 handshake is part of the fallback tax.
      assert.equal(single.handshake_connections, 1);
      assert.equal(single.upgrade_attempts, 1);
      assert.ok(single.handshake_bytes > 0);
      assert.ok(single.handshake_ms_p50 >= 0);
      const direct = await runTurnPattern(port, "direct-http", 10);
      assert.equal(direct.upgrade_attempts, 0);
      assert.equal(direct.http_requests, 10);
      assert.equal(direct.handshake_connections, 0);
      assert.equal(direct.handshake_bytes, 0);
      const long = await runTurnPattern(port, "ws-fallback", 20);
      assert.equal(long.fallbacks, 20);
      assert.equal(long.handshake_connections, 20);
      assert.match(long.output_sha256, /^[0-9a-f]{64}$/);
      assert.ok(long.latency_p50_ms >= 0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await guard.finalize();
    }
  });

  it("evaluates the safe local fixture end to end and cleans up", async () => {
    const results = await evaluateWsFallback([1, 2]);
    assert.equal(results.length, 4);
    for (const result of results) {
      assert.equal(result.output_sha256.length, 64);
    }
    // Fallback and direct HTTP over the same semantic turns must produce the
    // identical semantic output hash (deterministic response identities).
    assert.equal(results[0]!.output_sha256, results[1]!.output_sha256);
    assert.equal(results[2]!.output_sha256, results[3]!.output_sha256);
  });

  it("proves temp-home cleanup when the gateway listener fails to open", async () => {
    const { createServer } = await import("node:http");
    const occupier = createServer((_req, res) => res.end());
    await new Promise<void>((resolve) => occupier.listen(0, "127.0.0.1", resolve));
    const occupiedPort = (occupier.address() as AddressInfo).port;
    const tmpRoot = mkdtempSync(join(tmpdir(), "cob-ws-fail-"));
    const { readdirSync } = await import("node:fs");
    try {
      await assert.rejects(() => evaluateWsFallback([1], { tmpRoot, port: occupiedPort }), /EADDRINUSE/);
      // The guard finalized despite the setup failure: no temp home remains.
      assert.deepEqual(readdirSync(tmpRoot).filter((name) => name.startsWith("cob-ws-fallback-state-")), []);
    } finally {
      await new Promise<void>((resolve) => occupier.close(() => resolve()));
    }
  });
});
