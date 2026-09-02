/**
 * Responses WebSocket fallback benchmark (pack-excluded eval fixture).
 *
 * Measures the current client pattern against an isolated in-process gateway
 * and a fake upstream: each turn attempts a WebSocket upgrade (cob answers
 * 426 upgrade_required) and then falls back to the successful HTTP request.
 * Compares it with direct HTTP for 1, 10, and 20 sequential continuation
 * turns over the same local fixture. Uses only the Node runtime (raw sockets
 * + fetch); no WebSocket library dependency.
 *
 * The result is a feasibility receipt for later review. This harness does not
 * implement product WebSocket, persistent sessions, multiplexing,
 * backpressure, or replay, and Ollama stays HTTP upstream.
 *
 * Usage: node dist/eval-ws-fallback.js [--out receipt.json] [--turns 1,10,20]
 */
import { connect, type Socket } from "node:net";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { percentile } from "./eval-gateway-memory.js";
import { EvalRunGuard } from "./eval-run-guard.js";
import { listenGateway } from "./codex/gateway.js";
import type { CatalogFile } from "./codex/types.js";

export const WS_FALLBACK_SCHEMA_VERSION = 1;

const CATALOG: CatalogFile = {
  models: [{ slug: "codex-mini" }, { slug: "ollama/test" }],
};

const TURN_TEXT = "cob-ws-fallback turn fixture with deterministic padding 0123456789\n";

export type WsFallbackProbe = {
  status: number;
  upgrade_accepted: boolean;
  /** Handshake wall time in milliseconds. */
  elapsed_ms: number;
  /** Handshake request bytes (the upgrade request written to the socket). */
  request_bytes: number;
  /** Handshake response bytes (the HTTP response head read back). */
  response_bytes: number;
};

/**
 * Raw WebSocket-upgrade probe against a loopback HTTP server. Resolves with
 * the HTTP status of the handshake response (cob answers 426) plus its time
 * and byte cost, without any WebSocket library. The handshake time and bytes
 * are part of the measured fallback tax.
 */
