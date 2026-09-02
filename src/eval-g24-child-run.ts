/**
 * G24 isolated real-child canary (authorized isolated run only).
 *
 * Contract: real configured 0731 child driven through the real codex CLI in a
 * guard-owned temp CODEX_HOME against an in-process cob gateway on the
 * isolated port; compact forced by the isolated catalog window
 * (context_window = 8192); the pinned versioned V2 corpus (one canonical
 * corpus hash) is executed as the workdir fixture; the continuation nonce is
 * an independent fixed fixture marker, never summarizer output; evidence is
 * scored by the G9 scorer. Isolated evidence only — never live gold.
 *
 * Cleanup discipline: the run guard owns the exclusive run id, all temp
 * homes, the isolated port, and every spawned child; all setup and the run
 * live inside try/finally so any failure still runs the cleanup proof, and a
 * failed proof fails the harness. Retained receipts are written outside the
 * guard-owned homes so finalize cannot delete them. Evidence and console
 * output are content-free: hashes, byte counts, codes, booleans, and
 * aggregates only — no transcript, prompt/response text or head, auth, path,
 * or session/checkpoint/response ids. Any missing evidence yields FAIL or
 * INCONCLUSIVE, never gold.
 *
 * Usage: node dist/eval-g24-child-run.js
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  G24_CORPUS,
  G24_HANDOFF_SKELETON,
  g24CorpusSha256,
} from "./eval-g24-corpus.js";
import {
  EvalRunGuard,
  liveHomeShaSnapshot,
  resolveLiveCodexHome,
} from "./eval-run-guard.js";
import { finalizeG9, initialG9State, reduceG9, type G9Event, type G9State } from "./eval-g9.js";
import { ollamaWireUnsafeReason } from "./eval-g8r.js";
import { incompleteOllamaCompactHandoffError, OLLAMA_COMPACT_TRANSCRIPT_VERSION } from "./codex/compaction/summary.js";
import { idSha8, type EvalLiveShaSnapshot, type EvalRunIdentity } from "./eval-receipt.js";
import { prepareProfileAndCatalog } from "./codex/runtime/lifecycle.js";
import { listenGateway } from "./codex/gateway/server.js";
import { resolvePaths, type CobPaths } from "./codex/paths.js";
import { isRecord } from "./core/json.js";

const GATEWAY_PORT = 18791;
const BUNDLED_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex";
const MODEL = "ollama/deepseek-v4-flash:0731-cloud";
const OLLAMA_URL = "http://127.0.0.1:11434";
export const G24_ISOLATED_WINDOW = 8192;
const ISOLATED_WINDOW = G24_ISOLATED_WINDOW;
const BASE_LINES = 12; // ~6KB first corpus file
const APPENDIX_LINES = 20; // ~10KB second file pushes later turns over the window
const CODEX_TIMEOUT_MS = 1_500_000;
/**
 * Independent fixed fixture nonce. The prompt requires the child's final
 * reply to end with this exact marker line, so continuation bodies carry it
 * without any dependence on summarizer output.
 */
export const G24_FIXTURE_NONCE = "COB_G24_NONCE_20260831_FIXED_A7F3";

/** Fixed nonce check: never derived from summarizer output. */
export function g24NoncePresent(body: string): boolean {
  return body.includes(G24_FIXTURE_NONCE);
}

function sha256File(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function corpusFile(marker: string, lines: number): string {
  const parts: string[] = [];
  for (let i = 0; i < lines; i += 1) {
    parts.push(
      `${marker} line ${String(i).padStart(4, "0")}: cob isolated G24 corpus text with deterministic padding ${(
        (i * 7919) % 9973
      )
        .toString()
        .padStart(4, "0")}`.padEnd(240, " x"),
    );
  }
  return `${parts.join("\n")}\n`;
}

/**
 * Deterministic workdir files built from the pinned versioned V2 corpus: the
 * pinned conversation fixture is serialized into the first file (executed by
 * the real child), and the remaining filler is deterministic. The run's one
 * canonical corpus hash is the pinned corpus hash; there is no second,
 * file-derived corpus hash.
 */
export function buildRunCorpus(): { fileA: string; fileB: string; canonicalSha256: string } {
  const pinned = `${G24_CORPUS.map((item) => JSON.stringify(item)).join("\n")}\n`;
  const fileA = `${pinned}${corpusFile("g24-corpus-a", BASE_LINES)}`;
  const fileB = `${G24_HANDOFF_SKELETON}\n${corpusFile("g24-corpus-b", APPENDIX_LINES)}`;
  return { fileA, fileB, canonicalSha256: g24CorpusSha256() };
}

async function isPortOpen(port: number): Promise<boolean> {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(3_000, () => {
      socket.destroy();
      resolve(true);
    });
  });
}

function bodyToText(body: unknown): string {
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  return body === undefined || body === null ? "" : String(body);
}

function tryParseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** JSON envelopes in chronological order (plain JSON or Responses SSE). */
function responseObjects(responseBody: string): Record<string, unknown>[] {
  const candidates: Record<string, unknown>[] = [];
  const direct = tryParseJsonObject(responseBody);
  if (direct) candidates.push(direct);
  for (const line of responseBody.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const parsed = tryParseJsonObject(line.slice(5).trim());
    if (parsed) candidates.push(parsed);
  }
  return candidates;
}

/**
 * Response id of a captured gateway response (plain JSON or Responses SSE
 * where the id lives in `response.id` of created/completed events).
 */
function responseIdOf(responseBody: string): string | undefined {
  const candidates = responseObjects(responseBody);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]!;
    const response: unknown = candidate.response;
    const id = typeof candidate.id === "string" ? candidate.id : undefined;
    const nestedId = isRecord(response) && typeof response.id === "string" ? response.id : undefined;
    if (id || nestedId) return id || nestedId;
  }
  return undefined;
}

type CodexExecResult = {
  status: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Set only when this harness explicitly killed the child. */
  terminationOwner?: "harness";
  terminationReason?: CodexTerminationReason;
};

type CodexTerminationReason = "window_floor" | "postcompact_retrigger" | "timeout";

type CodexTerminationController = {
  request: (reason: CodexTerminationReason) => void;
};

/** Async codex runner: the gateway event loop keeps serving codex while it runs. */
function runCodexExec(
  command: string,
  args: string[],
  options: {
    cwd: string;
    input: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    terminationController?: CodexTerminationController;
    /** Registers the child with the run guard so cleanup owns it. */
    register?: (child: ChildProcess) => void;
  },
): Promise<CodexExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env });
    options.register?.(child);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let terminationOwner: "harness" | undefined;
    let terminationReason: CodexTerminationReason | undefined;
    let escalationTimer: NodeJS.Timeout | undefined;
    const requestTermination = (reason: CodexTerminationReason): void => {
      if (settled || terminationReason) return;
      terminationOwner = "harness";
      terminationReason = reason;
      child.kill("SIGTERM");
      escalationTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 1_000);
      escalationTimer.unref();
    };
    if (options.terminationController) options.terminationController.request = requestTermination;
    const timer = setTimeout(() => requestTermination("timeout"), options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on("error", () => undefined);
    child.once("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      reject(new Error(`INCONCLUSIVE: codex exec failed to spawn: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      resolve({
        status: code ?? -1,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        terminationOwner,
        terminationReason,
      });
    });
    child.stdin.end(options.input);
  });
}

function extractSummaryText(responseBody: string): string {
  const parsed: unknown = JSON.parse(responseBody);
  const texts: string[] = [];
  const output = (parsed as { output?: unknown }).output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string") texts.push(text);
      }
    }
  }
  return texts.join("\n");
}

export type CodexExitClassification = {
  kind: "fail" | "inconclusive";
  code: string;
  reason: string;
};

/**
 * Nonzero codex exec exits are not all transport failures: when the latest
 * summarizer capture fails the shared seven-section validator, cob failed
 * closed and codex aborted — that exact case is a G24 FAIL, everything else
 * stays INCONCLUSIVE. Content-free: reasons never include the summary body
 * or stderr text.
 */
export function classifyCodexNonzeroExit(input: {
  signal: NodeJS.Signals | null;
  latestSummarizerResponse?: string;
  /** Signal ownership is explicit; a signal alone is never treated as harness teardown. */
  terminationOwner?: "harness";
  terminationReason?: CodexTerminationReason;
}): CodexExitClassification {
  if (input.terminationOwner === "harness") {
    if (input.terminationReason === "window_floor") return G24_WINDOW_FLOOR_CLASSIFICATION;
    if (input.terminationReason === "postcompact_retrigger") return G24_POSTCOMPACT_RETRIGGER_CLASSIFICATION;
    return {
      kind: "inconclusive",
      code: "g24_harness_terminated",
      reason: "harness terminated the codex child; run evidence is inconclusive",
    };
  }
  const latestSummarizerResponse = input.latestSummarizerResponse;
  if (latestSummarizerResponse) {
    let summary: string | undefined;
    try {
      summary = extractSummaryText(latestSummarizerResponse);
    } catch {
      summary = undefined;
    }
    if (summary !== undefined && incompleteOllamaCompactHandoffError(summary)) {
      return {
        kind: "fail",
        code: "compaction_summary_incomplete",
        reason:
          "codex exited nonzero after a summarizer handoff that failed the shared seven-section validator; cob failed closed without retry and codex aborted",
      };
    }
  }
  return {
    kind: "inconclusive",
    code: "codex_exec_failed",
    reason: `codex exec exited nonzero (signal ${String(input.signal)}); no incomplete summarizer handoff observed`,
  };
}

export type Capture = {
  kind: "summarizer" | "turn";
  requestBody: string;
  responseBody: string;
  /** Synthetic request-boundary evidence recorded before harness termination. */
  terminationReason?: "postcompact_retrigger";
};

