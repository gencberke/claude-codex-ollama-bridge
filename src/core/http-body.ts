/**
 * Bounded, time-limited response body readers for local HTTP fetches.
 * Failures are typed and content-free: error messages never echo response
 * bytes or request URLs.
 */

export type LimitedBodyFailureCode = "body_oversize" | "body_malformed";

export class LimitedBodyError extends Error {
  readonly code: LimitedBodyFailureCode;

  constructor(code: LimitedBodyFailureCode, message: string) {
    super(message);
    this.name = "LimitedBodyError";
    this.code = code;
  }
}

export class BodyAbortedError extends Error {
  constructor(message = "response body read aborted") {
    super(message);
    this.name = "BodyAbortedError";
  }
}

/**
 * Read a response body up to `maxBytes` (reading at most maxBytes + 1 to
 * detect oversize without buffering extra). When `signal` is given, abort is
 * rechecked after every awaited read, and a read that races an abort resolves
 * as BodyAbortedError — a cancelled stream can never surface as success.
 */
export async function readLimitedResponse(
  response: Response,
  opts: { maxBytes: number; signal?: AbortSignal },
): Promise<string> {
  const body = response.body;
  if (body === null) {
    throw new LimitedBodyError("body_malformed", "response has no body");
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (opts.signal?.aborted) throw new BodyAbortedError();
      const result = await raceAbort(reader.read(), opts.signal);
      // Signal already checked above. Cancel() resolves a pending read as
      // {done:true}, which must not count as a completed body.
      if (opts.signal?.aborted) throw new BodyAbortedError();
      if (result.done) break;
      const value = result.value;
      total += value.byteLength;
      if (total > opts.maxBytes) {
        throw new LimitedBodyError("body_oversize", `response body exceeds ${opts.maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    try {
      void reader.cancel().catch(() => {});
    } catch {
      // cancellation is best effort; the body may already be closed
    }
  }
  const parts: string[] = [];
  const decoder = new TextDecoder();
  for (const chunk of chunks) {
    parts.push(decoder.decode(chunk, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join("");
}

type ReadStep = { done: false; value: Uint8Array } | { done: true; value?: undefined };

function raceAbort(
  read: Promise<ReadStep>,
  signal: AbortSignal | undefined,
): Promise<ReadStep> {
  if (signal === undefined) return read;
  if (signal.aborted) return Promise.reject(new BodyAbortedError());
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      reject(new BodyAbortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    read.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}