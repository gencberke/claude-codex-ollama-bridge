import { createHash } from "node:crypto";

/**
 * Content-free correlation for compact/checkpoint/continuation eval.
 * Hashes identifiers only; never summary text, envelope, or patch bodies.
 * Pack-excluded.
 */
export type EvalReceipt = {
  receiptSha8: string;
  parentSha8: string;
  compactSha8: string;
  continuationSha8: string;
  attempt: number;
};

export function idSha8(value: string | undefined | null): string {
  if (typeof value !== "string" || value.length === 0) return "-";
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);
}

export function evalReceipt(parts: {
  parentResponseId?: string;
  compactResponseId?: string;
  continuationResponseId?: string;
  attempt?: number;
}): EvalReceipt {
  const parentSha8 = idSha8(parts.parentResponseId);
  const compactSha8 = idSha8(parts.compactResponseId);
  const continuationSha8 = idSha8(parts.continuationResponseId);
  const attempt = parts.attempt ?? 0;
  const receiptSha8 = createHash("sha256")
    .update(
      JSON.stringify({
        parent: parentSha8,
        compact: compactSha8,
        continuation: continuationSha8,
        attempt,
      }),
    )
    .digest("hex")
    .slice(0, 8);
  return { receiptSha8, parentSha8, compactSha8, continuationSha8, attempt };
}
