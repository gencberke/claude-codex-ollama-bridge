import {
  boundedStableStringify,
  evalReceipt,
  liveShaError,
  runIdentityError,
  sameRunIdentity,
  type EvalLiveShaSnapshot,
  type EvalReceipt,
  type EvalRunIdentity,
} from "./eval-receipt.js";
import { ollamaWireUnsafeReason } from "./eval-g8r.js";
import { incompleteOllamaCompactHandoffError } from "./codex/compaction/summary.js";
import { isRecord } from "./core/json.js";

/**
 * G9 protocol lane: compact fail-closed, then a valid seven-section handoff,
 * then two same-child continuations. A later compact-ok without those
 * continuations is not gold. Pack-excluded. cob does not retry incomplete
 * summaries.
 */

/**
 * Explicit G24 replay-reduction threshold: the Ollama-bound replay must be
 * strictly below post/pre = 0.25, not merely shrink. Recorded decision: the
 * observed gold ratio is ≈0.029 (LIVE-TESTING G8 record), so 0.25 keeps ~8x
 * headroom while codifying `replay_ratio << 1`; the earlier 0.5 draft only
 * required halving and was tightened in review.
 */
export const G24_MAX_REPLAY_RATIO = 0.25;

/** The Completed handoff line must be distinctive enough to correlate continuations. */
export const G9_MIN_HANDOFF_NONCE_LENGTH = 8;

export type G9Phase = "baseline" | "compact" | "cont1" | "cont2" | "pass" | "fail";

export type G9Event =
  | { type: "baseline"; responseId: string; run: EvalRunIdentity }
  | { type: "compact_incomplete"; ollamaHitsDelta: number; httpStatus: number; code: string; run: EvalRunIdentity }
  | {
      type: "compact_ok";
      responseId: string;
      parentResponseId: string;
      preBytes: number;
      postBytes: number;
      /** Raw summarizer handoff text; the scorer re-validates it itself. */
      handoffSummary: string;
      run: EvalRunIdentity;
    }
  | {
      type: "continuation";
      responseId: string;
      parentResponseId: string;
      /** Deprecated: the scorer derives nonce presence from the captured body. */
      noncePresent?: boolean;
      ollamaBody: unknown;
      run: EvalRunIdentity;
    };

export type G9State = {
  phase: G9Phase;
  verdict?: "pass" | "fail";
  code: string;
  reason: string;
  run?: EvalRunIdentity;
  baselineId?: string;
  compactId?: string;
  handoffNonce?: string;
  lastContinuationId?: string;
  replayRatio?: number;
  incompleteCount: number;
  continuationCount: number;
  seenResponseIds: string[];
  receipts: EvalReceipt[];
};

export function initialG9State(): G9State {
  return {
    phase: "baseline",
    code: "need_baseline",
    reason: "waiting for baseline checkpoint",
    incompleteCount: 0,
    continuationCount: 0,
    seenResponseIds: [],
    receipts: [],
  };
}

function identityFailure(state: G9State, run: EvalRunIdentity): string | undefined {
  const incomplete = runIdentityError(run);
  if (incomplete) return incomplete;
  if (state.run && !sameRunIdentity(state.run, run)) return "run_identity_mismatch";
  return undefined;
}

