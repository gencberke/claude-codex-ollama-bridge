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
import { uniqueTempPath } from "../../core/atomic.js";
import { MAX_UPSTREAM_BODY_BYTES } from "../../core/http/body.js";
import { withExclusiveLock } from "../../core/lock.js";
import { isRecord, type JsonObject } from "../../core/json.js";
import { assertResponseId, CHECKPOINTS_DIRECTORY, COMPACT_ARCHIVE_DIRECTORY, ConversationStateError, decodeResponseId, encodeResponseId, DEFAULT_STATE_MAX_AGE_MS, DEFAULT_STATE_MAX_BYTES, DEFAULT_STATE_MAX_HEADS, DEFAULT_STATE_MAX_NODES, MAX_STATE_CHAIN_DEPTH, MAX_STATE_CHECKPOINT_BYTES, MAX_STATE_SCAN_FILES, positiveInteger, stableJson, normalizeCheckpoint, serializeCheckpoint, STATE_LOCK_NAME, validateCheckpoint, type ConversationCheckpoint, type PublishCheckpoint, type StateHistoryItem, type StateRetentionOptions, type StateRetentionReport } from "./schema.js";
import { checkpointTime, cloneHistoryItem, compactionOpaqueFingerprint, compactionOutputMatchesItem, createStateHistoryItems, mergeStateHistory, retainedResponseIds, sameHistory } from "./history.js";

