import { createHash } from "node:crypto";
import type { JsonObject } from "./types.js";
import { isRecord } from "./types.js";

const MAX_NAMED_TOOLS = 24;
const SHA_HEX_LEN = 8;
const TOOL_NAME_RE = /[^A-Za-z0-9_.:@/-]+/g;

export type NamedByteCount = {
  name: string;
  bytes: number;
};

export type RequestMetrics = {
  decodedBytes: number;
  instructionsBytes: number;
  toolsBytes: number;
  inputBytes: number;
  textBytes: number;
  reasoningBytes: number;
  metadataBytes: number;
  toolsCount: number;
  inputCount: number;
  previousResponseId: boolean;
  reasoningEffort: string;
  toolsSha: string;
  instructionsSha: string;
  inputByType: Record<string, number>;
  toolBytesByName: NamedByteCount[];
};

export type OllamaUsageMetrics = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  promptEvalCount?: number;
  promptEvalDurationMs?: number;
  evalDurationMs?: number;
};

export function jsonUtf8Bytes(value: unknown): number {
  if (value === undefined) return 0;
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function sha256Hex8(value: unknown): string {
  if (value === undefined) return "-";
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex").slice(0, SHA_HEX_LEN);
}

export function summarizeRequest(payload: JsonObject, decodedBytes: number): RequestMetrics {
  const tools = payload.tools;
  const input = payload.input;
  return {
    decodedBytes,
    instructionsBytes: jsonUtf8Bytes(payload.instructions),
    toolsBytes: jsonUtf8Bytes(tools),
    inputBytes: jsonUtf8Bytes(input),
    textBytes: jsonUtf8Bytes(payload.text),
    reasoningBytes: jsonUtf8Bytes(payload.reasoning),
    metadataBytes: jsonUtf8Bytes(payload.metadata),
    toolsCount: countTools(tools),
    inputCount: Array.isArray(input) ? input.length : input === undefined ? 0 : 1,
    previousResponseId: typeof payload.previous_response_id === "string" && payload.previous_response_id.trim().length > 0,
    reasoningEffort: readReasoningEffort(payload),
    toolsSha: sha256Hex8(tools),
    instructionsSha: sha256Hex8(payload.instructions),
    inputByType: countInputByType(input),
    toolBytesByName: toolBytesByName(tools),
  };
}

export function formatRequestMetrics(metrics: RequestMetrics): string {
  const parts = [
    `decoded_bytes=${metrics.decodedBytes}`,
    `b_instr=${metrics.instructionsBytes}`,
    `b_tools=${metrics.toolsBytes}`,
    `b_input=${metrics.inputBytes}`,
    `b_text=${metrics.textBytes}`,
    `b_reason=${metrics.reasoningBytes}`,
    `b_meta=${metrics.metadataBytes}`,
    `tools_n=${metrics.toolsCount}`,
    `input_n=${metrics.inputCount}`,
    `prev_id=${metrics.previousResponseId ? 1 : 0}`,
    `effort=${sanitizeToken(metrics.reasoningEffort)}`,
    `tools_sha=${metrics.toolsSha}`,
    `instr_sha=${metrics.instructionsSha}`,
    `input_by=${formatCounts(metrics.inputByType)}`,
    `tool_bytes=${formatNamedBytes(metrics.toolBytesByName)}`,
  ];
  return parts.join(" ");
}

export type OllamaWireMetrics = {
  wireBytes: number;
  toolsCount: number;
  toolsBytes: number;
  toolsSha: string;
  toolBytesByName: NamedByteCount[];
  promotedN: number;
  promotedBytes: number;
  skippedCap: number;
  skippedInvalid: number;
  skippedUnsupported: number;
  collisions: number;
};

export function formatOllamaWireMetrics(metrics: OllamaWireMetrics): string {
  return [
    `wire_bytes=${metrics.wireBytes}`,
    `tools_n=${metrics.toolsCount}`,
    `b_tools=${metrics.toolsBytes}`,
    `tools_sha=${metrics.toolsSha}`,
    `tool_bytes=${formatNamedBytes(metrics.toolBytesByName)}`,
    `promoted_n=${metrics.promotedN}`,
    `promoted_bytes=${metrics.promotedBytes}`,
    `promotion_skipped_cap=${metrics.skippedCap}`,
    `promotion_skipped_invalid=${metrics.skippedInvalid}`,
    `promotion_skipped_unsupported=${metrics.skippedUnsupported}`,
    `promotion_collisions=${metrics.collisions}`,
  ].join(" ");
}

export function extractOllamaUsage(envelope: unknown): OllamaUsageMetrics | undefined {
  if (!isRecord(envelope)) return undefined;
  const usage = isRecord(envelope.usage) ? envelope.usage : undefined;
  const details = usage && isRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  const metrics: OllamaUsageMetrics = {
    inputTokens: readFiniteNumber(usage?.input_tokens) ?? readFiniteNumber(usage?.prompt_tokens),
    outputTokens: readFiniteNumber(usage?.output_tokens) ?? readFiniteNumber(usage?.completion_tokens),
    cachedInputTokens:
      readFiniteNumber(usage?.cached_input_tokens) ??
      readFiniteNumber(details?.cached_tokens) ??
      readFiniteNumber(usage?.prompt_cache_hit_tokens),
    totalTokens: readFiniteNumber(usage?.total_tokens),
    promptEvalCount: readFiniteNumber(envelope.prompt_eval_count) ?? readFiniteNumber(usage?.prompt_eval_count),
    promptEvalDurationMs: durationToMs(
      envelope.prompt_eval_duration ?? usage?.prompt_eval_duration,
    ),
    evalDurationMs: durationToMs(envelope.eval_duration ?? usage?.eval_duration),
  };
  if (
    metrics.inputTokens === undefined &&
    metrics.outputTokens === undefined &&
    metrics.promptEvalDurationMs === undefined &&
    metrics.evalDurationMs === undefined
  ) {
    return undefined;
  }
  return metrics;
}

export function formatOllamaUsage(metrics: OllamaUsageMetrics): string {
  return [
    `in=${fmtNum(metrics.inputTokens)}`,
    `out=${fmtNum(metrics.outputTokens)}`,
    `cache=${fmtNum(metrics.cachedInputTokens)}`,
    `total=${fmtNum(metrics.totalTokens)}`,
    `prompt_eval_n=${fmtNum(metrics.promptEvalCount)}`,
    `prompt_eval_ms=${fmtNum(metrics.promptEvalDurationMs)}`,
    `eval_ms=${fmtNum(metrics.evalDurationMs)}`,
  ].join(" ");
}

function countTools(tools: unknown): number {
  return flattenTools(tools).length;
}

function toolBytesByName(tools: unknown): NamedByteCount[] {
  const counts = new Map<string, number>();
  for (const tool of flattenTools(tools)) {
    const name = sanitizeToken(toolName(tool));
    counts.set(name, (counts.get(name) ?? 0) + jsonUtf8Bytes(tool));
  }
  return [...counts.entries()]
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
    .slice(0, MAX_NAMED_TOOLS);
}

function flattenTools(tools: unknown): unknown[] {
  if (!Array.isArray(tools)) return [];
  const flat: unknown[] = [];
  for (const tool of tools) {
    if (isRecord(tool) && tool.type === "namespace" && Array.isArray(tool.tools)) {
      for (const child of tool.tools) flat.push(child);
      continue;
    }
    flat.push(tool);
  }
  return flat;
}

function toolName(tool: unknown): string {
  if (!isRecord(tool)) return "unknown";
  if (typeof tool.name === "string" && tool.name.trim().length > 0) return tool.name;
  if (isRecord(tool.function) && typeof tool.function.name === "string" && tool.function.name.trim().length > 0) {
    return tool.function.name;
  }
  if (typeof tool.type === "string" && tool.type.trim().length > 0) return tool.type;
  return "unknown";
}

function countInputByType(input: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  const items = Array.isArray(input) ? input : input === undefined ? [] : [input];
  for (const item of items) {
    const key = inputTypeKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function inputTypeKey(item: unknown): string {
  if (typeof item === "string") return "string";
  if (!isRecord(item)) return "other";
  if (typeof item.type === "string" && item.type.trim().length > 0) {
    if (item.type === "message" && typeof item.role === "string" && item.role.trim().length > 0) {
      return `message:${sanitizeToken(item.role)}`;
    }
    return sanitizeToken(item.type);
  }
  if (typeof item.role === "string" && item.role.trim().length > 0) {
    return `message:${sanitizeToken(item.role)}`;
  }
  return "other";
}

function readReasoningEffort(payload: JsonObject): string {
  if (isRecord(payload.reasoning) && typeof payload.reasoning.effort === "string") {
    return payload.reasoning.effort;
  }
  if (typeof payload.reasoning_effort === "string") return payload.reasoning_effort;
  return "-";
}

function formatCounts(counts: Record<string, number>): string {
  const keys = Object.keys(counts).sort();
  if (keys.length === 0) return "-";
  return keys.map((key) => `${key}:${counts[key]}`).join(",");
}

function formatNamedBytes(entries: NamedByteCount[]): string {
  if (entries.length === 0) return "-";
  return entries.map((entry) => `${entry.name}:${entry.bytes}`).join(",");
}

function sanitizeToken(value: string): string {
  const cleaned = value.replace(TOOL_NAME_RE, "_").slice(0, 80);
  return cleaned.length > 0 ? cleaned : "unknown";
}

function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

/** Ollama native durations are nanoseconds; values under 1e6 are treated as milliseconds. */
function durationToMs(value: unknown): number | undefined {
  const raw = readFiniteNumber(value);
  if (raw === undefined) return undefined;
  if (raw >= 1_000_000) return Math.round(raw / 1_000_000);
  return Math.round(raw);
}

function fmtNum(value: number | undefined): string {
  return value === undefined ? "-" : String(value);
}
