import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  amplifyRatio,
  buildLanes,
  fixturePayload,
  formatLaneResult,
  parseLaneArgs,
  percentile,
  runLane,
} from "./eval-gateway-memory.js";

describe("gateway memory benchmark harness", () => {
  it("parses lane arguments fail-closed", () => {
    const parsed = parseLaneArgs(["--lane", "default", "--out", "receipt.json"]);
    assert.equal(parsed.lanes.length, 2);
    assert.equal(parsed.out, "receipt.json");
    assert.deepEqual(
      parsed.lanes.map((lane) => [lane.concurrency, lane.payloadBytes]),
      [
        [1, 1024 * 1024],
        [3, 1024 * 1024],
      ],
    );
    assert.deepEqual(
      buildLanes("full").map((lane) => lane.payloadBytes),
      [1024 * 1024, 8 * 1024 * 1024, 32 * 1024 * 1024],
    );
  });

  it("computes nearest-rank percentiles and in-flight amplification deterministically", () => {
    assert.equal(percentile([], 95), 0);
    assert.equal(percentile([5], 50), 5);
    assert.equal(percentile([10, 20, 30, 40], 50), 20);
    assert.equal(percentile([10, 20, 30, 40], 95), 40);
    assert.equal(percentile([3, 1, 2], 50), 2);
    // The denominator accounts for concurrent in-flight payloads, never the
    // iteration count: 3 MiB peak delta over 3 x 1 MiB in flight is 1x.
    assert.equal(amplifyRatio(3 * 1024 * 1024, 1024 * 1024, 3), 1);
    assert.equal(amplifyRatio(2 * 1024, 1024, 2), 1);
    assert.equal(amplifyRatio(0, 1024, 1), 0);
    assert.equal(amplifyRatio(1024, 1024, 0), 0);
  });

  it("covers the documented stream, tool, and continuation lanes", () => {
    const defaults = buildLanes("default");
    assert.deepEqual(
      defaults.map((lane) => [lane.concurrency, lane.stream, lane.toolSchema, lane.continuation]),
      [
        [1, false, false, false],
        [3, true, true, true],
      ],
    );
    const full = buildLanes("full");
    assert.deepEqual(
      full.map((lane) => [lane.payloadBytes, lane.stream, lane.toolSchema, lane.continuation]),
      [
        [1024 * 1024, false, false, false],
        [8 * 1024 * 1024, true, true, false],
        [32 * 1024 * 1024, true, true, true],
      ],
    );
    assert.throws(() => parseLaneArgs(["--lane", "stress-64mib"]), /unknown lane set/);
    assert.throws(() => parseLaneArgs(["--bogus"]), /unknown argument/);
    assert.throws(() => parseLaneArgs(["--out"]), /--out/);
    assert.throws(() => parseLaneArgs(["--out", ""]), /--out/);
    assert.throws(() => parseLaneArgs(["--out", "--lane"]), /--out/);
    assert.throws(() => parseLaneArgs(["--lane"]), /--lane/);
  });

  it("builds a deterministic payload fixture with a stable hash", () => {
    const first = fixturePayload(1024 * 1024);
    const second = fixturePayload(1024 * 1024);
    assert.equal(first.length, 1024 * 1024);
    assert.equal(first, second);
    assert.equal(
      createHash("sha256").update(first).digest("hex"),
      createHash("sha256").update(second).digest("hex"),
    );
  });

  it("formats a content-free lane result line", () => {
    const formatted = formatLaneResult({
      lane: buildLanes("default")[0]!,
      node_version: "v22.0.0",
      fixture_sha256: "a".repeat(64),
      iterations: 30,
      rss_baseline_bytes: 100,
      rss_peak_bytes: 300,
      rss_delta_bytes: 200,
      amplification_denominator_bytes: 1024 * 1024,
      amplification_ratio: 200 / (1024 * 1024),
      event_loop_delay_p50_ms: 0.5,
      event_loop_delay_p95_ms: 2.5,
      latency_p50_ms: 1.25,
      latency_p95_ms: 9.75,
      completed: 30,
      rejected: 0,
      output_sha256: "b".repeat(64),
    });
    assert.match(formatted, /^lane=default-1mib-c1-plain /);
    assert.match(formatted, /rss_delta=200 /);
    assert.match(formatted, /amplification_denominator_bytes=1048576 /);
    assert.match(formatted, /amplification_ratio=0\.000 /);
    assert.match(formatted, /completed=30 rejected=0/);
    assert.equal(formatted.includes("cob-memory-fixture"), false);
  });

  it("sends the stream, tool, and continuation lane in-process and proves cleanup", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "cob-mem-test-"));
    const result = await runLane(
      { name: "test-tiny-modes", concurrency: 2, payloadBytes: 4096, iterations: 3, stream: true, toolSchema: true, continuation: true },
      { tmpRoot },
    );
    assert.equal(result.completed, 6);
    assert.equal(result.rejected, 0);
    assert.equal(result.iterations, 3);
    assert.match(result.output_sha256, /^[0-9a-f]{64}$/);
    assert.match(result.fixture_sha256, /^[0-9a-f]{64}$/);
    assert.ok(result.rss_peak_bytes >= result.rss_baseline_bytes);
    assert.equal(result.amplification_denominator_bytes, 4096 * 2);
    assert.ok(result.amplification_ratio >= 0);
    assert.ok(result.event_loop_delay_p50_ms >= 0);
    assert.ok(result.event_loop_delay_p95_ms >= 0);
  });

  it("runs the smallest safe lane in-process with a fake upstream and proves cleanup", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "cob-mem-test-"));
    const result = await runLane(
      { name: "test-tiny", concurrency: 2, payloadBytes: 4096, iterations: 3, stream: false, toolSchema: false, continuation: false },
      { tmpRoot },
    );
    assert.equal(result.completed, 6);
    assert.equal(result.rejected, 0);
    assert.equal(result.iterations, 3);
    assert.match(result.output_sha256, /^[0-9a-f]{64}$/);
    assert.match(result.fixture_sha256, /^[0-9a-f]{64}$/);
    assert.ok(result.rss_peak_bytes >= result.rss_baseline_bytes);
  });

  it("yields the same output hash for two identical runs of the same fixture", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "cob-mem-det-"));
    const config = { name: "test-deterministic", concurrency: 3, payloadBytes: 4096, iterations: 3, stream: true, toolSchema: true, continuation: true } as const;
    const first = await runLane(config, { tmpRoot });
    const second = await runLane(config, { tmpRoot });
    assert.equal(first.completed, second.completed);
    assert.equal(first.rejected, second.rejected);
    assert.equal(first.output_sha256, second.output_sha256);
  });

  it("proves temp-home cleanup when the gateway listener fails to open", async () => {
    const { createServer } = await import("node:http");
    const occupier = createServer((_req, res) => res.end());
    await new Promise<void>((resolve) => occupier.listen(0, "127.0.0.1", resolve));
    const occupiedPort = (occupier.address() as import("node:net").AddressInfo).port;
    const tmpRoot = mkdtempSync(join(tmpdir(), "cob-mem-fail-"));
    try {
      await assert.rejects(
        () =>
          runLane(
            { name: "test-setup-fail", concurrency: 1, payloadBytes: 1024, iterations: 1, stream: false, toolSchema: false, continuation: false },
            { tmpRoot, port: occupiedPort },
          ),
        /EADDRINUSE/,
      );
      // The guard finalized despite the setup failure: no temp home remains.
      assert.deepEqual(readdirSync(tmpRoot).filter((name) => name.startsWith("cob-mem-state-")), []);
    } finally {
      await new Promise<void>((resolve) => occupier.close(() => resolve()));
    }
  });

  it("proves temp-home cleanup when port allocation fails before the listener starts", async () => {
    const { EventEmitter } = await import("node:events");
    // A loopback server whose listen fails asynchronously with EPERM: the
    // harness's port allocation fails before any listener exists, and the
    // guard's cleanup proof must still run so no guard-owned temp home leaks.
    // The exclusive run-ID lock intentionally remains as a tombstone so
    // duplicate run IDs stay rejected.
    const failing = new EventEmitter() as unknown as import("./eval-run-guard.js").EvalLoopbackServer;
    const failingAny = failing as unknown as {
      listen: (...args: unknown[]) => void;
      close: (cb?: (error?: Error) => void) => void;
    };
    failingAny.listen = () => {
      setImmediate(() =>
        failing.emit("error", Object.assign(new Error("SIMULATED_ALLOCATE_EPERM"), { code: "EPERM" })),
      );
    };
    failingAny.close = (cb) => cb?.();
    const tmpRoot = mkdtempSync(join(tmpdir(), "cob-mem-alloc-fail-"));
    await assert.rejects(
      () =>
        runLane(
          { name: "test-alloc-fail", concurrency: 1, payloadBytes: 1024, iterations: 1, stream: false, toolSchema: false, continuation: false },
          { tmpRoot, serverFactory: () => failing },
        ),
      /SIMULATED_ALLOCATE_EPERM/,
    );
    // The guard finalized despite the allocation failure: no temp home remains.
    assert.deepEqual(readdirSync(tmpRoot).filter((name) => name.startsWith("cob-mem-state-")), []);
  });
});
