import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadCatalogFile, resetCatalogFileCache } from "./codex/catalog.js";
import { formatRequestMetrics, summarizeRequest } from "./codex/request-metrics.js";
import { rewriteSseLine } from "./codex/sse.js";

const WARMUP = 30;
const MEASURED = 100;

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

function timeMs(fn: () => void): number {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

describe("WP5 hot-path fixtures (methodology, not a live G15 claim)", () => {
  it("measures catalog cache hits with identical parsed identity", () => {
    resetCatalogFileCache();
    const dir = mkdtempSync(join(tmpdir(), "cob-wp5-catalog-"));
    const path = join(dir, "cob-catalog.json");
    writeFileSync(
      path,
      `${JSON.stringify({ models: Array.from({ length: 40 }, (_, i) => ({ slug: `m${i}` })) })}\n`,
    );
    const first = loadCatalogFile(path);
    for (let i = 0; i < WARMUP; i += 1) loadCatalogFile(path);
    const samples: number[] = [];
    let hits = 0;
    for (let i = 0; i < MEASURED; i += 1) {
      samples.push(
        timeMs(() => {
          if (loadCatalogFile(path) === first) hits += 1;
        }),
      );
    }
    assert.equal(hits, MEASURED);
    assert.ok(median(samples) >= 0);
    assert.ok(p95(samples) >= median(samples));
    resetCatalogFileCache();
  });

  it("keeps large-tool metrics hashes stable across measured iterations", () => {
    const tools = Array.from({ length: 80 }, (_, index) => ({
      type: "function",
      name: `tool_${index}`,
      description: "schema-secret-must-not-appear",
      parameters: { type: "object", properties: { q: { type: "string" } } },
    }));
    const payload = {
      model: "ollama/deepseek-v4-flash:0731-cloud",
      instructions: "short cob instructions",
      tools,
      input: [{ type: "message", role: "user", content: "hey" }],
    };
    const line = formatRequestMetrics(summarizeRequest(payload, 50_000));
    const expected = createHash("sha256").update(line).digest("hex");
    for (let i = 0; i < WARMUP; i += 1) summarizeRequest(payload, 50_000);
    for (let i = 0; i < MEASURED; i += 1) {
      const next = formatRequestMetrics(summarizeRequest(payload, 50_000));
      assert.equal(createHash("sha256").update(next).digest("hex"), expected);
      assert.equal(next.includes("schema-secret-must-not-appear"), false);
    }
  });

  it("records SSE identity fast-path hits without changing bytes", () => {
    const line = 'data: {"id":"evt_1","delta":"hi"}';
    let hits = 0;
    const rewrite = (value: unknown) => value;
    for (let i = 0; i < WARMUP; i += 1) rewriteSseLine(line, rewrite);
    for (let i = 0; i < MEASURED; i += 1) {
      const out = rewriteSseLine(line, rewrite);
      if (out === line) hits += 1;
    }
    assert.equal(hits, MEASURED);
  });
});
