import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { describe, it } from "node:test";
import { TagsServer } from "./eval-wp14-outage-canary.js";

/** Fake loopback server whose listen fails asynchronously with EPERM. */
function failingServer(): Server {
  const failing = new EventEmitter() as unknown as Server;
  const seam = failing as unknown as {
    listen: (...args: unknown[]) => void;
    close: (cb?: (error?: Error) => void) => void;
    address: () => unknown;
  };
  seam.listen = () => {
    setImmediate(() => {
      failing.emit("error", Object.assign(new Error("SIMULATED_LISTEN_EPERM"), { code: "EPERM" }));
    });
  };
  seam.close = (cb) => cb?.();
  seam.address = () => null;
  return failing;
}

describe("WP14 outage canary TagsServer", () => {
  it("rejects an async listen failure instead of crashing and stays safely stoppable", async () => {
    const server = new TagsServer(failingServer);
    // The async error event rejects the start promise; it never becomes an
    // unhandled exception that skips the canary's finally cleanup.
    await assert.rejects(() => server.start(), /SIMULATED_LISTEN_EPERM/);
    // A failed listen leaves the server stopped: stop() stays idempotent and
    // safe, so the cleanup/finally path can still run.
    assert.equal(server.port, 0);
    assert.equal(await server.stop(), true);
    assert.equal(await server.stop(), true);
  });

  it("starts again after a failed listen and keeps the normal success path", async () => {
    let calls = 0;
    const server = new TagsServer(() => {
      calls += 1;
      return calls === 1 ? failingServer() : createServer();
    });
    await assert.rejects(() => server.start(), /SIMULATED_LISTEN_EPERM/);
    // Recovery: a fresh start with a working server succeeds, proving the
    // failed start left no stuck state behind.
    const url = await server.start();
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(server.port > 0);
    // Success listener behavior is unchanged: start() stays once-only while
    // running and stop() returns the port-closed proof.
    await assert.rejects(() => server.start(), /already running/);
    assert.equal(await server.stop(), true);
    assert.equal(await server.stop(), true);
  });
});