import { randomBytes } from "node:crypto";

/** Distinct from ChatGPT Fernet (`gAAAAA`) and OpenCodex `ocx1`. */
export const COB_COMPACT_MAGIC = "cob1";
export const COB_COMPACT_VERSION = 1;
export const MAX_COB_COMPACT_SUMMARY_BYTES = 64 * 1024;

export class CobCompactEnvelopeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CobCompactEnvelopeError";
  }
}

export function encodeCobCompactEnvelope(summary: string): string {
  if (typeof summary !== "string" || summary.trim().length === 0) {
    throw new CobCompactEnvelopeError(
      "compaction_summary_empty",
      "Ollama compact summary is empty; resend the full context without compacting",
    );
  }
  const bytes = Buffer.byteLength(summary, "utf8");
  if (bytes > MAX_COB_COMPACT_SUMMARY_BYTES) {
    throw new CobCompactEnvelopeError(
      "compaction_summary_too_large",
      `Ollama compact summary exceeds ${MAX_COB_COMPACT_SUMMARY_BYTES} bytes; resend the full context without compacting`,
    );
  }
  const payload = Buffer.from(summary, "utf8").toString("base64url");
  return `${COB_COMPACT_MAGIC}.${COB_COMPACT_VERSION}.${payload}`;
}

export function decodeCobCompactEnvelope(value: string): string {
  if (typeof value !== "string") {
    throw new CobCompactEnvelopeError(
      "compaction_envelope_malformed",
      "compaction envelope is missing; resend the full context without the compaction item",
    );
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("gAAAAA")) {
    throw new CobCompactEnvelopeError(
      "compaction_envelope_fernet",
      "ChatGPT Fernet compaction state cannot be decoded as a cob envelope; resend the full context",
    );
  }
  if (trimmed.startsWith("ocx1")) {
    throw new CobCompactEnvelopeError(
      "compaction_envelope_unsupported",
      "OpenCodex ocx1 compaction state is not a cob envelope; resend the full context",
    );
  }
  const match = /^cob1\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(trimmed);
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new CobCompactEnvelopeError(
      "compaction_envelope_malformed",
      "compaction envelope is malformed; resend the full context without the compaction item",
    );
  }
  const version = Number(match[1]);
  if (version !== COB_COMPACT_VERSION) {
    throw new CobCompactEnvelopeError(
      "compaction_envelope_unsupported",
      `compaction envelope version ${version} is unsupported; resend the full context without the compaction item`,
    );
  }
  let summary: string;
  try {
    const buf = Buffer.from(match[2], "base64url");
    if (buf.toString("base64url") !== match[2]) {
      throw new Error("non-canonical base64url");
    }
    summary = buf.toString("utf8");
  } catch {
    throw new CobCompactEnvelopeError(
      "compaction_envelope_malformed",
      "compaction envelope payload is not canonical base64url; resend the full context without the compaction item",
    );
  }
  if (summary.trim().length === 0) {
    throw new CobCompactEnvelopeError(
      "compaction_summary_empty",
      "Ollama compact summary is empty; resend the full context without compacting",
    );
  }
  if (Buffer.byteLength(summary, "utf8") > MAX_COB_COMPACT_SUMMARY_BYTES) {
    throw new CobCompactEnvelopeError(
      "compaction_summary_too_large",
      `Ollama compact summary exceeds ${MAX_COB_COMPACT_SUMMARY_BYTES} bytes; resend the full context without compacting`,
    );
  }
  return summary;
}

export function isCobCompactEnvelope(value: string): boolean {
  return typeof value === "string" && value.trim().startsWith(`${COB_COMPACT_MAGIC}.`);
}

export function newCobCompactIds(): { responseId: string; itemId: string } {
  return {
    responseId: `cob_cmp_${randomBytes(16).toString("hex")}`,
    itemId: `cob_cmpi_${randomBytes(16).toString("hex")}`,
  };
}
