import { evalReceipt, type EvalReceipt } from "./eval-receipt.js";

/**
 * G9 protocol lane: compact fail-closed, then a valid seven-section handoff,
 * then two same-child continuations. A later compact-ok without those
 * continuations is not gold. Pack-excluded. cob does not retry incomplete
 * summaries.
 */
export type G9Phase = "baseline" | "compact" | "cont1" | "cont2" | "pass" | "fail";

export type G9Event =
  | { type: "baseline"; responseId: string }
  | { type: "compact_incomplete"; ollamaHitsDelta: number; httpStatus: number; code: string }
  | { type: "compact_ok"; responseId: string; parentResponseId: string }
  | { type: "continuation"; responseId: string; parentResponseId: string; noncePresent: boolean; ollamaUnsafe?: string };

export type G9State = {
  phase: G9Phase;
  verdict?: "pass" | "fail";
  code: string;
  reason: string;
  baselineId?: string;
  compactId?: string;
  incompleteCount: number;
  continuationCount: number;
  receipts: EvalReceipt[];
};

export function initialG9State(): G9State {
  return {
    phase: "baseline",
    code: "need_baseline",
    reason: "waiting for baseline checkpoint",
    incompleteCount: 0,
    continuationCount: 0,
    receipts: [],
  };
}

export function reduceG9(state: G9State, event: G9Event): G9State {
  if (state.phase === "fail" || state.phase === "pass") return state;
  switch (event.type) {
    case "baseline":
      if (state.phase !== "baseline") return fail(state, "unexpected_baseline", "baseline already recorded");
      return {
        ...state,
        phase: "compact",
        baselineId: event.responseId,
        code: "need_compact",
        reason: "waiting for compact trigger",
      };
    case "compact_incomplete":
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
    case "compact_ok":
      if (state.phase !== "compact") return fail(state, "unexpected_compact_ok", "compact ok outside the compact phase");
      return {
        ...state,
        phase: "cont1",
        compactId: event.responseId,
        code: "need_continuation",
        reason: "valid compact is not gold without same-child continuation",
        receipts: [
          ...state.receipts,
          evalReceipt({
            parentResponseId: event.parentResponseId,
            compactResponseId: event.responseId,
            attempt: state.incompleteCount + 1,
          }),
        ],
      };
    case "continuation":
      if (state.phase !== "cont1" && state.phase !== "cont2") {
        return fail(state, "unexpected_continuation", "continuation before a valid compact");
      }
      if (event.ollamaUnsafe) {
        return fail(state, event.ollamaUnsafe, "continuation Ollama body was not provider-safe");
      }
      if (!event.noncePresent) {
        return fail(state, "continuation_nonce_missing", "continuation must carry the fixture nonce");
      }
      if (state.phase === "cont1") {
        return {
          ...state,
          phase: "cont2",
          continuationCount: 1,
          code: "need_second_continuation",
          reason: "first continuation ok; G9 still needs a second turn",
          receipts: [
            ...state.receipts,
            evalReceipt({
              parentResponseId: event.parentResponseId,
              compactResponseId: state.compactId,
              continuationResponseId: event.responseId,
              attempt: 1,
            }),
          ],
        };
      }
      return {
        ...state,
        phase: "pass",
        verdict: "pass",
        continuationCount: 2,
        code: "compact_and_two_continuations",
        reason: "valid compact plus two same-child continuations",
        receipts: [
          ...state.receipts,
          evalReceipt({
            parentResponseId: event.parentResponseId,
            compactResponseId: state.compactId,
            continuationResponseId: event.responseId,
            attempt: 2,
          }),
        ],
      };
  }
}

export function finalizeG9(state: G9State): G9State {
  if (state.phase === "pass" || state.phase === "fail") return state;
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
