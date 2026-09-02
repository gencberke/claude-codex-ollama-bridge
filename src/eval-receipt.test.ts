import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { boundedStableStringify, evalReceipt, idSha256, liveShaError } from "./eval-receipt.js";
import type { EvalLiveShaSnapshot, EvalRunIdentity } from "./eval-receipt.js";

const HEX64 = /^[0-9a-f]{64}$/;

describe("eval receipt", () => {
  it("hashes identifiers only and stays stable for the same ids", () => {
    const first = evalReceipt({
      parentResponseId: "resp-1",
      compactResponseId: "compact-1",
      continuationResponseId: "resp-2",
      attempt: 1,
    });
    const second = evalReceipt({
      parentResponseId: "resp-1",
      compactResponseId: "compact-1",
      continuationResponseId: "resp-2",
      attempt: 1,
    });
    assert.deepEqual(first, second);
    assert.equal(first.parentSha256, idSha256("resp-1"));
    assert.equal(first.compactSha256, idSha256("compact-1"));
    assert.notEqual(first.receiptSha256, first.parentSha256);
    const leaked = JSON.stringify(first);
    assert.equal(leaked.includes("resp-1"), false);
    assert.equal(leaked.includes("You are compacting"), false);
  });

  it("carries strict 64-hex hashes for every field including provenance", () => {
    const run: EvalRunIdentity = {
      model: "ollama/test",
      child: "child-1",
      session: "sess-1",
      requestId: "req-1",
      corpusSha256: "a".repeat(64),
    };
    const receipt = evalReceipt({
      parentResponseId: "resp-1",
      continuationResponseId: "resp-2",
      run,
      artifact: { model: run.model, input: [{ role: "user" }] },
      attempt: 1,
    });
    for (const field of [
      receipt.receiptSha256,
      receipt.parentSha256,
      receipt.compactSha256,
      receipt.continuationSha256,
      receipt.runSha256,
      receipt.corpusSha256,
      receipt.artifactSha256,
    ]) {
      assert.match(field, HEX64);
    }
    assert.equal(receipt.corpusSha256, "a".repeat(64));
    assert.equal(
      receipt.runSha256,
      createHash("sha256").update(boundedStableStringify(run)).digest("hex"),
    );
    assert.equal(
      receipt.artifactSha256,
      createHash("sha256").update(boundedStableStringify({ model: run.model, input: [{ role: "user" }] })).digest("hex"),
    );
  });

  it("keeps provenance deterministic for cyclic and malformed input", () => {
    const cyclic: Record<string, unknown> = { name: "body" };
    cyclic.self = cyclic;
    const receipt = evalReceipt({ run: cyclic as unknown as EvalRunIdentity, artifact: cyclic, attempt: 1 });
    assert.match(receipt.runSha256, HEX64);
    assert.match(receipt.artifactSha256, HEX64);
    assert.match(receipt.corpusSha256, HEX64);
    const again = evalReceipt({ run: cyclic as unknown as EvalRunIdentity, artifact: cyclic, attempt: 1 });
    assert.equal(receipt.runSha256, again.runSha256);
    assert.equal(receipt.artifactSha256, again.artifactSha256);
    assert.equal(receipt.corpusSha256, idSha256(""));
  });

  it("does not treat missing ids as empty hashes of summary text", () => {
    const receipt = evalReceipt({ attempt: 0 });
    assert.equal(receipt.parentSha256, idSha256(""));
    assert.equal(receipt.compactSha256, idSha256(""));
    assert.equal(receipt.continuationSha256, idSha256(""));
    assert.match(receipt.parentSha256, HEX64);
  });
});

describe("live SHA snapshots", () => {
  const LIVE = {
    configSha256: "c".repeat(64),
    catalogSha256: "d".repeat(64),
    catalogMetaSha256: "e".repeat(64),
  };

  it("requires config, catalog, and catalog metadata on both sides", () => {
    assert.equal(liveShaError(LIVE, LIVE), undefined);
    // A typed snapshot cannot omit metadata; the runtime check still fails
    // closed on a malformed object that reaches it (test-boundary cast).
    const missingMeta = {
      configSha256: LIVE.configSha256,
      catalogSha256: LIVE.catalogSha256,
    } as unknown as EvalLiveShaSnapshot;
    assert.equal(
      liveShaError(missingMeta, LIVE),
      "live_sha_snapshot_incomplete",
    );
    assert.equal(
      liveShaError(LIVE, { ...LIVE, catalogMetaSha256: "" }),
      "live_sha_snapshot_incomplete",
    );
    assert.equal(liveShaError({ ...LIVE, configSha256: "short" }, LIVE), "live_sha_snapshot_incomplete");
  });

  it("rejects any snapshot mutation between before and after", () => {
    assert.equal(liveShaError(LIVE, { ...LIVE, catalogMetaSha256: "f".repeat(64) }), "post_run_sha_mutation");
    assert.equal(liveShaError(LIVE, { ...LIVE, catalogSha256: "f".repeat(64) }), "post_run_sha_mutation");
  });
});
