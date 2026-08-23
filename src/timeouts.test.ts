import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HeadersTimeoutError, fetchWithHeadersTimeout } from "./timeouts.js";

describe("timeouts", () => {
  it("applies the headers deadline independently of later body activity", async () => {
    await assert.rejects(
      () =>
        fetchWithHeadersTimeout(
          async (_url, init) =>
            new Promise((_, reject) => {
              init.signal?.addEventListener("abort", () => {
                reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
              });
            }),
          "http://127.0.0.1:9",
          { method: "POST", headers: {}, body: Buffer.alloc(0) },
          40,
        ),
      (error: unknown) =>
        error instanceof HeadersTimeoutError && error.code === "upstream_headers_timeout",
    );
  });

  it("resolves when headers arrive before the deadline", async () => {
    const response = await fetchWithHeadersTimeout(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return new Response("ok", { status: 200 });
      },
      "http://127.0.0.1:9",
      { method: "POST", headers: {}, body: Buffer.alloc(0) },
      80,
    );
    assert.equal(response.status, 200);
  });

  it("does not rewrite a connection refusal as a headers timeout", async () => {
    const started = Date.now();
    await assert.rejects(
      () =>
        fetchWithHeadersTimeout(
          async (_url, init) => {
            init.signal?.addEventListener("abort", () => {
              throw new Error("headers timer should not fire on refusal");
            });
            throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1"), { code: "ECONNREFUSED" });
          },
          "http://127.0.0.1:9",
          { method: "POST", headers: {}, body: Buffer.alloc(0) },
          240_000,
        ),
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof HeadersTimeoutError) &&
        /ECONNREFUSED/.test(error.message),
    );
    assert.ok(Date.now() - started < 1000);
  });
});
