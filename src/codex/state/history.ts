import { createHash } from "node:crypto";
import type { JsonObject } from "../../core/json.js";
import { isRecord } from "../../core/json.js";
import {
  assertResponseId,
  ConversationStateError,
  MAX_STATE_CHAIN_DEPTH,
  MAX_STATE_HISTORY_ITEMS,
  MAX_STATE_RESPONSE_ID_BYTES,
  type ConversationCheckpoint,
  type HistoryProvenance,
  type HistorySource,
  type StateHistoryItem,
} from "./schema.js";
import { itemIdentity, jsonCloneOrNull, stableJson } from "./schema.js";
import { ollamaFollowUpInputError, projectOllamaInputValue } from "../ollama/history.js";

/**
 * State history identity, merge, and replay helpers. Pure; no filesystem access.
 */

export function stateHistoryValues(history: readonly StateHistoryItem[]): unknown[] {
  return history.map((item) => structuredClone(item.value));
}

export function createStateHistoryItems(
  value: unknown,
  sourceResponseId: string,
  source: HistorySource,
): StateHistoryItem[] {
  assertResponseId(sourceResponseId, "source response id");
  const values = inputValues(value);
  return values.map((item, ordinal) => createStateHistoryItem(item, sourceResponseId, source, ordinal));
}

export function createStateHistoryItem(
  value: unknown,
  sourceResponseId: string,
  source: HistorySource,
  ordinal: number,
): StateHistoryItem {
  assertResponseId(sourceResponseId, "source response id");
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= MAX_STATE_HISTORY_ITEMS) {
    throw new ConversationStateError("state_checkpoint_incompatible", "checkpoint item ordinal is invalid");
  }
  const projected = projectOllamaInputValue(value);
  const itemId = explicitItemId(projected);
  const provenance: HistoryProvenance = {
    source,
    sourceResponseId,
    ordinal,
    ...(itemId ? { itemId } : {}),
  };
  return {
    identity: itemIdentity(projected, provenance),
    value: structuredClone(projected),
    provenance,
  };
}

export function mergeStateHistory(
  base: readonly StateHistoryItem[],
  additions: readonly StateHistoryItem[],
): StateHistoryItem[] {
  const merged = base.map(cloneHistoryItem);
  const identities = new Set(merged.map((item) => item.identity));
  const valuesByItemId = new Map<string, Set<string | undefined>>();
  for (const item of merged) {
    const itemId = item.provenance.itemId;
    if (itemId === undefined) continue;
    const values = valuesByItemId.get(itemId);
    const serializedValue = JSON.stringify(item.value);
    if (values) values.add(serializedValue);
    else valuesByItemId.set(itemId, new Set([serializedValue]));
  }
  for (const addition of additions) {
    if (identities.has(addition.identity)) continue;
    const itemId = addition.provenance.itemId;
    const serializedValue = itemId === undefined ? undefined : JSON.stringify(addition.value);
    if (itemId !== undefined && valuesByItemId.get(itemId)?.has(serializedValue)) continue;
    const cloned = cloneHistoryItem(addition);
    merged.push(cloned);
    identities.add(cloned.identity);
    if (itemId !== undefined) {
      const values = valuesByItemId.get(itemId);
      if (values) values.add(serializedValue);
      else valuesByItemId.set(itemId, new Set([serializedValue]));
    }
    if (merged.length > MAX_STATE_HISTORY_ITEMS) {
      throw new ConversationStateError(
        "state_checkpoint_too_large",
        `conversation history exceeds ${MAX_STATE_HISTORY_ITEMS} items`,
        413,
      );
    }
  }
  return merged;
}

export function sameHistory(left: readonly StateHistoryItem[], right: readonly StateHistoryItem[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item.identity === right[index]?.identity);
}

export function cloneHistoryItem(item: StateHistoryItem): StateHistoryItem {
  return {
    identity: item.identity,
    value: structuredClone(item.value),
    provenance: { ...item.provenance },
  };
}

/** Canonical history-item identity. Recomputed on every checkpoint read. */
export function historyItemIdentity(value: unknown, provenance: HistoryProvenance): string {
  return itemIdentity(value, provenance);
}


export function explicitItemId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const type = typeof value.type === "string" ? value.type : "item";
  for (const key of ["id", "item_id", "itemId", "call_id"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0 && candidate.length <= MAX_STATE_RESPONSE_ID_BYTES) {
      return `${type}:${key}:${candidate}`;
    }
  }
  return undefined;
}

export function inputValues(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}


export function checkpointTime(node: ConversationCheckpoint): number {
  const parsed = Date.parse(node.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function retainedResponseIds(
  nodes: readonly ConversationCheckpoint[],
  alwaysRetain: string | undefined,
  maxHeads: number,
): Set<string> {
  const sorted = nodes
    .slice()
    .sort((a, b) => checkpointTime(b) - checkpointTime(a) || b.responseId.localeCompare(a.responseId));
  const roots: ConversationCheckpoint[] = [];
  if (alwaysRetain) {
    const draft = sorted.find((node) => node.responseId === alwaysRetain);
    if (draft) roots.push(draft);
  }
  for (const node of sorted) {
    if (roots.some((root) => root.responseId === node.responseId)) continue;
    if (roots.length >= maxHeads) break;
    roots.push(node);
  }
  const byId = new Map(nodes.map((node) => [node.responseId, node]));
  const retained = new Set<string>();
  for (const root of roots) {
    let current: ConversationCheckpoint | undefined = root;
    let depth = 0;
    while (current && depth <= MAX_STATE_CHAIN_DEPTH && !retained.has(current.responseId)) {
      retained.add(current.responseId);
      current = current.parentResponseId ? byId.get(current.parentResponseId) : undefined;
      depth += 1;
    }
  }
  return retained;
}


export function compactionOutputMatchesItem(
  output: unknown,
  item: JsonObject,
  itemId: string | undefined,
  fingerprint: string,
  opaqueFingerprint: string,
): boolean {
  if (!isRecord(output) || output.type !== "compaction") return false;
  const fullMatch = stableJson(output) === fingerprint;
  const opaqueMatch = compactionOpaqueFingerprint(output) === opaqueFingerprint;
  if (typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) {
    return fullMatch || opaqueMatch;
  }
  return (itemId !== undefined && output.id === itemId) || fullMatch || opaqueMatch;
}

export function compactionOpaqueFingerprint(value: JsonObject): string {
  return createHash("sha256")
    .update(
      stableJson({
        type: value.type,
        id: value.id,
        encrypted_content: value.encrypted_content,
      }),
    )
    .digest("hex");
}
