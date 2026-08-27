import { sha256Hex8 } from "./request-metrics.js";

/**
 * Process-local compact-attempt correlation for logs only.
 * Codex remote-v2 may re-POST the same trigger; cob still does one Ollama
 * call per inbound request and does not retry. Evicted after 256 groups.
 */
const MAX_GROUPS = 256;

export type CompactAttemptNote = {
  groupSha8: string;
  attempt: number;
};

type CompactAttemptEntry = {
  attempt: number;
};

const groups = new Map<string, CompactAttemptEntry>();

export function resetCompactAttemptLog(): void {
  groups.clear();
}

export function compactAttemptRawKey(opts: {
  parentResponseId?: string;
  threadModel: string;
  replayHistory: unknown;
}): string {
  const parent =
    typeof opts.parentResponseId === "string" ? opts.parentResponseId.trim() : "";
  if (parent.length > 0) return `parent:${parent}`;
  return `hist:${opts.threadModel}:${sha256Hex8(opts.replayHistory)}`;
}

export function noteCompactAttempt(opts: {
  parentResponseId?: string;
  threadModel: string;
  replayHistory: unknown;
}): CompactAttemptNote {
  const rawKey = compactAttemptRawKey(opts);
  const groupSha8 = sha256Hex8(rawKey);
  const previous = groups.get(rawKey);
  const attempt = (previous?.attempt ?? 0) + 1;
  groups.delete(rawKey);
  groups.set(rawKey, { attempt });
  while (groups.size > MAX_GROUPS) {
    const oldest = groups.keys().next().value;
    if (oldest === undefined) break;
    groups.delete(oldest);
  }
  return { groupSha8, attempt };
}

export function formatCompactAttemptLog(note: CompactAttemptNote): string {
  return `compact_group=${note.groupSha8} compact_attempt=${note.attempt}`;
}
