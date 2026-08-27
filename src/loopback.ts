const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function assertLoopbackHttpUrl(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must be http(s)`);
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(`${label} must be loopback (127.0.0.1), got ${parsed.hostname}`);
  }
}

export function assertLoopbackBindHost(host: string): void {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`gateway must bind loopback, got ${host}`);
  }
}
