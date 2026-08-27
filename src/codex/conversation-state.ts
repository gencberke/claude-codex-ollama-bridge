import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { uniqueTempPath } from "../core/atomic.js";
import { findEncryptedContent } from "./encrypted.js";
import { MAX_UPSTREAM_BODY_BYTES } from "../core/http/body.js";
import { withExclusiveLock } from "../core/lock.js";
import { projectOllamaInputValue, ollamaFollowUpInputError } from "./compaction.js";
import type { JsonObject } from "../core/json.js";
import { isRecord } from "../core/json.js";

export const CONVERSATION_STATE_SCHEMA_VERSION = 1;
export const DEFAULT_STATE_MAX_NODES = 512;
export const DEFAULT_STATE_MAX_HEADS = 64;
export const DEFAULT_STATE_MAX_BYTES = 256 * 1024 * 1024;
export const DEFAULT_STATE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_STATE_CHAIN_DEPTH = 4_096;
export const MAX_STATE_HISTORY_ITEMS = 100_000;
export const MAX_STATE_RESPONSE_ID_BYTES = 512;
export const MAX_STATE_CHECKPOINT_BYTES = 128 * 1024 * 1024;
const MAX_STATE_SCAN_FILES = 10_000;
const CHECKPOINTS_DIRECTORY = "checkpoints";
const COMPACT_ARCHIVE_DIRECTORY = "compact-archive";
const STATE_LOCK_NAME = ".state.lock";

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
// Do not remove these without a read-only type and a corpus test.
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

export class ConversationStateStore {
  readonly stateDir: string;
  readonly checkpointsDir: string;
  readonly compactArchiveDir: string;
  private readonly lockPath: string;
  private readonly retention: Required<StateRetentionOptions>;

  constructor(stateDir: string, options: StateRetentionOptions = {}) {
    this.stateDir = stateDir;
    this.checkpointsDir = join(stateDir, CHECKPOINTS_DIRECTORY);
    this.compactArchiveDir = join(stateDir, COMPACT_ARCHIVE_DIRECTORY);
    this.lockPath = join(stateDir, STATE_LOCK_NAME);
    this.retention = {
      maxNodes: positiveInteger(options.maxNodes, DEFAULT_STATE_MAX_NODES),
      maxHeads: positiveInteger(options.maxHeads, DEFAULT_STATE_MAX_HEADS),
      maxBytes: positiveInteger(options.maxBytes, DEFAULT_STATE_MAX_BYTES),
      maxAgeMs: positiveInteger(options.maxAgeMs, DEFAULT_STATE_MAX_AGE_MS),
    };
  }

  checkpointPath(responseId: string): string {
    assertResponseId(responseId, "response id");
    return join(this.checkpointsDir, `${encodeResponseId(responseId)}.json`);
  }

  compactArchivePath(responseId: string): string {
    assertResponseId(responseId, "response id");
    return join(this.compactArchiveDir, `${encodeResponseId(responseId)}.json`);
  }

  async resolve(responseId: string): Promise<{ responseId: string; history: StateHistoryItem[]; checkpoint: ConversationCheckpoint }> {
    assertResponseId(responseId, "previous_response_id");
    const seen = new Set<string>();
    return this.resolveChain(responseId, seen, 0);
  }

  /**
   * True when `ancestorResponseId` is `headResponseId` or a parent of it.
   * Used to decide whether a compaction item agrees with previous_response_id.
   */
  async lineageContains(headResponseId: string, ancestorResponseId: string): Promise<boolean> {
    assertResponseId(headResponseId, "previous_response_id");
    assertResponseId(ancestorResponseId, "compaction response id");
    let current: string | undefined = headResponseId;
    const seen = new Set<string>();
    let depth = 0;
    while (current) {
      if (depth > MAX_STATE_CHAIN_DEPTH) {
        throw new ConversationStateError(
          "state_checkpoint_incompatible",
          "checkpoint lineage is deeper than cob's bounded validation limit; resend the full context without previous_response_id",
        );
      }
      if (seen.has(current)) {
        throw new ConversationStateError(
          "state_checkpoint_incompatible",
          `checkpoint lineage contains a cycle at ${current}; resend the full context without previous_response_id`,
        );
      }
      seen.add(current);
      if (current === ancestorResponseId) return true;
      current = this.readCheckpoint(current).parentResponseId;
      depth += 1;
    }
    return false;
  }

