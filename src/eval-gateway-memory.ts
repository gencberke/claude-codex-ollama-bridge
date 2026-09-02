/**
 * Gateway memory amplification benchmark (pack-excluded eval fixture).
 *
 * In-process/isolated gateway plus a fake upstream; never the live gateway,
 * a live home, or a shared Ollama daemon. Parameterizes concurrency, payload
 * size, streaming, tool-schema shape, and continuation mode.
 *
 * Lanes:
 *   default (safe): 1 MiB payload at concurrency 1 (plain) and 3
 *                   (stream + tool schema + continuation).
 *   full:           1/8/32 MiB at concurrency 1/3/5 with the same mode
 *                   coverage (explicit opt-in only; 64 MiB and near-cap
 *                   stress lanes are never automatic).
 *
 * Records Node version, fixture hash, iterations, RSS baseline/peak/delta, a
 * peak-amplification ratio whose denominator accounts for concurrent
 * in-flight payloads (payload bytes x concurrency, never iterations),
 * event-loop-delay histogram percentiles, latency p50/p95,
 * completed/rejected counts, and a canonical output hash. The receipt is
 * content-free.
 *
 * Usage: node dist/eval-gateway-memory.js [--lane default|full] [--out receipt.json]
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { listenGateway } from "./codex/gateway.js";
import { EvalRunGuard, type EvalRunGuardOptions } from "./eval-run-guard.js";
import type { CatalogFile } from "./codex/types.js";
import { isRecord, type JsonObject } from "./core/json.js";

export const MEMORY_BENCH_SCHEMA_VERSION = 1;

const CATALOG: CatalogFile = {
  models: [{ slug: "codex-mini" }, { slug: "ollama/test" }],
};

export type MemoryLane = {
  name: string;
  concurrency: number;
  payloadBytes: number;
  iterations: number;
  stream: boolean;
  toolSchema: boolean;
  continuation: boolean;
};

export type LaneResult = {
  lane: MemoryLane;
  node_version: string;
  fixture_sha256: string;
  iterations: number;
  rss_baseline_bytes: number;
  rss_peak_bytes: number;
  rss_delta_bytes: number;
  amplification_denominator_bytes: number;
  amplification_ratio: number;
  event_loop_delay_p50_ms: number;
  event_loop_delay_p95_ms: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  completed: number;
  rejected: number;
  output_sha256: string;
};

export function parseLaneArgs(argv: string[]): { lanes: MemoryLane[]; out?: string } {
  let laneName = "default";
  let out: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--lane") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--lane requires a value");
      laneName = value;
      index += 1;
    } else if (arg === "--out") {
      const value = argv[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw new Error("--out requires a non-empty path value");
      }
      out = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { lanes: buildLanes(laneName), out };
}

export function buildLanes(name: string): MemoryLane[] {
  if (name === "default") {
    return [
      lane("default-1mib-c1-plain", 1, 1024 * 1024),
      lane("default-1mib-c3-stream-tool-cont", 3, 1024 * 1024, {
        stream: true,
        toolSchema: true,
        continuation: true,
      }),
    ];
  }
  if (name === "full") {
    return [
      lane("full-1mib-c1-plain", 1, 1024 * 1024),
      lane("full-8mib-c3-stream-tool", 3, 8 * 1024 * 1024, { stream: true, toolSchema: true }),
      lane("full-32mib-c5-stream-tool-cont", 5, 32 * 1024 * 1024, {
        stream: true,
        toolSchema: true,
        continuation: true,
      }),
    ];
  }
  throw new Error(`unknown lane set: ${name} (use default or full)`);
}

function lane(
  name: string,
  concurrency: number,
  payloadBytes: number,
  over: Partial<Pick<MemoryLane, "stream" | "toolSchema" | "continuation">> = {},
): MemoryLane {
  return {
    name,
    concurrency,
    payloadBytes,
    iterations: 30,
    stream: false,
    toolSchema: false,
    continuation: false,
    ...over,
  };
}

/** Nearest-rank percentile over a numeric sample. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)]!;
}

/**
 * Peak amplification over the concurrent in-flight payload bytes: the peak
 * RSS delta is divided by the payload bytes that can actually be in flight at
 * once (payload x concurrency), never by the iteration count.
 */
export function amplifyRatio(rssPeakDeltaBytes: number, payloadBytes: number, inFlightPayloads: number): number {
  if (payloadBytes <= 0 || inFlightPayloads <= 0) return 0;
  return rssPeakDeltaBytes / (payloadBytes * inFlightPayloads);
}

