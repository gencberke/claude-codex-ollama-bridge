import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { responseSink, watchIdle } from "./core/http/relay.js";
import { IdleTimeoutError } from "./core/http/timeouts.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("relay idle and backpressure", () => {
  it("trips idle before the first byte and after a gap between chunks", async () => {
    const source = new PassThrough();
    source.on("error", () => undefined);
    const abort = new AbortController();
    watchIdle(source, 40, abort);
    await delay(20);
    assert.equal(source.destroyed, false);
    await delay(40);
    assert.ok(source.errored instanceof IdleTimeoutError);
    assert.equal(abort.signal.aborted, false);

    const later = new PassThrough();
    later.on("error", () => undefined);
    const abortLater = new AbortController();
    watchIdle(later, 40, abortLater);
    later.write("chunk-1");
    await delay(25);
    assert.equal(later.destroyed, false);
    later.write("chunk-2");
    await delay(25);
    assert.equal(later.destroyed, false);
    await delay(40);
    assert.ok(later.errored instanceof IdleTimeoutError);
  });

  it("pauses the idle clock while the downstream socket is backpressured", async () => {
    const source = new PassThrough();
    source.on("error", () => undefined);
    const abort = new AbortController();
    const idle = watchIdle(source, 40, abort);
    idle.pause();
    await delay(80);
    assert.equal(source.destroyed, false);
    idle.resume();
    await delay(20);
    assert.equal(source.destroyed, false);
    await delay(40);
    assert.ok(source.errored instanceof IdleTimeoutError);
  });

  it("pauses idle on write false and rearms on drain before reading continues", async () => {
    const source = new PassThrough();
    source.on("error", () => undefined);
    const abort = new AbortController();
    const idle = watchIdle(source, 40, abort);
    const res = new FakeResponse(false);
    const sink = responseSink(res as never, true, idle);
    sink.write("blocked");
    await delay(80);
    assert.equal(source.destroyed, false);
    assert.equal(sink.isPaused(), true);
    res.emitDrain();
    assert.equal(sink.isPaused(), false);
    await delay(20);
    assert.equal(source.destroyed, false);
    await delay(40);
    assert.ok(source.errored instanceof IdleTimeoutError);
  });
});

class FakeResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  private readonly writeOk: boolean;

  constructor(writeOk: boolean) {
    super();
    this.writeOk = writeOk;
  }

  write(_chunk: Buffer | string): boolean {
    return this.writeOk;
  }

  end(): this {
    this.writableEnded = true;
    return this;
  }

  emitDrain(): void {
    this.emit("drain");
  }
}
