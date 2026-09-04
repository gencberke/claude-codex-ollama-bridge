import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import { isRecord } from "../../core/json.js";
import {
  GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
  GATEWAY_NON_SUCCESS_KINDS,
  GATEWAY_REQUEST_ROUTES,
  GATEWAY_REQUEST_TERMINALS,
  isDiagnosticErrorCode,
  type GatewayNonSuccessKind,
  type GatewayRequestRoute,
  type GatewayRequestTerminal,
} from "../diagnostic-event.js";
import { DIAGNOSTIC_LOG_MAX_BYTES } from "./diagnostic-log.js";

const DIAGNOSTIC_EVENT_KINDS = new Set([
  "compact_failure",
  "compact_start",
  "compact_success",
  "gate5_observation",
  "guard_rejection",
  "ollama_invalid_json",
  "request_end",
  "request_route",
  "request_start",
  "upstream_terminal",
]);
const SHA8 = /^[a-f0-9]{8}$/;

export type DiagnosticFileReport = {
  state: "missing" | "ok" | "unsafe" | "oversized" | "unreadable";
  bytes: number;
  complete_lines: number;
  partial_lines: number;
};

export type DiagnosticReadReport = {
  schema_version: 1;
  available: boolean;
  clean: boolean;
  files: {
    backup: DiagnosticFileReport;
    active: DiagnosticFileReport;
  };
  events: {
    valid: number;
    malformed: number;
    unsupported_schema: number;
    unsupported_kind: number;
  };
  runs: number;
  requests: {
    starts: number;
    ends: number;
    matched: number;
    unmatched_starts: number;
    unmatched_ends: number;
    duplicate_starts: number;
    duplicate_ends: number;
    missing_terminal: number;
  };
  routes: Record<GatewayRequestRoute, number>;
  terminals: Record<GatewayRequestTerminal, number>;
  error_codes: Record<string, number>;
  non_success_kinds: Record<GatewayNonSuccessKind, number>;
};

/**
 * Read the bounded backup before the active sidecar and summarize only
 * structural, content-free fields. Files are opened read-only without
 * following symlinks; the command never repairs or rotates diagnostics.
 */
export function readDiagnosticReport(path: string): DiagnosticReadReport {
  const routes = zeroRecord(GATEWAY_REQUEST_ROUTES);
  const terminals = zeroRecord(GATEWAY_REQUEST_TERMINALS);
  const nonSuccessKinds = zeroRecord(GATEWAY_NON_SUCCESS_KINDS);
  const errorCodes: Record<string, number> = {};
  const startKeys = new Set<string>();
  const endKeys = new Set<string>();
  const runs = new Set<string>();
  let starts = 0;
  let ends = 0;
  let duplicateStarts = 0;
  let duplicateEnds = 0;
  let missingTerminal = 0;
  let valid = 0;
  let malformed = 0;
  let unsupportedSchema = 0;
  let unsupportedKind = 0;

  const consume = (line: string): void => {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      malformed += 1;
      return;
    }
    if (!isRecord(event)) {
      malformed += 1;
      return;
    }
    if (event.schema_version !== GATEWAY_DIAGNOSTIC_SCHEMA_VERSION) {
      unsupportedSchema += 1;
      return;
    }
    if (typeof event.kind !== "string" || !DIAGNOSTIC_EVENT_KINDS.has(event.kind)) {
      unsupportedKind += 1;
      return;
    }
    valid += 1;
    if (event.kind !== "request_start" && event.kind !== "request_end") return;
    const key = requestKey(event);
    if (!key) {
      malformed += 1;
      valid -= 1;
      return;
    }
    const run = runKey(event);
    if (run) runs.add(run);
    if (event.kind === "request_start") {
      starts += 1;
      if (startKeys.has(key)) duplicateStarts += 1;
      startKeys.add(key);
      return;
    }
    ends += 1;
    if (endKeys.has(key)) duplicateEnds += 1;
    endKeys.add(key);
    if (isOneOf(event.route, GATEWAY_REQUEST_ROUTES)) routes[event.route] += 1;
    if (isOneOf(event.terminal, GATEWAY_REQUEST_TERMINALS)) {
      terminals[event.terminal] += 1;
    } else {
      missingTerminal += 1;
    }
    if (isDiagnosticErrorCode(event.error_code)) increment(errorCodes, event.error_code);
    if (isOneOf(event.non_success_kind, GATEWAY_NON_SUCCESS_KINDS)) {
      nonSuccessKinds[event.non_success_kind] += 1;
    }
  };

  const backup = readDiagnosticFile(`${path}.1`, consume);
  const active = readDiagnosticFile(path, consume);
  let matched = 0;
  for (const key of startKeys) if (endKeys.has(key)) matched += 1;
  const available = backup.state === "ok" || active.state === "ok";
  const filesClean = [backup, active].every(
    (file) => (file.state === "ok" || file.state === "missing") && file.partial_lines === 0,
  );
  return {
    schema_version: 1,
    available,
    clean: available && filesClean && malformed === 0 && unsupportedSchema === 0 && unsupportedKind === 0,
    files: { backup, active },
    events: { valid, malformed, unsupported_schema: unsupportedSchema, unsupported_kind: unsupportedKind },
    runs: runs.size,
    requests: {
      starts,
      ends,
      matched,
      unmatched_starts: Math.max(0, startKeys.size - matched),
      unmatched_ends: Math.max(0, endKeys.size - matched),
      duplicate_starts: duplicateStarts,
      duplicate_ends: duplicateEnds,
      missing_terminal: missingTerminal,
    },
    routes,
    terminals,
    error_codes: Object.fromEntries(Object.entries(errorCodes).sort(([a], [b]) => a.localeCompare(b))),
    non_success_kinds: nonSuccessKinds,
  };
}

