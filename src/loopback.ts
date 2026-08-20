import { NATIVE_RESPONSES_URL } from "./constants.js";

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

export function assertNativeUrlPinned(url: string | undefined): void {
  if (url && url !== NATIVE_RESPONSES_URL) {
    throw new Error("native ChatGPT URL is pinned and cannot be overridden");
  }
}

export function assertLoopbackBindHost(host: string): void {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`gateway must bind loopback, got ${host}`);
  }
}
