import { createHash } from "node:crypto";
import { MAX_UPSTREAM_BODY_BYTES } from "../../core/http/body.js";
import type { JsonObject } from "../../core/json.js";
import { isRecord } from "../../core/json.js";
import { findEncryptedContent } from "../encrypted.js";
import { ollamaFollowUpInputError, projectOllamaInputValue } from "../ollama/history.js";

/**
 * Checkpoint schema: types, limits, validation, serialization, and the
 * Cob state errors. Pure; no filesystem access.
 */

export const CONVERSATION_STATE_SCHEMA_VERSION = 1;
export const DEFAULT_STATE_MAX_NODES = 512;
export const DEFAULT_STATE_MAX_HEADS = 64;
export const DEFAULT_STATE_MAX_BYTES = 256 * 1024 * 1024;
export const DEFAULT_STATE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_STATE_CHAIN_DEPTH = 4_096;
export const MAX_STATE_HISTORY_ITEMS = 100_000;
export const MAX_STATE_RESPONSE_ID_BYTES = 512;
export const MAX_STATE_CHECKPOINT_BYTES = 128 * 1024 * 1024;
export const MAX_STATE_SCAN_FILES = 10_000;
export const CHECKPOINTS_DIRECTORY = "checkpoints";
export const COMPACT_ARCHIVE_DIRECTORY = "compact-archive";
export const STATE_LOCK_NAME = ".state.lock";

export type HistorySource = "request" | "response" | "replacement";

export type HistoryProvenance = {
  source: HistorySource;
  sourceResponseId: string;
  ordinal: number;
  itemId?: string;
};

export type StateHistoryItem = {
  identity: string;
  value: unknown;
  provenance: HistoryProvenance;
};

export type StateProvenance = {
  source: "ollama-response" | "native-compact" | "ollama-summary";
  gateway: "cob";
  upstreamModel?: string;
  compactModel?: string;
};

export type ConversationCheckpoint = {
  schemaVersion: number;
  responseId: string;
  parentResponseId?: string;
  requestInput: unknown;
  output: unknown;
  providerInput: StateHistoryItem[];
  providerOutput: StateHistoryItem[];
  replacementHistory?: StateHistoryItem[];
  history: StateHistoryItem[];
  responseBody: JsonObject;
  route: "ollama";
  model: string;
  provenance: StateProvenance;
  isCompactionReplacement: boolean;
  createdAt: string;
  rawCompactArchive?: string;
};

export type PublishCheckpoint = {
  responseId: string;
  parentResponseId?: string;
  requestInput: unknown;
  output: unknown;
  providerInput: StateHistoryItem[];
  providerOutput: StateHistoryItem[];
  replacementHistory?: StateHistoryItem[];
  history: StateHistoryItem[];
  responseBody: JsonObject;
  model: string;
  provenance: StateProvenance;
  isCompactionReplacement: boolean;
  createdAt?: string;
  rawCompactBody?: Buffer;
  rawCompactArchive?: string;
};

export type StateRetentionOptions = {
  maxNodes?: number;
  maxHeads?: number;
  maxBytes?: number;
  maxAgeMs?: number;
};

export type StateRetentionReport = {
  removedNodes: number;
  removedBytes: number;
  retainedNodes: number;
  retainedBytes: number;
};

export class ConversationStateError extends Error {
  readonly status: number;

  constructor(
    readonly code:
      | "state_checkpoint_missing"
      | "state_checkpoint_corrupt"
      | "state_checkpoint_incompatible"
      | "state_checkpoint_unsafe"
      | "state_checkpoint_conflict"
      | "state_checkpoint_too_large"
      | "state_retention_exhausted"
      | "state_archive_too_large",
    message: string,
    status = 400,
  ) {
    super(message);
    this.name = "ConversationStateError";
    this.status = status;
  }
}

// Clone audit (WP6D): keep structuredClone at mutation boundaries only.
// - validateHistory / resolve / mergeStateHistory clone so callers cannot
//   mutate stored or shared items.
// - stateHistoryValues clones because gateway may project the returned array.