export function formatDiagnosticReport(report: DiagnosticReadReport): string {
  const state = !report.available ? "absent" : report.clean ? "ok" : "degraded";
  return [
    `diagnostics: ${state}`,
    `files: backup=${report.files.backup.state} active=${report.files.active.state} bytes=${report.files.backup.bytes + report.files.active.bytes} partial=${report.files.backup.partial_lines + report.files.active.partial_lines}`,
    `events: valid=${report.events.valid} malformed=${report.events.malformed} unsupported_schema=${report.events.unsupported_schema} unsupported_kind=${report.events.unsupported_kind} runs=${report.runs}`,
    `requests: starts=${report.requests.starts} ends=${report.requests.ends} matched=${report.requests.matched} unmatched_starts=${report.requests.unmatched_starts} unmatched_ends=${report.requests.unmatched_ends} duplicate_starts=${report.requests.duplicate_starts} duplicate_ends=${report.requests.duplicate_ends} missing_terminal=${report.requests.missing_terminal}`,
    `routes: ${formatCounts(report.routes)}`,
    `terminals: ${formatCounts(report.terminals)}`,
    `error_codes: ${formatCounts(report.error_codes)}`,
    `non_success_kinds: ${formatCounts(report.non_success_kinds)}`,
  ].join("\n");
}

function readDiagnosticFile(path: string, consume: (line: string) => void): DiagnosticFileReport {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
      return { state: "unsafe", bytes: 0, complete_lines: 0, partial_lines: 0 };
    }
    if (stat.size > DIAGNOSTIC_LOG_MAX_BYTES) {
      return { state: "oversized", bytes: 0, complete_lines: 0, partial_lines: 0 };
    }
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    const text = buffer.subarray(0, offset).toString("utf8");
    const parts = text.split("\n");
    const hasPartial = parts.at(-1)?.length !== 0;
    parts.pop();
    const complete = parts.filter((line) => line.length > 0);
    for (const line of complete) consume(line);
    return {
      state: "ok",
      bytes: offset,
      complete_lines: complete.length,
      partial_lines: hasPartial ? 1 : 0,
    };
  } catch (error) {
    return {
      state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable",
      bytes: 0,
      complete_lines: 0,
      partial_lines: 0,
    };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // A read-only diagnostics command must not turn a close failure into
        // an application failure after it already produced a bounded report.
      }
    }
  }
}

function requestKey(event: Record<string, unknown>): string | undefined {
  if (!Number.isSafeInteger(event.pid) || !Number.isSafeInteger(event.request_seq) || !SHA8.test(String(event.request_fp8))) {
    return undefined;
  }
  return `${runKey(event) ?? `legacy:${event.pid}`}:${event.pid}:${event.request_seq}:${event.request_fp8}`;
}

function runKey(event: Record<string, unknown>): string | undefined {
  return typeof event.run_sha8 === "string" && SHA8.test(event.run_sha8)
    ? event.run_sha8
    : Number.isSafeInteger(event.pid)
      ? `legacy:${event.pid}`
      : undefined;
}

function zeroRecord<const T extends readonly string[]>(keys: T): Record<T[number], number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T[number], number>;
}

function isOneOf<const T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function formatCounts(record: Record<string, number>): string {
  const populated = Object.entries(record).filter(([, count]) => count > 0);
  return populated.length === 0 ? "none" : populated.map(([key, count]) => `${key}=${count}`).join(" ");
}
