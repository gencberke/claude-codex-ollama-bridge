import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { evalReceipt, type EvalReceipt } from "./eval-receipt.js";
import { isRecord } from "./core/json.js";

/**
 * G8-R: completed checkpoint replay after gateway restart.
 * Distinct from G8-M (mid-flight same-child continuity). Pack-excluded.
 */
export const G8R_PASS = "completed_checkpoint_replay";

const FORBIDDEN_OLLAMA_SUBSTRINGS = ["cob1.", "gAAAAA", "ocx1", "compaction_trigger"] as const;

export type G8rObservation = {
  epochAPortOpenAfterStop: boolean;
  parentResponseId: string;
  replayResponseId?: string;
  epochACheckpointIds: string[];
  epochBCheckpointIds: string[];
  replayOllamaBody?: unknown;
};

export type G8rScore = {
  verdict: "pass" | "fail";
  code: string;
  reason: string;
  receipts: EvalReceipt;
};

export function listCheckpointIds(stateDir: string): string[] {
  const dir = join(stateDir, "checkpoints");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => Buffer.from(name.slice(0, -".json".length), "base64url").toString("utf8"))
    .sort();
}

export function ollamaWireUnsafeReason(body: unknown): string | undefined {
  if (!isRecord(body)) return "ollama_body_not_object";
  if ("previous_response_id" in body) return "previous_response_id_on_ollama";
  const serialized = JSON.stringify(body);
  for (const needle of FORBIDDEN_OLLAMA_SUBSTRINGS) {
    if (serialized.includes(needle)) return `forbidden_ollama_wire:${needle}`;
  }
  return undefined;
}

export function scoreG8rReplay(obs: G8rObservation): G8rScore {
  const receipts = evalReceipt({
    parentResponseId: obs.parentResponseId,
    continuationResponseId: obs.replayResponseId,
    attempt: 1,
  });
  if (obs.epochAPortOpenAfterStop) {
    return fail("port_still_open", "epoch A port was still accepting connections after stop", receipts);
  }
  if (obs.epochACheckpointIds.length !== 1) {
    return fail("expected_single_completed_checkpoint", "G8-R starts from exactly one completed checkpoint", receipts);
  }
  if (obs.epochACheckpointIds[0] !== obs.parentResponseId) {
    return fail("checkpoint_id_mismatch", "epoch A checkpoint id does not match parent_response_id", receipts);
  }
  const added = obs.epochBCheckpointIds.filter((id) => !obs.epochACheckpointIds.includes(id));
  if (added.length !== 1) {
    return fail("expected_single_new_checkpoint", "epoch B must publish exactly one new checkpoint", receipts);
  }
  if (obs.replayResponseId && added[0] !== obs.replayResponseId) {
    return fail("checkpoint_id_mismatch", "epoch B checkpoint id does not match the replay response", receipts);
  }
  const unsafe = ollamaWireUnsafeReason(obs.replayOllamaBody);
  if (unsafe) {
    return fail(unsafe, "Ollama replay body must be provider-safe expanded history", receipts);
  }
  if (!hasExpandedHistory(obs.replayOllamaBody)) {
    return fail("history_not_expanded", "replay Ollama input must include prior user and assistant items", receipts);
  }
  return {
    verdict: "pass",
    code: G8R_PASS,
    reason: "completed checkpoint replayed after gateway restart",
    receipts,
  };
}

function hasExpandedHistory(body: unknown): boolean {
  if (!isRecord(body) || !Array.isArray(body.input) || body.input.length < 3) return false;
  const roles = body.input.map((item) => (isRecord(item) ? item.role : undefined));
  return roles.includes("user") && roles.includes("assistant");
}

function fail(code: string, reason: string, receipts: EvalReceipt): G8rScore {
  return { verdict: "fail", code, reason, receipts };
}
