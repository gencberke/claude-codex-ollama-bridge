/**
 * Protocol-free body and response size limits shared by both surfaces.
 * Surface-specific timeout constants stay surface-owned.
 */
import type { IncomingMessage } from "node:http";
import { IdleTimeoutError } from "./timeouts.js";

export const MAX_RAW_BODY_BYTES = 32 * 1024 * 1024;
export const MAX_DECODED_BODY_BYTES = 64 * 1024 * 1024;
export const MAX_UPSTREAM_BODY_BYTES = 64 * 1024 * 1024;

/** Upstream body/stream idle deadline used as the shared default. */
export const IDLE_TIMEOUT_MS = 300_000;

export class BodyLimitError extends Error {
  readonly status = 413;
  readonly code = "payload_too_large";
  constructor(message = `Request body exceeds ${MAX_RAW_BODY_BYTES} bytes`) {
    super(message);
    this.name = "BodyLimitError";
  }
}

export class UpstreamLimitError extends Error {
  readonly status = 502;
  readonly code = "upstream_payload_too_large";
  constructor(message = `Upstream body exceeds ${MAX_UPSTREAM_BODY_BYTES} bytes`) {
    super(message);
    this.name = "UpstreamLimitError";
  }
}

export class BodyAbortedError extends Error {
  readonly code = "request_aborted";
  constructor() {
    super("request aborted");
    this.name = "BodyAbortedError";
  }
}

export function readLimitedBody(
  req: IncomingMessage,
  opts: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<Buffer> {
  const maxBytes = opts.maxBytes ?? MAX_RAW_BODY_BYTES;
  const contentLength = Number(req.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    req.resume();
    return Promise.reject(
      new BodyLimitError(`Content-Length ${contentLength} exceeds ${maxBytes} bytes`),
    );
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (error?: Error, body?: Buffer): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(body ?? Buffer.alloc(0));
    };

    const onAbort = (): void => {
      req.destroy();
      finish(new BodyAbortedError());
    };

    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > maxBytes) {
        req.resume();
        finish(new BodyLimitError(`Request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = (): void => finish(undefined, Buffer.concat(chunks, total));
    const onError = (error: Error): void => finish(error);

    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

export async function readLimitedResponse(
  response: Response,
  maxBytes = MAX_UPSTREAM_BODY_BYTES,
  opts: { idleMs?: number; signal?: AbortSignal } = {},
): Promise<Buffer> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new UpstreamLimitError(`Upstream Content-Length ${contentLength} exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const idleMs = opts.idleMs ?? IDLE_TIMEOUT_MS;
  const chunks: Buffer[] = [];
  let total = 0;
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const tripIdle = (): void => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  };
  const bump = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(tripIdle, idleMs);
  };
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  bump();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (opts.signal?.aborted) throw new BodyAbortedError();
      const { done, value } = await reader.read();
      if (timedOut) throw new IdleTimeoutError();
      if (done) break;
      bump();
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new UpstreamLimitError(`Upstream body exceeds ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
    if (timedOut) throw new IdleTimeoutError();
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (timedOut) throw new IdleTimeoutError();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
