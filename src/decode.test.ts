import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { decodeRequestBody, RequestDecodeError } from "./decode.js";

describe("decodeRequestBody", () => {
  it("round-trips Codex zstd JSON", () => {
    const json = Buffer.from('{"model":"gpt-5.6-luna"}', "utf8");
    const compressed = zstdCompressSync(json);
    const decoded = decodeRequestBody(compressed, "zstd");
    assert.equal(decoded.decoded, true);
    assert.equal(decoded.body.toString("utf8"), json.toString("utf8"));
  });

  it("detects zstd from the frame magic when the header is missing", () => {
    const json = Buffer.from('{"model":"gpt-5.6-luna"}', "utf8");
    const decoded = decodeRequestBody(zstdCompressSync(json));
    assert.equal(decoded.decoded, true);
    assert.equal(decoded.body.toString("utf8"), json.toString("utf8"));
  });

  it("round-trips gzip JSON", () => {
    const json = Buffer.from('{"model":"gpt-5.6-luna"}', "utf8");
    const decoded = decodeRequestBody(gzipSync(json), "gzip");
    assert.equal(decoded.decoded, true);
    assert.equal(decoded.body.toString("utf8"), json.toString("utf8"));
  });

  it("leaves plain JSON untouched", () => {
    const json = Buffer.from('{"model":"gpt-5.6-luna"}', "utf8");
    const decoded = decodeRequestBody(json, undefined);
    assert.equal(decoded.decoded, false);
    assert.equal(decoded.body.toString("utf8"), json.toString("utf8"));
  });

  it("fail-closes unreadable compressed bodies instead of returning the raw bytes", () => {
    assert.throws(
      () => decodeRequestBody(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0xff]), "zstd"),
      (error: unknown) => error instanceof RequestDecodeError && error.code === "invalid_encoding",
    );
    assert.throws(
      () => decodeRequestBody(Buffer.from("not-gzip"), "gzip"),
      RequestDecodeError,
    );
  });
});