function positiveBytes(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function completedHandoffLine(summary: string): string {
  return (summary.split("\n").find((line) => line.startsWith("Completed:")) ?? "").trim();
}

function nonEmptyId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function reduceG9(state: G9State, event: G9Event): G9State {
  if (state.phase === "fail" || state.phase === "pass") return state;
  if (!isRecord(event) || !nonEmptyId(event.type)) {
    return fail(state, "malformed_event", "every G9 event must be a known record");
  }
  if (
    event.type !== "baseline" &&
    event.type !== "compact_incomplete" &&
    event.type !== "compact_ok" &&
    event.type !== "continuation"
  ) {
    return fail(state, "unknown_event", "every G9 event must be a known record");
  }
  const identity = identityFailure(state, event.run);
  if (identity) {
    return fail(state, identity, "every G9 event must belong to one non-empty run identity");
  }
  switch (event.type) {
    case "baseline": {
      if (state.phase !== "baseline") return fail(state, "unexpected_baseline", "baseline already recorded");
      if (!nonEmptyId(event.responseId)) {
        return fail(state, "empty_response_id", "baseline response id must be non-empty");
      }
      return {
        ...state,
        run: event.run,
        phase: "compact",
        baselineId: event.responseId,
        seenResponseIds: [event.responseId],
        code: "need_compact",
        reason: "waiting for compact trigger",
      };
    }
    case "compact_incomplete": {
      if (state.phase !== "compact") {
        return fail(state, "unexpected_compact_incomplete", "incomplete compact outside the compact phase");
      }
      if (event.ollamaHitsDelta !== 1) {
        return fail(state, "cob_compact_retry_forbidden", "cob must not resend history after an incomplete summary");
      }
      if (event.httpStatus !== 400 || event.code !== "compaction_summary_incomplete") {
        return fail(state, "incomplete_not_fail_closed", "incomplete compact must fail closed as compaction_summary_incomplete");
      }
      return {
        ...state,
        incompleteCount: state.incompleteCount + 1,
        code: "need_compact",
        reason: "incomplete fail-closed; still need a valid seven-section compact",
      };
    }
    case "compact_ok": {
      if (state.phase !== "compact") return fail(state, "unexpected_compact_ok", "compact ok outside the compact phase");
      if (!nonEmptyId(event.responseId)) {
        return fail(state, "empty_response_id", "compact response id must be non-empty");
      }
      if (state.seenResponseIds.includes(event.responseId)) {
        return fail(state, "duplicate_response_id", "compact response id must differ from every earlier response");
      }
      if (event.parentResponseId !== state.baselineId) {
        return fail(state, "compact_parent_mismatch", "compact must chain directly from the baseline response");
      }
      if (!positiveBytes(event.preBytes) || !positiveBytes(event.postBytes)) {
        return fail(state, "compact_bytes_incomplete", "compact evidence must carry positive pre and post byte counts");
      }
      if (event.postBytes >= event.preBytes) {
        return fail(state, "compact_no_shrink", "compaction must shrink the Ollama-bound replay");
      }
      // The scorer does not trust harness-declared section flags: it
      // re-validates the raw handoff text with the shared product validator
      // (exact, ordered, singular, non-empty seven sections).
      const handoffError =
        typeof event.handoffSummary !== "string"
          ? { kind: "error" as const }
          : incompleteOllamaCompactHandoffError(event.handoffSummary);
      if (handoffError) {
        return fail(
          state,
          "compact_handoff_sections_incomplete",
          "G24 requires the exact ordered seven-section handoff summary; a bare recap is not gold",
        );
      }
      const handoffLine = completedHandoffLine(event.handoffSummary);
      const handoffBody = handoffLine.startsWith("Completed:") ? handoffLine.slice("Completed:".length).trim() : "";
      if (handoffBody.length < G9_MIN_HANDOFF_NONCE_LENGTH) {
        return fail(
          state,
          "compact_handoff_nonce_missing",
          "compact handoff must carry a distinctive Completed line to correlate continuations",
        );
      }
      const handoffNonce = handoffLine;
      if (event.postBytes / event.preBytes >= G24_MAX_REPLAY_RATIO) {
        return fail(
          state,
          "compact_shrink_below_threshold",
          `replay reduction must beat the explicit G24 threshold (post/pre < ${G24_MAX_REPLAY_RATIO})`,
        );
      }
      return {
        ...state,
        phase: "cont1",
        compactId: event.responseId,
        handoffNonce,
        seenResponseIds: [...state.seenResponseIds, event.responseId],
        replayRatio: event.postBytes / event.preBytes,
        code: "need_continuation",
        reason: "valid compact is not gold without same-child continuation",
        receipts: [
          ...state.receipts,
          evalReceipt({
            parentResponseId: event.parentResponseId,
            compactResponseId: event.responseId,
            run: event.run,
            artifact: event.handoffSummary,
            attempt: state.incompleteCount + 1,
          }),
        ],
      };
    }
    case "continuation": {
      if (state.phase !== "cont1" && state.phase !== "cont2") {
        return fail(state, "unexpected_continuation", "continuation before a valid compact");
      }
      const unsafe = ollamaWireUnsafeReason(event.ollamaBody);
      if (unsafe) {
        return fail(state, unsafe, "continuation Ollama body must be provider-safe; the scorer inspects the raw body");
      }
      const bodyModel = isRecord(event.ollamaBody) ? event.ollamaBody.model : undefined;
      const expectedModel =
        typeof state.run?.model === "string" && state.run.model.startsWith("ollama/")
          ? state.run.model.slice("ollama/".length)
          : state.run?.model;
      if (typeof bodyModel !== "string" || bodyModel !== expectedModel) {
        return fail(state, "model_mismatch", "continuation Ollama body model must match the run identity model");
      }
      if (!nonEmptyId(event.responseId)) {
        return fail(state, "empty_response_id", "continuation response id must be non-empty");
      }
      if (state.seenResponseIds.includes(event.responseId)) {
        return fail(state, "duplicate_response_id", "continuation response id must differ from every earlier response");
      }
      const expectedParent = state.phase === "cont1" ? state.compactId : state.lastContinuationId;
      if (expectedParent === undefined || event.parentResponseId !== expectedParent) {
        return fail(state, "continuation_parent_mismatch", "continuation must chain from the compact or prior continuation");
      }
      const serialized = boundedStableStringify(event.ollamaBody);
      const noncePresent = state.handoffNonce !== undefined && serialized.includes(state.handoffNonce);
      if (!noncePresent) {
        return fail(
          state,
          "continuation_nonce_missing",
          "continuation must carry the compact handoff nonce; presence is derived from the captured body",
        );
      }
      if (state.phase === "cont1") {
        return {
          ...state,
          phase: "cont2",
          lastContinuationId: event.responseId,
          seenResponseIds: [...state.seenResponseIds, event.responseId],
          continuationCount: 1,
          code: "need_second_continuation",
          reason: "first continuation ok; G9 still needs a second turn",
          receipts: [
            ...state.receipts,
            evalReceipt({
              parentResponseId: event.parentResponseId,
              compactResponseId: state.compactId,
              continuationResponseId: event.responseId,
              run: event.run,
              artifact: event.ollamaBody,
              attempt: 1,
            }),
          ],
        };
      }
      return {
        ...state,
        phase: "pass",
        verdict: "pass",
        lastContinuationId: event.responseId,
        seenResponseIds: [...state.seenResponseIds, event.responseId],
        continuationCount: 2,
        code: "compact_and_two_continuations",
        reason: "valid compact plus two same-child continuations",
        receipts: [
          ...state.receipts,
          evalReceipt({
            parentResponseId: event.parentResponseId,
            compactResponseId: state.compactId,
            continuationResponseId: event.responseId,
            run: event.run,
            artifact: event.ollamaBody,
            attempt: 2,
          }),
        ],
      };
    }
    default:
      return fail(state, "unknown_event", "every G9 event must be a known record");
  }
}

export function finalizeG9(
  state: G9State,
  liveBefore: EvalLiveShaSnapshot,
  liveAfter: EvalLiveShaSnapshot,
): G9State {
  if (state.phase === "fail") return state;
  const liveSha = liveShaError(liveBefore, liveAfter);
  if (liveSha) {
    return fail(state, liveSha, "config, catalog, and catalog metadata SHAs must be snapshotted before and after the run");
  }
  if (state.phase === "pass") return state;
  if (state.phase === "cont1" || state.phase === "cont2") {
    return fail(state, "compaction_continuation_incomplete", "compact-ok without the required continuations is not G9 gold");
  }
  if (state.incompleteCount > 0 && state.phase === "compact") {
    return fail(state, "compaction_summary_incomplete", "compact stayed incomplete; cob does not retry");
  }
  return fail(state, "g9_protocol_incomplete", "G9 protocol did not reach compact plus two continuations");
}

function fail(state: G9State, code: string, reason: string): G9State {
  return { ...state, phase: "fail", verdict: "fail", code, reason };
}
