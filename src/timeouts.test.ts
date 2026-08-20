import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConnectTimeoutError, fetchWithConnectTimeout } from "./timeouts.js";

describe("timeouts", () => {
  it("applies connect timeout independently of later body activity", async () => {
    await assert.rejects(
      () =>
        fetchWithConnectTimeout(
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
      (error: unknown) => error instanceof ConnectTimeoutError,
    );
  });
});