export function normalizeCheckpoint(draft: PublishCheckpoint): ConversationCheckpoint & { rawCompactBody?: Buffer } {
  assertResponseId(draft.responseId, "response id");
  if (draft.parentResponseId !== undefined) assertResponseId(draft.parentResponseId, "parent response id");
  if (draft.parentResponseId === draft.responseId) {
    throw new ConversationStateError("state_checkpoint_incompatible", "checkpoint cannot be its own parent");
  }
  if (typeof draft.model !== "string" || draft.model.trim().length === 0 || draft.model.length > MAX_STATE_RESPONSE_ID_BYTES) {
    throw new ConversationStateError("state_checkpoint_incompatible", "checkpoint model is invalid");
  }
  if (
    !Array.isArray(draft.output) ||
    !isRecord(draft.responseBody) ||
    draft.responseBody.id !== draft.responseId ||
    !Array.isArray(draft.responseBody.output) ||
    (draft.responseBody.status !== undefined && draft.responseBody.status !== "completed")
  ) {
    throw new ConversationStateError(
      "state_checkpoint_incompatible",
      `response ${draft.responseId} does not contain a completed response envelope`,
    );
  }
  const history = validateHistory(draft.history, "history");
  const providerInput = validateHistory(draft.providerInput, "providerInput");
  const providerOutput = validateHistory(draft.providerOutput, "providerOutput");
  const replacementHistory =
    draft.replacementHistory === undefined
      ? undefined
      : validateHistory(draft.replacementHistory, "replacementHistory");
  if (draft.isCompactionReplacement && replacementHistory === undefined) {
    throw new ConversationStateError(
      "state_checkpoint_incompatible",
      "compaction replacement checkpoint is missing replacement history",
    );
  }
  if (draft.isCompactionReplacement && draft.rawCompactBody === undefined && draft.rawCompactArchive === undefined) {
    throw new ConversationStateError(
      "state_checkpoint_incompatible",
      "compaction replacement checkpoint is missing its raw native archive",
    );
  }
  const createdAt = draft.createdAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new ConversationStateError("state_checkpoint_incompatible", "checkpoint timestamp is invalid");
  }
  const node: ConversationCheckpoint & { rawCompactBody?: Buffer } = {
    schemaVersion: CONVERSATION_STATE_SCHEMA_VERSION,
    responseId: draft.responseId,
    ...(draft.parentResponseId ? { parentResponseId: draft.parentResponseId } : {}),
    requestInput: jsonCloneOrNull(draft.requestInput),
    output: jsonCloneOrNull(draft.output),
    providerInput,
    providerOutput,
    ...(replacementHistory ? { replacementHistory } : {}),
    history,
    responseBody: structuredClone(draft.responseBody),
    route: "ollama",
    model: draft.model,
    provenance: structuredClone(draft.provenance),
    isCompactionReplacement: draft.isCompactionReplacement,
    createdAt,
    ...(draft.rawCompactArchive ? { rawCompactArchive: draft.rawCompactArchive } : {}),
    ...(draft.rawCompactBody ? { rawCompactBody: Buffer.from(draft.rawCompactBody) } : {}),
  };
  if (node.rawCompactBody && node.rawCompactBody.length > MAX_UPSTREAM_BODY_BYTES) {
    throw new ConversationStateError(
      "state_archive_too_large",
      `native compact response exceeds ${MAX_UPSTREAM_BODY_BYTES} bytes`,
      413,
    );
  }
  assertSafeProviderHistory(node);
  return node;
}