export type G24CheckpointRecord = {
  responseId: string;
  parentResponseId?: string;
  isCompactionReplacement: boolean;
  createdAt: string;
};

export type G24CompactionEpisode = {
  summarizer: Capture;
  summarizerCaptureIndex: number;
  replacement: G24CheckpointRecord;
  baseline: G24CheckpointRecord;
  continuations: [G24CheckpointRecord, G24CheckpointRecord];
  continuationCaptures: [Capture, Capture];
};

export type G24CompactionCorrelation =
  | { kind: "ok"; episode: G24CompactionEpisode }
  | { kind: "missing"; code: "compaction_continuation_incomplete" | "summarizer_wire_capture_missing" };

function validSummarizerCapture(capture: Capture): boolean {
  if (capture.kind !== "summarizer") return false;
  try {
    const envelope = tryParseJsonObject(capture.responseBody);
    if (envelope?.status !== "completed") return false;
    return incompleteOllamaCompactHandoffError(extractSummaryText(capture.responseBody)) === undefined;
  } catch {
    return false;
  }
}

/**
 * Correlate compaction episodes by chronological ordinal, then prove the
 * selected replacement's direct two-child lineage and matching wire captures.
 * This deliberately does not pair the first replacement with the last summary:
 * a valid episode must carry all of its own evidence.
 */
export function correlateG24CompactionEpisodes(
  captures: Capture[],
  checkpoints: G24CheckpointRecord[],
): G24CompactionCorrelation {
  const validSummaries = captures
    .map((capture, index) => ({ capture, index }))
    .filter(({ capture }) => validSummarizerCapture(capture));
  if (validSummaries.length === 0) return { kind: "missing", code: "summarizer_wire_capture_missing" };

  const replacements = checkpoints
    .filter((record) => record.isCompactionReplacement)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.responseId.localeCompare(b.responseId));
  if (replacements.length === 0) return { kind: "missing", code: "compaction_continuation_incomplete" };

  const byParent = new Map<string, G24CheckpointRecord[]>();
  for (const record of checkpoints) {
    if (!record.parentResponseId || record.isCompactionReplacement) continue;
    const children = byParent.get(record.parentResponseId) ?? [];
    children.push(record);
    byParent.set(record.parentResponseId, children);
  }
  for (const children of byParent.values()) {
    children.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.responseId.localeCompare(b.responseId));
  }
  const captureForResponse = new Map<string, { capture: Capture; index: number }>();
  captures.forEach((capture, index) => {
    const responseId = responseIdOf(capture.responseBody);
    if (responseId && !captureForResponse.has(responseId)) captureForResponse.set(responseId, { capture, index });
  });

  // Pair only in chronological order. Invalid summarizer responses are not
  // successful episodes and therefore do not consume a replacement ordinal.
  const pairCount = Math.min(validSummaries.length, replacements.length);
  for (let index = 0; index < pairCount; index += 1) {
    const summary = validSummaries[index]!;
    const replacement = replacements[index]!;
    const baseline = checkpoints.find((record) => record.responseId === replacement.parentResponseId);
    const firstChildren = byParent.get(replacement.responseId) ?? [];
    const first = firstChildren.length === 1 ? firstChildren[0] : undefined;
    const secondChildren = first ? byParent.get(first.responseId) ?? [] : [];
    const second = secondChildren.length === 1 ? secondChildren[0] : undefined;
    const firstCapture = first ? captureForResponse.get(first.responseId) : undefined;
    const secondCapture = second ? captureForResponse.get(second.responseId) : undefined;
    // A summary must precede its own descendant wire evidence. This check is
    // the chronological link between the Ollama capture and state checkpoint.
    if (
      !baseline ||
      !first ||
      !second ||
      !firstCapture ||
      !secondCapture ||
      summary.index >= firstCapture.index ||
      firstCapture.index >= secondCapture.index
    ) {
      continue;
    }
    return {
      kind: "ok",
      episode: {
        summarizer: summary.capture,
        summarizerCaptureIndex: summary.index,
        replacement,
        baseline,
        continuations: [first, second],
        continuationCaptures: [firstCapture.capture, secondCapture.capture],
      },
    };
  }
  return {
    kind: "missing",
    code: "compaction_continuation_incomplete",
  };
}

function exactUpstreamInputTokens(responseBody: string): number | undefined {
  let value: number | undefined;
  for (const candidate of responseObjects(responseBody)) {
    const envelopes = [candidate, isRecord(candidate.response) ? candidate.response : undefined];
    for (const envelope of envelopes) {
      const usage = envelope?.usage;
      if (!isRecord(usage) || typeof usage.input_tokens !== "number") continue;
      if (!Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0) return undefined;
      if (value !== undefined && value !== usage.input_tokens) return undefined;
      value = usage.input_tokens;
    }
  }
  return value;
}