/** Deterministic synthetic payload: fixture text with a fixed filler pattern. */
export function fixturePayload(payloadBytes: number): string {
  const block = "cob-memory-fixture line with deterministic padding 0123456789\n";
  const repeats = Math.max(1, Math.ceil(payloadBytes / block.length));
  return block.repeat(repeats).slice(0, payloadBytes);
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function upstreamEnvelope(id: string): JsonObject {
  return {
    id,
    object: "response",
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
  };
}

/** Read a fetch-init body as UTF-8 text regardless of its runtime type. */
function requestBodyText(body: unknown): string {
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  return body === undefined || body === null ? "" : String(body);
}

/** Extract the response id from a cob SSE relay (held terminal frame). */
function responseIdFromSse(text: string): string | undefined {
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed: unknown = JSON.parse(payload);
      if (!isRecord(parsed)) continue;
      const response = parsed.response;
      if (isRecord(response) && typeof response.id === "string") return response.id;
    } catch {
      // Skip non-JSON frames; the id lives in the completed frame.
    }
  }
  return undefined;
}

export async function runLane(
  laneConfig: MemoryLane,
  opts: { tmpRoot?: string; port?: number; serverFactory?: EvalRunGuardOptions["serverFactory"] } = {},
): Promise<LaneResult> {
  const guard = new EvalRunGuard({ label: `gateway-memory-${laneConfig.name}`, runId: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, tmpRoot: opts.tmpRoot, serverFactory: opts.serverFactory });
  const stateDir = guard.allocateHome("cob-mem-state-");
  const payloadText = fixturePayload(laneConfig.payloadBytes);
  const fixtureSha256 = createHash("sha256").update(payloadText).digest("hex");
  const delay = monitorEventLoopDelay({ resolution: 20 });
  let completed = 0;
  let rejected = 0;
  const latencies: number[] = [];
  const outputParts: string[] = [];
  const rssBaseline = process.memoryUsage().rss;
  let rssPeak = rssBaseline;
  const rssSampler = setInterval(() => {
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  }, 25);
  let gateway: Awaited<ReturnType<typeof listenGateway>> | undefined;
  // Deterministic response identity: a per-gateway counter mints ids, so the
  // same fixture repeated in an independent run produces the identical
  // response bytes and output hash, while every request inside one run still
  // gets a unique id (cob state fail-closed requires unique checkpoints).
  let upstreamSeq = 0;
  let port = 0;
  try {
    // Port allocation lives inside the try: an allocation failure (for
    // example EPERM on listen) must still run the guard's cleanup proof in
    // the finally below, so no guard-owned temp home is left behind. The
    // exclusive run-ID lock intentionally remains as a tombstone so duplicate
    // run IDs stay rejected. An injected
    // port is a test-only setup-failure seam; it is registered with the
    // guard only after a successful listen so a failed setup still passes
    // the guard's port-closed proof.
    port = opts.port ?? (await guard.allocateClosedPort());
    gateway = await listenGateway({
      port,
      catalog: CATALOG,
      stateDir,
      ollamaFetch: async (_url, init) => {
        // The fake upstream reads nothing but the stream flag and answers with
        // a tiny envelope, so measured memory is the gateway's own handling
        // cost. Streaming requests get a real SSE upstream so the stream lane
        // exercises the SSE relay path.
        const bodyText = requestBodyText(init?.body);
        let streamRequested = false;
        try {
          const parsed: unknown = JSON.parse(bodyText);
          streamRequested = isRecord(parsed) && parsed.stream === true;
        } catch {
          streamRequested = false;
        }
        const envelope = upstreamEnvelope(`mem-${(upstreamSeq += 1)}`);
        if (streamRequested) {
          return new Response(`data: ${JSON.stringify({ type: "response.completed", response: envelope })}\n\ndata: [DONE]\n\n`, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response(JSON.stringify(envelope), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    if (opts.port !== undefined) guard.registerPort(port);
    delay.enable();
    let firstResponseId: string | undefined;
    for (let iteration = 0; iteration < laneConfig.iterations; iteration += 1) {
      // Deterministic output order: concurrent workers write into a fixed
      // slot and the batch hash parts are appended in worker order only
      // after the whole batch settles.
      const batchOutputs: string[] = new Array(laneConfig.concurrency);
      const batch: Promise<void>[] = [];
      for (let worker = 0; worker < laneConfig.concurrency; worker += 1) {
        batch.push(
          (async () => {
            const started = performance.now();
            const body: JsonObject = laneConfig.continuation && firstResponseId
              ? {
                  model: "ollama/test",
                  stream: laneConfig.stream,
                  previous_response_id: firstResponseId,
                  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: payloadText }] }],
                }
              : {
                  model: "ollama/test",
                  stream: laneConfig.stream,
                  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: payloadText }] }],
                };
            if (laneConfig.toolSchema) {
              body.tools = [
                { type: "function", name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } } } },
              ];
            }
            const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            });
            const text = await response.text();
            latencies.push(performance.now() - started);
            const isSse = (response.headers.get("content-type") ?? "").includes("text/event-stream");
            let responseId: string | undefined;
            if (isSse) {
              if (response.status === 200 && text.includes("response.completed") && text.trimEnd().endsWith("data: [DONE]")) {
                responseId = responseIdFromSse(text);
              }
            } else {
              try {
                const parsed = JSON.parse(text) as { id?: string };
                if (typeof parsed.id === "string") responseId = parsed.id;
              } catch {
                responseId = undefined;
              }
            }
            // Canonical output: status plus the full body hash, so the
            // output hash covers actual response content, not just lengths.
            batchOutputs[worker] = `${response.status}:${sha256Text(text)}`;
            if (response.status === 200) {
              completed += 1;
              if (iteration === 0 && worker === 0 && responseId) {
                firstResponseId = responseId;
              }
            } else {
              rejected += 1;
            }
          })(),
        );
      }
      await Promise.all(batch);
      // Canonical order-independent batch multiset: concurrent workers may
      // receive their response ids in any arrival order, so the batch's hash
      // parts are sorted before they join the deterministic output hash.
      outputParts.push(...batchOutputs.sort());
      rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
    }
  } finally {
    clearInterval(rssSampler);
    delay.disable();
    // The listener is closed only if it opened; the guard finalizes in every
    // case, including setup failure.
    if (gateway) {
      const closing = gateway;
      gateway = undefined;
      await new Promise<void>((resolve) => closing.close(() => resolve()));
    }
    await guard.finalize();
  }
  const denominatorBytes = laneConfig.payloadBytes * laneConfig.concurrency;
  return {
    lane: laneConfig,
    node_version: process.version,
    fixture_sha256: fixtureSha256,
    iterations: laneConfig.iterations,
    rss_baseline_bytes: rssBaseline,
    rss_peak_bytes: rssPeak,
    rss_delta_bytes: rssPeak - rssBaseline,
    amplification_denominator_bytes: denominatorBytes,
    amplification_ratio: amplifyRatio(rssPeak - rssBaseline, laneConfig.payloadBytes, laneConfig.concurrency),
    // Real event-loop-delay histogram percentiles from the IntervalHistogram.
    event_loop_delay_p50_ms: delay.count > 0 ? delay.percentile(50) / 1e6 : 0,
    event_loop_delay_p95_ms: delay.count > 0 ? delay.percentile(95) / 1e6 : 0,
    latency_p50_ms: percentile(latencies, 50),
    latency_p95_ms: percentile(latencies, 95),
    completed,
    rejected,
    output_sha256: createHash("sha256").update(outputParts.join("\n")).digest("hex"),
  };
}

