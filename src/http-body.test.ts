import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, it } from "node:test";

import { BodyAbortedError, LimitedBodyError, readLimitedResponse } from "./core/http-body.js";
import { loadOllamaTags, OLLAMA_TAGS_MAX_BYTES } from "./core/ollama/tags.js";

describe("bounded http body reads", () => {
  describe("readLimitedResponse", () => {
    it("reads an in-cap body verbatim", async () => {
      const response = new Response("hello bounded world");
      assert.equal(
        await readLimitedResponse(response, { maxBytes: 1024 }),
        "hello bounded world",
      );
    });

    it("rejects an oversize body with a content-free typed failure", async () => {
      const response = new Response("a".repeat(100));
      await assert.rejects(
        () => readLimitedResponse(response, { maxBytes: 10 }),
        (error: unknown) => {
          assert.ok(error instanceof LimitedBodyError);
          assert.equal((error as LimitedBodyError).code, "body_oversize");
          assert.ok(!error.message.includes("aaaa"), "error must not echo body content");
          return true;
        },
      );
    });

    it("rejects a response with no body as malformed", async () => {
      const response = new Response();
      await assert.rejects(
        () => readLimitedResponse(response, { maxBytes: 10 }),
        (error: unknown) => {
          assert.ok(error instanceof LimitedBodyError);
          assert.equal((error as LimitedBodyError).code, "body_malformed");
          return true;
        },
      );
    });

    it("fails with BodyAbortedError when aborted while a read is pending", async () => {
      let streamClosed = false;
      const body = new ReadableStream<Uint8Array>({
        start() {
          // Never enqueue and never close: the first read stays pending.
        },
        cancel() {
          streamClosed = true;
        },
      });
      const controller = new AbortController();
      const pending = readLimitedResponse(new Response(body), {
        maxBytes: 1024,
        signal: controller.signal,
      });
      const timer = setTimeout(() => controller.abort(), 20);
      await assert.rejects(() => pending, BodyAbortedError);
      clearTimeout(timer);
      assert.equal(streamClosed, true, "reader must be cancelled after abort");
    });

    it("rejects immediately when the signal is already aborted", async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("tiny"));
        },
      });
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        () => readLimitedResponse(new Response(body), { maxBytes: 1024, signal: controller.signal }),
        BodyAbortedError,
      );
    });
  });

  describe("loadOllamaTags", () => {
    let server: Server;
    let port: number;
    let responder: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void;
    let requestCount: number;

    beforeEach(async () => {
      requestCount = 0;
      responder = (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      };
      server = createServer((req, res) => {
        requestCount += 1;
        responder(req, res);
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      port = (server.address() as { port: number }).port;
    });

    afterEach(() => {
      server.close();
    });

    it("fails closed when /api/tags sends an oversize body", async () => {
      const models = `{"models":[{"name":"ollama/big-${"x".repeat(OLLAMA_TAGS_MAX_BYTES)}"}]}`;
      responder = (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(models);
      };
      await assert.rejects(
        () => loadOllamaTags(`http://127.0.0.1:${port}`),
        /exceeds \d+ bytes/,
      );
      assert.ok(requestCount > 0);
    });

    it("fails closed when /api/tags sends a malformed body", async () => {
      responder = (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{not json at all");
      };
      await assert.rejects(
        () => loadOllamaTags(`http://127.0.0.1:${port}`),
        (error: unknown) => {
          assert.ok(error instanceof LimitedBodyError);
          assert.equal((error as LimitedBodyError).code, "body_malformed");
          return true;
        },
      );
    });

    it("still parses a normal model list", async () => {
      responder = (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          models: [{
            name: "deepseek-v4-flash:0731-cloud",
            capabilities: ["tools", "thinking"],
          }],
        }));
      };
      const tags = await loadOllamaTags(`http://127.0.0.1:${port}`);
      assert.equal(tags.length, 1);
      assert.equal(tags[0]!.name, "deepseek-v4-flash:0731-cloud");
    });
  });
});