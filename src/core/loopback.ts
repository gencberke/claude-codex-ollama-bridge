export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export type LoopbackUrlResult =
  | { ok: true; port: number; host: string; pathname: string }
  | { ok: false; reason: string };

/**
 * One shared loopback normalizer for local HTTP URLs: 127.0.0.1,
 * case-insensitive localhost, and `[::1]` (WHATWG keeps the brackets in
 * hostname) are accepted. URL credentials are always rejected. Errors never
 * echo the raw URL, which may contain a password.
 */
export function parseLoopbackHttpUrl(url: string, label: string): LoopbackUrlResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `${label} is not a valid URL` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `${label} must be http(s), got ${parsed.protocol}` };
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { ok: false, reason: `${label} must not include credentials` };
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    return { ok: false, reason: `${label} must be loopback (127.0.0.1), got ${parsed.hostname}` };
  }
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === "https:"
      ? 443
      : 80;
  if (!Number.isInteger(port) || port <= 0) {
    return { ok: false, reason: `${label} has an invalid port` };
  }
  return { ok: true, port, host: parsed.hostname, pathname: parsed.pathname };
}

export function assertLoopbackHttpUrl(url: string, label: string): void {
  const parsed = parseLoopbackHttpUrl(url, label);
  if (!parsed.ok) throw new Error(parsed.reason);
}

export function assertLoopbackBindHost(host: string): void {
  if (!LOOPBACK_HOSTS.has(host.toLowerCase())) {
    throw new Error(`gateway must bind loopback, got ${host}`);
  }
}