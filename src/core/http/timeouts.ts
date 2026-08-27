type TimedFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: Buffer;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export class HeadersTimeoutError extends Error {
  readonly status = 504;
  readonly code = "upstream_headers_timeout";
  constructor(message = "Upstream response headers timed out") {
    super(message);
    this.name = "HeadersTimeoutError";
  }
}

export class IdleTimeoutError extends Error {
  readonly status = 504;
  readonly code = "idle_timeout";
  constructor(message = "Upstream idle timeout") {
    super(message);
    this.name = "IdleTimeoutError";
  }
}

export async function fetchWithHeadersTimeout(
  fetchImpl: TimedFetch,
  url: string,
  init: Parameters<TimedFetch>[1],
  headersMs: number,
): Promise<Response> {
  const headers = new AbortController();
  const timer = setTimeout(() => headers.abort(), headersMs);
  const signal = combineSignals(init.signal, headers.signal);
  try {
    return await fetchImpl(url, { ...init, signal });
  } catch (error) {
    if (headers.signal.aborted && !init.signal?.aborted) {
      throw new HeadersTimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const live = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];
  return AbortSignal.any(live);
}