  async resolveCompactionItem(
    item: unknown,
    model: string,
  ): Promise<{ responseId: string; history: StateHistoryItem[]; checkpoint: ConversationCheckpoint }> {
    if (!isRecord(item) || item.type !== "compaction") {
      throw new ConversationStateError(
        "state_checkpoint_missing",
        "compaction state is unavailable; resend the full context without the compaction item",
      );
    }
    const itemId = typeof item.id === "string" && item.id.length > 0 ? item.id : undefined;
    const fingerprint = stableJson(item);
    const opaqueFingerprint = compactionOpaqueFingerprint(item);
    const matches = this.readValidCheckpoints()
      .map((entry) => entry.node)
      .filter(
        (node) =>
          node.isCompactionReplacement &&
          node.model === model &&
          Array.isArray(node.output) &&
          node.output.some((output) => compactionOutputMatchesItem(output, item, itemId, fingerprint, opaqueFingerprint)),
      );
    if (matches.length === 0) {
      throw new ConversationStateError(
        "state_checkpoint_missing",
        "compaction state is unavailable; resend the full context without the compaction item",
      );
    }
    if (matches.length > 1) {
      throw new ConversationStateError(
        "state_checkpoint_conflict",
        "compaction state is ambiguous; resend the full context without the compaction item",
      );
    }
    return this.resolve(matches[0]!.responseId);
  }

  async archiveRawCompactResponse(responseId: string, body: Buffer): Promise<string> {
    assertResponseId(responseId, "response id");
    if (body.length > MAX_UPSTREAM_BODY_BYTES) {
      throw new ConversationStateError(
        "state_archive_too_large",
        `native compact response exceeds ${MAX_UPSTREAM_BODY_BYTES} bytes`,
        413,
      );
    }
    return withExclusiveLock(this.lockPath, async () => {
      this.ensureDirectories();
      this.recoverTemporaryFiles();
      this.removeOrphanedArchives();
      const path = this.compactArchivePath(responseId);
      writeImmutable(path, body);
      return relativeStatePath(this.stateDir, path);
    });
  }

  async publish(draft: PublishCheckpoint): Promise<void> {
    const node = normalizeCheckpoint(draft);
    if (
      node.rawCompactArchive !== undefined &&
      node.rawCompactArchive !== relativeStatePath(this.stateDir, this.compactArchivePath(node.responseId))
    ) {
      throw new ConversationStateError(
        "state_checkpoint_unsafe",
        "checkpoint compact archive path is outside cob's state layout",
      );
    }
    if (node.rawCompactBody !== undefined) {
      node.rawCompactArchive = relativeStatePath(this.stateDir, this.compactArchivePath(node.responseId));
    }
    const serialized = serializeCheckpoint(node);
    if (serialized.length > MAX_STATE_CHECKPOINT_BYTES) {
      throw new ConversationStateError(
        "state_checkpoint_too_large",
        `checkpoint exceeds ${MAX_STATE_CHECKPOINT_BYTES} bytes`,
        413,
      );
    }
    await withExclusiveLock(this.lockPath, async () => {
      this.ensureDirectories();
      this.recoverTemporaryFiles();
      const existing = this.readValidCheckpoints();
      const target = this.checkpointPath(node.responseId);
      const already = readOptionalBuffer(target);
      if (already) {
        if (already.equals(serialized)) {
          if (node.rawCompactBody !== undefined) {
            writeImmutable(this.compactArchivePath(node.responseId), node.rawCompactBody);
          }
          return;
        }
        throw new ConversationStateError(
          "state_checkpoint_conflict",
          `checkpoint ${node.responseId} already exists with different content`,
        );
      }

      const all = [
        ...existing,
        {
          node,
          size: serialized.length + (node.rawCompactBody?.length ?? compactArchiveSize(this, node.responseId)),
        },
      ];
      const retained = retainedResponseIds(all.map((entry) => entry.node), node.responseId, this.retention.maxHeads);
      const removable = all.filter((entry) => !retained.has(entry.node.responseId));
      const removed = new Set<string>();
      let remainingNodes = all.length;
      let remainingBytes = all.reduce((total, entry) => total + entry.size, 0);
      for (const entry of removable.sort((a, b) => checkpointTime(a.node) - checkpointTime(b.node))) {
        const tooOld = Date.now() - checkpointTime(entry.node) > this.retention.maxAgeMs;
        const tooMany = remainingNodes > this.retention.maxNodes;
        const tooLarge = remainingBytes > this.retention.maxBytes;
        if (!tooOld && !tooMany && !tooLarge) continue;
        removeCheckpointFiles(this, entry.node);
        removed.add(entry.node.responseId);
        remainingNodes -= 1;
        remainingBytes -= entry.size;
      }
      if (remainingNodes > this.retention.maxNodes || remainingBytes > this.retention.maxBytes) {
        throw new ConversationStateError(
          "state_retention_exhausted",
          "cob cannot retain this conversation checkpoint within its bounded state budget; resend the full context without previous_response_id",
          413,
        );
      }

      if (node.rawCompactBody) {
        const archive = this.compactArchivePath(node.responseId);
        writeImmutable(archive, node.rawCompactBody);
        delete node.rawCompactBody;
      }
      writeImmutable(target, serializeCheckpoint(node));
      void removed;
      this.removeOrphanedArchives(all.filter((entry) => !removed.has(entry.node.responseId)));
    });
  }