export function validateCheckpoint(value: unknown, expectedResponseId: string): ConversationCheckpoint {
  if (!isRecord(value)) {
    throw new ConversationStateError(
      "state_checkpoint_corrupt",
      `checkpoint ${expectedResponseId} is not an object; resend the full context without previous_response_id`,
    );
  }
  if (value.schemaVersion !== CONVERSATION_STATE_SCHEMA_VERSION) {
    throw new ConversationStateError(
      "state_checkpoint_incompatible",
      `checkpoint ${expectedResponseId} uses an unsupported schema; resend the full context without previous_response_id`,
    );
  }
  if (value.responseId !== expectedResponseId || typeof value.responseId !== "string") {
    throw new ConversationStateError(
      "state_checkpoint_corrupt",
      `checkpoint ${expectedResponseId} has a mismatched response id; resend the full context without previous_response_id`,
    );
  }
  if (
    value.parentResponseId !== undefined &&
    (typeof value.parentResponseId !== "string" || value.parentResponseId.length === 0)
  ) {
    throw new ConversationStateError(
      "state_checkpoint_incompatible",
      `checkpoint ${expectedResponseId} has an invalid parent response id; resend the full context without previous_response_id`,
    );
  }
  if (value.route !== "ollama" || typeof value.model !== "string" || value.model.length === 0) {
    throw new ConversationStateError(
      "state_checkpoint_incompatible",
      `checkpoint ${expectedResponseId} has an incompatible route or model; resend the full context without previous_response_id`,
    );
  }
  if (
    !isRecord(value.responseBody) ||
    value.responseBody.id !== expectedResponseId ||
    !Array.isArray(value.output) ||
    !Array.isArray(value.responseBody.output) ||
    (value.responseBody.status !== undefined && value.responseBody.status !== "completed") ||
    typeof value.isCompactionReplacement !== "boolean" ||
    typeof value.createdAt !== "string" ||
    !isRecord(value.provenance) ||
    (value.rawCompactArchive !== undefined && typeof value.rawCompactArchive !== "string")
  ) {
    throw new ConversationStateError(
      "state_checkpoint_corrupt",
      `checkpoint ${expectedResponseId} is missing required lineage fields; resend the full context without previous_response_id`,
    );
  }
  if (!value.isCompactionReplacement && value.rawCompactArchive !== undefined) {
    throw new ConversationStateError(
      "state_checkpoint_incompatible",
      `checkpoint ${expectedResponseId} has an unexpected compact archive; resend the full context without previous_response_id`,
    );
  }
  const provenance = validateProvenance(value.provenance, expectedResponseId);
  const providerInput = validateHistory(value.providerInput, "providerInput");
  const providerOutput = validateHistory(value.providerOutput, "providerOutput");
  const history = validateHistory(value.history, "history");
  const replacementHistory =
    value.replacementHistory === undefined
      ? undefined
      : validateHistory(value.replacementHistory, "replacementHistory");
  if (value.isCompactionReplacement && replacementHistory === undefined) {
    throw new ConversationStateError(
      "state_checkpoint_incompatible",
      `checkpoint ${expectedResponseId} is missing replacement history; resend the full context without previous_response_id`,
    );
  }
  if (!Number.isFinite(Date.parse(value.createdAt))) {
    throw new ConversationStateError(
      "state_checkpoint_corrupt",
      `checkpoint ${expectedResponseId} has an invalid timestamp; resend the full context without previous_response_id`,
    );
  }
  const checkpoint: ConversationCheckpoint = {
    schemaVersion: CONVERSATION_STATE_SCHEMA_VERSION,
    responseId: expectedResponseId,
    ...(typeof value.parentResponseId === "string" ? { parentResponseId: value.parentResponseId } : {}),
    requestInput: jsonCloneOrNull(value.requestInput),
    output: jsonCloneOrNull(value.output),
    providerInput,
    providerOutput,
    ...(replacementHistory ? { replacementHistory } : {}),
    history,
    responseBody: structuredClone(value.responseBody),
    route: "ollama",
    model: value.model,
    provenance,
    isCompactionReplacement: value.isCompactionReplacement,
    createdAt: value.createdAt,
    ...(typeof value.rawCompactArchive === "string" ? { rawCompactArchive: value.rawCompactArchive } : {}),
  };
  assertSafeProviderHistory(checkpoint);
  return checkpoint;
}

export function validateProvenance(value: JsonObject, responseId: string): StateProvenance {
  if (
    (value.source !== "ollama-response" &&
      value.source !== "native-compact" &&
      value.source !== "ollama-summary") ||
    value.gateway !== "cob" ||
    (value.upstreamModel !== undefined && typeof value.upstreamModel !== "string") ||
    (value.compactModel !== undefined && typeof value.compactModel !== "string")
  ) {
    throw new ConversationStateError(
      "state_checkpoint_incompatible",
      `checkpoint ${responseId} has invalid provenance; resend the full context without previous_response_id`,
    );
  }
  return {
    source: value.source,
    gateway: "cob",
    ...(typeof value.upstreamModel === "string" ? { upstreamModel: value.upstreamModel } : {}),
    ...(typeof value.compactModel === "string" ? { compactModel: value.compactModel } : {}),
  };
}

