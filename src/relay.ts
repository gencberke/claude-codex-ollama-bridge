import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough, type Readable, type Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { IdleTimeoutError } from "./timeouts.js";

export function attachCancellation(req: IncomingMessage, res: ServerResponse): AbortController {
  const abort = new AbortController();
  const trip = (): void => {
    if (!abort.signal.aborted) abort.abort();
  };
  req.once("aborted", trip);
  req.once("close", () => {
    if (!req.complete) trip();
  });
  res.once("close", () => {
    if (!res.writableEnded) trip();
  });
  abort.signal.addEventListener(
    "abort",
    () => {
      req.destroy();
    },
    { once: true },
  );
  return abort;
}

export function sseErrorTerminal(message: string): string {
  const payload = JSON.stringify({
    error: { type: "server_error", code: "upstream_stream_error", message },
  });
  return `data: ${payload}\n\ndata: [DONE]\n\n`;
}

export function sseDoneTerminal(): string {
  return "data: [DONE]\n\n";
}

export async function relayPassthrough(
  source: Readable,
  res: ServerResponse,
  opts: { idleMs: number; abort: AbortController },
): Promise<boolean> {
  return relayThrough(source, res, opts);
}

export async function relayTransformed(
  source: Readable,
  transform: Transform,
  res: ServerResponse,
  opts: { idleMs: number; abort: AbortController; endResponse?: boolean },
): Promise<boolean> {
  const idle = watchIdle(source, opts.idleMs, opts.abort);
  const sink = responseSink(res, opts.endResponse !== false, idle);
  try {
    await pipeline(source, transform, sink);
  } catch (error) {
    idle.clear();
    if (!res.headersSent) throw error;
    await failRelayedResponse(res, error);
    return false;
  }
  idle.clear();
  return true;
}

async function relayThrough(
  source: Readable,
  res: ServerResponse,
  opts: { idleMs: number; abort: AbortController },
): Promise<boolean> {
  const idle = watchIdle(source, opts.idleMs, opts.abort);
  const sink = responseSink(res, true, idle);
  try {
    await pipeline(source, sink);
  } catch (error) {
    idle.clear();
    if (!res.headersSent) throw error;
    await failRelayedResponse(res, error);
    return false;
  }
  idle.clear();
  return true;
}

export async function failRelayedResponse(res: ServerResponse, error: unknown): Promise<void> {
  if (isBenignAbort(error)) {
    if (!res.writableEnded) res.end();
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (!res.headersSent) {
    return;
  }
  if (res.writableEnded) return;
  try {
    res.write(sseErrorTerminal(message));
    res.end();
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