  async cleanup(): Promise<StateRetentionReport> {
    return withExclusiveLock(this.lockPath, async () => {
      this.ensureDirectories();
      this.recoverTemporaryFiles();
      const entries = this.readValidCheckpoints();
      const retained = retainedResponseIds(
        entries.map((entry) => entry.node),
        undefined,
        this.retention.maxHeads,
      );
      let removedNodes = 0;
      let removedBytes = 0;
      for (const entry of entries) {
        if (retained.has(entry.node.responseId)) continue;
        removeCheckpointFiles(this, entry.node);
        removedNodes += 1;
        removedBytes += entry.size;
      }
      const remaining = entries.filter((entry) => retained.has(entry.node.responseId));
      this.removeOrphanedArchives(remaining);
      return {
        removedNodes,
        removedBytes,
        retainedNodes: remaining.length,
        retainedBytes: remaining.reduce((total, entry) => total + entry.size, 0),
      };
    });
  }

  clear(): void {
    const resolved = resolvePath(this.stateDir);
    if (this.stateDir.length === 0 || resolved === resolvePath("/") || resolved === resolvePath(".")) {
      throw new Error("refusing to clear an unsafe cob state path");
    }
    rmSync(this.stateDir, { recursive: true, force: true });
  }

  private async resolveChain(
    responseId: string,
    seen: Set<string>,
    depth: number,
  ): Promise<{ responseId: string; history: StateHistoryItem[]; checkpoint: ConversationCheckpoint }> {
    if (depth > MAX_STATE_CHAIN_DEPTH) {
      throw new ConversationStateError(
        "state_checkpoint_incompatible",
        "checkpoint lineage is deeper than cob's bounded validation limit; resend the full context without previous_response_id",
      );
    }
    if (seen.has(responseId)) {
      throw new ConversationStateError(
        "state_checkpoint_incompatible",
        `checkpoint lineage contains a cycle at ${responseId}; resend the full context without previous_response_id`,
      );
    }
    seen.add(responseId);
    const checkpoint = this.readCheckpoint(responseId);
    this.assertCompactArchive(checkpoint);
    let parentHistory: StateHistoryItem[] = [];
    if (checkpoint.parentResponseId) {
      const parent = await this.resolveChain(checkpoint.parentResponseId, seen, depth + 1);
      parentHistory = parent.history;
    }
    const expected = checkpoint.isCompactionReplacement
      ? checkpoint.replacementHistory ?? []
      : mergeStateHistory(
          mergeStateHistory(parentHistory, checkpoint.providerInput),
          checkpoint.providerOutput,
        );
    if (!sameHistory(expected, checkpoint.history)) {
      throw new ConversationStateError(
        "state_checkpoint_corrupt",
        `checkpoint ${responseId} does not deterministically reconstruct its lineage; resend the full context without previous_response_id`,
      );
    }
    seen.delete(responseId);
    return { responseId, history: checkpoint.history.map(cloneHistoryItem), checkpoint };
  }

