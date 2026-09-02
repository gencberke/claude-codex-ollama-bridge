import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  boundedStableStringify,
  evalReceipt,
  liveShaError,
  runIdentityError,
  STABLE_CIRCULAR_MARKER,
  type EvalLiveShaSnapshot,
  type EvalReceipt,
  type EvalRunIdentity,
} from "./eval-receipt.js";
import { isRecord } from "./core/json.js";

/**
 * G8-R: completed checkpoint replay after gateway restart.
 * Distinct from G8-M (mid-flight same-child continuity). Pack-excluded.
 */
export const G8R_PASS = "completed_checkpoint_replay";

const FORBIDDEN_OLLAMA_SUBSTRINGS = [
  "cob1.",
  "gAAAAA",
  "ocx1",
  "compaction_trigger",
  "encrypted_content",
  "previous_response_id",
] as const;

const MAX_WIRE_SCAN_BYTES = 8 * 1024 * 1024;

export type G8rObservation = {
  run: EvalRunIdentity;
  liveBefore: EvalLiveShaSnapshot;
  liveAfter: EvalLiveShaSnapshot;
  epochAPortOpenAfterStop: boolean;
  parentResponseId: string;
  replayResponseId: string;
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

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Decode checkpoint filenames as canonical base64url response ids. A
 * non-canonical or empty encoding fails closed instead of yielding an
 * arbitrary id.
 */
export function listCheckpointIds(stateDir: string): string[] {
  const dir = join(stateDir, "checkpoints");
  if (!existsSync(dir)) return [];
  const ids: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const encoded = name.slice(0, -".json".length);
    const decoded = Buffer.from(encoded, "base64url");
    const id = decoded.toString("utf8");
    if (
      !BASE64URL_PATTERN.test(encoded) ||
      id.length === 0 ||
      id.includes("\uFFFD") ||
      Buffer.from(id, "utf8").toString("base64url") !== encoded
    ) {
      throw new Error("malformed_checkpoint_filename");
    }
    ids.push(id);
  }
  return ids;
}

export function ollamaWireUnsafeReason(body: unknown): string | undefined {
  if (!isRecord(body)) return "ollama_body_not_object";
  if ("previous_response_id" in body) return "previous_response_id_on_ollama";
  const serialized = boundedStableStringify(body);
  if (serialized.includes(JSON.stringify(STABLE_CIRCULAR_MARKER))) return "ollama_body_circular";
  if (serialized.length > MAX_WIRE_SCAN_BYTES) return "ollama_body_oversize";
  for (const needle of FORBIDDEN_OLLAMA_SUBSTRINGS) {
    if (serialized.includes(needle)) return `forbidden_ollama_wire:${needle}`;
  }
  return undefined;
}

function nonEmptyStrings(values: unknown[]): boolean {
  return values.every((value) => typeof value === "string" && value.length > 0);
}

function hasDuplicates(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

export function scoreG8rReplay(obs: G8rObservation): G8rScore {
  if (
    !isRecord(obs) ||
    !Array.isArray(obs.epochACheckpointIds) ||
    !Array.isArray(obs.epochBCheckpointIds)
  ) {
    return fail(
      "malformed_observation",
      "G8-R checkpoint evidence must be arrays of non-empty ids",
      evalReceipt({ attempt: 1 }),
    );
  }
  const receipts = evalReceipt({
    parentResponseId: obs.parentResponseId,
    continuationResponseId: obs.replayResponseId,
    run: obs.run,
    artifact: obs.replayOllamaBody,
    attempt: 1,
  });
  if (!nonEmptyStrings([...obs.epochACheckpointIds, ...obs.epochBCheckpointIds])) {
    return fail("malformed_observation", "G8-R checkpoint evidence must be arrays of non-empty ids", receipts);
  }
  if (hasDuplicates(obs.epochACheckpointIds) || hasDuplicates(obs.epochBCheckpointIds)) {
    return fail(
      "duplicate_checkpoint_filename",
      "checkpoint filenames must decode to unique ids; duplicate evidence cannot pass",
      receipts,
    );
  }
  const identity = runIdentityError(obs.run);
  if (identity) {
    return fail(identity, "G8-R run identity must name model, child, session, request, and corpus", receipts);
  }
  const liveSha = liveShaError(obs.liveBefore, obs.liveAfter);
  if (liveSha) {
    return fail(liveSha, "config, catalog, and catalog metadata SHAs must be snapshotted before and after the run", receipts);
  }
  if (typeof obs.parentResponseId !== "string" || obs.parentResponseId.length === 0) {
    return fail("parent_response_missing", "G8-R requires a non-empty parent response id", receipts);
  }
  if (obs.epochAPortOpenAfterStop) {
    return fail("port_still_open", "epoch A port was still accepting connections after stop", receipts);
  }
  if (obs.epochACheckpointIds.length !== 1) {
    return fail("expected_single_completed_checkpoint", "G8-R starts from exactly one completed checkpoint", receipts);
  }
  if (obs.epochACheckpointIds[0] !== obs.parentResponseId) {
    return fail("checkpoint_id_mismatch", "epoch A checkpoint id does not match parent_response_id", receipts);
  }
  if (!obs.epochBCheckpointIds.includes(obs.parentResponseId)) {
    return fail(
      "checkpoint_lineage_missing",
      "epoch B must retain the parent checkpoint for an exact unique lineage",
      receipts,
    );
  }
  const added = obs.epochBCheckpointIds.filter((id) => !obs.epochACheckpointIds.includes(id));
  if (added.length !== 1) {
    return fail("expected_single_new_checkpoint", "epoch B must publish exactly one new checkpoint", receipts);
  }
  if (typeof obs.replayResponseId !== "string" || obs.replayResponseId.length === 0) {
    return fail("replay_response_missing", "G8-R requires a non-empty replay response id", receipts);
  }
  if (added[0] !== obs.replayResponseId) {
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
  if (!roles.every((role) => typeof role === "string" && role.length > 0)) return false;
  return roles.includes("user") && roles.includes("assistant") && roles[roles.length - 1] === "user";
}

function fail(code: string, reason: string, receipts: EvalReceipt): G8rScore {
  return { verdict: "fail", code, reason, receipts };
}
