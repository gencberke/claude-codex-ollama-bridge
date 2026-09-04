/**
 * Content-free G26 sidecar evaluator (pack-excluded).
 *
 * Aggregates one explicit time window and Ollama model from bounded gateway
 * diagnostics. One active and one rotated sidecar may be supplied. The
 * receipt never carries the raw model, request fingerprint,
 * prompt, output, tool name, task id, or child id. Controller/no-progress and
 * agent-local counters remain separate upstream evidence; this evaluator does
 * not infer them or make a Gold decision.
 *
 * Usage:
 *   node dist/eval-g26.js --input <jsonl> [--input <rotated-jsonl>]
 *     --lane A|B --from <iso> --to <iso> --model <slug>
 *     --expected-hosted-drop <n> --out <receipt.json>
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { modelSha8 } from "./codex/diagnostic-event.js";
import { isRecord } from "./core/json.js";

export const G26_SIDECAR_RECEIPT_SCHEMA_VERSION = 1;
const MAX_DIAGNOSTIC_BYTES = 8 * 1024 * 1024 + 32 * 1024;
const MAX_DIAGNOSTIC_LINE_BYTES = 16 * 1024;

type Count<T extends string | number | boolean> = { value: T; count: number };

type RequestBase = {
  timestamp: string;
  pid: number;
  run_sha8?: string;
  request_seq: number;
  request_fp8: string;
  route: string;
  model_sha8?: string;
};

type RequestStart = RequestBase & { kind: "request_start" };

type RequestEnd = RequestBase & {
  kind: "request_end";
  status: number;
  upstream_status?: number;
  terminal?: string;
  total_latency_ms: number;
  provider_attempts: number;
  gateway_retry_count: number;
  outbound_stream?: boolean;
  response_content_type_class?: string;
  decoder_mode?: string;
  hosted_tools_dropped_n?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
};

export type G26SidecarOptions = {
  lane: "A" | "B";
  from: string;
  to: string;
  model: string;
  expectedHostedDrop: number;
};

export type G26SidecarReceipt = {
  schema_version: typeof G26_SIDECAR_RECEIPT_SCHEMA_VERSION;
  measurement: "g26_sidecar";
  lane: "G26-A" | "G26-B";
  window: { from: string; to: string };
  model_sha8: string;
  parse: { invalid_line_count: number };
  requests: { starts: number; ends: number; starts_without_end: number; ends_without_start: number };
  outcomes: {
    statuses: Count<number>[];
    upstream_statuses: Count<number>[];
    terminals: Count<string>[];
    invalid_json_count: number;
  };
  transport: {
    provider_attempts_total: number;
    provider_attempts_max: number;
    provider_retry_excess: number;
    gateway_retry_total: number;
    gateway_retry_max: number;
  };
  wire: {
    decoder_tuples: Array<{
      outbound_stream: boolean | "missing";
      response_content_type_class: string;
      decoder_mode: string;
      count: number;
    }>;
    hosted_drop_counts: Count<number>[];
  };
  duplicates: { fingerprints_repeated: number; repeat_excess: number; max_repeat: number };
  successful_usage: {
    records: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  latency_ms: { total: number; max: number };
  observable_transport_pass: boolean;
  reason_codes: string[];
  decision_note: string;
};

export function parseG26Jsonl(text: string): { events: unknown[]; invalidLineCount: number } {
  const events: unknown[] = [];
  let invalidLineCount = 0;
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    if (Buffer.byteLength(line, "utf8") > MAX_DIAGNOSTIC_LINE_BYTES) {
      invalidLineCount += 1;
      continue;
    }
    try {
      events.push(JSON.parse(line) as unknown);
    } catch {
      invalidLineCount += 1;
    }
  }
  return { events, invalidLineCount };
}

export function evaluateG26Sidecar(
  events: unknown[],
  options: G26SidecarOptions,
  invalidLineCount = 0,
): G26SidecarReceipt {
  const fromMs = parseWindowBoundary(options.from, "from");
  const toMs = parseWindowBoundary(options.to, "to");
  if (fromMs > toMs) throw new Error("G26 window start must not be after its end");
  if (!Number.isSafeInteger(options.expectedHostedDrop) || options.expectedHostedDrop < 0) {
    throw new Error("expected hosted drop must be a non-negative integer");
  }
  const expectedModelSha8 = modelSha8(options.model);
  const starts = events
    .filter(isRequestStart)
    .filter((event) => inWindow(event.timestamp, fromMs, toMs))
    .filter((event) => event.route === "ollama" && event.model_sha8 === expectedModelSha8);
  const ends = events
    .filter(isRequestEnd)
    .filter((event) => inWindow(event.timestamp, fromMs, toMs))
    .filter((event) => event.route === "ollama" && event.model_sha8 === expectedModelSha8);

  const startKeys = new Set(starts.map(requestKey));
  const endKeys = new Set(ends.map(requestKey));
  const startsWithoutEnd = [...startKeys].filter((key) => !endKeys.has(key)).length;
  const endsWithoutStart = [...endKeys].filter((key) => !startKeys.has(key)).length;
  const fingerprintCounts = countStrings(starts.map((event) => `${event.run_sha8 ?? event.pid}:${event.request_fp8}`));
  const repeated = [...fingerprintCounts.values()].filter((count) => count > 1);
  const providerAttempts = ends.map((event) => event.provider_attempts);
  const gatewayRetries = ends.map((event) => event.gateway_retry_count);
  const successful = ends.filter((event) => event.status === 200);
  const usageRecords = successful.filter((event) => event.usage !== undefined);
  const invalidJsonCount = ends.filter((event) => event.terminal === "invalid_json").length;
  const decoderTuples = tupleCounts(ends);
  const hostedDropCounts = numericCounts(
    ends.flatMap((event) => event.hosted_tools_dropped_n === undefined ? [] : [event.hosted_tools_dropped_n]),
  );

  const reasonCodes = new Set<string>();
  if (invalidLineCount > 0) reasonCodes.add("malformed_jsonl");
  if (ends.length === 0) reasonCodes.add("no_ollama_requests");
  if (startsWithoutEnd > 0 || endsWithoutStart > 0 || starts.length !== ends.length) {
    reasonCodes.add("unmatched_request_pair");
  }
  if (ends.some((event) => event.status !== 200 || event.upstream_status !== 200)) {
    reasonCodes.add("non_200_outcome");
  }
  if (ends.some((event) => event.terminal !== "completed")) reasonCodes.add("terminal_failure");
  if (invalidJsonCount > 0) reasonCodes.add("invalid_json");
  if (providerAttempts.some((attempts) => attempts !== 1)) reasonCodes.add("provider_retry_or_missing_attempt");
  if (gatewayRetries.some((retries) => retries !== 0)) reasonCodes.add("gateway_retry");
  if (repeated.length > 0) reasonCodes.add("duplicate_fingerprint");
  if (ends.some((event) => !validDecoderTuple(event))) reasonCodes.add("decoder_mismatch");
  if (ends.some((event) => event.hosted_tools_dropped_n !== options.expectedHostedDrop)) {
    reasonCodes.add("hosted_drop_mismatch");
  }
  if (usageRecords.length !== successful.length) reasonCodes.add("successful_usage_missing");

  const reasons = [...reasonCodes].sort();
  return {
    schema_version: G26_SIDECAR_RECEIPT_SCHEMA_VERSION,
    measurement: "g26_sidecar",
    lane: `G26-${options.lane}`,
    window: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    model_sha8: expectedModelSha8,
    parse: { invalid_line_count: invalidLineCount },
    requests: {
      starts: starts.length,
      ends: ends.length,
      starts_without_end: startsWithoutEnd,
      ends_without_start: endsWithoutStart,
    },
    outcomes: {
      statuses: numericCounts(ends.map((event) => event.status)),
      upstream_statuses: numericCounts(ends.flatMap((event) => event.upstream_status === undefined ? [] : [event.upstream_status])),
      terminals: stringCounts(ends.map((event) => event.terminal ?? "missing")),
      invalid_json_count: invalidJsonCount,
    },
    transport: {
      provider_attempts_total: sum(providerAttempts),
      provider_attempts_max: max(providerAttempts),
      provider_retry_excess: sum(providerAttempts.map((attempts) => Math.max(0, attempts - 1))),
      gateway_retry_total: sum(gatewayRetries),
      gateway_retry_max: max(gatewayRetries),
    },
    wire: { decoder_tuples: decoderTuples, hosted_drop_counts: hostedDropCounts },
    duplicates: {
      fingerprints_repeated: repeated.length,
      repeat_excess: sum(repeated.map((count) => count - 1)),
      max_repeat: max([...fingerprintCounts.values()]),
    },
    successful_usage: {
      records: usageRecords.length,
      input_tokens: sum(usageRecords.map((event) => event.usage?.input_tokens ?? 0)),
      output_tokens: sum(usageRecords.map((event) => event.usage?.output_tokens ?? 0)),
      total_tokens: sum(usageRecords.map((event) => event.usage?.total_tokens ?? 0)),
    },
    latency_ms: {
      total: sum(ends.map((event) => event.total_latency_ms)),
      max: max(ends.map((event) => event.total_latency_ms)),
    },
    observable_transport_pass: reasons.length === 0,
    reason_codes: reasons,
    decision_note:
      "Observable sidecar transport evidence only; controller retry/reconnect, no-progress, agent-local retry, continuity, task outcome, and Gold remain external receipt fields.",
  };
}

function isRequestStart(value: unknown): value is RequestStart {
  if (!isRecord(value) || value.kind !== "request_start") return false;
  return requestBaseValid(value);
}

function isRequestEnd(value: unknown): value is RequestEnd {
  if (!isRecord(value) || value.kind !== "request_end" || !requestBaseValid(value)) return false;
  return (
    Number.isSafeInteger(value.status) &&
    Number.isFinite(value.total_latency_ms) &&
    Number.isSafeInteger(value.provider_attempts) &&
    Number.isSafeInteger(value.gateway_retry_count)
  );
}

function requestBaseValid(value: Record<string, unknown>): value is Record<string, unknown> & RequestBase {
  return (
    typeof value.timestamp === "string" &&
    Number.isSafeInteger(value.pid) &&
    (value.run_sha8 === undefined || typeof value.run_sha8 === "string") &&
    Number.isSafeInteger(value.request_seq) &&
    typeof value.request_fp8 === "string" &&
    typeof value.route === "string" &&
    (value.model_sha8 === undefined || typeof value.model_sha8 === "string")
  );
}

function parseWindowBoundary(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid G26 ${name} timestamp`);
  return parsed;
}

function inWindow(timestamp: string, fromMs: number, toMs: number): boolean {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) && parsed >= fromMs && parsed <= toMs;
}

function requestKey(event: RequestBase): string {
  return `${event.run_sha8 ?? event.pid}:${event.pid}:${event.request_seq}:${event.request_fp8}`;
}

function validDecoderTuple(event: RequestEnd): boolean {
  if (event.outbound_stream === true) {
    return event.response_content_type_class === "sse" && event.decoder_mode === "sse_header";
  }
  if (event.outbound_stream === false) {
    return event.response_content_type_class === "json" && event.decoder_mode === "json";
  }
  return false;
}

function tupleCounts(events: RequestEnd[]): G26SidecarReceipt["wire"]["decoder_tuples"] {
  const counts = new Map<string, { tuple: G26SidecarReceipt["wire"]["decoder_tuples"][number]; count: number }>();
  for (const event of events) {
    const outbound = event.outbound_stream ?? "missing";
    const contentType = event.response_content_type_class ?? "missing";
    const decoder = event.decoder_mode ?? "missing";
    const key = `${String(outbound)}\u0000${contentType}\u0000${decoder}`;
    const current = counts.get(key);
    if (current) current.count += 1;
    else counts.set(key, {
      tuple: {
        outbound_stream: outbound,
        response_content_type_class: contentType,
        decoder_mode: decoder,
        count: 0,
      },
      count: 1,
    });
  }
  return [...counts.values()]
    .map(({ tuple, count }) => ({ ...tuple, count }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function countStrings(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function numericCounts(values: number[]): Count<number>[] {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a - b).map(([value, count]) => ({ value, count }));
}

function stringCounts(values: string[]): Count<string>[] {
  const counts = countStrings(values);
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([value, count]) => ({ value, count }));
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function max(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

type CliOptions = G26SidecarOptions & { inputs: string[]; out: string };

export function parseG26Args(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  const inputs: string[] = [];
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("G26 arguments must be --name value pairs");
    }
    if (key === "--input") {
      if (inputs.includes(value)) throw new Error("duplicate G26 input path");
      inputs.push(value);
      continue;
    }
    if (values.has(key)) throw new Error(`duplicate G26 argument: ${key}`);
    values.set(key, value);
  }
  const allowed = new Set(["--input", "--lane", "--from", "--to", "--model", "--expected-hosted-drop", "--out"]);
  for (const key of values.keys()) if (!allowed.has(key)) throw new Error(`unknown G26 argument: ${key}`);
  if (inputs.length === 0) throw new Error("missing G26 argument: --input");
  if (inputs.length > 2) throw new Error("G26 accepts at most one active and one rotated input");
  const lane = required(values, "--lane");
  const from = required(values, "--from");
  const to = required(values, "--to");
  const model = required(values, "--model");
  const out = required(values, "--out");
  const expectedHostedDrop = Number(required(values, "--expected-hosted-drop"));
  if (lane !== "A" && lane !== "B") throw new Error("G26 lane must be A or B");
  return { inputs, lane, from, to, model, expectedHostedDrop, out };
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`missing G26 argument: ${key}`);
  return value;
}

async function main(): Promise<void> {
  const { inputs, out, ...options } = parseG26Args(process.argv.slice(2));
  const bytes = inputs.reduce((total, input) => total + statSync(input).size, 0);
  if (bytes > MAX_DIAGNOSTIC_BYTES) throw new Error("G26 diagnostic inputs exceed the bounded evaluator limit");
  const parsed = inputs.map((input) => parseG26Jsonl(readFileSync(input, "utf8")));
  const receipt = evaluateG26Sidecar(
    parsed.flatMap((input) => input.events),
    options,
    sum(parsed.map((input) => input.invalidLineCount)),
  );
  writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  console.log(
    `G26-${options.lane}: requests=${receipt.requests.ends} observable_transport_pass=${receipt.observable_transport_pass} receipt=${out}`,
  );
  process.exit(receipt.observable_transport_pass ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