/**
 * ConversationStateStore: the single filesystem resource owner for cob state.
 */

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

  async publish(draft: PublishCheckpoint, options?: { signal?: AbortSignal }): Promise<void> {
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
      // The client may leave between the caller's abort check and this lock
      // grant. Re-check after the lock and before the first mutation so an
      // aborted response never becomes a committed checkpoint head.
      if (options?.signal?.aborted) {
        throw new ConversationStateError(
          "state_publish_aborted",
          "client left before the checkpoint commit; nothing was published",
          499,
        );
      }
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

      if (node.parentResponseId) {
        // The caller resolved this parent before the checkpoint was validated,
        // but retention from a concurrent publish may have pruned it while
        // this publish waited for the lock. Revalidate the full ancestry under
        // the lock: a dangling child never becomes a retained head, and no
        // archive or checkpoint bytes are written before the chain confirms.
        await this.resolve(node.parentResponseId);
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
      // Plan retention without touching the filesystem: a publish failure must
      // leave the previous checkpoint set exactly as it was, so the committed
      // checkpoint file is the transaction's only mutation point.
      const plannedRemovals: ConversationCheckpoint[] = [];
      let remainingNodes = all.length;
      let remainingBytes = all.reduce((total, entry) => total + entry.size, 0);
      for (const entry of removable.sort((a, b) => checkpointTime(a.node) - checkpointTime(b.node))) {
        const tooOld = Date.now() - checkpointTime(entry.node) > this.retention.maxAgeMs;
        const tooMany = remainingNodes > this.retention.maxNodes;
        const tooLarge = remainingBytes > this.retention.maxBytes;
        if (!tooOld && !tooMany && !tooLarge) continue;
        plannedRemovals.push(entry.node);
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
        // The archive precedes the commit point: it only becomes authoritative
        // once the candidate checkpoint that references it is published.
        writeImmutable(this.compactArchivePath(node.responseId), node.rawCompactBody);
        delete node.rawCompactBody;
      }
      writeImmutable(target, serializeCheckpoint(node));

      // Post-commit maintenance only. A prune failure must never retract the
      // committed checkpoint or turn this publish into a reported failure.
      const removed = new Set<string>();
      for (const entry of plannedRemovals) {
        try {
          removeCheckpointFiles(this, entry);
          removed.add(entry.responseId);
        } catch {
          console.warn(
            `warning: cob state prune deferred; planned_n=${plannedRemovals.length} removed_n=${removed.size} code=state_prune_io_error`,
          );
          break;
        }
      }
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

/**
 * State-owned checkpoint publishers. One function per replacement semantic;
 * identity fields (catalog model, upstream model, handoff item) are resolved
 * by the caller so this layer depends on no wire or route module.
 */

export type CheckpointPublishContext = {
  state: ConversationStateStore;
  requestInput: unknown;
  requestInputProjection: unknown;
  baseHistory: StateHistoryItem[];
  parentResponseId?: string;
  /** Tripped when the client leaves; checked again inside the publish lock. */
  signal?: AbortSignal;
};

export async function publishOllamaCheckpoint(
  context: CheckpointPublishContext,
  response: JsonObject,
  identity: { model: string; upstreamModel: string },
): Promise<void> {
  const responseId = typeof response.id === "string" ? response.id : "";
  if (responseId.length === 0 || !Array.isArray(response.output)) return;
  const providerInput = createStateHistoryItems(
    context.requestInputProjection,
    responseId,
    "request",
  );
  const providerOutput = createStateHistoryItems(response.output, responseId, "response");
  const history = mergeStateHistory(
    mergeStateHistory(context.baseHistory, providerInput),
    providerOutput,
  );
  await context.state.publish({
    responseId,
    parentResponseId: context.parentResponseId,
    requestInput: context.requestInput,
    output: response.output,
    providerInput,
    providerOutput,
    history,
    responseBody: response,
    model: identity.model,
    provenance: {
      source: "ollama-response",
      gateway: "cob",
      upstreamModel: identity.upstreamModel,
    },
    isCompactionReplacement: false,
  }, { signal: context.signal });
}

export async function publishCompactCheckpoint(
  context: CheckpointPublishContext,
  response: JsonObject,
  rawBody: Buffer,
  identity: { model: string; compactModel: string },
): Promise<void> {
  const responseId = typeof response.id === "string" ? response.id : "";
  if (responseId.length === 0 || !Array.isArray(response.output)) {
    throw new ConversationStateError(
      "state_checkpoint_incompatible",
      "native compaction response cannot be checkpointed; resend the full context",
    );
  }
  const providerInput = createStateHistoryItems(
    context.requestInputProjection,
    responseId,
    "request",
  );
  const preCompactionHistory = mergeStateHistory(context.baseHistory, providerInput);
  // Native encrypted state remains in responseBody/output inside private cob
  // state, while Ollama receives only this provider-safe replay history.
  const replacementHistory = preCompactionHistory;
  await context.state.publish({
    responseId,
    parentResponseId: context.parentResponseId,
    requestInput: context.requestInput,
    output: response.output,
    providerInput,
    providerOutput: [],
    replacementHistory,
    history: replacementHistory,
    responseBody: response,
    model: identity.model,
    provenance: {
      source: "native-compact",
      gateway: "cob",
      compactModel: identity.compactModel,
    },
    isCompactionReplacement: true,
    rawCompactBody: rawBody,
  }, { signal: context.signal });
}

export async function publishOllamaSummaryCheckpoint(
  context: CheckpointPublishContext,
  response: JsonObject,
  rawBody: Buffer,
  identity: { model: string; compactModel: string; upstreamModel: string },
  summaryHandoffItem: JsonObject,
): Promise<void> {
  const responseId = typeof response.id === "string" ? response.id : "";
  if (responseId.length === 0 || !Array.isArray(response.output)) {
    throw new ConversationStateError(
      "state_checkpoint_incompatible",
      "Ollama compact response cannot be checkpointed; resend the full context",
    );
  }
  const replacementHistory = createStateHistoryItems(
    summaryHandoffItem,
    responseId,
    "replacement",
  );
  await context.state.publish({
    responseId,
    parentResponseId: context.parentResponseId,
    requestInput: context.requestInput,
    output: response.output,
    providerInput: [],
    providerOutput: [],
    replacementHistory,
    history: replacementHistory,
    responseBody: response,
    model: identity.model,
    provenance: {
      source: "ollama-summary",
      gateway: "cob",
      compactModel: identity.compactModel,
      upstreamModel: identity.upstreamModel,
    },
    isCompactionReplacement: true,
    rawCompactBody: rawBody,
  }, { signal: context.signal });
}