export function formatLaneResult(result: LaneResult): string {
  return [
    `lane=${result.lane.name}`,
    `node=${result.node_version}`,
    `fixture_sha256=${result.fixture_sha256.slice(0, 16)}`,
    `iterations=${result.iterations}`,
    `rss_baseline=${result.rss_baseline_bytes}`,
    `rss_peak=${result.rss_peak_bytes}`,
    `rss_delta=${result.rss_delta_bytes}`,
    `amplification_denominator_bytes=${result.amplification_denominator_bytes}`,
    `amplification_ratio=${result.amplification_ratio.toFixed(3)}`,
    `loop_p50_ms=${result.event_loop_delay_p50_ms.toFixed(3)}`,
    `loop_p95_ms=${result.event_loop_delay_p95_ms.toFixed(3)}`,
    `latency_p50_ms=${result.latency_p50_ms.toFixed(3)}`,
    `latency_p95_ms=${result.latency_p95_ms.toFixed(3)}`,
    `completed=${result.completed}`,
    `rejected=${result.rejected}`,
    `output_sha256=${result.output_sha256.slice(0, 16)}`,
  ].join(" ");
}

async function main(): Promise<void> {
  const { lanes, out } = parseLaneArgs(process.argv.slice(2));
  const results: LaneResult[] = [];
  for (const laneConfig of lanes) {
    const result = await runLane(laneConfig);
    results.push(result);
    console.log(formatLaneResult(result));
  }
  if (out) {
    const receipt = {
      schema_version: MEMORY_BENCH_SCHEMA_VERSION,
      measurement: "gateway_memory_amplification",
      lanes: results,
      decision_note:
        "measurement only; no queue, semaphore, admission policy, or body-limit change is authorized by this receipt",
    };
    writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    console.log(`receipt: ${out}`);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
