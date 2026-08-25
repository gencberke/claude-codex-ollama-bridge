import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evalReceipt, idSha8 } from "./eval-receipt.js";

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
    assert.equal(first.parentSha8, idSha8("resp-1"));
    assert.equal(first.compactSha8, idSha8("compact-1"));
    assert.notEqual(first.receiptSha8, first.parentSha8);
    const leaked = JSON.stringify(first);
    assert.equal(leaked.includes("resp-1"), false);
    assert.equal(leaked.includes("You are compacting"), false);
  });

  it("does not treat missing ids as empty hashes of summary text", () => {
    const receipt = evalReceipt({ attempt: 0 });
    assert.equal(receipt.parentSha8, "-");
    assert.equal(receipt.compactSha8, "-");
    assert.equal(receipt.continuationSha8, "-");
  });
});
