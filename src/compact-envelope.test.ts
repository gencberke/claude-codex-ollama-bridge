import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { looksLikeCiphertext } from "./codex/encrypted.js";
import {
  CobCompactEnvelopeError,
  COB_COMPACT_VERSION,
  encodeCobCompactEnvelope,
  decodeCobCompactEnvelope,
  isCobCompactEnvelope,
  MAX_COB_COMPACT_SUMMARY_BYTES,
  newCobCompactIds,
} from "./codex/compact-envelope.js";

describe("cob compact envelope", () => {
  it("round-trips UTF-8 summaries with cob magic and version", () => {
    const encoded = encodeCobCompactEnvelope("handoff: ş and 漢字");
    assert.equal(encoded.startsWith(`cob1.${COB_COMPACT_VERSION}.`), true);
    assert.equal(isCobCompactEnvelope(encoded), true);
    assert.equal(encoded.startsWith("gAAAAA"), false);
    assert.equal(encoded.startsWith("ocx1"), false);
    assert.equal(looksLikeCiphertext(encoded), false);
    assert.equal(decodeCobCompactEnvelope(encoded), "handoff: ş and 漢字");
  });

  it("rejects empty, oversized, Fernet, ocx1, and unknown versions", () => {
    assert.throws(
      () => encodeCobCompactEnvelope("   "),
      (error: unknown) => error instanceof CobCompactEnvelopeError && error.code === "compaction_summary_empty",
    );
    assert.throws(
      () => encodeCobCompactEnvelope("x".repeat(MAX_COB_COMPACT_SUMMARY_BYTES + 1)),
      (error: unknown) =>
        error instanceof CobCompactEnvelopeError && error.code === "compaction_summary_too_large",
    );
    assert.throws(
      () => decodeCobCompactEnvelope("gAAAAAnot-cob"),
      (error: unknown) => error instanceof CobCompactEnvelopeError && error.code === "compaction_envelope_fernet",
    );
    assert.throws(
      () => decodeCobCompactEnvelope("ocx1:deadbeef"),
      (error: unknown) =>
        error instanceof CobCompactEnvelopeError && error.code === "compaction_envelope_unsupported",
    );
    const v2 = encodeCobCompactEnvelope("ok").replace(`cob1.${COB_COMPACT_VERSION}.`, "cob1.2.");
    assert.throws(
      () => decodeCobCompactEnvelope(v2),
      (error: unknown) =>
        error instanceof CobCompactEnvelopeError && error.code === "compaction_envelope_unsupported",
    );
    assert.throws(
      () => decodeCobCompactEnvelope("cob1.1.!!!"),
      (error: unknown) =>
        error instanceof CobCompactEnvelopeError && error.code === "compaction_envelope_malformed",
    );
  });

  it("mints collision-resistant cob ids that are not Fernet", () => {
    const first = newCobCompactIds();
    const second = newCobCompactIds();
    assert.match(first.responseId, /^cob_cmp_[0-9a-f]{32}$/);
    assert.match(first.itemId, /^cob_cmpi_[0-9a-f]{32}$/);
    assert.notEqual(first.responseId, second.responseId);
    assert.notEqual(first.itemId, second.itemId);
    assert.equal(first.responseId.startsWith("gAAAAA"), false);
  });
});
