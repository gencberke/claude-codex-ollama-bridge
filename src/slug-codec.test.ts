import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeOllamaId, encodeOllamaId } from "./slug-codec.js";

describe("ollama slug codec", () => {
  it("leaves colon tags unchanged", () => {
    assert.equal(encodeOllamaId("deepseek-v4-flash:cloud"), "deepseek-v4-flash:cloud");
    assert.equal(decodeOllamaId("deepseek-v4-flash:cloud"), "deepseek-v4-flash:cloud");
  });

  it("round-trips inner slashes", () => {
    const id = "library/qwen2.5:7b";
    const encoded = encodeOllamaId(id);
    assert.equal(encoded, "library%2Fqwen2.5:7b");
    assert.equal(encoded.includes("/"), false);
    assert.equal(decodeOllamaId(encoded), id);
  });

  it("does not collide a literal %2F with a slash", () => {
    assert.equal(encodeOllamaId("foo%2Fbar"), "foo%252Fbar");
    assert.equal(decodeOllamaId("foo%252Fbar"), "foo%2Fbar");
    assert.equal(decodeOllamaId(encodeOllamaId("foo/bar")), "foo/bar");
    assert.notEqual(encodeOllamaId("foo/bar"), encodeOllamaId("foo%2Fbar"));
  });

  it("round-trips mixed percents and slashes", () => {
    const id = "a%/b%2F/c";
    assert.equal(decodeOllamaId(encodeOllamaId(id)), id);
  });
});
