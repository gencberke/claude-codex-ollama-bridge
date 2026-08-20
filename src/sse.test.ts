import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sseRewriteTransform, SseLimitError } from "./sse.js";

describe("bounded SSE parser", () => {
  it("does not split multi-byte UTF-8 characters across chunks", async () => {
    const transform = sseRewriteTransform((value) => value);
    const line = 'data: {"text":"Türkçe ğüşiöç"}\n';
    const buf = Buffer.from(line, "utf8");
    const split = buf.indexOf(Buffer.from("ğ", "utf8"));
    assert.ok(split > 0);
    const chunks: Buffer[] = [];
    transform.on("data", (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<void>((resolve, reject) => {
      transform.on("end", resolve);
      transform.on("error", reject);
    });
    transform.write(buf.subarray(0, split + 1));
    transform.write(buf.subarray(split + 1));
    transform.end();
    await done;
    assert.equal(Buffer.concat(chunks).toString("utf8"), line);
  });

  it("rejects an incomplete SSE frame that exceeds the line budget", async () => {
    const transform = sseRewriteTransform((value) => value, 32);
    const boom = new Promise<Error>((resolve) => {
      transform.on("error", (error: Error) => resolve(error));
    });
    transform.write(Buffer.alloc(64, 0x41));
    const error = await boom;
    assert.equal(error instanceof SseLimitError, true);
  });
});
