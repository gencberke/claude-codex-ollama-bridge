import { FORWARD_HEADERS, NATIVE_RESPONSES_URL } from "./constants.js";
import { CONNECT_TIMEOUT_MS } from "./limits.js";
import { fetchWithConnectTimeout } from "./timeouts.js";

export type HeaderMap = Record<string, string | string[] | undefined>;

export function pickForwardHeaders(headers: HeaderMap): Record<string, string> {
  const out: Record<string, string> = {};
  const allow = new Set(FORWARD_HEADERS);
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    const listed = allow.has(key as (typeof FORWARD_HEADERS)[number]);
    const prefixed =
      key.startsWith("x-codex-") || key.startsWith("chatgpt-") || key.startsWith("x-openai-");
    if (!listed && !prefixed) continue;
    const value = Array.isArray(rawValue) ? rawValue.join(",") : rawValue;
    if (value && value.length > 0) {
      out[key] = value;
    }
  }
  return out;
}

export function nativeRequestHeaders(headers: HeaderMap, contentType?: string): Record<string, string> {
  const forwarded = pickForwardHeaders(headers);
  if (contentType && !forwarded["content-type"]) {
    forwarded["content-type"] = contentType;
  }
  if (!forwarded.accept) {
    forwarded.accept = "text/event-stream, application/json";
  }
  return forwarded;
}

export type UpstreamFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: Buffer;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export async function forwardNativeResponses(opts: {
  body: Buffer;
  headers: HeaderMap;
  contentType?: string;
  url?: string;
  fetchImpl?: UpstreamFetch;
  signal?: AbortSignal;
  connectMs?: number;
}): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as UpstreamFetch);
  return fetchWithConnectTimeout(
    fetchImpl,
    opts.url ?? NATIVE_RESPONSES_URL,
    {
      method: "POST",
      headers: nativeRequestHeaders(opts.headers, opts.contentType),
      body: opts.body,
      signal: opts.signal,
    },
    opts.connectMs ?? CONNECT_TIMEOUT_MS,
  );
}
