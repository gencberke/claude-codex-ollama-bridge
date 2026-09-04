import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { formatDiagnosticReport, readDiagnosticReport } from "./codex/runtime/diagnostics.js";

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

describe("diagnostic sidecar reader", () => {
  it("pairs backup and active events by process run and summarizes failure identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-diagnostics-reader-"));
    const path = join(dir, "cob-diagnostics.jsonl");
    const first = { pid: 7, run_sha8: "aaaaaaaa", request_seq: 1, request_fp8: "11111111" };
    const second = { pid: 7, run_sha8: "bbbbbbbb", request_seq: 1, request_fp8: "11111111" };
    writeFileSync(
      `${path}.1`,
      line({ schema_version: 1, kind: "request_start", ...first, timestamp: "2026-09-04T00:00:00Z", route: "ollama" }) +
        line({ schema_version: 1, kind: "request_end", ...first, timestamp: "2026-09-04T00:00:01Z", route: "ollama", status: 200, total_latency_ms: 1, terminal: "completed", provider_attempts: 1, gateway_retry_count: 0 }),
      { mode: 0o600 },
    );
    writeFileSync(
      path,
      line({ schema_version: 1, kind: "request_start", ...second, timestamp: "2026-09-04T00:00:02Z", route: "ollama" }) +
        line({ schema_version: 1, kind: "request_end", ...second, timestamp: "2026-09-04T00:00:03Z", route: "ollama", status: 200, total_latency_ms: 1, terminal: "non_success", error_code: "ollama_response_incomplete", non_success_kind: "incomplete", provider_attempts: 1, gateway_retry_count: 0 }),
      { mode: 0o600 },
    );

    const report = readDiagnosticReport(path);
    assert.equal(report.clean, true);
    assert.equal(report.runs, 2);
    assert.deepEqual(report.requests, {
      starts: 2,
      ends: 2,
      matched: 2,
      unmatched_starts: 0,
      unmatched_ends: 0,
      duplicate_starts: 0,
      duplicate_ends: 0,
      missing_terminal: 0,
    });
    assert.equal(report.terminals.completed, 1);
    assert.equal(report.terminals.non_success, 1);
    assert.equal(report.error_codes.ollama_response_incomplete, 1);
    assert.equal(report.non_success_kinds.incomplete, 1);
    assert.match(formatDiagnosticReport(report), /^diagnostics: ok/m);
  });

  it("refuses a symlinked sidecar without reading its contents", () => {
    const dir = mkdtempSync(join(tmpdir(), "cob-diagnostics-symlink-"));
    const target = join(dir, "target");
    const path = join(dir, "cob-diagnostics.jsonl");
    writeFileSync(target, "private provider text", { mode: 0o600 });
    symlinkSync(target, path);

    const report = readDiagnosticReport(path);
    assert.equal(report.available, false);
    assert.equal(report.clean, false);
    assert.equal(report.files.active.state, "unreadable");
    assert.equal(JSON.stringify(report).includes("private provider text"), false);
  });
});
