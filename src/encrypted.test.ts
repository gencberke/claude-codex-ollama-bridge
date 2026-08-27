import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  encryptedOllamaRejection,
  findEncryptedContent,
  looksLikeCiphertext,
  NON_STRING_ENCRYPTED_CONTENT,
  stripPlaintextEncryptedContent,
} from "./codex/encrypted.js";

describe("encrypted_content", () => {
  it("finds nested Fernet payloads", () => {
    const found = findEncryptedContent({
      input: [{ type: "agent_message", encrypted_content: "gAAAAAnot-a-real-token-but-long-enough" }],
    });
    assert.equal(found?.startsWith("gAAAAA"), true);
  });

  it("ignores empty encrypted placeholders", () => {
    assert.equal(findEncryptedContent({ encrypted_content: "" }), undefined);
    assert.equal(findEncryptedContent({ encrypted_function_args: [] }), undefined);
  });

  it("rejects sibling encrypted_* fields, ocx1, and cob envelopes", () => {
    assert.equal(findEncryptedContent({ encrypted_function_args: ["cipher"] }), NON_STRING_ENCRYPTED_CONTENT);
    assert.equal(findEncryptedContent({ encrypted_reason: "secret" }), "secret");
    assert.equal(findEncryptedContent({ input: [{ type: "message", text: "ocx1:deadbeef" }] })?.startsWith("ocx1"), true);
    assert.equal(findEncryptedContent({ input: [{ type: "message", text: "cob1.1.abc" }] })?.startsWith("cob1."), true);
    const stripped = stripPlaintextEncryptedContent({
      encrypted_function_args: [],
      encrypted_content: "",
      keep: "ok",
    });
    assert.equal(JSON.stringify(stripped).includes("encrypted_"), false);
    assert.equal(JSON.stringify(stripped), JSON.stringify({ keep: "ok" }));
  });

  it("fail-closed rejection is HTTP 400", () => {
    const rejection = encryptedOllamaRejection("gAAAAAabcdef");
    assert.equal(rejection.status, 400);
    assert.equal(rejection.body.error.code, "encrypted_content_unsupported");
  });

  it("detects Fernet prefix as ciphertext", () => {
    assert.equal(looksLikeCiphertext("gAAAAAhello"), true);
    assert.equal(looksLikeCiphertext("short"), false);
  });

  it("treats object encrypted_content as present and strips it regardless of type", () => {
    const payload = {
      input: [{ type: "compaction", encrypted_content: { blob: "x" } }],
    };
    assert.equal(findEncryptedContent(payload), NON_STRING_ENCRYPTED_CONTENT);
    const stripped = stripPlaintextEncryptedContent(payload);
    assert.equal(JSON.stringify(stripped).includes("encrypted_content"), false);
    assert.equal(JSON.stringify(stripped).includes("blob"), false);
  });
});