/**
 * Detect the structural low-window loop: a post-compact turn reports exact
 * upstream usage at/over the context window and the very next wire request is
 * another summarizer. Request bytes are intentionally not consulted.
 */
export function g24WindowFloorTriggered(captures: Capture[], window: number): boolean {
  for (let index = 0; index + 1 < captures.length; index += 1) {
    if (!validSummarizerCapture(captures[index]!)) continue;
    const nextSummaryOffset = captures.slice(index + 1).findIndex((capture) => capture.kind === "summarizer");
    if (nextSummaryOffset < 0) continue;
    const nextSummaryIndex = index + 1 + nextSummaryOffset;
    const reachedFloor = captures.slice(index + 1, nextSummaryIndex).some((capture) => {
      const inputTokens = capture.kind === "turn" ? exactUpstreamInputTokens(capture.responseBody) : undefined;
      return inputTokens !== undefined && inputTokens >= window;
    });
    if (reachedFloor) return true;
  }
  return false;
}

/** Exact floor evidence since the latest valid handoff, before a new summarizer is sent. */
function g24WindowFloorPending(captures: Capture[], window: number): boolean {
  let latestSummaryIndex = -1;
  for (let index = captures.length - 1; index >= 0; index -= 1) {
    if (validSummarizerCapture(captures[index]!)) {
      latestSummaryIndex = index;
      break;
    }
  }
  if (latestSummaryIndex < 0) return false;
  return captures.slice(latestSummaryIndex + 1).some((capture) => {
    const inputTokens = capture.kind === "turn" ? exactUpstreamInputTokens(capture.responseBody) : undefined;
    return inputTokens !== undefined && inputTokens >= window;
  });
}

/** A later summarizer request after the first valid handoff is a structural retrigger. */
export function g24PostcompactRetriggerPending(captures: Capture[]): boolean {
  return captures.some((capture) => validSummarizerCapture(capture));
}

/** True only for the harness-owned pre-upstream retrigger capture. */
export function g24PostcompactRetriggerTriggered(captures: Capture[]): boolean {
  return captures.some((capture) => capture.terminationReason === "postcompact_retrigger");
}

/** A completed run decision keeps structural window evidence authoritative. */
export function classifyG24RunExit(input: {
  signal: NodeJS.Signals | null;
  latestSummarizerResponse?: string;
  windowFloorTriggered: boolean;
  postcompactRetriggerTriggered?: boolean;
  latestSummarizerActualSecond?: boolean;
  terminationOwner?: "harness";
  terminationReason?: CodexTerminationReason;
}): CodexExitClassification {
  // A real incomplete second summary is a cob FAIL, not a structural
  // retrigger. The structural marker is only present for the pre-upstream
  // request capture below.
  if (input.latestSummarizerResponse && input.latestSummarizerActualSecond) {
    try {
      if (incompleteOllamaCompactHandoffError(extractSummaryText(input.latestSummarizerResponse))) {
        return classifyCodexNonzeroExit(input);
      }
    } catch {
      // The ordinary nonzero-exit classifier owns malformed responses.
    }
  }
  if (input.terminationOwner === "harness") {
    return classifyCodexNonzeroExit(input);
  }
  if (input.postcompactRetriggerTriggered) return G24_POSTCOMPACT_RETRIGGER_CLASSIFICATION;
  if (input.windowFloorTriggered) return G24_WINDOW_FLOOR_CLASSIFICATION;
  return classifyCodexNonzeroExit(input);
}

export const G24_WINDOW_FLOOR_CLASSIFICATION: CodexExitClassification = {
  kind: "inconclusive",
  code: "g24_window_below_postcompact_floor",
  reason: "post-compact upstream input usage reached the isolated window before an immediate next summarizer",
};

export const G24_POSTCOMPACT_RETRIGGER_CLASSIFICATION: CodexExitClassification = {
  kind: "inconclusive",
  code: "g24_postcompact_retrigger_before_completion",
  reason: "a second summarizer request arrived before the Codex child completed",
};