  private assertCompactArchive(checkpoint: ConversationCheckpoint): void {
    if (!checkpoint.isCompactionReplacement) return;
    const expected = relativeStatePath(this.stateDir, this.compactArchivePath(checkpoint.responseId));
    if (checkpoint.rawCompactArchive !== expected) {
      throw new ConversationStateError(
        "state_checkpoint_corrupt",
        `checkpoint ${checkpoint.responseId} is missing its native compact archive; resend the full context without previous_response_id`,
      );
    }
    try {
      const archive = statSync(join(this.stateDir, checkpoint.rawCompactArchive));
      if (!archive.isFile() || archive.size > MAX_UPSTREAM_BODY_BYTES || (archive.mode & 0o077) !== 0) {
        throw new Error("unsafe compact archive");
      }
    } catch {
      throw new ConversationStateError(
        "state_checkpoint_corrupt",
        `checkpoint ${checkpoint.responseId} has an unavailable native compact archive; resend the full context without previous_response_id`,
      );
    }
  }

  private readCheckpoint(responseId: string): ConversationCheckpoint {
    const path = this.checkpointPath(responseId);
    let raw: Buffer;
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > MAX_STATE_CHECKPOINT_BYTES) {
        throw new ConversationStateError(
          "state_checkpoint_too_large",
          `checkpoint ${responseId} exceeds cob's bounded validation limit`,
          413,
        );
      }
      if ((stat.mode & 0o077) !== 0) {
        throw new ConversationStateError(
          "state_checkpoint_unsafe",
          `checkpoint ${responseId} has unsafe permissions; resend the full context without previous_response_id`,
        );
      }
      raw = readFileSync(path);
    } catch (error) {
      if (error instanceof ConversationStateError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ConversationStateError(
          "state_checkpoint_missing",
          `checkpoint ${responseId} is unavailable; resend the full context without previous_response_id`,
        );
      }
      throw new ConversationStateError(
        "state_checkpoint_corrupt",
        `checkpoint ${responseId} could not be read; resend the full context without previous_response_id`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new ConversationStateError(
        "state_checkpoint_corrupt",
        `checkpoint ${responseId} is not valid JSON; resend the full context without previous_response_id`,
      );
    }
    return validateCheckpoint(parsed, responseId);
  }

  private readValidCheckpoints(): Array<{ node: ConversationCheckpoint; size: number }> {
    let names: string[];
    try {
      names = readdirSync(this.checkpointsDir);
    } catch {
      return [];
    }
    const files = names.filter((name) => name.endsWith(".json"));
    if (files.length > MAX_STATE_SCAN_FILES) {
      throw new ConversationStateError(
        "state_retention_exhausted",
        "cob state contains too many checkpoint files; run cob restore or resend the full context",
        413,
      );
    }
    const entries: Array<{ node: ConversationCheckpoint; size: number }> = [];
    for (const name of files) {
      const path = join(this.checkpointsDir, name);
      try {
        const stat = statSync(path);
        if (!stat.isFile() || stat.size > MAX_STATE_CHECKPOINT_BYTES || (stat.mode & 0o077) !== 0) continue;
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        const encoded = name.slice(0, -".json".length);
        const responseId = decodeResponseId(encoded);
        if (!responseId) continue;
        const node = validateCheckpoint(parsed, responseId);
        entries.push({ node, size: stat.size + compactArchiveSize(this, responseId) });
      } catch {
        // A corrupt unrelated node must not make cleanup delete or rewrite it.
        // A request naming it still fails closed through readCheckpoint().
      }
    }
    return entries;
  }

  private ensureDirectories(): void {
    ensurePrivateDirectory(this.stateDir);
    ensurePrivateDirectory(this.checkpointsDir);
    ensurePrivateDirectory(this.compactArchiveDir);
  }

  private recoverTemporaryFiles(): void {
    for (const directory of [this.stateDir, this.checkpointsDir, this.compactArchiveDir]) {
      let names: string[];
      try {
        names = readdirSync(directory);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".tmp")) continue;
        const path = join(directory, name);
        try {
          const stat = statSync(path);
          if (Date.now() - stat.mtimeMs > 60 * 60 * 1_000) unlinkSync(path);
        } catch {
          // A concurrent publisher owns this temporary path; leave it alone.
        }
      }
    }
  }

  private removeOrphanedArchives(known?: ReadonlyArray<{ node: ConversationCheckpoint }>): void {
    const retained = new Set((known ?? this.readValidCheckpoints()).map((entry) => entry.node.responseId));
    let names: string[];
    try {
      names = readdirSync(this.compactArchiveDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const responseId = decodeResponseId(name.slice(0, -".json".length));
      if (!responseId || retained.has(responseId)) continue;
      const path = join(this.compactArchiveDir, name);
      try {
        statSync(path);
        unlinkSync(path);
      } catch {
        // Leave files that cannot be inspected or removed.
      }
    }
  }
}