export function probeWebSocketUpgrade(port: number, path = "/v1/responses", timeoutMs = 5_000): Promise<WsFallbackProbe> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const started = performance.now();
    const socket: Socket = connect({ host: "127.0.0.1", port }, () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          "\r\n",
      );
    });
    const requestBytes = Buffer.byteLength(
      `GET ${path} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "\r\n",
      "utf8",
    );
    let data = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("websocket upgrade probe timed out"));
    }, timeoutMs);
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
      const end = data.indexOf("\r\n\r\n");
      if (end < 0) return;
      const status = Number(data.split(" ")[1] ?? 0);
      const upgradeAccepted = /^HTTP\/1\.1 101\b/.test(data);
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({
        status,
        upgrade_accepted: upgradeAccepted,
        elapsed_ms: performance.now() - started,
        request_bytes: requestBytes,
        response_bytes: Buffer.byteLength(data.slice(0, end + 4), "utf8"),
      });
    });
    socket.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

export type TurnPatternResult = {
  pattern: "ws-fallback" | "direct-http";
  turns: number;
  http_requests: number;
  upgrade_attempts: number;
  fallbacks: number;
  /** 426 handshake cost included in the fallback tax. */
  handshake_connections: number;
  handshake_ms_p50: number;
  handshake_ms_p95: number;
  handshake_bytes: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  request_bytes: number;
  response_bytes: number;
  output_sha256: string;
};

export function parseTurnsArg(value: string | undefined): number[] {
  if (!value) return [1, 10, 20];
  const turns = value.split(",").map((entry) => Number(entry));
  if (turns.some((turn) => !Number.isInteger(turn) || turn < 1 || turn > 100)) {
    throw new Error("--turns must be comma-separated integers in 1..100");
  }
  return turns;
}

/**
 * Fail-closed CLI argument parsing. Supports only `--out <path>` and
 * `--turns <comma-separated values>`; unknown arguments, dangling flags, and
 * an explicitly empty `--turns` are errors. The `[1, 10, 20]` default applies
 * only when `--turns` is genuinely absent.
 */
export function parseWsArgs(argv: string[]): { turns: number[]; out?: string } {
  let out: string | undefined;
  let turns: number[] | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--out") {
      const value = argv[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw new Error("--out requires a non-empty path value");
      }
      out = value;
      index += 1;
    } else if (arg === "--turns") {
      const value = argv[index + 1];
      if (value === undefined || value.length === 0) throw new Error("--turns requires a non-empty value");
      turns = parseTurnsArg(value);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { turns: turns ?? [1, 10, 20], out };
}

export async function runTurnPattern(
  port: number,
  pattern: "ws-fallback" | "direct-http",
  turns: number,
): Promise<TurnPatternResult> {
  let httpRequests = 0;
  let upgradeAttempts = 0;
  let fallbacks = 0;
  let requestBytes = 0;
  let responseBytes = 0;
  let handshakeBytes = 0;
  const handshakeLatencies: number[] = [];
  const latencies: number[] = [];
  const outputs: string[] = [];
  let previousResponseId: string | undefined;
  for (let turn = 0; turn < turns; turn += 1) {
    const turnStarted = performance.now();
    if (pattern === "ws-fallback") {
      // The 426 handshake is part of the fallback tax: its time and bytes are
      // accumulated alongside the HTTP request cost.
      const probe = await probeWebSocketUpgrade(port);
      upgradeAttempts += 1;
      handshakeBytes += probe.request_bytes + probe.response_bytes;
      handshakeLatencies.push(probe.elapsed_ms);
      if (probe.status === 426 && !probe.upgrade_accepted) fallbacks += 1;
      else throw new Error(`expected 426 upgrade_required, got ${probe.status} accepted=${probe.upgrade_accepted}`);
    }
    const body = JSON.stringify({
      model: "ollama/test",
      ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: TURN_TEXT }] }],
    });
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const text = await response.text();
    latencies.push(performance.now() - turnStarted);
    httpRequests += 1;
    requestBytes += Buffer.byteLength(body, "utf8");
    responseBytes += Buffer.byteLength(text, "utf8");
    // Canonical output: status plus the full body hash.
    outputs.push(`${response.status}:${createHash("sha256").update(text, "utf8").digest("hex")}`);
    if (response.status !== 200) throw new Error(`turn ${turn} failed with HTTP ${response.status}`);
    const parsed = JSON.parse(text) as { id?: string };
    if (typeof parsed.id === "string") previousResponseId = parsed.id;
  }
  return {
    pattern,
    turns,
    http_requests: httpRequests,
    upgrade_attempts: upgradeAttempts,
    fallbacks,
    handshake_connections: pattern === "ws-fallback" ? upgradeAttempts : 0,
    handshake_ms_p50: percentile(handshakeLatencies, 50),
    handshake_ms_p95: percentile(handshakeLatencies, 95),
    handshake_bytes: handshakeBytes,
    latency_p50_ms: percentile(latencies, 50),
    latency_p95_ms: percentile(latencies, 95),
    request_bytes: requestBytes,
    response_bytes: responseBytes,
    output_sha256: createHash("sha256").update(outputs.join("\n")).digest("hex"),
  };
}

export function formatTurnResult(result: TurnPatternResult): string {
  return [
    `pattern=${result.pattern}`,
    `turns=${result.turns}`,
    `http_requests=${result.http_requests}`,
    `upgrade_attempts=${result.upgrade_attempts}`,
    `fallbacks=${result.fallbacks}`,
    `handshake_connections=${result.handshake_connections}`,
    `handshake_ms_p50=${result.handshake_ms_p50.toFixed(3)}`,
    `handshake_ms_p95=${result.handshake_ms_p95.toFixed(3)}`,
    `handshake_bytes=${result.handshake_bytes}`,
    `latency_p50_ms=${result.latency_p50_ms.toFixed(3)}`,
    `latency_p95_ms=${result.latency_p95_ms.toFixed(3)}`,
    `request_bytes=${result.request_bytes}`,
    `response_bytes=${result.response_bytes}`,
    `output_sha256=${result.output_sha256.slice(0, 16)}`,
  ].join(" ");
}

export async function evaluateWsFallback(
  turnSets: number[],
  opts: { tmpRoot?: string; port?: number } = {},
): Promise<TurnPatternResult[]> {
  const guard = new EvalRunGuard({
    label: "ws-fallback-bench",
    runId: `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    tmpRoot: opts.tmpRoot,
  });
  // Each pattern run gets its own isolated gateway and state dir, so the
  // deterministic response-id counter restarts per run: fallback and direct
  // HTTP over the same turns produce identical response bytes and therefore
  // the identical output hash, while every turn inside one run keeps a
  // unique id (cob state fail-closed requires unique checkpoints).
  let firstRunPortUsed = false;
  const runIsolated = async (
    pattern: "ws-fallback" | "direct-http",
    turns: number,
  ): Promise<TurnPatternResult> => {
    const stateDir = guard.allocateHome("cob-ws-fallback-state-");
    // An injected port is a test-only setup-failure seam for the first run;
    // it is registered with the guard only after a successful listen so a
    // failed setup still passes the guard's port-closed proof while homes
    // are always cleaned up.
    const injected = !firstRunPortUsed && opts.port !== undefined;
    firstRunPortUsed = true;
    const port = injected ? opts.port! : await guard.allocateClosedPort();
    let gateway: Awaited<ReturnType<typeof listenGateway>> | undefined;
    let seq = 0;
    try {
      gateway = await listenGateway({
        port,
        catalog: CATALOG,
        stateDir,
        ollamaFetch: async () =>
          new Response(
            JSON.stringify({
              id: `ws-${(seq += 1)}`,
              object: "response",
              status: "completed",
              output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      });
      if (injected) guard.registerPort(port);
      return await runTurnPattern(port, pattern, turns);
    } finally {
      // The listener is closed only if it opened; the guard finalizes once
      // for every owned home and port at the end of the evaluation.
      if (gateway) {
        const closing = gateway;
        gateway = undefined;
        await new Promise<void>((resolve) => closing.close(() => resolve()));
      }
    }
  };
  const results: TurnPatternResult[] = [];
  try {
    for (const turns of turnSets) {
      results.push(await runIsolated("ws-fallback", turns));
      results.push(await runIsolated("direct-http", turns));
    }
  } finally {
    await guard.finalize();
  }
  return results;
}

async function main(): Promise<void> {
  const { turns: turnSets, out } = parseWsArgs(process.argv.slice(2));
  const results = await evaluateWsFallback(turnSets);
  for (const result of results) console.log(formatTurnResult(result));
  if (out) {
    const receipt = {
      schema_version: WS_FALLBACK_SCHEMA_VERSION,
      measurement: "responses_ws_fallback_tax",
      lanes: results,
      decision_note:
        "feasibility receipt only; no product WebSocket, persistent session, multiplexing, backpressure, or replay is authorized by this receipt; Ollama remains HTTP upstream",
    };
    writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    console.log(`receipt: ${out}`);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
