type TimedFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: Buffer;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export class ConnectTimeoutError extends Error {
  readonly status = 504;
  readonly code = "connect_timeout";
  constructor(message = "Upstream connect timed out") {
    super(message);
    this.name = "ConnectTimeoutError";
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

export async function fetchWithConnectTimeout(
  fetchImpl: TimedFetch,
  url: string,
  init: Parameters<TimedFetch>[1],
  connectMs: number,
): Promise<Response> {
  const connect = new AbortController();
  const timer = setTimeout(() => connect.abort(), connectMs);
  const signal = combineSignals(init.signal, connect.signal);
  try {
    return await fetchImpl(url, { ...init, signal });
  } catch (error) {
    if (connect.signal.aborted && !init.signal?.aborted) {
      throw new ConnectTimeoutError();
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