export function clearConversationState(stateDir: string): void {
  new ConversationStateStore(stateDir).clear();
}

function normalizeCheckpoint(draft: PublishCheckpoint): ConversationCheckpoint & { rawCompactBody?: Buffer } {
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

function validateCheckpoint(value: unknown, expectedResponseId: string): ConversationCheckpoint {
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

function validateProvenance(value: JsonObject, responseId: string): StateProvenance {
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

function validateHistory(value: unknown, label: string): StateHistoryItem[] {
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

function assertSafeProviderHistory(checkpoint: {
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

function serializeCheckpoint(node: ConversationCheckpoint & { rawCompactBody?: Buffer }): Buffer {
  const serializable: ConversationCheckpoint = { ...node };
  delete (serializable as ConversationCheckpoint & { rawCompactBody?: Buffer }).rawCompactBody;
  return Buffer.from(`${JSON.stringify(serializable)}\n`, "utf8");
}

function sameHistory(left: readonly StateHistoryItem[], right: readonly StateHistoryItem[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item.identity === right[index]?.identity);
}

function cloneHistoryItem(item: StateHistoryItem): StateHistoryItem {
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

function itemIdentity(value: unknown, provenance: HistoryProvenance): string {
  const material = `${provenance.source}|${provenance.sourceResponseId}|${provenance.ordinal}|${stableJson(value)}`;
  return `item_${createHash("sha256").update(material).digest("hex")}`;
}

function explicitItemId(value: unknown): string | undefined {
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

function inputValues(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function jsonCloneOrNull(value: unknown): unknown {
  return value === undefined ? null : structuredClone(value);
}

function checkpointTime(node: ConversationCheckpoint): number {
  const parsed = Date.parse(node.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function retainedResponseIds(
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

function removeCheckpointFiles(store: ConversationStateStore, node: ConversationCheckpoint): void {
  try {
    unlinkSync(store.checkpointPath(node.responseId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    unlinkSync(store.compactArchivePath(node.responseId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function compactArchiveSize(store: ConversationStateStore, responseId: string): number {
  try {
    const stat = statSync(store.compactArchivePath(responseId));
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

function writeImmutable(path: string, data: Buffer): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const previous = readFileSync(path);
    if (previous.equals(data)) {
      chmodSync(path, 0o600);
      return;
    }
    throw new ConversationStateError(
      "state_checkpoint_conflict",
      `immutable cob state file ${path} already contains different content`,
    );
  }
  const temp = uniqueTempPath(path);
  try {
    writeFileSync(temp, data, { mode: 0o600 });
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      // Preserve the original publication error.
    }
    throw error;
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function readOptionalBuffer(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function relativeStatePath(stateDir: string, path: string): string {
  return path.slice(stateDir.length + 1);
}

function assertResponseId(value: string, label: string): void {
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

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function encodeResponseId(responseId: string): string {
  return Buffer.from(responseId, "utf8").toString("base64url");
}

function decodeResponseId(encoded: string): string | undefined {
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    if (encodeResponseId(decoded) !== encoded) return undefined;
    assertResponseId(decoded, "response id");
    return decoded;
  } catch {
    return undefined;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function compactionOutputMatchesItem(
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

function compactionOpaqueFingerprint(value: JsonObject): string {
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
