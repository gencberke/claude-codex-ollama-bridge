import type { ServerResponse } from "node:http";
import { PassThrough, type Readable, type Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { IdleTimeoutError } from "./timeouts.js";

/**
 * Surface-owned writer invoked when an upstream stream fails after response
 * headers were sent. The raw relay itself never emits a protocol terminal.
 */
export type StreamFailureWriter = (res: ServerResponse, error: unknown) => void | Promise<void>;

export async function relayPassthrough(
  source: Readable,
  res: ServerResponse,
  opts: { idleMs: number; abort: AbortController; onUpstreamFailure?: StreamFailureWriter },
): Promise<boolean> {
  return relayThrough(source, res, opts);
}

export async function relayTransformed(
  source: Readable,
  transform: Transform,
  res: ServerResponse,
  opts: {
    idleMs: number;
    abort: AbortController;
    endResponse?: boolean;
    appendErrorTerminal?: boolean;
    onUpstreamFailure?: StreamFailureWriter;
  },
): Promise<boolean> {
  const idle = watchIdle(source, opts.idleMs, opts.abort);
  const sink = responseSink(res, opts.endResponse !== false, idle);
  try {
    await pipeline(source, transform, sink);
  } catch (error) {
    idle.clear();
    if (!res.headersSent || opts.appendErrorTerminal === false) throw error;
    await finishFailedRelay(res, error, opts.onUpstreamFailure);
    return false;
  }
  idle.clear();
  return true;
}

async function relayThrough(
  source: Readable,
  res: ServerResponse,
  opts: { idleMs: number; abort: AbortController; onUpstreamFailure?: StreamFailureWriter },
): Promise<boolean> {
  const idle = watchIdle(source, opts.idleMs, opts.abort);
  const sink = responseSink(res, true, idle);
  try {
    await pipeline(source, sink);
  } catch (error) {
    idle.clear();
    if (!res.headersSent) throw error;
    await finishFailedRelay(res, error, opts.onUpstreamFailure);
    return false;
  }
  idle.clear();
  return true;
}

/**
 * Protocol-free failure ending: benign aborts and upstream failures both end
 * the truncated response without writing any protocol body. Surfaces that own
 * a terminal contract pass onUpstreamFailure.
 */
async function finishFailedRelay(
  res: ServerResponse,
  error: unknown,
  onUpstreamFailure?: StreamFailureWriter,
): Promise<void> {
  if (isBenignAbort(error)) {
    if (!res.writableEnded) res.end();
    return;
  }
  if (res.writableEnded) return;
  if (!onUpstreamFailure) {
    try {
      res.end();
    } catch {
      res.destroy();
    }
    return;
  }
  try {
    await onUpstreamFailure(res, error);
  } catch {
    res.destroy();
  }
}

export function isBenignAbort(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: string; code?: string };
  return record.name === "AbortError" || record.code === "ABORT_ERR" || record.code === "ERR_STREAM_PREMATURE_CLOSE";
}

export type IdleWatch = {
  clear: () => void;
  pause: () => void;
  resume: () => void;
};

export function responseSink(
  res: ServerResponse,
  endResponse = true,
  idle?: IdleWatch,
): PassThrough {
  const sink = new PassThrough();
  const onDrain = (): void => {
    idle?.resume();
    sink.resume();
  };
  res.on("drain", onDrain);
  sink.on("data", (chunk: Buffer) => {
    if (res.writableEnded) return;
    const ok = res.write(chunk);
    if (!ok) {
      idle?.pause();
      sink.pause();
    }
  });
  const detach = (): void => {
    res.off("drain", onDrain);
  };
  sink.on("end", () => {
    detach();
    if (endResponse && !res.writableEnded) res.end();
  });
  sink.on("close", detach);
  sink.on("error", detach);
  return sink;
}

export function watchIdle(
  source: Readable,
  idleMs: number,
  abort: AbortController,
): IdleWatch {
  let paused = false;
  let timer: NodeJS.Timeout | undefined;
  const trip = (): void => {
    source.destroy(new IdleTimeoutError());
  };
  const arm = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (paused || abort.signal.aborted) return;
    timer = setTimeout(trip, idleMs);
  };
  const bump = (): void => {
    if (paused) return;
    arm();
  };
  arm();
  abort.signal.addEventListener(
    "abort",
    () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    { once: true },
  );
  source.on("data", bump);
  source.on("end", () => {
    if (timer) clearTimeout(timer);
  });
  source.on("error", () => {
    if (timer) clearTimeout(timer);
  });
  return {
    clear: () => {
      if (timer) clearTimeout(timer);
      source.off("data", bump);
    },
    pause: () => {
      paused = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    resume: () => {
      if (!paused) return;
      paused = false;
      arm();
    },
  };
}
