import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rewriteSseLine, SSE_OMIT_LINE, sseRewriteTransform, SseLimitError } from "./sse.js";

function sseData(line: string | typeof SSE_OMIT_LINE): string {
  assert.equal(typeof line, "string");
  return (line as string).slice("data: ".length);
}

function referenceRewriteSseLine(line: string, rewriteJson: (value: unknown) => unknown): string {
  if (!line.startsWith("data:")) return line;
  const payload = line.slice("data:".length).trim();
  if (payload.length === 0 || payload === "[DONE]") return line;
  try {
    return `data: ${JSON.stringify(rewriteJson(JSON.parse(payload)))}`;
  } catch {
    return line;
  }
}

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

  it("forwards the original data payload only on strict rewriter reference equality", () => {
    const line = 'data: {"id":"evt_1","delta":"hi"}';
    const seen: unknown[] = [];
    const same = rewriteSseLine(line, (value) => value, {
      onData: (event) => seen.push(event.value),
    });
    assert.equal(same, line);
    assert.deepEqual(seen[0], { id: "evt_1", delta: "hi" });

    const rewritten = rewriteSseLine(line, (value) => ({ ...(value as object), id: "evt_2" }));
    assert.equal(rewritten, 'data: {"id":"evt_2","delta":"hi"}');

    assert.equal(rewriteSseLine("data: [DONE]", (value) => value), "data: [DONE]");
    assert.equal(rewriteSseLine(": keepalive", (value) => value), ": keepalive");
  });

  it("keeps optimized and reference rewriters semantically identical across a fixture corpus", () => {
    const events = [
      { id: "evt_1", type: "response.output_text.delta", delta: "hi" },
      { id: "evt_2", type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
      { id: "evt_3", type: "response.output_item.done", item: { type: "function_call", name: "shell", arguments: "{}" } },
      { id: "evt_4", type: "error", error: { code: "idle_timeout", message: "upstream idle" } },
      { type: "response.created", response: { id: "resp_2" } },
    ];
    for (const event of events) {
      const line = `data: ${JSON.stringify(event)}`;
      const identity = rewriteSseLine(line, (value) => value);
      assert.equal(identity, line);
      const reference = referenceRewriteSseLine(line, (value) => value);
      assert.deepEqual(JSON.parse(sseData(identity)), JSON.parse(reference.slice("data: ".length)));

      const mutated = rewriteSseLine(line, (value) => ({ ...(value as object), id: "rewritten" }));
      const mutatedRef = referenceRewriteSseLine(line, (value) => ({ ...(value as object), id: "rewritten" }));
      assert.notEqual(mutated, line);
      assert.deepEqual(JSON.parse(sseData(mutated)), JSON.parse(mutatedRef.slice("data: ".length)));
    }
    assert.equal(rewriteSseLine("data: not-json", (value) => value), "data: not-json");
    assert.equal(rewriteSseLine("data: [DONE]", (value) => value), referenceRewriteSseLine("data: [DONE]", (value) => value));
    assert.equal(rewriteSseLine(": comment", (value) => value), referenceRewriteSseLine(": comment", (value) => value));
  });

  it("rewrites CRLF and multi-line SSE data through the same transform", async () => {
    const transform = sseRewriteTransform((value) => {
      if (value && typeof value === "object" && "id" in value) {
        return { ...(value as object), id: "rewritten" };
      }
      return value;
    });
    const chunks: Buffer[] = [];
    transform.on("data", (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<void>((resolve, reject) => {
      transform.on("end", resolve);
      transform.on("error", reject);
    });
    transform.write(Buffer.from('data: {"id":"a","n":1}\r\ndata: {"id":"b","n":2}\r\n', "utf8"));
    transform.end();
    await done;
    const text = Buffer.concat(chunks).toString("utf8");
    assert.match(text, /"id":"rewritten"/);
    assert.match(text, /"n":1/);
    assert.match(text, /"n":2/);
    assert.equal(text.includes("\r"), false);
  });

  it("omits data lines without dropping comments or changing identity bytes", async () => {
    assert.equal(rewriteSseLine('data: {"id":"keep"}', (value) => value), 'data: {"id":"keep"}');
    assert.equal(rewriteSseLine('data: {"drop":true}', () => SSE_OMIT_LINE), SSE_OMIT_LINE);
    const transform = sseRewriteTransform((value) => {
      if (value && typeof value === "object" && "drop" in (value as object)) return SSE_OMIT_LINE;
      return value;
    });
    const chunks: Buffer[] = [];
    transform.on("data", (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<void>((resolve, reject) => {
      transform.on("end", resolve);
      transform.on("error", reject);
    });
    transform.write(Buffer.from(': comment\ndata: {"id":"keep"}\ndata: {"drop":true}\ndata: {"id":"later"}\n', "utf8"));
    transform.end();
    await done;
    const text = Buffer.concat(chunks).toString("utf8");
    assert.match(text, /: comment/);
    assert.match(text, /"id":"keep"/);
    assert.match(text, /"id":"later"/);
    assert.equal(text.includes("drop"), false);
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