export function validateHistory(value: unknown, label: string): StateHistoryItem[] {
  if (!Array.isArray(value) || value.length > MAX_STATE_HISTORY_ITEMS) {
    throw new ConversationStateError(
      "state_checkpoint_incompatible",
      `${label} is not a bounded history array; resend the full context without previous_response_id`,
    );
  }
  const identities = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.identity !== "string" || item.identity.length === 0 || identities.has(item.identity)) {
      throw new ConversationStateError(
        "state_checkpoint_corrupt",
        `${label}[${index}] has an invalid or duplicate identity; resend the full context without previous_response_id`,
      );
    }
    if (!isRecord(item.provenance)) {
      throw new ConversationStateError(
        "state_checkpoint_corrupt",
        `${label}[${index}] is missing provenance; resend the full context without previous_response_id`,
      );
    }
    const provenance = item.provenance;
    const ordinal = provenance.ordinal;
    if (
      (provenance.source !== "request" &&
        provenance.source !== "response" &&
        provenance.source !== "replacement") ||
      typeof provenance.sourceResponseId !== "string" ||
      provenance.sourceResponseId.length === 0 ||
      typeof ordinal !== "number" ||
      !Number.isInteger(ordinal) ||
      ordinal < 0 ||
      ordinal >= MAX_STATE_HISTORY_ITEMS ||
      (provenance.itemId !== undefined && typeof provenance.itemId !== "string")
    ) {
      throw new ConversationStateError(
        "state_checkpoint_corrupt",
        `${label}[${index}] has invalid provenance; resend the full context without previous_response_id`,
      );
    }
    const normalizedOrdinal = ordinal as number;
    const normalizedProvenance: HistoryProvenance = {
      source: provenance.source,
      sourceResponseId: provenance.sourceResponseId,
      ordinal: normalizedOrdinal,
      ...(typeof provenance.itemId === "string" ? { itemId: provenance.itemId } : {}),
    };
    const computed = itemIdentity(item.value, normalizedProvenance);
    if (item.identity !== computed) {
      throw new ConversationStateError(
        "state_checkpoint_corrupt",
        `${label}[${index}] identity does not match its value and provenance; resend the full context without previous_response_id`,
      );
    }
    identities.add(computed);
    return {
      identity: computed,
      value: structuredClone(item.value),
      provenance: normalizedProvenance,
    };
  });
}

export function assertSafeProviderHistory(checkpoint: {
  providerInput: StateHistoryItem[];
  providerOutput: StateHistoryItem[];
  replacementHistory?: StateHistoryItem[];
  history: StateHistoryItem[];
}): void {
  const all = [
    ...checkpoint.providerInput,
    ...checkpoint.providerOutput,
    ...(checkpoint.replacementHistory ?? []),
    ...checkpoint.history,
  ];
  for (const item of all) {
    if (findEncryptedContent(item.value) !== undefined) {
      throw new ConversationStateError(
        "state_checkpoint_unsafe",
        "checkpoint contains encrypted_content in provider history; resend the full context without previous_response_id",
      );
    }
    const invalid = ollamaFollowUpInputError(item.value);
    if (invalid) {
      throw new ConversationStateError(
        "state_checkpoint_unsafe",
        `${invalid}; resend the full context without previous_response_id`,
      );
    }
  }
}

export function serializeCheckpoint(node: ConversationCheckpoint & { rawCompactBody?: Buffer }): Buffer {
  const serializable: ConversationCheckpoint = { ...node };
  delete (serializable as ConversationCheckpoint & { rawCompactBody?: Buffer }).rawCompactBody;
  return Buffer.from(`${JSON.stringify(serializable)}\n`, "utf8");
}

export function assertResponseId(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_STATE_RESPONSE_ID_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ConversationStateError(
      "state_checkpoint_unsafe",
      `${label} is invalid; resend the full context without previous_response_id`,
    );
  }
}

export function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function encodeResponseId(responseId: string): string {
  return Buffer.from(responseId, "utf8").toString("base64url");
}

export function decodeResponseId(encoded: string): string | undefined {
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    if (encodeResponseId(decoded) !== encoded) return undefined;
    assertResponseId(decoded, "response id");
    return decoded;
  } catch {
    return undefined;
  }
}

export function itemIdentity(value: unknown, provenance: HistoryProvenance): string {
  const material = `${provenance.source}|${provenance.sourceResponseId}|${provenance.ordinal}|${stableJson(value)}`;
  return `item_${createHash("sha256").update(material).digest("hex")}`;
}

export function jsonCloneOrNull(value: unknown): unknown {
  return value === undefined ? null : structuredClone(value);
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
