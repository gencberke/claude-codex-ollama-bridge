import { createHash } from "node:crypto";
import { isRecord } from "./core/json.js";

/**
 * Content-free correlation for compact/checkpoint/continuation eval.
 * Hashes identifiers only; never summary text, envelope, or patch bodies.
 * Pack-excluded.
 */
export type EvalReceipt = {
  receiptSha256: string;
  parentSha256: string;
  compactSha256: string;
  continuationSha256: string;
  runSha256: string;
  corpusSha256: string;
  artifactSha256: string;
  attempt: number;
};

export function idSha256(value: string | undefined | null): string {
  const text = typeof value === "string" ? value : "";
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Compatibility shorthand: first 8 hex chars of the full id digest. */
export function idSha8(value: string | undefined | null): string {
  return idSha256(value).slice(0, 8);
}

/**
 * Deterministic, cycle-safe, bounded stable serialization for hashing and
 * wire-scan evidence. Cycles and depth overflow become fixed marker strings
 * so every input maps to exactly one output.
 */
export const STABLE_CIRCULAR_MARKER = "\u0000cob:circular";
export const STABLE_DEPTH_MARKER = "\u0000cob:depth-capped";
const MAX_STABLE_DEPTH = 128;

export function boundedStableStringify(value: unknown): string {
  return stableStringify(value, 0, new Set<object>());
}

function stableStringify(value: unknown, depth: number, seen: Set<object>): string {
  if (depth > MAX_STABLE_DEPTH) return JSON.stringify(STABLE_DEPTH_MARKER);
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "string":
      return JSON.stringify(value);
    case "bigint":
      return JSON.stringify(value.toString());
    default:
      break;
  }
  if (typeof value !== "object") return "null";
  if (seen.has(value as object)) return JSON.stringify(STABLE_CIRCULAR_MARKER);
  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      const parts = value.map((item) => stableStringify(item, depth + 1, seen));
      return `[${parts.join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => {
        const child = record[key];
        return typeof child !== "function" && typeof child !== "symbol" && child !== undefined;
      })
      .sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key], depth + 1, seen)}`);
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(value as object);
  }
}

/** Run-level identity every eval observation/event must carry. All fields non-empty. */
export type EvalRunIdentity = {
  model: string;
  child: string;
  session: string;
  requestId: string;
  corpusSha256: string;
};

/** Config + catalog + catalog-metadata SHA snapshots taken before and after an eval run. */
export type EvalLiveShaSnapshot = {
  configSha256: string;
  catalogSha256: string;
  catalogMetaSha256: string;
};

const CORPUS_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function runIdentityError(run: EvalRunIdentity): string | undefined {
  if (!isRecord(run)) return "run_identity_incomplete";
  for (const field of [run.model, run.child, run.session, run.requestId]) {
    if (typeof field !== "string" || field.length === 0) return "run_identity_incomplete";
  }
  if (typeof run.corpusSha256 !== "string" || !CORPUS_SHA256_PATTERN.test(run.corpusSha256)) {
    return "run_identity_corpus_sha256_invalid";
  }
  return undefined;
}

export function sameRunIdentity(a: EvalRunIdentity, b: EvalRunIdentity): boolean {
  if (!isRecord(a) || !isRecord(b)) return false;
  return (
    a.model === b.model &&
    a.child === b.child &&
    a.session === b.session &&
    a.requestId === b.requestId &&
    a.corpusSha256 === b.corpusSha256
  );
}

function snapshotIncomplete(snapshot: unknown): boolean {
  if (!isRecord(snapshot)) return true;
  for (const field of [snapshot.configSha256, snapshot.catalogSha256, snapshot.catalogMetaSha256]) {
    if (typeof field !== "string" || !SHA256_PATTERN.test(field)) return true;
  }
  return false;
}

export function liveShaError(
  before: EvalLiveShaSnapshot,
  after: EvalLiveShaSnapshot,
): string | undefined {
  if (snapshotIncomplete(before) || snapshotIncomplete(after)) {
    return "live_sha_snapshot_incomplete";
  }
  if (
    before.configSha256 !== after.configSha256 ||
    before.catalogSha256 !== after.catalogSha256 ||
    before.catalogMetaSha256 !== after.catalogMetaSha256
  ) {
    return "post_run_sha_mutation";
  }
  return undefined;
}

export function evalReceipt(parts: {
  parentResponseId?: string;
  compactResponseId?: string;
  continuationResponseId?: string;
  artifact?: unknown;
  run?: EvalRunIdentity;
  attempt?: number;
}): EvalReceipt {
  const parentSha256 = idSha256(parts.parentResponseId);
  const compactSha256 = idSha256(parts.compactResponseId);
  const continuationSha256 = idSha256(parts.continuationResponseId);
  const runSha256 = createHash("sha256").update(boundedStableStringify(parts.run ?? ""), "utf8").digest("hex");
  const corpusRaw = (parts.run as { corpusSha256?: unknown } | undefined)?.corpusSha256;
  const corpusSha256 =
    typeof corpusRaw === "string" && CORPUS_SHA256_PATTERN.test(corpusRaw)
      ? corpusRaw
      : idSha256(typeof corpusRaw === "string" ? corpusRaw : "");
  const artifactSha256 = createHash("sha256")
    .update(boundedStableStringify(parts.artifact), "utf8")
    .digest("hex");
  const attempt = Number.isInteger(parts.attempt) && (parts.attempt as number) >= 0 ? (parts.attempt as number) : 0;
  const receiptSha256 = createHash("sha256")
    .update(
      JSON.stringify({
        parent: parentSha256,
        compact: compactSha256,
        continuation: continuationSha256,
        run: runSha256,
        corpus: corpusSha256,
        artifact: artifactSha256,
        attempt,
      }),
    )
    .digest("hex");
  return {
    receiptSha256,
    parentSha256,
    compactSha256,
    continuationSha256,
    runSha256,
    corpusSha256,
    artifactSha256,
    attempt,
  };
}