/** Structural, content-free failure receipt: no stderr or summary text. */
export function writeFailureEvidence(
  evidenceDir: string,
  input: {
    codexStatus: number;
    signal: NodeJS.Signals | null;
    hasSessionId: boolean;
    stderr: string;
    latestSummarizer: Capture | undefined;
    verdict: CodexExitClassification;
    terminationOwner?: "harness";
    terminationReason?: CodexTerminationReason;
  },
): string {
  let handoffSummarySha256: string | null = null;
  let summarizerCapture: Record<string, unknown> | null = null;
  if (input.latestSummarizer) {
    let summary: string | undefined;
    try {
      summary = extractSummaryText(input.latestSummarizer.responseBody);
    } catch {
      summary = undefined;
    }
    if (summary !== undefined) handoffSummarySha256 = sha256Text(summary);
    summarizerCapture = {
      requestBytes: Buffer.byteLength(input.latestSummarizer.requestBody, "utf8"),
      requestSha256: sha256Text(input.latestSummarizer.requestBody),
      responseSha256: sha256Text(input.latestSummarizer.responseBody),
    };
  }
  const receipt = {
    transcriptFormatVersion: OLLAMA_COMPACT_TRANSCRIPT_VERSION,
    codexStatus: input.codexStatus,
    signal: input.signal,
    terminationOwner: input.terminationOwner ?? "unowned",
    terminationReason: input.terminationReason ?? "unowned",
    hasSessionId: input.hasSessionId,
    summarizerCapture,
    handoffSummarySha256,
    classification: input.verdict,
    stderrBytes: Buffer.byteLength(input.stderr, "utf8"),
    stderrSha256: sha256Text(input.stderr),
  };
  const failurePath = join(evidenceDir, "g24-failure.json");
  writeFileSync(failurePath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return failurePath;
}

/**
 * Content-free success-evidence builder. Keeps only hashes, byte counts,
 * codes, booleans, and aggregates: no raw transcript, prompt/response text or
 * heads, auth, paths, model slugs, or session/checkpoint/response ids.
 * Identity correlation uses short SHA-256 hashes only (modelSha8, childSha8,
 * requestIdSha8).
 */
export function g24EvidenceReceipt(input: {
  model: string;
  childSessionId: string | undefined;
  requestId: string;
  corpusSha256: string;
  window: number;
  codexStatus: number;
  stdout: string;
  stderr: string;
  captures: Capture[];
  checkpointTotal: number;
  hasCompactionReplacement: boolean;
  postCompactTurns: number;
  continuationChainOk: boolean;
  handoffSummary: string;
  scorer: { verdict: string | undefined; code: string; reason: string; replayRatio?: number };
}): Record<string, unknown> {
  return {
    transcriptFormatVersion: OLLAMA_COMPACT_TRANSCRIPT_VERSION,
    run: {
      modelSha8: idSha8(input.model),
      childSha8: idSha8(input.childSessionId),
      hasSessionId: Boolean(input.childSessionId),
      requestIdSha8: idSha8(input.requestId),
      corpusSha256: input.corpusSha256,
    },
    window: input.window,
    codexStatus: input.codexStatus,
    stdoutBytes: Buffer.byteLength(input.stdout, "utf8"),
    stdoutSha256: sha256Text(input.stdout),
    stderrBytes: Buffer.byteLength(input.stderr, "utf8"),
    stderrSha256: sha256Text(input.stderr),
    captures: input.captures.map((capture) => ({
      kind: capture.kind,
      requestBytes: Buffer.byteLength(capture.requestBody, "utf8"),
      requestSha256: sha256Text(capture.requestBody),
      responseSha256: sha256Text(capture.responseBody),
    })),
    checkpoints: {
      total: input.checkpointTotal,
      hasCompactionReplacement: input.hasCompactionReplacement,
      postCompactTurns: input.postCompactTurns,
      continuationChainOk: input.continuationChainOk,
    },
    handoffSummarySha256: sha256Text(input.handoffSummary),
    scorer: input.scorer,
  };
}

type CheckpointRecord = G24CheckpointRecord;

function readCheckpoints(stateDir: string): CheckpointRecord[] {
  const dir = join(stateDir, "checkpoints");
  if (!existsSync(dir)) return [];
  const records: CheckpointRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
      records.push({
        responseId: String(parsed.responseId ?? ""),
        parentResponseId: typeof parsed.parentResponseId === "string" ? parsed.parentResponseId : undefined,
        isCompactionReplacement: parsed.isCompactionReplacement === true,
        createdAt: String(parsed.createdAt ?? ""),
      });
    } catch {
      // Skip unreadable diagnostics; the verdict handles missing evidence.
    }
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function main(): Promise<void> {
  // LIVE-TESTING isolation rule: temp CODEX_HOME plus a copied auth.json.
  // The dev home and the live home stay untouched (live is read-only).
  // The run guard owns the exclusive run id, every temp home, the isolated
  // port, and every spawned child. All setup and the run live inside
  // try/finally coverage so any failure — including setup failure — still
  // executes the cleanup proof, and a failed proof fails the harness.
  const runId = `g24-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const guard = new EvalRunGuard({ label: "g24-child-run", runId });
  // Retained receipts must survive finalize: they are written outside the
  // guard-owned temp homes, which finalize deletes.
  const retainedDir = mkdtempSync(join(tmpdir(), "cob-g24-receipt-"));
  const liveHome = resolveLiveCodexHome();
  let gateway: Awaited<ReturnType<typeof listenGateway>> | undefined;
  const captures: Capture[] = [];
  const terminationController: CodexTerminationController = { request: () => undefined };
  let failure: unknown;
  let cleanupError: unknown;

  try {
    if (!existsSync(BUNDLED_CODEX)) {
      throw new Error("INCONCLUSIVE: bundled Codex CLI missing");
    }
    if (!existsSync(join(liveHome, "auth.json"))) {
      throw new Error("INCONCLUSIVE: live home has no auth.json to copy for isolation");
    }
    if (await isPortOpen(GATEWAY_PORT)) {
      throw new Error(`INCONCLUSIVE: isolated port ${GATEWAY_PORT} is occupied; refusing to continue`);
    }
    guard.registerPort(GATEWAY_PORT);

    const liveBeforeSnapshot = liveHomeShaSnapshot();
    const liveBefore: EvalLiveShaSnapshot = {
      configSha256: liveBeforeSnapshot.configSha256 ?? "",
      catalogSha256: liveBeforeSnapshot.catalogSha256 ?? "",
      catalogMetaSha256: liveBeforeSnapshot.catalogMetaSha256 ?? "",
    };
    const liveMetaBefore = liveBeforeSnapshot.catalogMetaSha256;
    console.log(
      `live snapshot (read-only): config=${liveBefore.configSha256.slice(0, 12)} catalog=${liveBefore.catalogSha256.slice(0, 12)}`,
    );

    const codexHome = guard.allocateHome("cob-g24-codex-home-");
    const workdir = guard.allocateHome("cob-g24-workdir-");
    const stateDir = guard.allocateHome("cob-g24-state-");
    const codexPaths: CobPaths = resolvePaths(codexHome);

    // Deterministic run corpus derived from the pinned versioned V2 corpus;
    // one canonical corpus hash pins the whole run.
    const corpus = buildRunCorpus();
    writeFileSync(join(workdir, "corpus-a.txt"), corpus.fileA, { mode: 0o600 });
    writeFileSync(join(workdir, "corpus-b.txt"), corpus.fileB, { mode: 0o600 });
    const canonicalCorpusSha256 = corpus.canonicalSha256;
    const requestId = runId;

    // Step 0: isolate auth (copy bytes, never logged) and seed the temp home.
    writeFileSync(join(codexHome, "auth.json"), readFileSync(join(liveHome, "auth.json")), {
      mode: 0o600,
    });
    // Step 1: seed the isolated catalog (real bundled + real tags, tiny window).
    const prepared = await prepareProfileAndCatalog({
      paths: codexPaths,
      port: GATEWAY_PORT,
      ollamaUrl: OLLAMA_URL,
      locked: true,
      cob: {
        compaction: { provider: "native", ollamaThreads: "summarize" },
        subagents: { models: [MODEL] },
        catalog: { supportsSearchTool: true, applyPatch: false, activeContextWindow: ISOLATED_WINDOW },
      },
    });
    const ollamaRow = prepared.catalog.models.find((model) => String(model.slug) === MODEL);
    console.log(
      `seeded: window=${JSON.stringify(ollamaRow?.context_window)} shell=${JSON.stringify(ollamaRow?.shell_type)} search=${JSON.stringify(ollamaRow?.supports_search_tool)}`,
    );

    // Step 2: in-process gateway on the isolated port with raw-wire capture.
    gateway = await listenGateway({
      port: GATEWAY_PORT,
      ollamaUrl: OLLAMA_URL,
      catalog: prepared.catalog,
      catalogPath: codexPaths.catalog,
      nonce: "g24-isolated-nonce",
      compaction: prepared.compaction,
      stateDir,
      ollamaFetch: async (url, init) => {
        const requestBody = bodyToText(init?.body);
        const kind: Capture["kind"] = requestBody.includes("You are compacting") ? "summarizer" : "turn";
        // The next summarizer request itself proves the retrigger. Record a
        // structural capture, then stop the child before spending another
        // model request; retained receipts keep only its hash and byte count.
        if (kind === "summarizer" && g24PostcompactRetriggerPending(captures)) {
          const terminationReason = g24WindowFloorPending(captures, ISOLATED_WINDOW)
            ? "window_floor"
            : "postcompact_retrigger";
          captures.push({
            kind,
            requestBody,
            responseBody: "",
            ...(terminationReason === "postcompact_retrigger" ? { terminationReason } : {}),
          });
          terminationController.request(terminationReason);
          return new Response(null, { status: 499 });
        }
        const response = await fetch(url, init);
        const responseBody = await response.clone().text();
        captures.push({ kind, requestBody, responseBody });
        console.log(
          `wire> ${kind} request_bytes=${Buffer.byteLength(requestBody, "utf8")} status=${response.status}`,
        );
        return response;
      },
    });
    console.log(`gateway listening on 127.0.0.1:${GATEWAY_PORT} (in-process, isolated)`);

    // Direct gateway sanity lane before the real child: cob -> daemon path.
    const sanity = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, input: "Reply with the single word ok.", stream: false }),
    });
    const sanityBody = await sanity.text();
    if (sanity.status !== 200 || !sanityBody.includes('"status":"completed"')) {
      throw new Error(
        `INCONCLUSIVE: gateway sanity lane failed (status=${sanity.status} ` +
          `bytes=${Buffer.byteLength(sanityBody, "utf8")} sha256=${sha256Text(sanityBody).slice(0, 16)})`,
      );
    }
    console.log("sanity lane: gateway -> daemon -> completed OK");

    // Step 3: one real agentic codex task. The second file read pushes the
    // session over the isolated window, so codex must compact mid-task and
    // then produce at least two post-compact model turns (wc tool call plus
    // the final answer) on the same child. The prompt's fixed fixture nonce
    // must survive into both post-compact continuation bodies.
    const prompt =
      "Work only inside this directory. Do exactly these steps:\n" +
      "1. Print the full contents of corpus-a.txt with cat.\n" +
      "2. Print the full contents of corpus-b.txt with cat.\n" +
      `3. Run: wc -l corpus-a.txt corpus-b.txt\n` +
      "4. Final reply: the two line counts, then one sentence per file describing its style.\n" +
      `5. End the final reply with this exact marker line: ${G24_FIXTURE_NONCE}\n`;
    const result = await runCodexExec(
      BUNDLED_CODEX,
      [
        "exec",
        "--profile",
        "cob",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "-C",
        workdir,
        "-m",
        MODEL,
        "-",
      ],
      {
        cwd: workdir,
        input: prompt,
        env: { ...process.env, CODEX_HOME: codexHome },
        timeoutMs: CODEX_TIMEOUT_MS,
        terminationController,
        register: (child) => {
          guard.registerProcess(child);
        },
      },
    );
    const codexStatus = result.status;
    const codexStdout = result.stdout;
    const codexStderr = result.stderr;
    const sessionId = /session id: ([0-9a-f-]+)/.exec(codexStderr)?.[1];
    console.log(`codex exec status=${codexStatus} has_session=${Boolean(sessionId)}`);
    const windowFloorTriggered = g24WindowFloorTriggered(captures, ISOLATED_WINDOW);
    const postcompactRetriggerTriggered = g24PostcompactRetriggerTriggered(captures);
    if (codexStatus !== 0) {
      const summarizerCaptures = captures.filter((capture) => capture.kind === "summarizer");
      const latestSummarizer = summarizerCaptures[summarizerCaptures.length - 1];
      // A low context window can produce a valid compact followed by a
      // post-compact turn that immediately re-enters compaction. Detect this
      // from exact upstream usage before classifying the later exit; otherwise
      // the second summarizer's incomplete response masks the loop shape.
      const verdict = classifyG24RunExit({
        signal: result.signal,
        latestSummarizerResponse: latestSummarizer?.responseBody,
        windowFloorTriggered,
        postcompactRetriggerTriggered,
        latestSummarizerActualSecond:
          summarizerCaptures.length > 1 && latestSummarizer?.terminationReason !== "postcompact_retrigger",
        terminationOwner: result.terminationOwner,
        terminationReason: result.terminationReason,
      });
      writeFailureEvidence(retainedDir, {
        codexStatus,
        signal: result.signal,
        hasSessionId: Boolean(sessionId),
        stderr: codexStderr,
        latestSummarizer,
        verdict,
        terminationOwner: result.terminationOwner,
        terminationReason: result.terminationReason,
      });
      console.log(
        `failure evidence written (sha256 ${sha256File(join(retainedDir, "g24-failure.json"))?.slice(0, 16)})`,
      );
      throw new Error(
        `${verdict.kind === "fail" ? "FAIL" : "INCONCLUSIVE"}: ${verdict.code}: ${verdict.reason}`,
      );
    }
    if (postcompactRetriggerTriggered || windowFloorTriggered) {
      const verdict = postcompactRetriggerTriggered
        ? G24_POSTCOMPACT_RETRIGGER_CLASSIFICATION
        : G24_WINDOW_FLOOR_CLASSIFICATION;
      const summarizerCaptures = captures.filter((capture) => capture.kind === "summarizer");
      writeFailureEvidence(retainedDir, {
        codexStatus,
        signal: result.signal,
        hasSessionId: Boolean(sessionId),
        stderr: codexStderr,
        latestSummarizer: summarizerCaptures[summarizerCaptures.length - 1],
        verdict,
        terminationOwner: result.terminationOwner,
        terminationReason: result.terminationReason,
      });
      throw new Error(`INCONCLUSIVE: ${verdict.code}: ${verdict.reason}`);
    }
    if (!sessionId) {
      throw new Error(
        "INCONCLUSIVE: codex session id missing from stderr; scorer and evidence require the real child session",
      );
    }
    const childId = `codex-session:${sessionId}`;
    // Step 4: identity + wire evidence from the real run.
    const checkpoints = readCheckpoints(stateDir);
    console.log(`checkpoints: ${checkpoints.length}`);
    const correlated = correlateG24CompactionEpisodes(captures, checkpoints);
    if (correlated.kind !== "ok") {
      throw new Error(`FAIL: ${correlated.code} (chronological compact episode evidence is incomplete)`);
    }
    const { episode } = correlated;
    const compactRecord = episode.replacement;
    const baseline = episode.baseline;
    const [cont1Record, cont2Record] = episode.continuations;
    const [cont1Capture, cont2Capture] = episode.continuationCaptures;
    const summarizer = episode.summarizer;
    const cont1Body = cont1Capture.requestBody;
    const cont2Body = cont2Capture.requestBody;
    const postCompact = checkpoints.filter(
      (record) => !record.isCompactionReplacement && record.createdAt >= compactRecord.createdAt,
    );

    // Wire safety: every Ollama-bound body must pass the shared check.
    for (const [index, capture] of captures.entries()) {
      const unsafe = ollamaWireUnsafeReason(JSON.parse(capture.requestBody));
      if (unsafe) {
        throw new Error(`FAIL: forbidden_ollama_wire on capture ${index}: ${unsafe}`);
      }
    }

    const handoffSummary = extractSummaryText(summarizer.responseBody);
    const run: EvalRunIdentity = {
      model: MODEL,
      child: childId,
      session: `g24-iso-${GATEWAY_PORT}`,
      requestId,
      corpusSha256: canonicalCorpusSha256,
    };
    const events: G9Event[] = [
      { type: "baseline", responseId: baseline.responseId, run },
      {
        type: "compact_ok",
        responseId: compactRecord.responseId,
        parentResponseId: baseline.responseId,
        preBytes: Buffer.byteLength(summarizer.requestBody, "utf8"),
        postBytes: Buffer.byteLength(cont1Body, "utf8"),
        handoffSummary,
        run,
      },
      {
        type: "continuation",
        responseId: cont1Record.responseId,
        parentResponseId: cont1Record.parentResponseId ?? "",
        noncePresent: g24NoncePresent(cont1Body),
        ollamaBody: JSON.parse(cont1Body),
        run,
      },
      {
        type: "continuation",
        responseId: cont2Record.responseId,
        parentResponseId: cont2Record.parentResponseId ?? "",
        noncePresent: g24NoncePresent(cont2Body),
        ollamaBody: JSON.parse(cont2Body),
        run,
      },
    ];
    let state: G9State = initialG9State();
    for (const event of events) state = reduceG9(state, event);
    const liveAfterSnapshot = liveHomeShaSnapshot();
    const liveAfter: EvalLiveShaSnapshot = {
      configSha256: liveAfterSnapshot.configSha256 ?? "",
      catalogSha256: liveAfterSnapshot.catalogSha256 ?? "",
      catalogMetaSha256: liveAfterSnapshot.catalogMetaSha256 ?? "",
    };
    if (liveMetaBefore !== (liveAfterSnapshot.catalogMetaSha256 ?? null)) {
      throw new Error("FAIL: live catalog metadata changed during the run");
    }
    const scored = finalizeG9(state, liveBefore, liveAfter);
    console.log(
      `scorer: verdict=${scored.verdict} code=${scored.code} reason=${scored.reason} replayRatio=${scored.replayRatio?.toFixed(4) ?? "-"}`,
    );

    // Content-free retained receipt: hashes, byte counts, codes, booleans,
    // and aggregate checkpoint shape only — no transcript, prompt/response
    // text or head, auth, path, or session/checkpoint/response ids.
    const evidence = g24EvidenceReceipt({
      model: MODEL,
      childSessionId: sessionId,
      requestId,
      corpusSha256: canonicalCorpusSha256,
      window: ISOLATED_WINDOW,
      codexStatus,
      stdout: codexStdout,
      stderr: codexStderr,
      captures,
      checkpointTotal: checkpoints.length,
      hasCompactionReplacement: Boolean(compactRecord),
      postCompactTurns: postCompact.length,
      continuationChainOk: Boolean(cont1Record && cont2Record),
      handoffSummary,
      scorer: {
        verdict: scored.verdict,
        code: scored.code,
        reason: scored.reason,
        replayRatio: scored.replayRatio,
      },
    });
    const evidencePath = join(retainedDir, "g24-evidence.json");
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    console.log(`evidence written (sha256 ${sha256File(evidencePath)?.slice(0, 16)})`);

    if (scored.verdict !== "pass") {
      throw new Error(`FAIL: ${scored.code}: ${scored.reason}`);
    }
    console.log("G24 isolated real-child canary: PASS (isolated evidence, not live gold)");
  } catch (error) {
    failure = error;
  } finally {
    if (gateway) {
      const closing = gateway;
      gateway = undefined;
      await new Promise<void>((resolve) => closing.close(() => resolve()));
    }
    // Cleanup failure must fail the harness: finalize throws when a port
    // stays open or a home survives, and that error is preserved past any
    // run failure.
    try {
      const proof = await guard.finalize();
      console.log(guard.formatCleanupProof(proof));
    } catch (error) {
      cleanupError = error;
      console.error(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
    }
  }
  if (failure ?? cleanupError) {
    if (failure) {
      console.error(failure instanceof Error ? failure.message : String(failure));
    }
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
